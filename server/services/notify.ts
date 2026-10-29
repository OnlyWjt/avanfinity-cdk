/**
 * 通知：通过 Telegram 机器人推送
 *  - 兑换需要关注（失败 / 待审核 / 需处理）：每分钟扫描一次，合并成一条
 *  - 平台库存不足：每 30 分钟检查，同一套餐 6 小时内只提醒一次
 *  - 商城：新成交、发货失败、代理申请、提现申请，每分钟合并一条
 *  - 每日报告：业务时区 09:00 发送前一天汇总
 */
import { q } from '../db.ts';
import { config } from '../config.ts';
import { getSetting, patchSetting } from './settings.ts';
import { decryptOpt } from '../crypto.ts';
import { gptOffers, fullPlanLabel } from './catalog.ts';

const ATTN_LABEL: Record<string, string> = { failed: '失败', manual_review: '待审核', requires_action: '需处理' };

export async function sendTelegram(text: string, override?: { token: string; chatId: string }) {
  const n = getSetting('notify');
  const token = override?.token || decryptOpt(n.tgTokenEnc), chatId = override?.chatId || n.tgChatId;
  if (!token || !chatId) throw new Error('还没有配置 Telegram 机器人');
  const r = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.description || `Telegram 返回 HTTP ${r.status}`);
}
const html = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const configured = () => { const n = getSetting('notify'); return !!(n.tgTokenEnc && n.tgChatId); };

/* ---------- 兑换需要关注 ---------- */
let lastScan = new Date().toISOString();
export async function scanAttention() {
  const n = getSetting('notify');
  if (!n.failAlert || !configured()) { lastScan = new Date().toISOString(); return 0; }
  const since = lastScan, until = new Date().toISOString();
  const rows = q.all<any>(`SELECT r.id, r.product, r.plan, r.status, r.account, r.error_msg, c.display FROM redemptions r JOIN codes c ON c.id = r.code_id
    WHERE r.status IN ('failed','manual_review','requires_action') AND r.updated_at > ? AND r.updated_at <= ? ORDER BY r.updated_at LIMIT 20`, [since, until]);
  lastScan = until;
  if (!rows.length) return 0;
  const lines = rows.map(r => `• <b>${ATTN_LABEL[r.status]}</b> ${html(fullPlanLabel(r.product, r.plan))} · ${html(r.account || '—')} · <code>${html(r.display)}</code>\n  ${html((r.error_msg || '').slice(0, 80))}`);
  await sendTelegram(`⚑ <b>${rows.length} 笔兑换需要关注</b>\n\n${lines.join('\n')}\n\n<a href="${config.publicUrl}/admin/orders.html?f=attention">去处理 →</a>`);
  return rows.length;
}

/* ---------- 商城 ---------- */
let lastShopScan = new Date().toISOString();
const yuan = (c: number) => '¥' + (c / 100).toFixed(2);
const SRC: Record<string, string> = { site: '主站', store: '分站', ref: '推广', wholesale: '批发' };
export async function scanShop() {
  const n = getSetting('notify');
  const since = lastShopScan, until = new Date().toISOString();
  lastShopScan = until;
  if (!n.shopAlert || !configured()) return 0;
  const paid = q.all<any>("SELECT title, quantity, total, source FROM orders WHERE paid_at > ? AND paid_at <= ? AND kind != 'topup' ORDER BY paid_at LIMIT 30", [since, until]);
  const failed = q.all<any>("SELECT no, deliver_error FROM orders WHERE status = 'paid' AND deliver_attempts = 1 AND next_deliver_at > ? LIMIT 10", [since]);
  const apply = q.all<any>("SELECT shop_name, slug FROM agents WHERE created_at > ? AND created_at <= ?", [since, until]);
  const wd = q.all<any>("SELECT w.amount, a.shop_name FROM withdrawals w JOIN agents a ON a.customer_id = w.agent_id WHERE w.created_at > ? AND w.created_at <= ?", [since, until]);
  const parts: string[] = [];
  if (paid.length) parts.push(`💰 <b>${paid.length} 笔新成交 ${yuan(paid.reduce((a, o) => a + o.total, 0))}</b>\n` + paid.slice(0, 10).map(o => `• ${html(o.title)} × ${o.quantity} · ${yuan(o.total)} · ${SRC[o.source] || o.source}`).join('\n') + (paid.length > 10 ? `\n…还有 ${paid.length - 10} 笔` : ''));
  if (failed.length) parts.push(`⚠️ <b>${failed.length} 笔已付款订单发货失败</b>（会自动重试）\n` + failed.map(o => `• <code>${o.no}</code> ${html((o.deliver_error || '').slice(0, 80))}`).join('\n'));
  if (apply.length) parts.push(`🙋 <b>${apply.length} 个新的代理申请</b>\n` + apply.map(a => `• ${html(a.shop_name)}（/s/${html(a.slug)}）`).join('\n'));
  if (wd.length) parts.push(`🏦 <b>${wd.length} 笔新的提现申请</b>\n` + wd.map(w => `• ${html(w.shop_name)} ${yuan(w.amount)}`).join('\n'));
  if (!parts.length) return 0;
  await sendTelegram(parts.join('\n\n') + `\n\n<a href="${config.publicUrl}/admin/shop-orders.html">打开商城后台 →</a>`);
  return parts.length;
}

/* ---------- 库存不足 ---------- */
const stockAlerted = new Map<string, number>();
export async function checkStock() {
  const n = getSetting('notify');
  if (!n.lowStock || !configured()) return 0;
  const r = await gptOffers();
  const low = (r.val || []).filter(o => o.enabled && o.stock < n.lowStockThreshold && Date.now() - (stockAlerted.get(o.plan) || 0) > 6 * 3600e3);
  if (!low.length) return 0;
  low.forEach(o => stockAlerted.set(o.plan, Date.now()));
  await sendTelegram(`📦 <b>平台库存不足</b>\n\n${low.map(o => `• ${html(fullPlanLabel('gpt', o.plan))}：剩 ${o.stock} 张`).join('\n')}\n\n库存低于 ${n.lowStockThreshold} 张时提醒，同一套餐 6 小时内只提醒一次。`);
  return low.length;
}

/* ---------- 每日报告 ---------- */
function dayStr(offsetDays = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86400e3));
}
export function dailyReportText() {
  const fx = getSetting('fx').usdCny, retail = getSetting('retail');
  const from = new Date(Date.now() - 86400e3).toISOString();
  const t = q.get<any>("SELECT COUNT(*) n, SUM(status='completed') ok, SUM(status IN ('failed','expired')) bad, SUM(status='blocked') blk FROM redemptions WHERE created_at > ?", [from])!;
  const done = q.all<any>("SELECT product, plan, cost_usd FROM redemptions WHERE status = 'completed' AND completed_at > ?", [from]);
  let sales = 0, cost = 0;
  for (const d of done) { cost += Number(d.cost_usd || 0) * fx; sales += retail[`${d.product}.${d.plan}`] || 0; }
  const blocks = q.all<any>("SELECT stage, COUNT(*) n FROM redemptions WHERE status = 'blocked' AND created_at > ? GROUP BY stage", [from]);
  const stageCN: Record<string, string> = { gate: '门槛', account: '账号', price: '价格', review: '人工拒绝' };
  const unused = q.get<{ n: number }>("SELECT COUNT(*) n FROM codes WHERE status = 'unused'")!.n;
  const rate = (t.ok || 0) + (t.bad || 0) ? Math.round((t.ok / (t.ok + t.bad)) * 100) + '%' : '—';
  const shop = q.get<any>("SELECT COUNT(*) n, COALESCE(SUM(total),0) s, COALESCE(SUM(cost),0) c, COALESCE(SUM(agent_profit + commission),0) a FROM orders WHERE kind != 'topup' AND status IN ('paid','delivered') AND paid_at > ?", [from])!;
  const shopLine = shop.n ? `
商城成交 <b>${shop.n}</b> 单 · ¥${(shop.s / 100).toFixed(2)} · 毛利 <b>¥${((shop.s - shop.c - shop.a) / 100).toFixed(2)}</b>` : '';
  return `📊 <b>日报 ${dayStr(-1)}</b>（近 24 小时）\n\n兑换成功 <b>${t.ok || 0}</b> · 失败 ${t.bad || 0} · 成功率 ${rate}\n策略拦截 ${t.blk || 0}${blocks.length ? '（' + blocks.map(b => `${stageCN[b.stage] || b.stage} ${b.n}`).join('、') + '）' : ''}\n` +
    `销售额 ¥${sales.toFixed(2)} · 成本 ¥${cost.toFixed(2)} · 利润 <b>¥${(sales - cost).toFixed(2)}</b>${shopLine}\n未兑换的码 ${unused} 张`;
}
export async function maybeDailyReport() {
  const n = getSetting('notify');
  if (!n.dailyReport || !configured()) return false;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', hour12: false }).format(new Date()));
  const today = dayStr();
  if (hour < 9 || n.lastReportDay === today) return false;
  patchSetting('notify', { lastReportDay: today });
  await sendTelegram(dailyReportText());
  return true;
}

export function startNotifier() {
  const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch(e => console.warn(`[notify] ${name}:`, e.message));
  setInterval(safe('attention', scanAttention), Number(process.env.NOTIFY_SCAN_MS) || 60e3).unref();
  setInterval(safe('shop', scanShop), Number(process.env.NOTIFY_SCAN_MS) || 60e3).unref();
  setInterval(safe('stock', checkStock), 30 * 60e3).unref();
  setInterval(safe('daily', maybeDailyReport), 10 * 60e3).unref();
}

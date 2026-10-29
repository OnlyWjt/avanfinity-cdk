/**
 * GPT 直充：资金护栏 + 卡台自动直充任务的辅助函数
 *
 * 护栏（设置 directGuard）
 *   - 单笔上限：预估成本超过就不下单；同时作为 maxTotalDebitUsd 发给卡台，由卡台再封顶一次
 *   - 每日总额：业务时区当天已占用 + 本单预留超过上限就不下单，并告警（每天一次）
 *   - 连续失败熔断：连续 N 笔直充失败自动暂停全部直充，必须人工恢复
 *   - 余额告警：卡台钱包可用余额低于阈值时告警（6 小时一次）
 * 额度账本 direct_spend：下单前在同一个事务里「检查 + 预留」，并发确认不会一起冲破上限
 *   reserved 进行中 / 结果未知（按预留额计）  spent 成功（按实际花费计）
 *   released 失败（按卡台仍占用的金额计）     cancelled 没有下单成功（不计）
 */
import { q, tx, now } from '../db.ts';
import { avan, type GptAutoTask, type GptDirectOrder } from '../avan/client.ts';
import { getSetting, patchSetting, type DirectGuard } from './settings.ts';
import { startOfDay } from './stats.ts';
import { sendTelegram } from './notify.ts';
import { config } from '../config.ts';
import { bad } from '../http.ts';

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const usdStr = (n: number) => r4(n).toFixed(2);
const html = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

/** 资金告警：只要配置了 Telegram 就发（和普通通知开关无关），发送失败只记日志 */
async function alert(text: string) {
  const n = getSetting('notify');
  if (!n.tgTokenEnc || !n.tgChatId) { console.warn('[direct] ' + text.replace(/<[^>]+>/g, '')); return; }
  await sendTelegram(text + `\n\n<a href="${config.publicUrl}/admin/settings.html#direct">打开直充护栏 →</a>`).catch(e => console.warn('[direct] 告警发送失败', e.message));
}

/* ==================================================================
   额度
   ================================================================== */
/** 业务时区当天已占用的直充额度（USD） */
/**
 * 当前占用的直充额度（USD）= 今天已经结束的支出 + 所有还没结束的预留（不管哪天创建）。
 *   - 还没结束（reserved）：按预算计，跨过零点也照算，否则昨晚提交、今天还在付款的单会从额度里消失
 *   - 已结束但费用还没核对（cost_verified = 0）：按预算和已知花费中较大的计，宁可多算
 *   - 已核对：按实际花费计；卡台没受理（cancelled）不计
 */
export function usedToday(): number {
  const r = q.get<{ v: number | null }>(`SELECT SUM(CASE
      WHEN status = 'reserved' THEN CAST(reserved_usd AS REAL)
      WHEN status IN ('spent','released') AND cost_verified = 1 THEN COALESCE(CAST(actual_usd AS REAL), 0)
      WHEN status IN ('spent','released') THEN MAX(CAST(reserved_usd AS REAL), COALESCE(CAST(actual_usd AS REAL), 0))
      ELSE 0 END) v FROM direct_spend WHERE created_at >= ? OR status = 'reserved'`, [startOfDay()]);
  return r4(r?.v || 0);
}

export type GuardResult = { ok: true; maxUsd: string } | { ok: false; rule: string; userMsg: string };
export const HOLD_MSG = "需要卖家确认后继续开通，兑换码不会作废。";

/** 这一单的预算：预估成本 ×(1 + 余量%) + 换卡费用余量。既是额度预留，也是发给卡台的 maxTotalDebitUsd */
export function orderBudget(estimateUsd: number, g = getSetting("directGuard")) {
  // 按分计算再进位到分：预估 ×(1+余量%) + 换卡费用余量
  const est = Math.round(estimateUsd * 100), fee = Math.round(g.feeBufferUsd * 100);
  return (Math.ceil(est * (100 + g.bufferPct) / 100) + fee) / 100;
}

/**
 * 下单前：检查护栏并预留这一单的预算（同步事务，并发确认不会一起冲破每日上限）。
 * 同一个幂等键重复调用直接通过（结果未知时原样重放）
 */
export function reserve(p: { redemptionId: string; codeId: string; accountKey: string | null; idemKey: string; plan: string; estimateUsd: number }): GuardResult {
  const g = getSetting("directGuard");
  let dailyHit = false;
  const res = tx((): GuardResult => {
    const exist = q.get<{ reserved_usd: string }>("SELECT reserved_usd FROM direct_spend WHERE idem_key = ?", [p.idemKey]);
    if (exist) return { ok: true, maxUsd: exist.reserved_usd };
    if (g.paused) return { ok: false, rule: `直充已暂停：${g.pausedReason || "管理员手动暂停"}`, userMsg: HOLD_MSG };
    // 预估必须是有效的正数：异常值会让预算和每日额度失效
    if (!(Number.isFinite(p.estimateUsd) && p.estimateUsd > 0)) return { ok: false, rule: `报价数据异常（预估 ${p.estimateUsd}），没有下单`, userMsg: HOLD_MSG };
    const budget = orderBudget(p.estimateUsd, g);
    if (budget > g.perOrderMaxUsd) return { ok: false, rule: `单笔上限：本单预算 $${usdStr(budget)}（预估 $${usdStr(p.estimateUsd)}）超过上限 $${usdStr(g.perOrderMaxUsd)}`, userMsg: HOLD_MSG };
    // 同一张码失败后可以重兑，每次都会产生开卡费：限制每张码的直充次数（卡台没受理的不算）
    const tries = q.get<{ n: number }>("SELECT COUNT(*) n FROM direct_spend WHERE code_id = ? AND status != 'cancelled'", [p.codeId])!.n;
    if (g.maxPerCode && tries >= g.maxPerCode) return { ok: false, rule: `同一张码已直充 ${tries} 次（上限 ${g.maxPerCode}），请确认后再继续`, userMsg: HOLD_MSG };
    const used = usedToday();
    if (used + budget > g.dailyMaxUsd) { dailyHit = true; return { ok: false, rule: `每日总额：今日已占用 $${usdStr(used)}，本单预算 $${usdStr(budget)}，上限 $${usdStr(g.dailyMaxUsd)}`, userMsg: HOLD_MSG }; }
    q.run("INSERT INTO direct_spend(redemption_id, code_id, account_key, idem_key, plan, reserved_usd, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [p.redemptionId, p.codeId, p.accountKey, p.idemKey, p.plan, usdStr(budget), "reserved", now()]);
    return { ok: true, maxUsd: usdStr(budget) };
  });
  if (dailyHit && g.dailyAlertDay !== startOfDay()) {
    patchSetting("directGuard", { dailyAlertDay: startOfDay() });
    void alert(`⛔ <b>直充今日额度已用完</b>

今日已占用 $${usdStr(usedToday())} / 上限 $${usdStr(g.dailyMaxUsd)}。之后的 GPT 直充兑换会转入待审核（兑换码不作废），调高额度后在「兑换记录」里通过即可继续。`);
  }
  return res;
}

/**
 * 这张码有没有还没出结果的直充（预算仍是 reserved：进行中、结果未知、或需要卖家核对）。
 * 这种情况下钱可能已经付出去了，释放 / 拒绝 / 撤销 / 退款都会让同一张码再付一次钱，必须先拿到结果
 */
export const pendingDirect = (codeId: string) => !!q.get("SELECT 1 FROM direct_spend WHERE code_id = ? AND status = 'reserved' LIMIT 1", [codeId]);
export const PENDING_MSG = '这张码还有一笔直充没有结果（可能已经付款），请先在兑换详情里「人工核对结果」或等它结束';

export const attachTask = (idemKey: string, taskId: string) => q.run("UPDATE direct_spend SET task_id = ? WHERE idem_key = ?", [taskId, idemKey]);

/** 结算一次下单。只处理还在 reserved 的记录，重复调用不会改两次 */
/**
 * 结算一次下单。只处理还在 reserved 的记录，重复调用不会改两次。
 * verified：费用是否已按卡台明细核对；没核对的由后台对账任务继续跟进（期间按预算计入额度）
 */
export function settle(idemKey: string, status: "spent" | "released" | "cancelled", actualUsd: number, o: { verified?: boolean; note?: string } = {}) {
  const verified = status === "cancelled" || !!o.verified;
  const changed = q.run("UPDATE direct_spend SET status = ?, actual_usd = ?, settled_at = ?, cost_verified = ?, cost_note = ? WHERE idem_key = ? AND status = 'reserved'",
    [status, usdStr(actualUsd), now(), verified ? 1 : 0, o.note ?? null, idemKey]).changes;
  if (changed && status === "released") checkFailTrip();
  return !!changed;
}
/** 这条兑换还没结束的下单（人工核对时一起结算） */
export const reservedOf = (redemptionId: string) =>
  q.all<{ id: number; idem_key: string; task_id: string | null }>("SELECT id, idem_key, task_id FROM direct_spend WHERE redemption_id = ? AND status = 'reserved' ORDER BY id", [redemptionId]);

/**
 * 熔断：最近 failTrip 笔已结束的直充全是失败，而且涉及至少 tripAccounts 个不同账号 → 暂停。
 * 只看不同账号，避免一个人反复故意失败就让全站直充停摆
 */
function checkFailTrip() {
  const g = getSetting("directGuard");
  if (!g.failTrip || g.paused) return;
  const last = q.all<{ status: string; account_key: string | null }>("SELECT status, account_key FROM direct_spend WHERE status IN ('spent','released') ORDER BY settled_at DESC, id DESC LIMIT ?", [g.failTrip]);
  if (last.length < g.failTrip || last.some(r => r.status !== "released")) return;
  const accounts = new Set(last.map(r => r.account_key || "?")).size;
  if (accounts < Math.min(g.tripAccounts || 1, g.failTrip)) return;
  pause(`最近 ${g.failTrip} 笔直充都失败（涉及 ${accounts} 个账号），自动熔断`);
  void alert(`🚨 <b>直充已自动熔断</b>

最近 ${g.failTrip} 笔 GPT 直充都失败，涉及 ${accounts} 个不同账号，已暂停全部直充。新的兑换会转入待审核（兑换码不作废）。
请先排查卡台、卡片和钱包，再在后台手动恢复。`);
}

export function pause(reason: string) { patchSetting("directGuard", { paused: true, pausedReason: reason.slice(0, 120), pausedAt: now() }); }
export function resume() { patchSetting("directGuard", { paused: false, pausedReason: "", pausedAt: "" }); }

export function saveGuard(b: Partial<DirectGuard>) {
  const num = (v: unknown, name: string, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name}应在 ${min}–${max} 之间`);
    return r4(n);
  };
  const cur = getSetting("directGuard");
  const perOrderMaxUsd = num(b.perOrderMaxUsd ?? cur.perOrderMaxUsd, "单笔上限", 1, 5000);
  const dailyMaxUsd = num(b.dailyMaxUsd ?? cur.dailyMaxUsd, "每日总额", 1, 1_000_000);
  if (dailyMaxUsd < perOrderMaxUsd) throw bad("每日总额不能小于单笔上限");
  patchSetting("directGuard", {
    perOrderMaxUsd, dailyMaxUsd,
    bufferPct: num(b.bufferPct ?? cur.bufferPct, "预算余量", 0, 100),
    feeBufferUsd: num(b.feeBufferUsd ?? cur.feeBufferUsd, "换卡费用余量", 0, 50),
    maxPerCode: Math.floor(num(b.maxPerCode ?? cur.maxPerCode, "每张码直充次数", 0, 20)),
    failTrip: Math.floor(num(b.failTrip ?? cur.failTrip, "熔断笔数", 0, 100)),
    tripAccounts: Math.floor(num(b.tripAccounts ?? cur.tripAccounts, "熔断账号数", 1, 100)),
    lowBalanceUsd: num(b.lowBalanceUsd ?? cur.lowBalanceUsd, "余额告警", 0, 1_000_000),
  });
}

/* ==================================================================
   钱包余额
   ================================================================== */
/** at：最近一次尝试的时间；okAt：最近一次成功取到余额的时间（失败时保留上次的值，页面据此标注过期） */
let balanceCache: { at: number; okAt: number; available: number | null; error?: string } = { at: 0, okAt: 0, available: null };
let lowAlertAt = 0, insufficientAt = 0;
export async function walletBalance(maxAgeMs = 60e3) {
  if (Date.now() - balanceCache.at < maxAgeMs) return balanceCache;
  try {
    const v = Number((await avan.balance()).balance);
    if (!Number.isFinite(v)) throw new Error('余额格式不正确');
    balanceCache = { at: Date.now(), okAt: Date.now(), available: v };
  } catch (e: any) { balanceCache = { ...balanceCache, at: Date.now(), error: e?.message || String(e) }; }
  return balanceCache;
}
/** 有直充策略时才检查余额（没在用直充不打扰） */
export async function checkBalance() {
  const g = getSetting('directGuard');
  if (!g.lowBalanceUsd || !directInUse()) return false;
  const b = await walletBalance(0);
  if (b.available == null || b.available >= g.lowBalanceUsd || Date.now() - lowAlertAt < 6 * 3600e3) return false;
  lowAlertAt = Date.now();
  await alert(`💸 <b>卡台钱包余额不足</b>\n\n可用余额 $${usdStr(b.available)}，低于告警线 $${usdStr(g.lowBalanceUsd)}。余额不够时 GPT 直充会失败，请尽快充值。（6 小时内只提醒一次）`);
  return true;
}
const directInUse = () => !!q.get("SELECT 1 FROM strategies WHERE enabled = 1 AND json_extract(config, '$.delivery') = 'direct' AND json_extract(config, '$.mode') = 'own' LIMIT 1");

/** 卡台以可用余额不足拒绝下单时立即告警（30 分钟内只发一次） */
export async function alertInsufficient(msg: string) {
  if (Date.now() - insufficientAt < 30 * 60e3) return;
  insufficientAt = Date.now();
  await alert(`💸 <b>直充下单被卡台拒绝：可用余额不足</b>\n\n${html(msg)}\n对应兑换已转入待审核，充值后在「兑换记录」里通过即可继续。`);
}

export function startDirectGuard() {
  setInterval(() => checkBalance().catch(e => console.warn('[direct] balance', e.message)), Number(process.env.BALANCE_SCAN_MS) || 10 * 60e3).unref();
  let reconciling = false;
  setInterval(async () => {
    if (reconciling) return; reconciling = true;
    try { await reconcile(); } catch (e: any) { console.warn('[direct] reconcile', e?.message || e); } finally { reconciling = false; }
  }, Number(process.env.DIRECT_RECONCILE_MS) || 5 * 60e3).unref();
}

/** 后台展示 */
export async function guardView() {
  const g = getSetting('directGuard');
  const b = await walletBalance();
  const today = q.get<any>(`SELECT COUNT(*) n, SUM(status = 'spent') ok, SUM(status = 'released') bad, SUM(status = 'reserved') pending FROM direct_spend WHERE created_at >= ?`, [startOfDay()])!;
  return {
    ...g, usedToday: usedToday(), inUse: directInUse(),
    today: { orders: today.n || 0, ok: today.ok || 0, failed: today.bad || 0, pending: today.pending || 0 },
    // 已结束但费用还没按卡台明细核对的笔数（期间按预算计入额度）
    unverified: q.get<{ n: number }>("SELECT COUNT(*) n FROM direct_spend WHERE status IN ('spent','released') AND cost_verified = 0")!.n,
    // 余额是缓存值：附上取到的时间，刷新失败时页面要能看出它可能已经过期
    balance: { available: b.available, error: b.error || null, at: b.at ? new Date(b.at).toISOString() : null, fetchedAt: b.okAt ? new Date(b.okAt).toISOString() : null },
  };
}

/* ==================================================================
   自动直充任务
   ================================================================== */
const ATTEMPT_LABEL: Record<string, string> = { funding: "准备中", payment: "正在开通", pending: "等待官方确认", completed: "已开通", failed: "未成功" };
export function taskProgress(t: GptAutoTask) {
  // 前两步和卡台 CDK 流程一致，兑换页的进度条按条数定位当前步骤
  return [{ step: '兑换码已确认', status: 'done' }, { step: '账号与报价已确认', status: 'done' }, ...t.attempts.map(a => ({
    step: `${t.attempts.length > 1 ? `开通尝试 ${a.attempt} · ` : ''}${ATTEMPT_LABEL[a.status] || a.status}`,
    status: a.status === 'completed' ? 'done' : a.status === 'failed' ? 'failed' : 'running',
  }))];
}

/* ==================================================================
   费用核对
   ================================================================== */
type Fin = { amount: string | null; currency: string | null; status: string };
const FINAL = new Set(['charged', 'released']);
const isUsd = (e: Fin) => (e.currency || '').toLowerCase() === 'usd';
const usdCharged = (list: Fin[] = []) => list.filter(e => e.status === 'charged' && e.amount != null && isUsd(e)).reduce((a, e) => a + Math.round(Number(e.amount) * 100), 0);

/**
 * 一次自动直充的实际花费：汇总**所有尝试**（包括失败的那张卡）订单费用明细里已扣款的美元项。
 * cardFunding 是转到卡上的本金，不算花费；真正花掉的是订阅款 + 服务费 + 开卡费 + 充值费。
 * 只有每次尝试的明细都拿到、而且没有 held / pending / unknown 的项，才算「已核对」；
 * 否则返回目前已知的金额，verified = false，由后台对账继续跟进。
 * 订阅款不是美元（非美国结账地区）时用预检的美元估算代替，并在 note 里注明。
 */
export async function taskCost(t: GptAutoTask, quoteUsd: number): Promise<{ usd: number; verified: boolean; note: string | null; willRenew: boolean | null }> {
  const attempts = Array.isArray(t.attempts) ? t.attempts : [];
  let cents = 0, verified = attempts.length > 0, fx = false, willRenew: boolean | null = null;
  for (const a of attempts) {
    if (!a.orderId) {
      // 没有订单：如果这次尝试已经开过卡，费用在别处，暂时核对不了
      if (a.newCard || a.cardId != null) verified = false;
      continue;
    }
    const order = await avan.gptOrder(a.orderId).then(r => r.order, () => null);
    const f = order?.financials;
    if (!f) { verified = false; continue; }
    const all = [f.subscriptionPayments, f.serviceFees, f.cardFunding, f.cardOpenFees, f.cardRechargeFees].flatMap(x => (x || []) as Fin[]);
    if (all.some(e => !FINAL.has(e.status) || (e.status === 'charged' && e.amount == null))) verified = false;
    const sub = ((f.subscriptionPayments || []) as Fin[]).filter(e => e.status === 'charged');
    if (sub.length) {
      if (sub.every(isUsd)) cents += usdCharged(sub);
      else { cents += Math.round(quoteUsd * 100); fx = true; }
    }
    cents += usdCharged(f.serviceFees as Fin[]) + usdCharged(f.cardOpenFees as Fin[]) + usdCharged(f.cardRechargeFees as Fin[]);
    if (a.status === 'completed' && typeof order?.willRenew === 'boolean') willRenew = order.willRenew;
  }
  return { usd: cents / 100, verified, note: fx ? '订阅款不是美元，按预检美元估算' : null, willRenew };
}

/**
 * 后台对账：结束了但费用还没核对的直充，重新拉取任务和费用明细。
 * 超过 7 天还核对不了的不再自动跟进（仍按预算计入当天，后台面板会显示数量）
 */
export async function reconcile() {
  const rows = q.all<{ id: number; redemption_id: string; task_id: string; status: string; reserved_usd: string }>(
    "SELECT id, redemption_id, task_id, status, reserved_usd FROM direct_spend WHERE status IN ('spent','released') AND cost_verified = 0 AND task_id IS NOT NULL AND settled_at > ? ORDER BY id LIMIT 10",
    [new Date(Date.now() - 7 * 86400e3).toISOString()]);
  let n = 0;
  for (const r of rows) {
    try {
      const red = q.get<{ quote: string | null; status: string }>('SELECT quote, status FROM redemptions WHERE id = ?', [r.redemption_id]);
      const qt = (() => { try { return JSON.parse(red?.quote || '{}'); } catch { return {}; } })();
      const c = await taskCost(await avan.gptAutoTask(r.task_id), Number(qt.usd) || 0);
      tx(() => {
        q.run('UPDATE direct_spend SET actual_usd = ?, cost_verified = ?, cost_note = ? WHERE id = ? AND cost_verified = 0', [usdStr(c.usd), c.verified ? 1 : 0, c.note, r.id]);
        if (r.status === 'spent' && red?.status === 'completed') {
          if (c.usd > 0) q.run('UPDATE redemptions SET cost_usd = ? WHERE id = ?', [c.usd.toFixed(4), r.redemption_id]);
          if (c.willRenew !== null && qt.willRenew == null) q.run('UPDATE redemptions SET quote = ? WHERE id = ?', [JSON.stringify({ ...qt, willRenew: c.willRenew }), r.redemption_id]);
        }
      });
      if (c.verified) n++;
    } catch (e: any) { console.warn('[direct] 对账失败', r.id, e?.message || e); }
  }
  return n;
}

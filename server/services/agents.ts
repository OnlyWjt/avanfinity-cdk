/**
 * 代理分销
 *   分站：/s/{slug}，代理自定价（≥ 进货价），利润 = (售价 − 进货价) × 数量
 *   推广：?ref={slug}，按主站零售价成交，佣金 = 实付 × 等级佣金 %
 *   批发：代理按进货价买码，自己卖
 *   进货价 = 商品代理基础价 × 等级批发折扣 %
 * 收益先冻结 shop.freezeDays 天，到期转为可提现；退款时冲回
 */
import { q, tx, now } from '../db.ts';
import { bad, notFound } from '../http.ts';
import { encrypt, decryptOpt } from '../crypto.ts';
import { getSetting } from './settings.ts';
import type { Order, Product } from './shop.ts';
import { startOfDay } from './stats.ts';

export interface Agent { customer_id: number; slug: string; shop_name: string; notice: string; contact: string; level_id: number | null; status: string; earnings: number; frozen: number; total_earned: number; created_at: string; approved_at: string | null }
export type Store = Agent;
interface Level { id: number; name: string; wholesale_pct: number; commission_pct: number; is_default: number; sort: number }

export async function ensureDefaultLevel() {
  if (!await q.get('SELECT 1 FROM agent_levels')) await q.run("INSERT INTO agent_levels(name, wholesale_pct, commission_pct, is_default, sort) VALUES ('普通代理', 100, 5, 1, 0)");
}
const levelOf = async (a: Agent) => await q.get<Level>('SELECT * FROM agent_levels WHERE id = ?', [a.level_id ?? -1]) || (await q.get<Level>('SELECT * FROM agent_levels WHERE is_default = 1'))!;
export const byCustomer = async (id: number) => await q.get<Agent>('SELECT * FROM agents WHERE customer_id = ?', [id]);
export const activeAgent = async (id: number) => { const a = await byCustomer(id); return a?.status === 'active' ? a : null; };
export const storeBySlug = async (slug: string) => { const a = await q.get<Agent>('SELECT * FROM agents WHERE slug = ?', [String(slug).trim().toLowerCase()]); return a?.status === 'active' ? a : null; };

export async function costFor(a: Agent, p: Product) { return Math.round((p.agent_price * (await levelOf(a)).wholesale_pct) / 100); }
export async function storePrice(a: Agent, p: Product) {
  const custom = (await q.get<{ price: number }>('SELECT price FROM agent_prices WHERE agent_id = ? AND product_id = ?', [a.customer_id, p.id]))?.price;
  return Math.max(custom ?? p.price, await costFor(a, p));
}
export async function commissionFor(agentId: number, total: number) {
  const a = await byCustomer(agentId);
  return a ? Math.floor((total * (await levelOf(a)).commission_pct) / 100) : 0;
}

/* ---------- 记账（调用方负责事务） ---------- */
async function income(a: Agent, amount: number, type: string, ref: string, note: string) {
  const days = getSetting('shop').freezeDays;
  const at = new Date(Date.now() + days * 86400e3).toISOString();
  await q.run('UPDATE agents SET frozen = frozen + ?, total_earned = total_earned + ? WHERE customer_id = ?', [amount, amount, a.customer_id]);
  const b = (await byCustomer(a.customer_id))!;
  await q.run("INSERT INTO ledger(owner, owner_id, type, amount, balance_after, ref, note, unfreeze_at, settled, created_at) VALUES ('agent', ?, ?, ?, ?, ?, ?, ?, 0, ?)", [a.customer_id, type, amount, b.earnings, ref, note, at, now()]);
}
/** 发货成功后：分站利润 / 推广佣金入账（冻结中） */
export async function creditOrder(o: Order) {
  if (!o.agent_id || await q.get("SELECT 1 FROM ledger WHERE owner = 'agent' AND ref = ? AND type IN ('profit','commission')", [o.no])) return;
  const a = await byCustomer(o.agent_id);
  if (!a) return;
  if (o.source === 'store' && o.agent_profit > 0) await income(a, o.agent_profit, 'profit', o.no, `分站订单 ${o.no}`);
  if (o.source === 'ref' && o.commission > 0) await income(a, o.commission, 'commission', o.no, `推广订单 ${o.no}`);
}
/** 退款：冲回这笔订单给代理的收益（冻结中的直接取消，已解冻的从可提现扣，可为负） */
export async function reverseOrder(o: Order) {
  if (!o.agent_id) return;
  for (const l of await q.all<any>("SELECT * FROM ledger WHERE owner = 'agent' AND ref = ? AND type IN ('profit','commission')", [o.no])) {
    if (await q.get("SELECT 1 FROM ledger WHERE owner = 'agent' AND ref = ? AND type = 'reverse'", [o.no])) return;
    if (l.settled) await q.run('UPDATE agents SET earnings = earnings - ?, total_earned = total_earned - ? WHERE customer_id = ?', [l.amount, l.amount, o.agent_id]);
    else { await q.run('UPDATE agents SET frozen = frozen - ?, total_earned = total_earned - ? WHERE customer_id = ?', [l.amount, l.amount, o.agent_id]); await q.run('UPDATE ledger SET settled = 2 WHERE id = ?', [l.id]); }
    const b = (await byCustomer(o.agent_id))!;
    await q.run("INSERT INTO ledger(owner, owner_id, type, amount, balance_after, ref, note, created_at) VALUES ('agent', ?, 'reverse', ?, ?, ?, ?, ?)", [o.agent_id, -l.amount, b.earnings, o.no, `订单 ${o.no} 退款，冲回收益`, now()]);
  }
}
/** 冻结期满的收益转为可提现 */
export async function unfreezeDue() {
  for (const l of await q.all<any>("SELECT * FROM ledger WHERE owner = 'agent' AND settled = 0 AND unfreeze_at <= ?", [now()])) {
    // 条件更新成功才转余额：同一条收益只会解冻一次
    await tx(async () => {
      if (!(await q.run('UPDATE ledger SET settled = 1 WHERE id = ? AND settled = 0', [l.id])).changes) return;
      await q.run('UPDATE agents SET frozen = frozen - ?, earnings = earnings + ? WHERE customer_id = ?', [l.amount, l.amount, l.owner_id]);
    });
  }
}

/* ---------- 代理自己的操作 ---------- */
export async function apply(customerId: number, b: { slug: string; shopName: string; contact?: string }) {
  if (!getSetting('shop').allowAgentApply) throw bad('暂未开放代理申请');
  const slug = String(b.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,23}$/.test(slug)) throw bad('店铺地址 3–24 位小写字母、数字或横线');
  if (['admin', 'shop', 'api', 'agent', 'account', 'assets'].includes(slug)) throw bad('这个店铺地址不能使用');
  const name = String(b.shopName || '').trim();
  if (!name || name.length > 30) throw bad('店铺名称 1–30 字');
  const cur = await byCustomer(customerId);
  if (cur && cur.status !== 'rejected') throw bad('你已经申请过了');
  const dup = await q.get<{ customer_id: number }>('SELECT customer_id FROM agents WHERE slug = ?', [slug]);
  if (dup && dup.customer_id !== customerId) throw bad('这个店铺地址已被使用');
  await ensureDefaultLevel();
  if (cur) await q.run("UPDATE agents SET slug = ?, shop_name = ?, contact = ?, status = 'pending' WHERE customer_id = ?", [slug, name, String(b.contact || '').slice(0, 60), customerId]);
  else await q.run("INSERT INTO agents(customer_id, slug, shop_name, contact, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)", [customerId, slug, name, String(b.contact || '').slice(0, 60), now()]);
}
/** 后台直接把客户设为代理（不受「开放代理申请」开关限制，直接生效） */
export async function adminMake(customerId: number, b: { slug: string; shopName: string; contact?: string; levelId?: number }) {
  const slug = String(b.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,23}$/.test(slug)) throw bad('店铺地址 3–24 位小写字母、数字或横线');
  if (['admin', 'shop', 'api', 'agent', 'account', 'assets'].includes(slug)) throw bad('这个店铺地址不能使用');
  const name = String(b.shopName || '').trim();
  if (!name || name.length > 30) throw bad('店铺名称 1–30 字');
  const cur = await byCustomer(customerId);
  if (cur && (cur.status === 'active' || cur.status === 'disabled')) throw bad('这个客户已经是代理了');
  const dup = await q.get<{ customer_id: number }>('SELECT customer_id FROM agents WHERE slug = ?', [slug]);
  if (dup && dup.customer_id !== customerId) throw bad('这个店铺地址已被使用');
  await ensureDefaultLevel();
  const lv = b.levelId || (await q.get<{ id: number }>('SELECT id FROM agent_levels WHERE is_default = 1'))!.id;
  if (cur) await q.run("UPDATE agents SET slug = ?, shop_name = ?, contact = ?, level_id = ?, status = 'active', approved_at = COALESCE(approved_at, ?) WHERE customer_id = ?", [slug, name, String(b.contact || '').slice(0, 60), lv, now(), customerId]);
  else await q.run("INSERT INTO agents(customer_id, slug, shop_name, contact, level_id, status, created_at, approved_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)", [customerId, slug, name, String(b.contact || '').slice(0, 60), lv, now(), now()]);
}
export async function updateStore(a: Agent, b: { shopName?: string; notice?: string; contact?: string }) {
  await q.run('UPDATE agents SET shop_name = ?, notice = ?, contact = ? WHERE customer_id = ?', [String(b.shopName ?? a.shop_name).trim().slice(0, 30) || a.shop_name, String(b.notice ?? a.notice).slice(0, 300), String(b.contact ?? a.contact).slice(0, 60), a.customer_id]);
}
export async function setPrice(a: Agent, p: Product, price: number | null) {
  if (price == null) { await q.run('DELETE FROM agent_prices WHERE agent_id = ? AND product_id = ?', [a.customer_id, p.id]); return; }
  const cost = await costFor(a, p);
  if (!Number.isInteger(price) || price < cost) throw bad(`售价不能低于进货价 ${(cost / 100).toFixed(2)} 元`);
  if (price > p.price * 3) throw bad('售价不能超过主站零售价的 3 倍');
  await q.upsert('agent_prices', { agent_id: a.customer_id, product_id: p.id, price }, ['agent_id', 'product_id'], ['price']);
}
export async function requestWithdraw(a: Agent, b: { amount: number; method: string; account: string; name?: string }) {
  const min = getSetting('shop').minWithdraw;
  const amount = Math.round(Number(b.amount));
  if (!(amount > 0 && amount >= min)) throw bad(`最低提现 ${(min / 100).toFixed(2)} 元`);
  if (!['alipay', 'usdt', 'bank', 'wechat'].includes(b.method)) throw bad('收款方式不正确');
  if (!String(b.account || '').trim()) throw bad('请填写收款账号');
  return await tx(async () => {
    if (await q.get("SELECT 1 FROM withdrawals WHERE agent_id = ? AND status = 'pending'", [a.customer_id])) throw bad('你有一笔提现正在审核，请等处理完再申请');
    const r = await q.run('UPDATE agents SET earnings = earnings - ? WHERE customer_id = ? AND earnings >= ?', [amount, a.customer_id, amount]);
    if (!r.changes) throw bad('可提现金额不足');
    const id = await q.insert('INSERT INTO withdrawals(agent_id, amount, method, account_enc, account_name, created_at) VALUES (?, ?, ?, ?, ?, ?)', [a.customer_id, amount, b.method, encrypt(String(b.account).trim()), String(b.name || '').slice(0, 30), now()]);
    await q.run("INSERT INTO ledger(owner, owner_id, type, amount, balance_after, ref, note, created_at) VALUES ('agent', ?, 'withdraw', ?, ?, ?, ?, ?)", [a.customer_id, -amount, (await byCustomer(a.customer_id))!.earnings, 'W' + id, '申请提现', now()]);
    return id;
  });
}

/** 代理中心数据 */
export async function dashboard(a: Agent) {
  const lv = await levelOf(a);
  const day = startOfDay(), month = startOfDay(29);
  const stat = async (since: string) => await q.get<any>("SELECT COUNT(*) n, COALESCE(SUM(total),0) sales, COALESCE(SUM(agent_profit + commission),0) earn FROM orders WHERE agent_id = ? AND kind = 'buy' AND status IN ('paid','delivered') AND paid_at >= ?", [a.customer_id, since]);
  return {
    agent: { slug: a.slug, shopName: a.shop_name, notice: a.notice, contact: a.contact, status: a.status, earnings: a.earnings, frozen: a.frozen, totalEarned: a.total_earned },
    level: { name: lv.name, wholesalePct: lv.wholesale_pct, commissionPct: lv.commission_pct },
    today: await stat(day), month: await stat(month),
    withdrawPending: await q.get<any>("SELECT id, amount, created_at FROM withdrawals WHERE agent_id = ? AND status = 'pending'", [a.customer_id]) || null,
    settings: { freezeDays: getSetting('shop').freezeDays, minWithdraw: getSetting('shop').minWithdraw },
  };
}
export async function agentOrders(a: Agent, limit = 100) {
  return (await q.all<any>("SELECT no, kind, source, title, quantity, total, agent_profit, commission, status, email, created_at, paid_at FROM orders WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?", [a.customer_id, limit]))
    .map(o => ({ ...o, email: o.kind === 'wholesale' ? o.email : o.email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2') }));
}
export const agentLedger = async (a: Agent) => await q.all("SELECT type, amount, ref, note, settled, unfreeze_at, created_at FROM ledger WHERE owner = 'agent' AND owner_id = ? ORDER BY id DESC LIMIT 100", [a.customer_id]);
export const agentWithdrawals = async (a: Agent) => (await q.all<any>('SELECT id, amount, method, account_enc, account_name, status, note, created_at, processed_at FROM withdrawals WHERE agent_id = ? ORDER BY id DESC LIMIT 50', [a.customer_id]))
  .map(w => ({ ...w, account: maskAcc(decryptOpt(w.account_enc) || ''), account_enc: undefined }));
const maskAcc = (s: string) => (s.length <= 6 ? s : s.slice(0, 3) + '****' + s.slice(-3));

/* ---------- 后台 ---------- */
export async function adminList(f: { status?: string; q?: string; page?: number; size?: number } = {}) {
  const where = ['1=1'], args: any[] = [];
  if (f.status) { where.push('a.status = ?'); args.push(f.status); }
  if (f.q) { where.push('(LOWER(a.shop_name) LIKE LOWER(?) OR LOWER(a.slug) LIKE LOWER(?) OR LOWER(c.email) LIKE LOWER(?))'); args.push(`%${f.q}%`, `%${f.q.toLowerCase()}%`, `%${f.q.toLowerCase()}%`); }
  const base = `FROM agents a JOIN customers c ON c.id = a.customer_id LEFT JOIN agent_levels l ON l.id = a.level_id WHERE ${where.join(' AND ')}`;
  const size = f.size ?? 500, page = f.page ?? 1;
  const total = (await q.get<{ n: number }>(`SELECT COUNT(*) n ${base}`, args))!.n;
  const list = await q.all<any>(`SELECT a.*, c.email, l.name level_name,
    (SELECT COUNT(*) FROM orders o WHERE o.agent_id = a.customer_id AND o.status IN ('paid','delivered')) orders,
    (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.agent_id = a.customer_id AND o.status IN ('paid','delivered') AND o.kind = 'buy') sales
    ${base} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]);
  return { total, list };
}
export async function adminReview(customerId: number, action: 'approve' | 'reject' | 'disable' | 'enable', levelId?: number) {
  const a = await byCustomer(customerId);
  if (!a) throw notFound('代理不存在');
  await ensureDefaultLevel();
  const st = { approve: 'active', reject: 'rejected', disable: 'disabled', enable: 'active' }[action];
  const lv = levelId ?? a.level_id ?? (await q.get<{ id: number }>('SELECT id FROM agent_levels WHERE is_default = 1'))!.id;
  await q.run('UPDATE agents SET status = ?, level_id = ?, approved_at = COALESCE(approved_at, CASE WHEN ? = \'active\' THEN ? END) WHERE customer_id = ?', [st, lv, st, now(), customerId]);
}
export const adminSetLevel = async (customerId: number, levelId: number) => await q.run('UPDATE agents SET level_id = ? WHERE customer_id = ?', [levelId, customerId]);
export const levels = async () => { await ensureDefaultLevel(); return await q.all<Level>('SELECT * FROM agent_levels ORDER BY sort, id'); };
export async function saveLevel(b: any, id?: number) {
  const name = String(b.name || '').trim().slice(0, 20);
  const w = Math.round(Number(b.wholesalePct)), c = Number(b.commissionPct);
  if (!name) throw bad('等级名称必填');
  if (!(w >= 10 && w <= 100)) throw bad('批发折扣 10–100（%）');
  if (!(c >= 0 && c <= 50)) throw bad('佣金比例 0–50（%）');
  if (id) await q.run('UPDATE agent_levels SET name = ?, wholesale_pct = ?, commission_pct = ?, sort = ? WHERE id = ?', [name, w, c, Number(b.sort) || 0, id]);
  else id = await q.insert('INSERT INTO agent_levels(name, wholesale_pct, commission_pct, sort) VALUES (?, ?, ?, ?)', [name, w, c, Number(b.sort) || 0]);
  if (b.isDefault) { await q.run('UPDATE agent_levels SET is_default = 0'); await q.run('UPDATE agent_levels SET is_default = 1 WHERE id = ?', [id]); }
  return id;
}
export async function deleteLevel(id: number) {
  const l = await q.get<Level>('SELECT * FROM agent_levels WHERE id = ?', [id]);
  if (!l) throw notFound('等级不存在');
  if (l.is_default) throw bad('默认等级不能删除');
  if (await q.get('SELECT 1 FROM agents WHERE level_id = ?', [id])) throw bad('还有代理在这个等级，不能删除');
  await q.run('DELETE FROM agent_levels WHERE id = ?', [id]);
}
export async function adminWithdrawals(status?: string) {
  return (await q.all<any>(`SELECT w.*, a.shop_name, a.slug, c.email FROM withdrawals w JOIN agents a ON a.customer_id = w.agent_id JOIN customers c ON c.id = w.agent_id ${status ? 'WHERE w.status = ?' : ''} ORDER BY w.id DESC LIMIT 200`, status ? [status] : []))
    .map(w => ({ ...w, account: decryptOpt(w.account_enc), account_enc: undefined }));
}
export async function processWithdraw(id: number, action: 'paid' | 'rejected', note: string, by: string) {
  const w = await q.get<any>('SELECT * FROM withdrawals WHERE id = ?', [id]);
  if (!w || w.status !== 'pending') throw bad('这笔提现不在待处理状态');
  await tx(async () => {
    // 条件更新：并发点两次「拒绝」只会退回一次
    if (!(await q.run("UPDATE withdrawals SET status = ?, note = ?, processed_at = ?, processed_by = ? WHERE id = ? AND status = 'pending'", [action, note.slice(0, 200), now(), by, id])).changes) throw bad('这笔提现不在待处理状态');
    if (action === 'rejected') {
      await q.run('UPDATE agents SET earnings = earnings + ? WHERE customer_id = ?', [w.amount, w.agent_id]);
      await q.run("INSERT INTO ledger(owner, owner_id, type, amount, balance_after, ref, note, created_at) VALUES ('agent', ?, 'withdraw_reject', ?, ?, ?, ?, ?)", [w.agent_id, w.amount, (await byCustomer(w.agent_id))!.earnings, 'W' + id, '提现被拒，退回可提现：' + note, now()]);
    }
  });
}
/** 代理把可提现收益转入余额（用于批发进货） */
export async function earningsToBalance(a: Agent, amount: number, credit: (id: number, amt: number, type: string, ref: string, note: string) => Promise<void>) {
  if (!Number.isInteger(amount) || amount <= 0) throw bad('金额不正确');
  // 扣收益和加余额必须同时成功
  await tx(async () => {
    const r = await q.run('UPDATE agents SET earnings = earnings - ? WHERE customer_id = ? AND earnings >= ?', [amount, a.customer_id, amount]);
    if (!r.changes) throw bad('可提现金额不足');
    await q.run("INSERT INTO ledger(owner, owner_id, type, amount, balance_after, ref, note, created_at) VALUES ('agent', ?, 'to_balance', ?, ?, ?, ?, ?)", [a.customer_id, -amount, (await byCustomer(a.customer_id))!.earnings, 'balance', '转入账户余额', now()]);
    await credit(a.customer_id, amount, 'from_earnings', 'agent', '代理收益转入');
  });
}

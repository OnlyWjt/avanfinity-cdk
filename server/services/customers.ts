/** 买家账户：注册 / 登录（独立于管理员会话）、余额、找回密码 */
import { createHash, randomInt } from 'node:crypto';
import { q, tx, now } from '../db.ts';
import { hashPassword, verifyPassword, token } from '../crypto.ts';
import { bad, HttpError } from '../http.ts';
import { getSetting } from './settings.ts';
import { sendMail, mailConfigured, layout } from './mail.ts';

export interface Customer { id: number; email: string; name: string; password_hash: string; balance: number; disabled: number; created_at: string; reset_hash: string | null; reset_expires: string | null }
const sid = (t: string) => createHash('sha256').update('c:' + t).digest('hex');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export const byId = async (id: number) => await q.get<Customer>('SELECT * FROM customers WHERE id = ?', [id]);
export const byEmail = async (e: string) => await q.get<Customer>('SELECT * FROM customers WHERE email = ?', [e.trim().toLowerCase()]);

export async function register(email: string, password: string, name = '') {
  if (!getSetting('shop').allowRegister) throw bad('暂未开放注册');
  email = email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw bad('邮箱格式不正确');
  if (password.length < 8) throw bad('密码至少 8 位');
  if (await byEmail(email)) throw new HttpError(409, '这个邮箱已经注册过了，请直接登录');
  // 注册不验证邮箱，所以不自动认领这个邮箱以前的免注册订单（否则别人用你的邮箱注册就能看到你的兑换码）；那些订单仍用查询密码查
  return await q.insert('INSERT INTO customers(email, name, password_hash, created_at) VALUES (?, ?, ?, ?)', [email, name.slice(0, 30), hashPassword(password), now()]);
}
export async function login(email: string, password: string) {
  const c = await byEmail(email);
  const ok = c ? verifyPassword(password, c.password_hash) : (verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
  if (!c || !ok) throw new HttpError(401, '邮箱或密码不正确');
  if (c.disabled) throw new HttpError(403, '账号已停用');
  await q.run('UPDATE customers SET last_login_at = ? WHERE id = ?', [now(), c.id]);
  return newSession(c.id);
}
async function newSession(id: number) {
  const t = token();
  await q.run('INSERT INTO customer_sessions(id, customer_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sid(t), id, now(), new Date(Date.now() + 30 * 86400e3).toISOString()]);
  return t;
}
export async function fromSession(t?: string) {
  if (!t) return null;
  const r = await q.get<Customer & { expires_at: string }>('SELECT c.*, s.expires_at FROM customer_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?', [sid(t)]);
  return r && r.expires_at > now() && !r.disabled ? r : null;
}
export const logout = async (t?: string) => t && await q.run('DELETE FROM customer_sessions WHERE id = ?', [sid(t)]);

/* ---------- 找回密码：邮件验证码 ---------- */
export async function sendReset(email: string) {
  const c = await byEmail(email);
  if (!c || !mailConfigured()) { hashPassword('-'); return; } // 不暴露邮箱是否存在（耗时也保持一致）
  const code = String(randomInt(100000, 1000000));
  await q.run('UPDATE customers SET reset_hash = ?, reset_expires = ? WHERE id = ?', [hashPassword(code), new Date(Date.now() + 15 * 60e3).toISOString(), c.id]);
  // 不等待发信：已注册和未注册邮箱的响应时间一致，不暴露邮箱是否存在
  void sendMail({ to: c.email, ref: 'reset', subject: `【${getSetting('theme').name}】重置密码验证码`, text: `验证码：${code}，15 分钟内有效。`, html: layout('重置密码', `<p>你的验证码是</p><p style="font-size:28px;font-weight:800;letter-spacing:6px">${code}</p><p style="color:#585d82">15 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>`) }).catch(() => {});
}
const resetFails = new Map<number, number>();
export async function resetPassword(email: string, code: string, password: string) {
  const c = await byEmail(email);
  if (!c || !c.reset_hash || !c.reset_expires || c.reset_expires < now()) throw bad('验证码不正确或已过期');
  if (!verifyPassword(code.trim(), c.reset_hash)) {
    // 同一个验证码最多试 5 次，之后作废，需要重新发送
    const n = (resetFails.get(c.id) || 0) + 1;
    if (n >= 5) { resetFails.delete(c.id); await q.run('UPDATE customers SET reset_hash = NULL, reset_expires = NULL WHERE id = ?', [c.id]); throw bad('验证码错误次数过多，已失效，请重新发送'); }
    resetFails.set(c.id, n);
    throw bad(`验证码不正确（还可以再试 ${5 - n} 次）`);
  }
  resetFails.delete(c.id);
  if (password.length < 8) throw bad('密码至少 8 位');
  await q.run('UPDATE customers SET password_hash = ?, reset_hash = NULL, reset_expires = NULL WHERE id = ?', [hashPassword(password), c.id]);
  await q.run('DELETE FROM customer_sessions WHERE customer_id = ?', [c.id]);
}
export async function changePassword(id: number, oldPw: string, newPw: string) {
  const c = (await byId(id))!;
  if (!verifyPassword(oldPw, c.password_hash)) throw bad('原密码不正确');
  if (newPw.length < 8) throw bad('新密码至少 8 位');
  await q.run('UPDATE customers SET password_hash = ? WHERE id = ?', [hashPassword(newPw), id]);
}

/* ---------- 余额（改余额和记流水在同一个事务里；外层已有事务时嵌套进去） ---------- */
export async function credit(id: number, amount: number, type: string, ref: string, note: string) {
  await tx(async () => {
    await q.run('UPDATE customers SET balance = balance + ? WHERE id = ?', [amount, id]);
    const b = (await byId(id))!.balance;
    await q.run("INSERT INTO ledger(owner, owner_id, type, amount, balance_after, ref, note, created_at) VALUES ('customer', ?, ?, ?, ?, ?, ?, ?)", [id, type, amount, b, ref, note, now()]);
  });
}
export async function debit(id: number, amount: number, type: string, ref: string, note: string, allowNegative = false) {
  await tx(async () => {
    const r = await q.run(`UPDATE customers SET balance = balance - ? WHERE id = ? ${allowNegative ? '' : 'AND balance >= ?'}`, allowNegative ? [amount, id] : [amount, id, amount]);
    if (!r.changes) throw bad('余额不足', 'INSUFFICIENT_BALANCE');
    const b = (await byId(id))!.balance;
    await q.run("INSERT INTO ledger(owner, owner_id, type, amount, balance_after, ref, note, created_at) VALUES ('customer', ?, ?, ?, ?, ?, ?, ?)", [id, type, -amount, b, ref, note, now()]);
  });
}
export const ledgerOf = async (id: number, limit = 50) => await q.all('SELECT type, amount, balance_after, ref, note, created_at FROM ledger WHERE owner = ? AND owner_id = ? ORDER BY id DESC LIMIT ?', ['customer', id, limit]);

export async function publicMe(c: Customer) {
  const ag = await q.get<any>('SELECT slug, shop_name, status FROM agents WHERE customer_id = ?', [c.id]);
  return { id: c.id, email: c.email, name: c.name, balance: c.balance, createdAt: c.created_at, agent: ag ? { slug: ag.slug, shopName: ag.shop_name, status: ag.status } : null };
}

/* ---------- 后台 ---------- */
/** type：normal 普通用户（不是代理，含被拒绝的）| agent 代理（正常 + 已停用）| pending 代理申请待审核 */
export async function adminList(f: { q?: string; type?: string; page: number; size: number }) {
  const conds: string[] = [], args: any[] = [];
  if (f.q) { conds.push('(LOWER(c.email) LIKE LOWER(?) OR LOWER(c.name) LIKE LOWER(?))'); args.push(`%${f.q}%`, `%${f.q}%`); }
  if (f.type === 'normal') conds.push("(a.status IS NULL OR a.status = 'rejected')");
  if (f.type === 'agent') conds.push("a.status IN ('active','disabled')");
  if (f.type === 'pending') conds.push("a.status = 'pending'");
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = (await q.get<{ n: number }>(`SELECT COUNT(*) n FROM customers c LEFT JOIN agents a ON a.customer_id = c.id ${where}`, args))!.n;
  const counts = (await q.get<any>("SELECT COUNT(*) n, SUM(CASE WHEN a.status IS NULL OR a.status = 'rejected' THEN 1 ELSE 0 END) normal, SUM(CASE WHEN a.status IN ('active','disabled') THEN 1 ELSE 0 END) agent, SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) pending FROM customers c LEFT JOIN agents a ON a.customer_id = c.id"))!;
  const list = await q.all<any>(`SELECT c.id, c.email, c.name, c.balance, c.disabled, c.created_at, c.last_login_at, a.status agent_status, a.slug, a.shop_name, l.name level_name,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status IN ('delivered','paid')) orders,
    (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.customer_id = c.id AND o.status IN ('delivered','paid') AND o.kind != 'topup') spent
    FROM customers c LEFT JOIN agents a ON a.customer_id = c.id LEFT JOIN agent_levels l ON l.id = a.level_id ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`, [...args, f.size, (f.page - 1) * f.size]);
  return { total, list, counts: { all: counts.n, normal: counts.normal || 0, agent: counts.agent || 0, pending: counts.pending || 0 } };
}
/** 后台手动开户：不受「允许买家注册」开关限制 */
export async function adminCreate(email: string, password: string, name = '') {
  email = email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw bad('邮箱格式不正确');
  if (password.length < 8) throw bad('密码至少 8 位');
  if (await byEmail(email)) throw new HttpError(409, '这个邮箱已经是客户了');
  return await q.insert('INSERT INTO customers(email, name, password_hash, created_at) VALUES (?, ?, ?, ?)', [email, name.slice(0, 30), hashPassword(password), now()]);
}
/** 后台重置客户密码，并让已登录的会话失效 */
export async function adminSetPassword(id: number, password: string) {
  if (!await byId(id)) throw bad('客户不存在');
  if (password.length < 8) throw bad('密码至少 8 位');
  await q.run('UPDATE customers SET password_hash = ? WHERE id = ?', [hashPassword(password), id]);
  await q.run('DELETE FROM customer_sessions WHERE customer_id = ?', [id]);
}
export async function adminAdjust(id: number, amount: number, note: string) {
  if (!await byId(id)) throw bad('客户不存在');
  if (!Number.isInteger(amount) || amount === 0) throw bad('调整金额不正确');
  if (amount > 0) await credit(id, amount, 'adjust', 'admin', note || '后台调整');
  else await debit(id, -amount, 'adjust', 'admin', note || '后台调整');
}

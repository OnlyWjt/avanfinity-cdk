/** 卡台 Webhook：验签 → 去重 → 落库 → 推进状态 */
import { q, now, json, parse, sql, dialect } from '../db.ts';
import { webhookSignature, safeEqual } from '../crypto.ts';
import { avanCredentials } from './settings.ts';
import { nudgeByUpstream } from './redeem.ts';
import { avan } from '../avan/client.ts';

export type VerifyResult = { ok: true } | { ok: false; status: number; reason: string };

export function verify(raw: string, h: { id?: string; ts?: string; sig?: string }): VerifyResult {
  const secret = avanCredentials().webhookSecret;
  if (!secret) return { ok: false, status: 503, reason: 'webhook secret not configured' };
  if (!h.id || !/^evt_[0-9a-f_]{1,100}$/.test(h.id) || !h.ts || !/^\d{10,}$/.test(h.ts) || !h.sig) return { ok: false, status: 400, reason: 'missing headers' };
  if (Math.abs(Date.now() / 1000 - Number(h.ts)) > 300) return { ok: false, status: 400, reason: 'timestamp out of range' };
  if (!safeEqual(webhookSignature(secret, h.ts, raw), h.sig)) return { ok: false, status: 401, reason: 'bad signature' };
  return { ok: true };
}

/** 返回 false 表示重复事件 */
export async function receive(id: string, raw: string): Promise<boolean> {
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return false; }
  const inserted = await q.insertIgnore('INSERT INTO webhook_events(id, type, payload, received_at) VALUES (?, ?, ?, ?)', [id, String(evt.type || 'unknown').slice(0, 100), raw, now()]);
  if (!inserted) return false;
  try {
    await apply(evt);
    await q.run('UPDATE webhook_events SET processed = 1 WHERE id = ?', [id]);
  } catch (e: any) {
    await q.run('UPDATE webhook_events SET error = ? WHERE id = ?', [String(e?.message || e), id]);
  }
  return true;
}

async function apply(evt: any) {
  const type: string = evt.type, obj = evt.data?.object || {};
  if (type.startsWith('openai.cdk.')) {
    const st = String(obj.status || type.split('.').pop()).slice(0, 40);
    if (obj.cdkId) {
      await q.run('UPDATE codes SET upstream_status = ? WHERE upstream_id = ?', [st, obj.cdkId]);
      // 托管码在卡台侧被兑换（例如用户绕过本系统直接去卡台兑换）
      if (type === 'openai.cdk.consumed') await q.run("UPDATE codes SET status = 'redeemed', redeemed_at = COALESCE(redeemed_at, ?) WHERE upstream_id = ? AND status = 'unused'", [now(), obj.cdkId]);
      if (type === 'openai.cdk.disabled') await q.run("UPDATE codes SET status = 'revoked' WHERE upstream_id = ? AND status = 'unused'", [obj.cdkId]);
      await nudgeByUpstream(obj.cdkId);
    }
  } else if (type.startsWith('openai.direct.')) {
    await nudgeByUpstream(obj.cdkId || obj.order?.cdkId, obj.orderId || obj.order?.id);
  } else if (type === 'card.transaction.updated') {
    await saveTx({ id: obj.transactionId, type: obj.type, status: obj.status, authAmount: obj.authAmount, settleAmount: obj.settleAmount, authCurrency: obj.authCurrency, merchantName: obj.merchantName, merchantCountry: obj.merchantCountry, authTime: obj.authTime });
  }
}

/* ---------------- 支付流水 ---------------- */
/** 只保存与兑换相关的字段，不保存卡号 / 卡 ID */
async function saveTx(t: any, cardNumberMasked?: string) {
  if (!t?.id) return;
  const last4 = cardNumberMasked ? String(cardNumberMasked).replace(/\D/g, '').slice(-4) : null;
  const data = { type: t.type, status: t.status, amount: t.settleAmount || t.authAmount, currency: t.settleCurrency || t.authCurrency, merchant: t.merchantName, country: t.merchantCountry, reason: t.failedReason || null, merchantAmount: t.merchantAmount ? `${t.merchantAmount} ${t.merchantCurrency || ''}`.trim() : null };
  const prev = await q.get<{ card_last4: string | null; redemption_id: string | null }>('SELECT card_last4, redemption_id FROM transactions WHERE id = ?', [t.id]);
  const l4 = last4 || prev?.card_last4 || null;
  let rid = prev?.redemption_id || null;
  if (!rid && l4 && t.authTime) {
    // 按卡号后四位 + 时间（±20 分钟）关联到兑换记录
    const at = new Date(t.authTime).getTime();
    // 时间最接近的那条（在程序里算距离：三种数据库的日期函数各不相同）
    const near = await q.all<{ id: string; created_at: string }>('SELECT id, created_at FROM redemptions WHERE card_last4 = ? AND created_at BETWEEN ? AND ?',
      [l4, new Date(at - 20 * 60e3).toISOString(), new Date(at + 20 * 60e3).toISOString()]);
    rid = near.sort((a, b) => Math.abs(new Date(a.created_at).getTime() - at) - Math.abs(new Date(b.created_at).getTime() - at))[0]?.id || null;
  }
  // 已有的卡号后四位、关联的兑换不被空值覆盖
  const head = `INSERT INTO transactions(id, auth_time, card_last4, redemption_id, data, synced_at) VALUES (?, ?, ?, ?, ?, ?)${sql.insertedAlias()}`;
  const v = sql.inserted;
  const set = `auth_time = ${v('auth_time')}, card_last4 = COALESCE(${v('card_last4')}, transactions.card_last4), redemption_id = COALESCE(${v('redemption_id')}, transactions.redemption_id), data = ${v('data')}, synced_at = ${v('synced_at')}`;
  await q.run(dialect === 'mysql' ? `${head} ON DUPLICATE KEY UPDATE ${set}` : `${head} ON CONFLICT(id) DO UPDATE SET ${set}`,
    [t.id, t.authTime ? String(t.authTime).slice(0, 40) : null, l4, rid, json(data), now()]);
}

export async function syncTransactions() {
  const r = await avan.allTransactions(1, 100);
  for (const t of r.list || []) await saveTx(t, t.cardNumberMasked);
  // 回填之前没关联上的
  for (const t of await q.all<any>('SELECT * FROM transactions WHERE redemption_id IS NULL AND card_last4 IS NOT NULL AND auth_time > ?', [new Date(Date.now() - 86400e3).toISOString()])) {
    await saveTx({ id: t.id, ...parse(t.data, {}), authTime: t.auth_time, settleAmount: parse<any>(t.data, {}).amount }, '****' + t.card_last4);
  }
  return (r.list || []).length;
}

export async function listTransactions(f: { product?: string; status?: string; type?: string; q?: string; page: number; size: number }) {
  const where = ['1=1'], args: any[] = [];
  if (f.product) { where.push('r.product = ?'); args.push(f.product); }
  if (f.status) { where.push(`${sql.json('t.data', 'status')} = ?`); args.push(f.status); }
  if (f.type) { where.push(`${sql.json('t.data', 'type')} = ?`); args.push(f.type); }
  if (f.q) { where.push(`(LOWER(${sql.json('t.data', 'merchant')}) LIKE ? OR ${sql.text('t.id')} = ? OR c.display LIKE ?)`); args.push(`%${f.q.toLowerCase()}%`, f.q, `%${f.q.toUpperCase()}%`); }
  const w = where.join(' AND ');
  const base = `FROM transactions t LEFT JOIN redemptions r ON r.id = t.redemption_id LEFT JOIN codes c ON c.id = r.code_id WHERE ${w}`;
  const total = (await q.get<{ n: number }>(`SELECT COUNT(*) n ${base}`, args))!.n;
  const list = (await q.all<any>(`SELECT t.id, t.auth_time, t.data, t.redemption_id, r.product, r.plan, r.account, c.display code ${base} ORDER BY t.auth_time DESC LIMIT ? OFFSET ?`, [...args, f.size, (f.page - 1) * f.size]))
    .map(r => ({ id: r.id, at: r.auth_time, ...parse(r.data, {}), redemptionId: r.redemption_id, product: r.product, plan: r.plan, account: r.account, code: r.code }));
  return { total, list };
}

export async function listEvents(f: { failed?: boolean; limit: number }) {
  return (await q.all<any>(`SELECT id, type, received_at, processed, error, payload FROM webhook_events ${f.failed ? 'WHERE error IS NOT NULL' : ''} ORDER BY received_at DESC LIMIT ?`, [f.limit]))
    .map(e => ({ id: e.id, type: e.type, at: e.received_at, processed: !!e.processed, error: e.error, payload: parse(e.payload, {}) }));
}
export async function eventStats() {
  const since = new Date(Date.now() - 86400e3).toISOString();
  const r = (await q.get<{ n: number; bad: number; last: string | null }>('SELECT COUNT(*) n, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) bad, MAX(received_at) last FROM webhook_events WHERE received_at > ?', [since]))!;
  return { total24h: r.n, failed24h: r.bad || 0, lastAt: (await q.get<{ m: string }>('SELECT MAX(received_at) m FROM webhook_events'))?.m || null };
}
export async function reprocess(id: string) {
  const e = await q.get<any>('SELECT * FROM webhook_events WHERE id = ?', [id]);
  if (!e) return false;
  try { await apply(JSON.parse(e.payload)); await q.run('UPDATE webhook_events SET processed = 1, error = NULL WHERE id = ?', [id]); return true; }
  catch (err: any) { await q.run('UPDATE webhook_events SET error = ? WHERE id = ?', [String(err?.message || err), id]); return false; }
}

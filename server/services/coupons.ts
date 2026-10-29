/** 优惠券：下单时占用（held），付款后核销（used），关单释放（released） */
import { q, now, json, parse } from '../db.ts';
import { bad, notFound } from '../http.ts';

interface Coupon { id: number; code: string; name: string; type: 'amount' | 'percent'; value: number; min_amount: number; max_discount: number | null; product_ids: string | null; max_uses: number | null; used: number; per_user: number; starts_at: string | null; ends_at: string | null; enabled: number }

const active = (c: Coupon) => q.get<{ n: number }>("SELECT COUNT(*) n FROM coupon_uses WHERE coupon_id = ? AND status IN ('held','used')", [c.id])!.n;

/** 校验并计算优惠金额（分） */
export function check(code: string, ctx: { productId?: string; subtotal: number; email: string }) {
  const c = q.get<Coupon>('SELECT * FROM coupons WHERE code = ?', [code.trim()]);
  if (!c || !c.enabled) throw bad('优惠券不存在或已停用', 'COUPON_INVALID');
  const t = now();
  if (c.starts_at && c.starts_at > t) throw bad('优惠券还没到可用时间', 'COUPON_INVALID');
  if (c.ends_at && c.ends_at < t) throw bad('优惠券已过期', 'COUPON_INVALID');
  const ids = parse<string[] | null>(c.product_ids, null);
  if (ids && ids.length && (!ctx.productId || !ids.includes(ctx.productId))) throw bad('这张优惠券不能用于这个商品', 'COUPON_INVALID');
  if (ctx.subtotal < c.min_amount) throw bad(`满 ${(c.min_amount / 100).toFixed(2)} 元才能使用这张优惠券`, 'COUPON_INVALID');
  if (c.max_uses != null && active(c) >= c.max_uses) throw bad('优惠券已被领完', 'COUPON_INVALID');
  const mine = q.get<{ n: number }>("SELECT COUNT(*) n FROM coupon_uses WHERE coupon_id = ? AND email = ? AND status IN ('held','used')", [c.id, ctx.email])!.n;
  if (mine >= c.per_user) throw bad('你已经用过这张优惠券了', 'COUPON_INVALID');
  let d = c.type === 'amount' ? c.value : Math.floor((ctx.subtotal * c.value) / 100);
  if (c.max_discount != null) d = Math.min(d, c.max_discount);
  d = Math.min(d, ctx.subtotal - 1); // 至少付 1 分
  if (d <= 0) throw bad('这张优惠券对当前订单没有优惠', 'COUPON_INVALID');
  return { id: c.id, discount: d, name: c.name || c.code };
}
export const hold = (couponId: number, orderNo: string, email: string) => q.run('INSERT INTO coupon_uses(coupon_id, order_no, email, status, created_at) VALUES (?, ?, ?, ?, ?)', [couponId, orderNo, email, 'held', now()]);
export function use(orderNo: string) {
  const u = q.get<{ coupon_id: number; status: string }>('SELECT coupon_id, status FROM coupon_uses WHERE order_no = ?', [orderNo]);
  if (!u || u.status === 'used') return;
  q.run("UPDATE coupon_uses SET status = 'used' WHERE order_no = ?", [orderNo]);
  q.run('UPDATE coupons SET used = used + 1 WHERE id = ?', [u.coupon_id]);
}
export const release = (orderNo: string) => q.run("UPDATE coupon_uses SET status = 'released' WHERE order_no = ? AND status = 'held'", [orderNo]);

/* ---------- 后台 ---------- */
export function list() {
  return q.all<Coupon>('SELECT * FROM coupons ORDER BY created_at DESC').map(c => ({
    id: c.id, code: c.code, name: c.name, type: c.type, value: c.value, minAmount: c.min_amount, maxDiscount: c.max_discount, productIds: parse<string[] | null>(c.product_ids, null),
    maxUses: c.max_uses, used: c.used, holding: q.get<{ n: number }>("SELECT COUNT(*) n FROM coupon_uses WHERE coupon_id = ? AND status = 'held'", [c.id])!.n,
    perUser: c.per_user, startsAt: c.starts_at, endsAt: c.ends_at, enabled: !!c.enabled,
  }));
}
export function save(b: any, id?: number) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw bad('券码 3–32 位字母、数字、下划线或横线');
  const type = b.type === 'percent' ? 'percent' : 'amount';
  const value = type === 'amount' ? Math.round(Number(b.value) * 100) : Math.round(Number(b.value));
  if (type === 'amount' && !(value > 0)) throw bad('减免金额必须大于 0');
  if (type === 'percent' && !(value >= 1 && value <= 99)) throw bad('折扣比例 1–99');
  const num = (v: any) => (v === '' || v == null ? null : Number(v));
  const minAmount = Math.round((num(b.minAmount) || 0) * 100), maxDiscount = num(b.maxDiscount) == null ? null : Math.round(num(b.maxDiscount)! * 100);
  const maxUses = num(b.maxUses) == null ? null : Math.max(1, Math.floor(num(b.maxUses)!));
  const perUser = Math.max(1, Math.floor(num(b.perUser) || 1));
  const productIds = Array.isArray(b.productIds) && b.productIds.length ? json(b.productIds.map(String)) : null;
  const dt = (v: any) => (v ? new Date(v).toISOString() : null);
  const dup = q.get<{ id: number }>('SELECT id FROM coupons WHERE code = ?', [code]);
  if (dup && dup.id !== id) throw bad('券码已存在');
  const f = [code, String(b.name || '').slice(0, 40), type, value, minAmount, maxDiscount, productIds, maxUses, perUser, dt(b.startsAt), dt(b.endsAt), b.enabled === false ? 0 : 1];
  if (id) {
    if (!q.get('SELECT 1 FROM coupons WHERE id = ?', [id])) throw notFound('优惠券不存在');
    q.run('UPDATE coupons SET code=?, name=?, type=?, value=?, min_amount=?, max_discount=?, product_ids=?, max_uses=?, per_user=?, starts_at=?, ends_at=?, enabled=? WHERE id=?', [...f, id]);
    return id;
  }
  return Number(q.run('INSERT INTO coupons(code, name, type, value, min_amount, max_discount, product_ids, max_uses, per_user, starts_at, ends_at, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [...f, now()]).lastInsertRowid);
}
export function remove(id: number) {
  if (q.get("SELECT 1 FROM coupon_uses WHERE coupon_id = ? AND status IN ('held','used')", [id])) throw bad('这张券已经被使用过，不能删除，可以停用');
  q.run('DELETE FROM coupon_uses WHERE coupon_id = ?', [id]);
  q.run('DELETE FROM coupons WHERE id = ?', [id]);
}

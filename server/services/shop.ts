/**
 * 商城：商品、下单、支付、发货、退款
 *
 * 订单状态：pending（待付款）→ paid（已付款待发货）→ delivered（已发货）
 *                          ↘ closed（超时 / 取消）        ↘ refunded（已退款）
 * 关键约束：
 *   - 价格、优惠、库存全部在服务端计算
 *   - 支付入账按平台流水号唯一 + 金额核对，重复回调只入账一次
 *   - 发货复用 generateBatch，幂等键 order-{订单号}，重复触发不会重复发码
 */
import { q, tx, now, json, parse, sql } from '../db.ts';
import { hex, token, hashPassword, verifyPasswordAsync, decryptOpt } from '../crypto.ts';
import { bad, notFound, HttpError } from '../http.ts';
import { getSetting } from './settings.ts';
import { getStrategy } from './strategy.ts';
import { generateBatch, revokeCodes } from './batches.ts';
import { fullPlanLabel, planKeys, GPT_DIRECT_PLAN_KEYS } from './catalog.ts';
import { channel, channels, notifyUrl } from './pay/index.ts';
import type { PayAction, PayResult, PaymentRow } from './pay/types.ts';
import * as coupons from './coupons.ts';
import { pendingDirect } from './direct.ts';
import * as agents from './agents.ts';
import * as customers from './customers.ts';
import { sendMail, mailConfigured, layout, button, esc, siteUrl } from './mail.ts';
import { config } from '../config.ts';
import { startOfDay } from './stats.ts';

export type Product = { id: string; category_id: number | null; product: 'gpt' | 'x' | 'tg'; plan: string; title: string; subtitle: string; description: string; badge: string; price: number; agent_price: number; strategy_id: string; stock_limit: number | null; sold: number; reserved: number; max_per_order: number; enabled: number; sort: number };
export type Order = {
  no: string; kind: 'buy' | 'wholesale' | 'topup'; source: string; customer_id: number | null; agent_id: number | null; email: string; contact: string; query_hash: string | null; view_token: string;
  product_id: string | null; title: string; quantity: number; unit_price: number; subtotal: number; discount: number; total: number; coupon_id: number | null; cost: number;
  agent_profit: number; commission: number; status: string; pay_method: string | null; payment_id: string | null; deliver_error: string | null; deliver_attempts: number;
  ip: string | null; device: string | null; mail_status: string | null; mail_attempts: number; snap_product: string | null; snap_plan: string | null; snap_strategy: string | null; created_at: string; expires_at: string; paid_at: string | null; delivered_at: string | null;
};

/* ==================================================================
   商品
   ================================================================== */
export const getProduct = async (id: string) => await q.get<Product>('SELECT * FROM shop_products WHERE id = ?', [id]);
export const available = (p: Product) => (p.stock_limit == null ? null : Math.max(0, p.stock_limit - p.sold - p.reserved));

export async function listProducts(all = false) {
  return await q.all<Product>(`SELECT * FROM shop_products ${all ? '' : 'WHERE enabled = 1'} ORDER BY sort, created_at`);
}
export async function saveProduct(b: any, id?: string) {
  const product = String(b.product);
  if (!['gpt', 'x', 'tg'].includes(product)) throw bad('产品不正确');
  if (!planKeys(product).includes(b.plan)) throw bad('套餐不正确');
  const price = Math.round(Number(b.price) * 100), agentPrice = Math.round(Number(b.agentPrice ?? b.price) * 100);
  if (!(price > 0 && price < 1e8)) throw bad('零售价不正确');
  if (!(agentPrice > 0 && agentPrice <= price)) throw bad('代理进货价必须大于 0 且不高于零售价');
  const s = await getStrategy(String(b.strategyId));
  if (!s.prod.includes(product as any)) throw bad(`策略「${s.name}」不适用于这个产品`);
  if (product === 'gpt' && s.mode === 'own' && s.delivery === 'direct' && !GPT_DIRECT_PLAN_KEYS.includes(b.plan)) throw bad(`策略「${s.name}」是直充，不支持 ${fullPlanLabel(product, b.plan)}，买家付款后会发不出货；请选走卡台 CDK 的策略`);
  const stock = b.stockLimit === '' || b.stockLimit == null ? null : Math.max(0, Math.floor(Number(b.stockLimit)));
  const maxPer = Math.max(1, Math.min(50, Math.floor(Number(b.maxPerOrder) || 10)));
  const title = String(b.title || fullPlanLabel(product, b.plan)).trim().slice(0, 60);
  const catId = b.categoryId === '' || b.categoryId == null ? null : Number(b.categoryId);
  if (catId != null && !await q.get('SELECT 1 FROM shop_categories WHERE id = ?', [catId])) throw bad('分类不存在');
  const f = [product, b.plan, title, String(b.subtitle || '').slice(0, 80), String(b.description || '').slice(0, 2000), String(b.badge || '').slice(0, 12), price, agentPrice, s.id, stock, maxPer, b.enabled === false ? 0 : 1, Math.floor(Number(b.sort) || 0), catId];
  if (id) {
    if (!await getProduct(id)) throw notFound('商品不存在');
    await q.run('UPDATE shop_products SET product=?, plan=?, title=?, subtitle=?, description=?, badge=?, price=?, agent_price=?, strategy_id=?, stock_limit=?, max_per_order=?, enabled=?, sort=?, category_id=?, updated_at=? WHERE id=?', [...f, now(), id]);
    return (await getProduct(id))!;
  }
  const nid = 'p_' + hex(6);
  await q.run('INSERT INTO shop_products(product, plan, title, subtitle, description, badge, price, agent_price, strategy_id, stock_limit, max_per_order, enabled, sort, category_id, created_at, updated_at, id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...f, now(), now(), nid]);
  return (await getProduct(nid))!;
}
export async function deleteProduct(id: string) {
  if (await q.get('SELECT 1 FROM orders WHERE product_id = ? LIMIT 1', [id])) throw bad('这个商品已经有订单，不能删除，可以下架');
  await q.run('DELETE FROM shop_products WHERE id = ?', [id]);
}
/* ---------- 分类（两级） ---------- */
export interface Category { id: number; parent_id: number | null; name: string; icon: string; sort: number; enabled: number }
export const listCategories = async (all = false) => await q.all<Category>(`SELECT * FROM shop_categories ${all ? '' : 'WHERE enabled = 1'} ORDER BY sort, id`);
export async function saveCategory(b: any, id?: number) {
  const name = String(b.name || '').trim().slice(0, 20);
  if (!name) throw bad('分类名称必填');
  const parent = b.parentId === '' || b.parentId == null ? null : Number(b.parentId);
  if (parent != null) {
    const pc = await q.get<Category>('SELECT * FROM shop_categories WHERE id = ?', [parent]);
    if (!pc) throw bad('上级分类不存在');
    if (pc.parent_id != null) throw bad('最多两级：二级分类下面不能再建分类');
    if (id && parent === id) throw bad('不能把分类放在自己下面');
    if (id && await q.get('SELECT 1 FROM shop_categories WHERE parent_id = ?', [id])) throw bad('这个分类下面还有二级分类，不能再变成二级分类');
  }
  const f = [parent, name, String(b.icon || '').slice(0, 4), Math.floor(Number(b.sort) || 0), b.enabled === false ? 0 : 1];
  if (id) {
    if (!await q.get('SELECT 1 FROM shop_categories WHERE id = ?', [id])) throw notFound('分类不存在');
    await q.run('UPDATE shop_categories SET parent_id = ?, name = ?, icon = ?, sort = ?, enabled = ? WHERE id = ?', [...f, id]);
    return id;
  }
  return await q.insert('INSERT INTO shop_categories(parent_id, name, icon, sort, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)', [...f, now()]);
}
export async function deleteCategory(id: number) {
  if (await q.get('SELECT 1 FROM shop_categories WHERE parent_id = ?', [id])) throw bad('请先删除或移走它下面的二级分类');
  const n = (await q.get<{ n: number }>('SELECT COUNT(*) n FROM shop_products WHERE category_id = ?', [id]))!.n;
  if (n) throw bad(`还有 ${n} 个商品在这个分类里，请先把它们移到别的分类`);
  await q.run('DELETE FROM shop_categories WHERE id = ?', [id]);
}
/** 商城展示用 */
export async function publicProduct(p: Product, store?: agents.Store | null) {
  const price = store ? await agents.storePrice(store, p) : p.price;
  return { id: p.id, categoryId: p.category_id, product: p.product, plan: p.plan, title: p.title, subtitle: p.subtitle, description: p.description, badge: p.badge, price, available: available(p), maxPerOrder: p.max_per_order, soldOut: available(p) === 0 };
}

/* ==================================================================
   下单
   ================================================================== */
const orderNo = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `S${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${hex(3).toUpperCase()}`;
};
const getOrder = async (no: string) => await q.get<Order>('SELECT * FROM orders WHERE no = ?', [no]);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export interface CreateOrder {
  kind: 'buy' | 'wholesale' | 'topup';
  productId?: string; quantity?: number; amount?: number;   // topup 金额（分）
  email?: string; contact?: string; queryPassword?: string;
  customerId?: number | null;
  storeSlug?: string; ref?: string; coupon?: string;
  payMethod: string; paySub?: string;
  ip: string; device: string; mobile: boolean;
}

export async function createOrder(i: CreateOrder) {
  const shop = getSetting('shop');
  if (!shop.enabled) throw bad('商城暂停营业', 'SHOP_CLOSED');
  const cust = i.customerId ? await customers.byId(i.customerId) : null;
  const email = (cust?.email || String(i.email || '')).trim().toLowerCase();
  if (!EMAIL.test(email)) throw bad('请填写正确的邮箱，用来接收兑换码和查询订单');
  if (!cust) {
    if (!i.queryPassword || String(i.queryPassword).length < 4 || String(i.queryPassword).length > 32) throw bad('请设置 4–32 位的查询密码，用来查询订单');
  }
  const pending = (await q.get<{ n: number }>("SELECT COUNT(*) n FROM orders WHERE ip = ? AND status = 'pending' AND created_at > ?", [i.ip, new Date(Date.now() - 3600e3).toISOString()]))!.n;
  if (pending >= 10) throw new HttpError(429, '未付款的订单太多，请先完成或等待它们自动关闭', 'TOO_MANY_PENDING');

  let product: Product | undefined, quantity = 1, unit = 0, title = '', source = 'site', agentId: number | null = null, agentProfit = 0, commission = 0, discount = 0, couponId: number | null = null;
  if (i.kind === 'topup') {
    if (!cust) throw bad('请先登录再充值');
    unit = Math.round(Number(i.amount));
    if (!(unit >= 100 && unit <= 5_000_000)) throw bad('充值金额 1–50000 元');
    title = '账户余额充值'; source = 'topup';
  } else {
    product = i.productId ? await getProduct(i.productId) : undefined;
    if (!product || !product.enabled) throw bad('商品不存在或已下架');
    quantity = Math.floor(Number(i.quantity) || 1);
    if (quantity < 1 || quantity > (i.kind === 'wholesale' ? 50 : product.max_per_order)) throw bad(`每单数量 1–${i.kind === 'wholesale' ? 50 : product.max_per_order}`);
    title = product.title;
    if (i.kind === 'wholesale') {
      const ag = cust ? await agents.activeAgent(cust.id) : null;
      if (!ag) throw bad('只有已审核的代理可以批发进货');
      unit = await agents.costFor(ag, product); source = 'wholesale'; agentId = ag.customer_id;
    } else {
      const store = i.storeSlug ? await agents.storeBySlug(i.storeSlug) : null;
      if (i.storeSlug && !store) throw bad('这个店铺不存在或已停用');
      if (store) {
        unit = await agents.storePrice(store, product); source = 'store'; agentId = store.customer_id;
        agentProfit = Math.max(0, unit - await agents.costFor(store, product)) * quantity;
      } else {
        unit = product.price;
        const ref = i.ref ? await agents.storeBySlug(i.ref) : null;
        // 代理用自己的推广链接给自己买（含退出登录后用自己的邮箱下单）不计佣
        if (ref && ref.customer_id !== cust?.id && (await customers.byId(ref.customer_id))?.email !== email) { source = 'ref'; agentId = ref.customer_id; }
      }
    }
  }
  const subtotal = unit * quantity;
  if (i.coupon) {
    if (source !== 'site' && source !== 'ref') throw bad('优惠券只能在主站购买时使用');
    const c = await coupons.check(i.coupon, { productId: product?.id, subtotal, email });
    discount = c.discount; couponId = c.id;
  }
  const total = subtotal - discount;
  if (total < 1) throw bad('订单金额不正确');
  if (source === 'ref' && agentId) commission = await agents.commissionFor(agentId, total);

  // 支付方式
  const method = String(i.payMethod || '');
  if (method === 'balance') {
    if (!cust) throw bad('请先登录才能使用余额支付');
    if (i.kind === 'topup') throw bad('充值不能用余额支付');
    if (cust.balance < total) throw bad(`余额不足（还差 ${((total - cust.balance) / 100).toFixed(2)} 元），请换一种支付方式`, 'INSUFFICIENT_BALANCE');
  } else if (!channel(method)?.enabled()) throw bad('这个支付方式暂不可用');

  const no = orderNo();
  const expires = new Date(Date.now() + shop.orderExpireMin * 60e3).toISOString();
  await tx(async () => {
    if (product) {
      const r = await q.run('UPDATE shop_products SET reserved = reserved + ? WHERE id = ? AND enabled = 1 AND (stock_limit IS NULL OR sold + reserved + ? <= stock_limit)', [quantity, product.id, quantity]);
      if (!r.changes) throw bad('库存不足，请减少数量或稍后再来', 'OUT_OF_STOCK');
    }
    // 套餐和发货策略在下单时快照，之后改商品不影响已付款待发货的订单
    await q.run(`INSERT INTO orders(no, kind, source, customer_id, agent_id, email, contact, query_hash, view_token, product_id, title, quantity, unit_price, subtotal, discount, total, coupon_id, agent_profit, commission, status, pay_method, ip, device, created_at, expires_at, snap_product, snap_plan, snap_strategy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [no, i.kind, source, cust?.id ?? null, agentId, email, String(i.contact || '').slice(0, 60), cust ? null : hashPassword(String(i.queryPassword)), token(18), product?.id ?? null, title, quantity, unit, subtotal, discount, total, couponId, agentProfit, commission, method, i.ip, i.device, now(), expires,
        product?.product ?? null, product?.plan ?? null, product?.strategy_id ?? null]);
    // 在事务里复查一次：优惠券的总次数 / 每人次数，和占用写在同一个事务里，并发下单不会超发
    if (couponId) { await coupons.check(i.coupon!, { productId: product?.id, subtotal, email }); await coupons.hold(couponId, no, email); }
  });
  let pay: PayAction;
  try { pay = await startPayment(no, method, i.paySub, i.ip, i.mobile, cust?.id ?? null); }
  catch (e) { await closeOrder((await getOrder(no))!, '发起支付失败'); throw e; }  // 不留下占库存、占优惠券的孤儿订单
  return { no, token: (await getOrder(no))!.view_token, pay };
}

/**
 * 为订单创建一次支付（也用于切换支付方式）
 * payerId：当前登录的买家。订单链接（view_token）只能用来查看订单，不能授权动用账户余额，
 * 所以余额支付必须是订单所属账户本人登录后发起
 */
export async function startPayment(no: string, method: string, sub: string | undefined, ip: string, mobile: boolean, payerId: number | null): Promise<PayAction> {
  const o = await getOrder(no);
  if (!o) throw notFound('订单不存在');
  if (o.status !== 'pending') throw bad('订单不是待付款状态');
  if (o.expires_at < now()) { await closeOrder(o, '超时未付款'); throw bad('订单已超时关闭，请重新下单', 'EXPIRED'); }
  // 同一渠道还有效的支付单直接复用
  const exist = await q.get<PaymentRow>("SELECT * FROM payments WHERE order_no = ? AND method = ? AND COALESCE(sub,'') = ? AND status = 'pending' AND expires_at > ?", [no, method, sub || '', now()]);
  if (exist) return actionOf(exist);
  if (method === 'balance') {
    if (o.kind === 'topup') throw bad('充值不能用余额支付');
    if (!o.customer_id || payerId !== o.customer_id) throw new HttpError(403, '余额支付需要登录下单的账户', 'BALANCE_FORBIDDEN');
    const pid = 'P' + hex(8).toUpperCase();
    // 扣余额和入账在同一个事务里：要么都成功，要么都没发生
    const res = await tx(async () => {
      await q.run('INSERT INTO payments(id, order_no, method, amount, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [pid, no, 'balance', o.total, 'pending', now(), o.expires_at]);
      await customers.debit(o.customer_id!, o.total, 'spend', no, `订单 ${no}`);
      return applyPayment({ paymentId: pid, paid: true, tradeNo: 'balance:' + pid, amount: o.total });
    });
    afterPayment(res);
    return { type: 'done' };
  }
  const ch = channel(method);
  if (!ch?.enabled()) throw bad('这个支付方式暂不可用');
  const pid = 'P' + hex(8).toUpperCase();
  const cryptoAmount = method === 'usdt' ? await (await import('./pay/usdt.ts')).uniqueAmount(o.total) : null;
  await q.run('INSERT INTO payments(id, order_no, method, sub, amount, crypto_amount, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [pid, no, method, sub || null, o.total, cryptoAmount, 'pending', now(), o.expires_at]);
  const pay = (await q.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', [pid]))!;
  let action: PayAction;
  try {
    action = await ch.create({ payment: pay, title: o.title, notifyUrl: notifyUrl(method), returnUrl: `${config.publicUrl}/shop/order.html?no=${no}&t=${o.view_token}`, clientIp: ip, mobile });
  } catch (e: any) {
    await q.run("UPDATE payments SET status = 'closed', raw = ? WHERE id = ?", [String(e?.message || e), pid]);
    // 渠道的原始报错（密钥、网关细节）只记日志，不给买家看
    console.warn(`[pay] ${method} 下单失败 ${no}：${e?.message || e}`);
    throw bad('这个支付方式暂时不可用，请换一种支付方式或稍后再试', 'PAY_UNAVAILABLE');
  }
  await q.run('UPDATE payments SET pay_url = ?, qr = ? WHERE id = ?', [action.url ?? null, action.qr ?? (action.type === 'crypto' ? json(action) : null), pid]);
  await q.run('UPDATE orders SET pay_method = ?, payment_id = ? WHERE no = ?', [method, pid, no]);
  return action;
}
function actionOf(p: PaymentRow): PayAction {
  if (p.method === 'usdt' && p.qr) return parse<PayAction>(p.qr, { type: 'crypto' });
  if (p.qr) return { type: 'qr', qr: p.qr, url: p.pay_url ?? undefined };
  return { type: 'redirect', url: p.pay_url ?? undefined };
}

/* ==================================================================
   支付结果
   ================================================================== */
export class PayMismatch extends Error {}

/** 入账：幂等、核对金额。任何渠道的回调 / 查单最终都走这里
 *  channelKey：从哪个渠道的回调 / 查单来的，必须和支付单的渠道一致（防止一个渠道的密钥给别的渠道的单入账） */
export async function markPaid(r: PayResult, channelKey?: string) {
  if (!r.paid) return false;
  afterPayment(await tx(async () => applyPayment(r, channelKey)));
  return true;
}
function afterPayment(res: string) {
  if (res === 'dup') return;
  if (res.startsWith('overpaid:')) { console.warn(`[shop] 订单 ${res.slice(9)} 收到重复付款，需要人工退款`); return; }
  setImmediate(() => deliver(res).catch(e => console.error('[shop] deliver', res, e)));
}
/** 入账的核心逻辑（调用方负责事务）。返回 'dup' | 'overpaid:订单号' | 订单号 */
async function applyPayment(r: PayResult, channelKey?: string): Promise<string> {
  {
    const p = await q.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', [r.paymentId]);
    if (!p) throw new PayMismatch('支付单不存在');
    if (channelKey && p.method !== channelKey) throw new PayMismatch(`支付单属于 ${p.method}，不是 ${channelKey}`);
    if (p.status === 'paid' || p.status === 'overpaid') return 'dup';
    const amountOk = p.method === 'usdt' ? r.cryptoAmount === p.crypto_amount : r.amount === p.amount;
    if (!amountOk) {
      await q.run('UPDATE payments SET raw = ? WHERE id = ?', [json({ mismatch: r }), p.id]);
      throw new PayMismatch(`金额不一致：应付 ${p.method === 'usdt' ? p.crypto_amount : p.amount}，回调 ${p.method === 'usdt' ? r.cryptoAmount : r.amount}`);
    }
    if (r.tradeNo && await q.get('SELECT 1 FROM payments WHERE trade_no = ? AND id != ?', [r.tradeNo, p.id])) throw new PayMismatch('平台流水号已被其他订单使用');
    const o = (await getOrder(p.order_no))!;
    if (o.status !== 'pending' && o.status !== 'closed') {
      // 订单已经用别的支付单付过 / 已退款：钱收到了但不再发货，标记为重复付款，后台提醒人工退款
      await q.run("UPDATE payments SET status = 'overpaid', trade_no = ?, paid_at = ?, raw = ? WHERE id = ?", [r.tradeNo ?? null, now(), json(r.raw ?? null), p.id]);
      return 'overpaid:' + o.no;
    }
    await q.run("UPDATE payments SET status = 'paid', trade_no = ?, paid_at = ?, raw = ? WHERE id = ?", [r.tradeNo ?? null, now(), json(r.raw ?? null), p.id]);
    // 超时关单后才到账：钱已经收到，照样发货（重新占用库存）
    if (o.status === 'closed' && o.product_id) await q.run('UPDATE shop_products SET reserved = reserved + ? WHERE id = ?', [o.quantity, o.product_id]);
    await q.run("UPDATE orders SET status = 'paid', pay_method = ?, payment_id = ?, paid_at = ?, next_deliver_at = ? WHERE no = ?", [p.method, p.id, now(), now(), o.no]);
    if (o.coupon_id) await coupons.use(o.no);
    // 同一订单的其他待付支付单作废
    await q.run("UPDATE payments SET status = 'closed' WHERE order_no = ? AND id != ? AND status = 'pending'", [o.no, p.id]);
    return o.no;
  }
}

/* ==================================================================
   发货
   ================================================================== */
const delivering = new Set<string>();
export async function deliver(no: string) {
  if (delivering.has(no)) return;
  delivering.add(no);
  try {
    const o = await getOrder(no);
    if (!o || o.status !== 'paid') return;
    if (o.kind === 'topup') {
      await tx(async () => {
        // 状态条件更新：并发 / 多进程下只会到账一次
        if ((await q.run("UPDATE orders SET status = 'delivered', delivered_at = ?, deliver_error = NULL WHERE no = ? AND status = 'paid'", [now(), no])).changes)
          await customers.credit(o.customer_id!, o.total, 'topup', no, '余额充值');
      });
      return;
    }
    const p = await getProduct(o.product_id!);
    const spec = { product: (o.snap_product || p?.product) as Product['product'], plan: o.snap_plan || p?.plan || '', strategyId: o.snap_strategy || p?.strategy_id || '' };
    try {
      const r = await generateBatch({ ...spec, quantity: o.quantity, memo: `订单 ${no}`, idemKey: `order-${no}`, userId: 0 });
      const fx = getSetting('fx').usdCny;
      const costUsd = Number((await q.get<{ cost_usd: string | null }>('SELECT cost_usd FROM batches WHERE id = ?', [r.batchId]))?.cost_usd || 0);
      const ok = await tx(async () => {
        // 生成兑换码期间订单可能被退款：只有仍是「已付款」才落地
        if (!(await q.run("UPDATE orders SET status = 'delivered', delivered_at = ?, deliver_error = NULL, cost = ? WHERE no = ? AND status = 'paid'", [now(), Math.round(costUsd * fx * 100) * o.quantity, no])).changes) return false;
        for (const c of await q.all<{ id: string }>('SELECT id FROM codes WHERE batch_id = ?', [r.batchId])) await q.insertIgnore('INSERT INTO order_codes(order_no, code_id) VALUES (?, ?)', [no, c.id]);
        if (o.product_id) await q.run(`UPDATE shop_products SET sold = sold + ?, reserved = ${sql.greatest('0', 'reserved - ?')} WHERE id = ?`, [o.quantity, o.quantity, o.product_id]);
        await agents.creditOrder((await getOrder(no))!);
        return true;
      });
      if (!ok) {
        const ids = (await q.all<{ id: string }>('SELECT id FROM codes WHERE batch_id = ?', [r.batchId])).map(c => c.id);
        await revokeCodes(ids).catch(() => {});
        console.warn(`[shop] 订单 ${no} 在发货过程中被退款，已作废刚生成的 ${ids.length} 张码`);
        return;
      }
      mailOrder(no).catch(() => {});
    } catch (e: any) {
      const n = o.deliver_attempts + 1;
      await q.run('UPDATE orders SET deliver_error = ?, deliver_attempts = ?, next_deliver_at = ? WHERE no = ?', [String(e?.message || e).slice(0, 300), n, new Date(Date.now() + Math.min(60, 2 ** n) * 60e3).toISOString(), no]);
      console.warn(`[shop] 订单 ${no} 发货失败（第 ${n} 次）：${e?.message || e}`);
    }
  } finally { delivering.delete(no); }
}

/* ==================================================================
   关单 / 退款
   ================================================================== */
async function closeOrder(o: Order, reason: string) {
  await tx(async () => {
    const r = await q.run("UPDATE orders SET status = 'closed', closed_at = ?, deliver_error = ? WHERE no = ? AND status = 'pending'", [now(), reason, o.no]);
    if (!r.changes) return;
    if (o.product_id) await q.run(`UPDATE shop_products SET reserved = ${sql.greatest('0', 'reserved - ?')} WHERE id = ?`, [o.quantity, o.product_id]);
    if (o.coupon_id) await coupons.release(o.no);
    await q.run("UPDATE payments SET status = 'closed' WHERE order_no = ? AND status = 'pending'", [o.no]);
    // 余额支付失败不会走到这里；其他渠道未付款不涉及资金
  });
}
export async function cancelOrder(no: string, tokenOrCustomer: { token?: string; customerId?: number }) {
  const o = await access(no, tokenOrCustomer);
  if (o.status !== 'pending') throw bad('只有待付款的订单可以取消');
  await closeOrder(o, '买家取消');
}

/**
 * 退款：作废兑换码、冲回代理收益、余额支付的退回余额。
 * 有兑换码已经兑换 / 正在兑换，或是卡台 GPT 码（没有撤销接口）时，先返回 409 让管理员确认（force = true 再提交）。
 */
const refunding = new Set<string>();
export async function refund(no: string, note: string, force = false) {
  // 进程内防重：检查和占用之间不能有 await，否则并发的两次点击都会通过检查
  if (refunding.has(no)) throw bad('这个订单正在退款，请稍候刷新');
  refunding.add(no);
  try { return await doRefund(no, note, force); } finally { refunding.delete(no); }
}
async function doRefund(no: string, note: string, force: boolean) {
  const o = await getOrder(no);
  if (!o) throw notFound('订单不存在');
  if (!['paid', 'delivered'].includes(o.status)) throw bad('只有已付款的订单可以退款');
  const codes = await q.all<{ id: string; status: string; mode: string; product: string }>('SELECT c.id, c.status, c.mode, c.product FROM order_codes oc JOIN codes c ON c.id = oc.code_id WHERE oc.order_no = ?', [no]);
  // 有直充还没出结果：钱可能已经付出去了，强制退款也不行，等结果确定或人工核对后再退
  if ((await Promise.all(codes.map(c => pendingDirect(c.id)))).some(Boolean)) throw new HttpError(409, '订单里有兑换码的直充还没有结果（可能已经付款），请先在兑换记录里核对结果，再退款', 'DIRECT_PENDING');
  const used = codes.filter(c => c.status === 'redeemed' || c.status === 'in_use').length;
  const hostedGpt = codes.filter(c => c.status === 'unused' && c.mode === 'hosted' && c.product === 'gpt').length;
  if ((used || hostedGpt) && !force) {
    const why = [used && `${used} 张已经兑换或正在兑换，无法收回`, hostedGpt && `${hostedGpt} 张是卡台 GPT 码，本系统停用后在卡台官方兑换页仍可能被兑换`].filter(Boolean).join('；');
    throw new HttpError(409, `${why}。确认仍要退款吗？`, 'REFUND_CONFIRM', { used, hostedGpt });
  }
  {
    const results = codes.length ? await revokeCodes(codes.map(c => c.id)) : [];
    const done = await tx(async () => {
      // 条件更新：并发点两次退款、或退款时状态已变化，只会处理一次
      if (!(await q.run("UPDATE orders SET status = 'refunded', refunded_at = ?, refund_note = ? WHERE no = ? AND status = ?", [now(), note.slice(0, 200), no, o.status])).changes) return false;
      if (o.product_id) {
        if (o.status === 'paid') await q.run(`UPDATE shop_products SET reserved = ${sql.greatest('0', 'reserved - ?')} WHERE id = ?`, [o.quantity, o.product_id]);
        else await q.run(`UPDATE shop_products SET sold = ${sql.greatest('0', 'sold - ?')} WHERE id = ?`, [o.quantity, o.product_id]);
      }
      await agents.reverseOrder(o);
      if (o.pay_method === 'balance' && o.customer_id) await customers.credit(o.customer_id, o.total, 'refund', no, `订单 ${no} 退款`);
      if (o.kind === 'topup' && o.status === 'delivered' && o.customer_id) await customers.debit(o.customer_id, o.total, 'refund', no, '充值退款', true);
      return true;
    });
    if (!done) throw bad('订单状态已变化，请刷新后再试');
    return { redeemed: used, notRevoked: results.filter(r => !r.ok).length, manualRefund: o.pay_method !== 'balance' };
  }
}

/* ==================================================================
   后台任务
   ================================================================== */
const QUERY_AFTER = Number(process.env.SHOP_QUERY_AFTER_MS) || 20e3;
export async function tickShop() {
  // 1. 待付款订单：先主动查单（防回调丢失），过期的关单
  const pend = await q.all<PaymentRow & { o_exp: string }>("SELECT p.*, o.expires_at o_exp FROM payments p JOIN orders o ON o.no = p.order_no WHERE p.status = 'pending' AND o.status = 'pending' AND p.method NOT IN ('balance','usdt') ORDER BY p.created_at LIMIT 30");
  // 并行查单：某个渠道超时不会拖住关单和发货
  await Promise.allSettled(pend.filter(p => Date.now() - new Date(p.created_at).getTime() >= QUERY_AFTER).map(async p => {
    const ch = channel(p.method);
    if (!ch?.query) return;
    const r = await ch.query(p).catch(() => null);
    if (r?.paid) await markPaid(r, ch.key).catch(e => console.warn('[shop] 查单入账失败', p.id, e.message));
  }));
  for (const o of await q.all<Order>("SELECT * FROM orders WHERE status = 'pending' AND expires_at < ?", [now()])) await closeOrder(o, '超时未付款');
  // 2. 发货失败的重试
  for (const o of await q.all<{ no: string }>("SELECT no FROM orders WHERE status = 'paid' AND (next_deliver_at IS NULL OR next_deliver_at <= ?) LIMIT 10", [now()])) await deliver(o.no);
  // 3. 发货邮件失败的重试（最多 3 次，只重试一天内的订单）
  for (const o of await q.all<{ no: string }>("SELECT no FROM orders WHERE status = 'delivered' AND mail_status LIKE 'failed%' AND mail_attempts < 3 AND delivered_at > ? LIMIT 5", [new Date(Date.now() - 86400e3).toISOString()])) await mailOrder(o.no);
  // 4. 代理收益解冻
  await agents.unfreezeDue();
}

/* ==================================================================
   查询 / 视图
   ================================================================== */
async function access(no: string, a: { token?: string; customerId?: number }): Promise<Order> {
  const o = await getOrder(String(no || ''));
  if (!o || !((a.token && a.token === o.view_token) || (a.customerId && a.customerId === o.customer_id))) throw notFound('订单不存在');
  return o;
}
const maskEmail = (e: string) => e.replace(/^(.{1,2}).*(@.*)$/, '$1***$2');

export async function orderView(o: Order, full = true) {
  const codes = o.status === 'delivered' && full
    ? (await q.all<{ id: string; code_enc: string | null; status: string; display: string }>('SELECT c.id, c.code_enc, c.status, c.display FROM order_codes oc JOIN codes c ON c.id = oc.code_id WHERE oc.order_no = ? ORDER BY c.seq', [o.no]))
      .map(c => ({ code: decryptOpt(c.code_enc) || c.display, status: c.status }))
    : [];
  const p = o.payment_id ? await q.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', [o.payment_id]) : undefined;
  return {
    no: o.no, kind: o.kind, title: o.title, quantity: o.quantity, unitPrice: o.unit_price, subtotal: o.subtotal, discount: o.discount, total: o.total,
    status: o.status, payMethod: o.pay_method, email: maskEmail(o.email), createdAt: o.created_at, expiresAt: o.expires_at, paidAt: o.paid_at, deliveredAt: o.delivered_at,
    token: o.view_token, delivering: o.status === 'paid', deliverError: o.status === 'paid' && o.deliver_attempts > 0 ? '正在为你准备兑换码，请稍候刷新' : null,
    pay: o.status === 'pending' && p && p.status === 'pending' ? actionOf(p) : null,
    codes,
  };
}
export async function viewOrder(no: string, a: { token?: string; customerId?: number }) { return orderView(await access(no, a)); }

/** 订单号 / 邮箱 + 查询密码 */
export async function queryOrders(key: string, password: string) {
  const k = key.trim();
  const rows = k.includes('@')
    ? await q.all<Order>('SELECT * FROM orders WHERE email = ? AND customer_id IS NULL ORDER BY created_at DESC LIMIT 50', [k.toLowerCase()])
    : await q.all<Order>('SELECT * FROM orders WHERE no = ? AND customer_id IS NULL', [k.toUpperCase()]);
  // 每个订单的查询密码盐不同，要逐条算 scrypt；放到线程池里算，避免一次查询卡住支付回调和发货
  const hit = await Promise.all(rows.map(async o => (o.query_hash ? await verifyPasswordAsync(password, o.query_hash) : false)));
  const ok = rows.filter((_, i) => hit[i]);
  if (!ok.length) throw notFound('没有找到订单，请检查订单号 / 邮箱和查询密码（注册用户请登录后查看）');
  return ok.map(o => ({ no: o.no, title: o.title, quantity: o.quantity, total: o.total, status: o.status, createdAt: o.created_at, token: o.view_token }));
}

/* ==================================================================
   邮件
   ================================================================== */
export async function mailOrder(no: string) {
  const o = await getOrder(no);
  if (!o || o.status !== 'delivered' || !mailConfigured()) return false;
  const v = await orderView(o);
  const link = siteUrl(`/shop/order.html?no=${o.no}&t=${o.view_token}`);
  const rows = v.codes.map(c => `<tr><td style="padding:8px 10px;font-family:Menlo,Consolas,monospace;font-size:14px;border-bottom:1px solid #eee">${esc(c.code)}</td><td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right"><a href="${esc(siteUrl('/redeem#code=' + encodeURIComponent(c.code)))}" style="color:#5b6bff">立即兑换</a></td></tr>`).join('');
  try {
    await sendMail({
      to: o.email, ref: o.no, subject: `【${getSetting('theme').name}】订单 ${o.no} 的兑换码`,
      text: `订单 ${o.no}\n${o.title} × ${o.quantity}\n\n${v.codes.map(c => c.code).join('\n')}\n\n订单详情：${link}`,
      html: layout('你的兑换码已送达', `<p style="color:#585d82;margin:0 0 12px">${esc(o.title)} × ${o.quantity} · 订单 ${o.no}</p>
        <table style="width:100%;border-collapse:collapse;background:#f7f8fc;border-radius:10px">${rows}</table>
        <p style="color:#585d82;font-size:13px">点击「立即兑换」按提示开通即可，兑换码也可以转送给他人。</p>${button(link, '查看订单')}`),
    });
    await q.run("UPDATE orders SET mail_status = 'sent' WHERE no = ?", [no]);
    return true;
  } catch (e: any) {
    await q.run('UPDATE orders SET mail_status = ?, mail_attempts = mail_attempts + 1 WHERE no = ?', ['failed: ' + String(e?.message || e).slice(0, 100), no]);
    return false;
  }
}

/* ==================================================================
   后台
   ================================================================== */
export async function adminListOrders(f: { status?: string; kind?: string; source?: string; q?: string; agent?: number; from?: string; to?: string; page: number; size: number }) {
  const where = ['1=1'], args: any[] = [];
  if (f.agent) { where.push('o.agent_id = ?'); args.push(f.agent); }
  if (f.from) { where.push('o.created_at >= ?'); args.push(f.from); }
  if (f.to) { where.push('o.created_at < ?'); args.push(f.to); }
  if (f.status) { where.push('o.status = ?'); args.push(f.status); }
  if (f.kind) { where.push('o.kind = ?'); args.push(f.kind); }
  if (f.source) { where.push('o.source = ?'); args.push(f.source); }
  if (f.q) { where.push('(LOWER(o.no) LIKE LOWER(?) OR LOWER(o.email) LIKE LOWER(?) OR LOWER(o.contact) LIKE LOWER(?) OR LOWER(p.trade_no) LIKE LOWER(?))'); args.push(`%${f.q.toUpperCase()}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const base = `FROM orders o LEFT JOIN payments p ON p.id = o.payment_id LEFT JOIN agents a ON a.customer_id = o.agent_id WHERE ${where.join(' AND ')}`;
  const total = (await q.get<{ n: number }>(`SELECT COUNT(*) n ${base}`, args))!.n;
  const list = await q.all<any>(`SELECT o.*, p.trade_no, p.sub, a.shop_name agent_name, a.slug agent_slug ${base} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...args, f.size, (f.page - 1) * f.size]);
  const sum = await q.get<any>("SELECT COUNT(*) n, COALESCE(SUM(total), 0) amt FROM orders WHERE kind != 'topup' AND status IN ('paid','delivered') AND paid_at >= ?", [startOfDay()]);
  const attention = (await q.get<{ n: number }>("SELECT COUNT(*) n FROM orders WHERE status = 'paid'"))!.n;
  const overpaid = (await q.get<{ n: number }>("SELECT COUNT(*) n FROM payments WHERE status = 'overpaid'"))!.n;
  return { total, list: list.map(adminOrderRow), today: { count: sum.n, amount: sum.amt }, attention, overpaid };
}
function adminOrderRow(o: any) {
  return { no: o.no, kind: o.kind, source: o.source, title: o.title, quantity: o.quantity, total: o.total, discount: o.discount, status: o.status, payMethod: o.pay_method, paySub: o.sub, tradeNo: o.trade_no,
    email: o.email, contact: o.contact, agent: o.agent_id ? { id: o.agent_id, name: o.agent_name, slug: o.agent_slug } : null, agentProfit: o.agent_profit, commission: o.commission, cost: o.cost,
    deliverError: o.deliver_error, deliverAttempts: o.deliver_attempts, mailStatus: o.mail_status, createdAt: o.created_at, paidAt: o.paid_at, deliveredAt: o.delivered_at, refundNote: o.refund_note };
}
export async function adminOrderDetail(no: string) {
  const o = await q.get<any>('SELECT o.*, p.trade_no, p.sub, a.shop_name agent_name, a.slug agent_slug FROM orders o LEFT JOIN payments p ON p.id = o.payment_id LEFT JOIN agents a ON a.customer_id = o.agent_id WHERE o.no = ?', [no]);
  if (!o) throw notFound('订单不存在');
  const pays = await q.all<any>('SELECT id, method, sub, amount, crypto_amount, status, trade_no, created_at, paid_at FROM payments WHERE order_no = ? ORDER BY created_at', [no]);
  const codes = await q.all<any>('SELECT c.id, c.display, c.status, c.product, c.account, c.redeemed_at FROM order_codes oc JOIN codes c ON c.id = oc.code_id WHERE oc.order_no = ?', [no]);
  const coupon = o.coupon_id ? await q.get<any>('SELECT code, name FROM coupons WHERE id = ?', [o.coupon_id]) : null;
  return { ...adminOrderRow(o), ip: o.ip, payments: pays, codes, coupon, customerId: o.customer_id, viewLink: `/shop/order.html?no=${o.no}&t=${o.view_token}` };
}
/** 管理员手动确认收款（线下 / 渠道异常时） */
export async function adminMarkPaid(no: string, note: string) {
  const o = await getOrder(no);
  if (!o || !['pending', 'closed'].includes(o.status)) throw bad('只有待付款 / 已关闭的订单可以手动确认收款');
  const pid = 'P' + hex(8).toUpperCase();
  await q.run('INSERT INTO payments(id, order_no, method, amount, status, created_at, expires_at, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [pid, no, 'manual', o.total, 'pending', now(), now(), json({ note })]);
  await markPaid({ paymentId: pid, paid: true, tradeNo: 'manual:' + pid, amount: o.total });
}

export async function shopStats() {
  const day = startOfDay();
  const r = (await q.get<any>("SELECT COUNT(*) n, COALESCE(SUM(total),0) sales, COALESCE(SUM(cost),0) cost, COALESCE(SUM(agent_profit + commission),0) agent FROM orders WHERE kind != 'topup' AND status IN ('paid','delivered') AND paid_at >= ?", [day]))!;
  return { orders: r.n, sales: r.sales, cost: r.cost, agentShare: r.agent, profit: r.sales - r.cost - r.agent };
}

export { channels };

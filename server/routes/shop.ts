/** 商城前台、买家中心、代理中心、支付回调 */
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { body, clientIp, rateLimit, HttpError, bad, str, int } from '../http.ts';
import { q } from '../db.ts';
import { decryptOpt } from '../crypto.ts';
import * as S from '../services/shop.ts';
import * as C from '../services/customers.ts';
import * as A from '../services/agents.ts';
import * as coupons from '../services/coupons.ts';
import { channel } from '../services/pay/index.ts';
import { getSetting, publicConfig } from '../services/settings.ts';
import { mailConfigured } from '../services/mail.ts';
import { fullPlanLabel } from '../services/catalog.ts';

const CSID = 'shop_sid';
const cookieOpts = { httpOnly: true, sameSite: 'Lax' as const, secure: config.cookieSecure, path: '/', maxAge: 30 * 86400 };
const me = (c: Context) => C.fromSession(getCookie(c, CSID));
const mustMe = async (c: Context) => { const u = await me(c); if (!u) throw new HttpError(401, '请先登录', 'LOGIN_REQUIRED'); return u; };
const mustAgent = async (c: Context) => { const u = await mustMe(c); const a = await A.activeAgent(u.id); if (!a) throw new HttpError(403, '你还不是代理，或者代理资格还在审核中', 'NOT_AGENT'); return a; };
const device = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{32,40}$/i.test(v) ? v : '');
const isMobile = (c: Context) => /Mobile|Android|iPhone/i.test(c.req.header('user-agent') || '');
const json = async (c: Context) => { if (!(c.req.header('content-type') || '').includes('application/json')) throw new HttpError(415, '只接受 JSON 请求'); return body<any>(c); };

export const shop = new Hono();
shop.use('*', async (c, next) => {
  if (!rateLimit(`shop:${clientIp(c)}`, 180, 60e3)) throw new HttpError(429, '请求太频繁，请稍后再试', 'RATE_LIMITED');
  await next(); c.header('Cache-Control', 'no-store');
});

/* ---------------- 商城 ---------------- */
shop.get('/config', async c => {
  const s = getSetting('shop'), slug = c.req.query('store');
  const store = slug ? await A.storeBySlug(slug) : null;
  const u = await me(c);
  return c.json({
    ...publicConfig(),
    shop: { enabled: s.enabled, title: store ? store.shop_name : s.title, notice: store ? store.notice : s.notice, allowRegister: s.allowRegister, allowAgentApply: s.allowAgentApply, orderExpireMin: s.orderExpireMin, refDays: s.refDays, mail: mailConfigured() },
    store: store ? { slug: store.slug, name: store.shop_name, contact: store.contact } : null, storeMissing: !!slug && !store,
    payMethods: S.channels(),
    me: u ? await C.publicMe(u) : null,
  });
});
shop.get('/products', async c => {
  const store = c.req.query('store') ? await A.storeBySlug(c.req.query('store')!) : null;
  // 只返回有上架商品的分类（以及它们的上级），空分类不出现在前台
  const list = await Promise.all((await S.listProducts()).map(p => S.publicProduct(p, store)));
  const cats = await S.listCategories(), used = new Set(list.map(p => p.categoryId).filter(Boolean));
  for (const c2 of cats) if (used.has(c2.id) && c2.parent_id) used.add(c2.parent_id);
  return c.json({ list, categories: cats.filter(c2 => used.has(c2.id)).map(c2 => ({ id: c2.id, parentId: c2.parent_id, name: c2.name, icon: c2.icon })) });
});
shop.post('/coupon', async c => {
  const b = await json(c);
  if (!rateLimit(`coupon:${clientIp(c)}`, 30, 600e3)) throw new HttpError(429, '尝试次数过多', 'RATE_LIMITED');
  const p = await S.getProduct(str(b.productId, '商品'));
  if (!p) throw bad('商品不存在');
  const qty = int(Number(b.quantity || 1), '数量', 1, 50);
  const u = await me(c);
  const r = await coupons.check(str(b.code, '券码', { max: 40 }), { productId: p.id, subtotal: p.price * qty, email: (u?.email || String(b.email || '')).toLowerCase() });
  return c.json({ discount: r.discount, name: r.name });
});
shop.post('/orders', async c => {
  const b = await json(c);
  if (!rateLimit(`order:${clientIp(c)}`, 20, 600e3)) throw new HttpError(429, '下单太频繁，请稍后再试', 'RATE_LIMITED');
  const u = await me(c);
  return c.json(await S.createOrder({
    kind: 'buy', productId: str(b.productId, '商品'), quantity: Number(b.quantity || 1), email: b.email, contact: b.contact, queryPassword: b.queryPassword,
    customerId: u?.id ?? null, storeSlug: b.store || undefined, ref: b.ref || undefined, coupon: b.coupon || undefined,
    payMethod: str(b.payMethod, '支付方式'), paySub: b.paySub || undefined, ip: clientIp(c), device: device(b.device), mobile: isMobile(c),
  }));
});
shop.get('/orders/:no', async c => c.json(await S.viewOrder(c.req.param('no'), { token: c.req.query('t'), customerId: (await me(c))?.id })));
shop.post('/orders/:no/pay', async c => {
  const b = await json(c);
  await S.viewOrder(c.req.param('no'), { token: b.t, customerId: (await me(c))?.id }); // 校验访问权限
  return c.json({ pay: await S.startPayment(c.req.param('no'), str(b.payMethod, '支付方式'), b.paySub || undefined, clientIp(c), isMobile(c), (await me(c))?.id ?? null) });
});
shop.post('/orders/:no/cancel', async c => { const b = await json(c); await S.cancelOrder(c.req.param('no'), { token: b.t, customerId: (await me(c))?.id }); return c.json({ ok: true }); });
shop.post('/query', async c => {
  const b = await json(c);
  if (!rateLimit(`query:${clientIp(c)}`, 20, 3600e3)) throw new HttpError(429, '查询次数过多，请一小时后再试', 'RATE_LIMITED');
  return c.json({ list: await S.queryOrders(str(b.key, '订单号或邮箱', { max: 200 }), String(b.password || '')) });
});

/* ---------------- 买家账户 ---------------- */
shop.post('/account/register', async c => {
  const b = await json(c);
  if (!rateLimit(`reg:${clientIp(c)}`, 5, 3600e3)) throw new HttpError(429, '注册太频繁', 'RATE_LIMITED');
  await C.register(str(b.email, '邮箱', { max: 200 }), String(b.password || ''), String(b.name || ''));
  setCookie(c, CSID, await C.login(b.email, b.password), cookieOpts);
  return c.json({ me: await C.publicMe((await C.byEmail(b.email))!) });
});
shop.post('/account/login', async c => {
  const b = await json(c);
  if (!rateLimit(`clogin:${clientIp(c)}`, 10, 900e3)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试', 'RATE_LIMITED');
  setCookie(c, CSID, await C.login(str(b.email, '邮箱'), String(b.password || '')), cookieOpts);
  return c.json({ me: await C.publicMe((await C.byEmail(b.email))!) });
});
shop.post('/account/logout', async c => { await C.logout(getCookie(c, CSID)); deleteCookie(c, CSID, { path: '/' }); return c.json({ ok: true }); });
shop.get('/account/me', async c => { const u = await me(c); return c.json({ me: u ? await C.publicMe(u) : null }); });
shop.post('/account/reset/send', async c => {
  const b = await json(c);
  if (!rateLimit(`reset:${clientIp(c)}`, 5, 3600e3)) throw new HttpError(429, '发送太频繁', 'RATE_LIMITED');
  const email = str(b.email, '邮箱').toLowerCase();
  if (!rateLimit(`reset-mail:${email}`, 3, 3600e3)) throw new HttpError(429, '这个邮箱发送太频繁，请一小时后再试', 'RATE_LIMITED');
  await C.sendReset(email);
  return c.json({ ok: true, mail: mailConfigured() });
});
shop.post('/account/reset', async c => { const b = await json(c); await C.resetPassword(str(b.email, '邮箱'), String(b.code || ''), String(b.password || '')); return c.json({ ok: true }); });
shop.post('/account/password', async c => { const b = await json(c); await C.changePassword((await mustMe(c)).id, String(b.oldPassword || ''), String(b.newPassword || '')); return c.json({ ok: true }); });
shop.get('/account/orders', async c => {
  const u = await mustMe(c);
  return c.json({ list: (await q.all<any>("SELECT no, kind, title, quantity, total, status, created_at, view_token FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100", [u.id])).map(o => ({ ...o, token: o.view_token, view_token: undefined })) });
});
shop.get('/account/ledger', async c => c.json({ list: await C.ledgerOf((await mustMe(c)).id) }));
shop.post('/account/topup', async c => {
  const u = await mustMe(c), b = await json(c);
  return c.json(await S.createOrder({ kind: 'topup', amount: Math.round(Number(b.amount) * 100), customerId: u.id, payMethod: str(b.payMethod, '支付方式'), paySub: b.paySub || undefined, ip: clientIp(c), device: device(b.device), mobile: isMobile(c) }));
});

/* ---------------- 代理中心 ---------------- */
shop.post('/agent/apply', async c => { const u = await mustMe(c); await A.apply(u.id, await json(c)); return c.json({ ok: true }); });
shop.get('/agent/dashboard', async c => {
  const u = await mustMe(c), a = await A.byCustomer(u.id);
  if (!a) return c.json({ agent: null });
  if (a.status !== 'active') return c.json({ agent: { status: a.status, slug: a.slug, shopName: a.shop_name } });
  return c.json(await A.dashboard(a));
});
shop.put('/agent/store', async c => { await A.updateStore(await mustAgent(c), await json(c)); return c.json({ ok: true }); });
shop.get('/agent/products', async c => {
  const a = await mustAgent(c);
  return c.json({ list: await Promise.all((await S.listProducts()).map(async p => ({ ...await S.publicProduct(p), sitePrice: p.price, cost: await A.costFor(a, p), myPrice: await A.storePrice(a, p), custom: !!await q.get('SELECT 1 FROM agent_prices WHERE agent_id = ? AND product_id = ?', [a.customer_id, p.id]) }))) });
});
shop.put('/agent/prices/:id', async c => {
  const a = await mustAgent(c), p = await S.getProduct(c.req.param('id'));
  if (!p) throw bad('商品不存在');
  const b = await json(c);
  await A.setPrice(a, p, b.price === null || b.price === '' ? null : Math.round(Number(b.price) * 100));
  return c.json({ ok: true });
});
shop.get('/agent/orders', async c => c.json({ list: await A.agentOrders(await mustAgent(c)) }));
shop.get('/agent/ledger', async c => c.json({ list: await A.agentLedger(await mustAgent(c)) }));
shop.get('/agent/withdrawals', async c => c.json({ list: await A.agentWithdrawals(await mustAgent(c)) }));
shop.post('/agent/withdrawals', async c => { const b = await json(c); return c.json({ id: await A.requestWithdraw(await mustAgent(c), { ...b, amount: Math.round(Number(b.amount) * 100) }) }); });
shop.post('/agent/to-balance', async c => { const b = await json(c); await A.earningsToBalance(await mustAgent(c), Math.round(Number(b.amount) * 100), C.credit); return c.json({ ok: true }); });
shop.post('/agent/wholesale', async c => {
  const a = await mustAgent(c), b = await json(c);
  return c.json(await S.createOrder({ kind: 'wholesale', productId: str(b.productId, '商品'), quantity: Number(b.quantity || 1), customerId: a.customer_id, payMethod: str(b.payMethod, '支付方式'), paySub: b.paySub || undefined, ip: clientIp(c), device: device(b.device), mobile: isMobile(c) }));
});
shop.get('/agent/stock', async c => {
  const a = await mustAgent(c);
  return c.json({ list: (await q.all<any>(`SELECT c.id, c.code_enc, c.display, c.status, c.product, c.plan, o.no, o.created_at FROM orders o JOIN order_codes oc ON oc.order_no = o.no JOIN codes c ON c.id = oc.code_id
    WHERE o.agent_id = ? AND o.kind = 'wholesale' AND o.status = 'delivered' ORDER BY o.created_at DESC, c.seq LIMIT 2000`, [a.customer_id])).map(r => ({ id: r.id, code: decryptOpt(r.code_enc) || r.display, status: r.status, product: r.product, plan: r.plan, planLabel: fullPlanLabel(r.product, r.plan), orderNo: r.no, at: r.created_at })) });
});

/* ---------------- 支付回调（不限流、不要求 JSON；只认验签） ---------------- */
export const payNotify = new Hono();
payNotify.all('/:key', async c => {
  const ch = channel(c.req.param('key'));
  if (!ch) return c.text('unknown channel', 404);
  const raw = c.req.method === 'POST' ? await c.req.text() : '';
  const headers = Object.fromEntries([...c.req.raw.headers].map(([k, v]) => [k.toLowerCase(), v]));
  const { result, response } = await ch.notify({ method: c.req.method, query: c.req.query(), body: raw, headers });
  if (result?.paid) {
    try { await S.markPaid(result, ch.key); }
    catch (e) {
      console.warn(`[pay] ${ch.key} 回调入账被拒：${e instanceof Error ? e.message : e}`);
      // 金额或流水号不一致：不回成功，让平台重试并留下记录，等人工核对
      return c.text('fail', 400);
    }
  }
  return c.body(response.body, response.status as any, { 'Content-Type': response.type || 'text/plain; charset=utf-8' });
});

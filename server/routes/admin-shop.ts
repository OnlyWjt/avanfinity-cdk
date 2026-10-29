/** 后台：商品、商城订单、优惠券、代理、客户、支付 / 邮件 / 商城设置 */
import { Hono } from 'hono';
import { type AppEnv, requireRole, audit, body, bad, str, int } from '../http.ts';
import { encryptOpt } from '../crypto.ts';
import * as S from '../services/shop.ts';
import * as coupons from '../services/coupons.ts';
import * as A from '../services/agents.ts';
import * as C from '../services/customers.ts';
import { getSetting, setSetting, type PaySettings } from '../services/settings.ts';
import { sendMail, layout } from '../services/mail.ts';
import { allChannels } from '../services/pay/index.ts';
import { q } from '../db.ts';
import { config, publicUrlOk } from '../config.ts';

export const adminShop = new Hono<AppEnv>();
const page = (v?: string) => Math.max(1, Number(v) || 1);
const size = (v?: string, d = 30) => Math.max(1, Math.min(200, Number(v) || d));
const yuan = (n: number) => (n / 100).toFixed(2);

/* ---------------- 商品 ---------------- */
adminShop.get('/products', requireRole('support'), c => c.json({ list: S.listProducts(true).map(p => ({ ...p, available: S.available(p) })) }));
adminShop.post('/products', requireRole('admin'), async c => { const p = S.saveProduct(await body(c)); audit(c, 'shop.product.create', p.title, p.id); return c.json(p); });
adminShop.put('/products/:id', requireRole('admin'), async c => { const p = S.saveProduct(await body(c), c.req.param('id')); audit(c, 'shop.product.update', p.title, { price: yuan(p.price), agentPrice: yuan(p.agent_price), enabled: p.enabled }); return c.json(p); });
adminShop.delete('/products/:id', requireRole('admin'), c => { S.deleteProduct(c.req.param('id')); audit(c, 'shop.product.delete', c.req.param('id')); return c.json({ ok: true }); });

adminShop.get('/categories', requireRole('support'), c => c.json({ list: S.listCategories(true).map(x => ({ ...x, products: q.get<{ n: number }>('SELECT COUNT(*) n FROM shop_products WHERE category_id = ?', [x.id])!.n })) }));
adminShop.post('/categories', requireRole('admin'), async c => { const b = await body(c); const id = S.saveCategory(b); audit(c, 'shop.category.create', b.name, id); return c.json({ id }); });
adminShop.put('/categories/:id', requireRole('admin'), async c => { const b = await body(c); S.saveCategory(b, Number(c.req.param('id'))); audit(c, 'shop.category.update', b.name, c.req.param('id')); return c.json({ ok: true }); });
adminShop.delete('/categories/:id', requireRole('admin'), c => { S.deleteCategory(Number(c.req.param('id'))); audit(c, 'shop.category.delete', c.req.param('id')); return c.json({ ok: true }); });

/* ---------------- 订单 ---------------- */
const orderFilter = (c: any) => ({ status: c.req.query('status'), kind: c.req.query('kind'), source: c.req.query('source'), q: c.req.query('q'), agent: Number(c.req.query('agent')) || undefined, from: c.req.query('from') || undefined, to: c.req.query('to') || undefined });
adminShop.get('/orders', requireRole('support'), c => c.json(S.adminListOrders({ ...orderFilter(c), page: page(c.req.query('page')), size: size(c.req.query('size')) })));
/** 导出当前筛选条件下的全部订单（最多 1 万条） */
adminShop.get('/orders/export', requireRole('operator'), c => {
  const r = S.adminListOrders({ ...orderFilter(c), page: 1, size: 10000 });
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const ST: Record<string, string> = { pending: '待付款', paid: '待发货', delivered: '已完成', closed: '已关闭', refunded: '已退款' };
  const head = ['订单号', '类型', '来源', '代理', '商品', '数量', '金额', '优惠', '成本', '代理分成', '状态', '支付方式', '支付流水号', '邮箱', '联系方式', '下单时间', '付款时间', '发货时间'];
  const rows = r.list.map(o => [o.no, o.kind, o.source, o.agent?.name || '', o.title, o.quantity, (o.total / 100).toFixed(2), (o.discount / 100).toFixed(2), (o.cost / 100).toFixed(2), ((o.agentProfit + o.commission) / 100).toFixed(2), ST[o.status] || o.status, o.payMethod || '', o.tradeNo || '', o.email, o.contact, o.createdAt, o.paidAt || '', o.deliveredAt || ''].map(cell).join(','));
  audit(c, 'shop.order.export', '', { n: rows.length });
  return c.body('﻿' + [head.join(','), ...rows].join('\n'), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="shop-orders-${new Date().toISOString().slice(0, 10)}.csv"` });
});
adminShop.get('/orders/:no', requireRole('support'), c => c.json(S.adminOrderDetail(c.req.param('no'))));
adminShop.post('/orders/:no/:action{deliver|refund|mail|paid}', requireRole('operator'), async c => {
  const no = c.req.param('no'), action = c.req.param('action');
  const b = await c.req.json().catch(() => ({}));
  if (action === 'deliver') { q.run("UPDATE orders SET next_deliver_at = NULL WHERE no = ? AND status = 'paid'", [no]); await S.deliver(no); }
  if (action === 'mail' && !(await S.mailOrder(no))) throw bad('邮件发送失败，请检查邮件设置，或订单还没发货');
  if (action === 'paid') { await S.adminMarkPaid(no, String(b.note || '')); }
  let extra = {};
  if (action === 'refund') extra = await S.refund(no, str(b.note, '退款说明', { min: 1, max: 200 }), b.force === true);
  audit(c, `shop.order.${action}`, no, b.note || '');
  return c.json({ ok: true, ...extra });
});

/* ---------------- 优惠券 ---------------- */
adminShop.get('/coupons', requireRole('support'), c => c.json({ list: coupons.list() }));
adminShop.post('/coupons', requireRole('admin'), async c => { const b = await body(c); const id = coupons.save(b); audit(c, 'shop.coupon.create', b.code); return c.json({ id }); });
adminShop.put('/coupons/:id', requireRole('admin'), async c => { const b = await body(c); coupons.save(b, Number(c.req.param('id'))); audit(c, 'shop.coupon.update', b.code); return c.json({ ok: true }); });
adminShop.delete('/coupons/:id', requireRole('admin'), c => { coupons.remove(Number(c.req.param('id'))); audit(c, 'shop.coupon.delete', c.req.param('id')); return c.json({ ok: true }); });

/* ---------------- 代理 ---------------- */
adminShop.get('/agents', requireRole('support'), c => c.json({ ...A.adminList({ status: c.req.query('status'), q: c.req.query('q'), page: page(c.req.query('page')), size: size(c.req.query('size'), 30) }), levels: A.levels() }));
adminShop.post('/agents/:id/:action{approve|reject|disable|enable}', requireRole('admin'), async c => {
  const b = await c.req.json().catch(() => ({}));
  A.adminReview(Number(c.req.param('id')), c.req.param('action') as any, b.levelId ? Number(b.levelId) : undefined);
  audit(c, `shop.agent.${c.req.param('action')}`, c.req.param('id'));
  return c.json({ ok: true });
});
adminShop.put('/agents/:id/level', requireRole('admin'), async c => { const b = await body(c); A.adminSetLevel(Number(c.req.param('id')), Number(b.levelId)); audit(c, 'shop.agent.level', c.req.param('id'), b.levelId); return c.json({ ok: true }); });
adminShop.get('/levels', requireRole('support'), c => c.json({ list: A.levels() }));
adminShop.post('/levels', requireRole('admin'), async c => { const b = await body(c); const id = A.saveLevel(b); audit(c, 'shop.level.create', b.name, id); return c.json({ id }); });
adminShop.put('/levels/:id', requireRole('admin'), async c => { const b = await body(c); const id = A.saveLevel(b, Number(c.req.param('id'))); audit(c, 'shop.level.update', b.name, id); return c.json({ id }); });
adminShop.delete('/levels/:id', requireRole('admin'), c => { A.deleteLevel(Number(c.req.param('id'))); audit(c, 'shop.level.delete', c.req.param('id')); return c.json({ ok: true }); });
adminShop.get('/withdrawals', requireRole('support'), c => c.json({ list: A.adminWithdrawals(c.req.query('status')) }));
adminShop.post('/withdrawals/:id/:action{paid|rejected}', requireRole('admin'), async c => {
  const b = await c.req.json().catch(() => ({}));
  A.processWithdraw(Number(c.req.param('id')), c.req.param('action') as any, String(b.note || ''), c.get('user').name);
  audit(c, `shop.withdraw.${c.req.param('action')}`, c.req.param('id'), b.note || '');
  return c.json({ ok: true });
});

/* ---------------- 客户 ---------------- */
adminShop.get('/customers', requireRole('support'), c => c.json(C.adminList({ q: c.req.query('q'), type: c.req.query('type'), page: page(c.req.query('page')), size: size(c.req.query('size')) })));
adminShop.get('/customers/:id', requireRole('support'), c => {
  const id = Number(c.req.param('id')), u = C.byId(id);
  if (!u) throw bad('客户不存在');
  return c.json({
    customer: { id: u.id, email: u.email, name: u.name, balance: u.balance, disabled: !!u.disabled, createdAt: u.created_at },
    orders: q.all('SELECT no, kind, title, quantity, total, status, created_at FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 30', [id]),
    ledger: C.ledgerOf(id, 30),
    agent: q.get<any>('SELECT a.slug, a.shop_name shopName, a.status, a.earnings, a.frozen, l.name levelName FROM agents a LEFT JOIN agent_levels l ON l.id = a.level_id WHERE a.customer_id = ?', [id]) || null,
  });
});
adminShop.post('/customers', requireRole('admin'), async c => {
  const b = await body(c);
  // 先校验代理信息，避免客户建好了代理却建不了
  if (b.agent) { const slug = String(b.agent.slug || '').trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9-]{2,23}$/.test(slug)) throw bad('店铺地址 3–24 位小写字母、数字或横线'); if (q.get('SELECT 1 FROM agents WHERE slug = ?', [slug])) throw bad('这个店铺地址已被使用'); if (!String(b.agent.shopName || '').trim()) throw bad('请填写店铺名称'); }
  const id = C.adminCreate(str(b.email, '邮箱', { max: 200 }), String(b.password || ''), String(b.name || ''));
  const bal = Math.round(Number(b.balance || 0) * 100);
  if (bal > 0) C.adminAdjust(id, bal, String(b.note || '开户赠送'));
  if (b.agent) A.adminMake(id, { slug: b.agent.slug, shopName: b.agent.shopName, levelId: b.agent.levelId ? Number(b.agent.levelId) : undefined });
  audit(c, 'shop.customer.create', b.email, { balance: b.balance || 0 });
  return c.json({ id });
});
adminShop.post('/customers/:id/agent', requireRole('admin'), async c => {
  const b = await body(c), id = Number(c.req.param('id'));
  if (!C.byId(id)) throw bad('客户不存在');
  A.adminMake(id, { slug: b.slug, shopName: b.shopName, contact: b.contact, levelId: b.levelId ? Number(b.levelId) : undefined });
  audit(c, 'shop.agent.make', String(id), { slug: b.slug });
  return c.json({ ok: true });
});
adminShop.post('/customers/:id/password', requireRole('admin'), async c => {
  const b = await body(c);
  C.adminSetPassword(Number(c.req.param('id')), String(b.password || ''));
  audit(c, 'shop.customer.password', c.req.param('id'));
  return c.json({ ok: true });
});
adminShop.post('/customers/:id/adjust', requireRole('admin'), async c => {
  const b = await body(c);
  C.adminAdjust(Number(c.req.param('id')), Math.round(Number(b.amount) * 100), String(b.note || ''));
  audit(c, 'shop.customer.adjust', c.req.param('id'), { amount: b.amount, note: b.note });
  return c.json({ ok: true });
});
adminShop.post('/customers/:id/disable', requireRole('admin'), async c => {
  const b = await body(c);
  q.run('UPDATE customers SET disabled = ? WHERE id = ?', [b.disabled ? 1 : 0, Number(c.req.param('id'))]);
  if (b.disabled) q.run('DELETE FROM customer_sessions WHERE customer_id = ?', [Number(c.req.param('id'))]);
  audit(c, b.disabled ? 'shop.customer.disable' : 'shop.customer.enable', c.req.param('id'));
  return c.json({ ok: true });
});

/* ---------------- 设置 ---------------- */
adminShop.get('/settings', requireRole('admin'), c => {
  const p = getSetting('pay'), m = getSetting('mail');
  const strip = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => k.endsWith('Enc') ? [k.replace(/Enc$/, 'Set'), !!v] : [k, v]));
  return c.json({
    shop: getSetting('shop'), mail: strip(m),
    pay: { epay: strip(p.epay), usdt: strip(p.usdt), alipay: strip(p.alipay), wechat: strip(p.wechat) },
    channels: allChannels.map(ch => ({ key: ch.key, ready: ch.enabled() })),
    publicUrl: config.publicUrl, publicUrlOk: publicUrlOk(),
  });
});
adminShop.put('/settings/shop', requireRole('admin'), async c => {
  const b = await body(c), s = getSetting('shop');
  setSetting('shop', {
    enabled: b.enabled ?? s.enabled, homepage: b.homepage === 'shop' ? 'shop' : 'redeem', title: str(b.title ?? s.title, '商城名称', { min: 1, max: 30 }), notice: str(b.notice ?? s.notice, '公告', { opt: true, max: 500 }),
    orderExpireMin: int(Number(b.orderExpireMin ?? s.orderExpireMin), '订单有效期', 5, 120), freezeDays: int(Number(b.freezeDays ?? s.freezeDays), '冻结天数', 0, 60),
    minWithdraw: int(Math.round(Number(b.minWithdraw ?? s.minWithdraw / 100) * 100), '最低提现金额', 1, 100_000_00), refDays: int(Number(b.refDays ?? s.refDays), '推广归因天数', 1, 365),
    allowAgentApply: !!(b.allowAgentApply ?? s.allowAgentApply), allowRegister: !!(b.allowRegister ?? s.allowRegister),
  });
  audit(c, 'settings.shop'); return c.json({ ok: true });
});
/** 支付渠道：Enc 字段只在提交了新值时更新；传空字符串表示清除 */
adminShop.put('/settings/pay/:ch{epay|usdt|alipay|wechat}', requireRole('admin'), async c => {
  const ch = c.req.param('ch') as keyof PaySettings, b = await body<any>(c), all = getSetting('pay');
  const cur: any = { ...all[ch] };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'enabled') cur.enabled = !!v;
    else if (`${k}Enc` in cur) { if (v === '') cur[`${k}Enc`] = null; else if (v) cur[`${k}Enc`] = encryptOpt(String(v).trim()); }
    else if (k in cur) cur[k] = typeof cur[k] === 'number' ? Number(v) : Array.isArray(cur[k]) ? (Array.isArray(v) ? v.map(String) : String(v).split(/[,，\s]+/).filter(Boolean)) : String(v).trim();
  }
  if (ch === 'usdt' && cur.address && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(cur.address)) throw bad('TRC20 地址格式不正确（T 开头 34 位）');
  if (ch === 'usdt' && !(cur.rate > 0 && cur.rate < 100)) throw bad('汇率不正确');
  if (ch === 'alipay' && !['precreate', 'page'].includes(cur.mode)) cur.mode = 'precreate';
  setSetting('pay', { ...all, [ch]: cur });
  audit(c, `settings.pay.${ch}`, '', { enabled: cur.enabled });
  return c.json({ ok: true, ready: allChannels.find(x => x.key === ch)!.enabled() });
});
adminShop.put('/settings/mail', requireRole('admin'), async c => {
  const b = await body(c), m = getSetting('mail');
  setSetting('mail', {
    enabled: !!(b.enabled ?? m.enabled), host: str(b.host ?? m.host, 'SMTP 服务器', { opt: true, max: 100 }), port: int(Number(b.port ?? m.port), '端口', 1, 65535), secure: !!(b.secure ?? m.secure),
    user: str(b.user ?? m.user, '账号', { opt: true, max: 200 }), passEnc: b.pass === '' ? null : b.pass ? encryptOpt(String(b.pass)) : m.passEnc,
    from: str(b.from ?? m.from, '发件人', { opt: true, max: 200 }), fromName: str(b.fromName ?? m.fromName, '发件人名称', { opt: true, max: 40 }),
  });
  audit(c, 'settings.mail'); return c.json({ ok: true });
});
adminShop.post('/settings/mail/test', requireRole('admin'), async c => {
  const b = await body(c);
  try { await sendMail({ to: str(b.to, '收件邮箱'), subject: '邮件发送测试', text: '如果你收到这封邮件，说明 SMTP 配置正确。', html: layout('邮件发送测试', '<p>如果你收到这封邮件，说明 SMTP 配置正确。</p>') }); }
  catch (e) { throw bad(`发送失败：${e instanceof Error ? e.message : e}`); }
  return c.json({ ok: true });
});
adminShop.get('/stats', requireRole('support'), c => c.json(S.shopStats()));
/** 总览页用：商城今日数据 + 需要处理的事项 */
adminShop.get('/summary', requireRole('support'), c => c.json({
  enabled: getSetting('shop').enabled,
  products: q.get<{ n: number }>('SELECT COUNT(*) n FROM shop_products WHERE enabled = 1')!.n,
  today: S.shopStats(),
  undelivered: q.get<{ n: number }>("SELECT COUNT(*) n FROM orders WHERE status = 'paid'")!.n,
  overpaid: q.get<{ n: number }>("SELECT COUNT(*) n FROM payments WHERE status = 'overpaid'")!.n,
  agentApply: q.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE status = 'pending'")!.n,
  withdrawals: q.get<{ n: number; s: number }>("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM withdrawals WHERE status = 'pending'")!,
  channels: allChannels.filter(ch => ch.enabled()).length,
}));
adminShop.get('/mail-log', requireRole('admin'), c => c.json({ list: q.all('SELECT * FROM mail_log ORDER BY id DESC LIMIT 100') }));


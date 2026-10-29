import { Hono } from 'hono';
import { q, now, parse } from '../db.ts';
import { type AppEnv, requireRole, audit, body, bad, notFound, str, int, oneOf, HttpError } from '../http.ts';
import { lookupHash, normalizeCode, webhookSignature, hex } from '../crypto.ts';
import { config } from '../config.ts';
import { avan, AvanError } from '../avan/client.ts';
import * as S from '../services/strategy.ts';
import * as B from '../services/batches.ts';
import * as R from '../services/redeem.ts';
import * as W from '../services/webhook.ts';
import * as ST from '../services/stats.ts';
import { getSetting, setSetting, patchSetting, avanCredentials, saveAvanCredentials, mask } from '../services/settings.ts';
import { gptOffers, gptSalePrice, catalogUsd, socialPlans, invalidateCatalog, fullPlanLabel, planKeys, isCredits } from '../services/catalog.ts';
import { createUser } from '../services/auth.ts';
import { encryptOpt } from '../crypto.ts';
import { sendTelegram, dailyReportText } from '../services/notify.ts';

export const admin = new Hono<AppEnv>();
const page = (v: string | undefined) => Math.max(1, Math.min(100000, Number(v) || 1));
const size = (v: string | undefined, def = 20) => Math.max(1, Math.min(200, Number(v) || def));
const PRODUCTS = ['gpt', 'x', 'tg'] as const;

/* ================= 总览 / 搜索 ================= */
admin.get('/overview', requireRole('support'), async c => c.json(await ST.overview()));
admin.get('/insights', requireRole('support'), async c => c.json(await ST.insights(int(c.req.query('days') || '7', 'days', 1, 90))));

admin.get('/search', requireRole('support'), async c => {
  const s = (c.req.query('q') || '').trim();
  if (!s) return c.json({ list: [] });
  const like = `%${s.toUpperCase().slice(0, 14)}%`;
  const codes = await q.all<any>('SELECT id, product, plan, display, status FROM codes WHERE LOWER(display) LIKE LOWER(?) OR code_hash = ? OR LOWER(account) LIKE LOWER(?) LIMIT 8', [like, lookupHash(normalizeCode(s)), `%${s}%`]);
  const reds = await q.all<any>('SELECT id, product, plan, account, status FROM redemptions WHERE LOWER(id) LIKE LOWER(?) OR LOWER(account) LIKE LOWER(?) ORDER BY created_at DESC LIMIT 8', [`%${s.toLowerCase()}%`, `%${s}%`]);
  const strategies = await q.all<any>('SELECT id, name FROM strategies WHERE LOWER(name) LIKE LOWER(?) LIMIT 5', [`%${s}%`]);
  const orders = await q.all<any>('SELECT no, title, quantity, total, status, email FROM orders WHERE LOWER(no) LIKE LOWER(?) OR LOWER(email) LIKE LOWER(?) OR LOWER(contact) LIKE LOWER(?) ORDER BY created_at DESC LIMIT 6', [like, `%${s.toLowerCase()}%`, `%${s}%`]);
  const customers = await q.all<any>('SELECT id, email, name, balance FROM customers WHERE LOWER(email) LIKE LOWER(?) OR LOWER(name) LIKE LOWER(?) LIMIT 5', [`%${s.toLowerCase()}%`, `%${s}%`]);
  return c.json({ list: [
    ...codes.map(x => ({ kind: 'code', id: x.id, product: x.product, label: x.display, sub: `${fullPlanLabel(x.product, x.plan)} · ${x.status}` })),
    ...reds.map(x => ({ kind: 'redemption', id: x.id, product: x.product, label: `${x.id} · ${x.account || '—'}`, sub: `${fullPlanLabel(x.product, x.plan)} · ${x.status}` })),
    ...strategies.map(x => ({ kind: 'strategy', id: x.id, label: x.name, sub: '兑换策略' })),
    ...orders.map(x => ({ kind: 'order', id: x.no, label: `${x.no} · ${x.title} × ${x.quantity}`, sub: `商城订单 · ¥${(x.total / 100).toFixed(2)} · ${x.email}` })),
    ...customers.map(x => ({ kind: 'customer', id: x.id, label: x.email, sub: `客户${x.name ? ' · ' + x.name : ''} · 余额 ¥${(x.balance / 100).toFixed(2)}` })),
  ] });
});

/* ================= CDK ================= */
admin.get('/codes/stats', requireRole('support'), async c => c.json(await B.codeStats()));
admin.get('/codes', requireRole('support'), async c => {
  const product = oneOf(c.req.query('product') || 'gpt', 'product', PRODUCTS);
  return c.json(await B.listCodes({ product, status: c.req.query('status'), plan: c.req.query('plan'), strategy: c.req.query('strategy'), q: c.req.query('q'), page: page(c.req.query('page')), size: size(c.req.query('size')) }));
});
admin.get('/codes/:id', requireRole('support'), async c => c.json(await B.codeDetail(c.req.param('id'))));
admin.post('/codes/export', requireRole('operator'), async c => {
  const { ids } = await body<{ ids: string[] }>(c);
  if (!Array.isArray(ids)) throw bad('ids 必须是数组');
  const out = await B.exportCodes(ids);
  await audit(c, 'cdk.export', `${out.length} 张`, ids.slice(0, 20).join(','));
  return c.json({ list: out });
});
admin.post('/codes/revoke', requireRole('operator'), async c => {
  const { ids } = await body<{ ids: string[] }>(c);
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw bad('一次撤销 1–500 张');
  const results = await B.revokeCodes(ids);
  await audit(c, 'cdk.revoke', `${results.filter(r => r.ok).length}/${ids.length} 张`, ids.slice(0, 20).join(','));
  return c.json({ results });
});

admin.get('/catalog', requireRole('support'), async c => {
  const [offers, xp, tp] = await Promise.all([gptOffers(), socialPlans('x'), socialPlans('tg')]);
  // 点数没有 CDK 售价和库存（兑换时按点数报价扣费）：成本按套餐目录估算，能估出来就算可生成
  const gpt = await Promise.all(planKeys('gpt').map(async k => {
    const o = offers.val?.find(x => x.plan === k);
    // fee：服务费，自定义点数在页面上按「单价 × 点数 + 服务费」估算，和后端 gptSalePrice 的算法一致
    if (isCredits(k) && !o?.salePrice) { const est = await gptSalePrice(k); return { key: k, label: fullPlanLabel('gpt', k), credits: true, enabled: est != null, cost: est, fee: (await catalogUsd(k))?.fee ?? 0, stock: null, status: est != null ? 'ESTIMATE' : 'WAITING_QUOTE' }; }
    return { key: k, label: fullPlanLabel('gpt', k), credits: isCredits(k), enabled: !!o?.enabled, cost: o?.salePrice ? Number(o.salePrice) : null, stock: o?.stock ?? null, status: o?.pricingStatus ?? null };
  }));
  return c.json({
    gpt,
    x: planKeys('x').map(k => { const p = xp.val?.plans.find(x => x.key === k); return { key: k, label: fullPlanLabel('x', k), enabled: p?.enabled ?? true, serviceFee: p ? Number(p.serviceFee) : null }; }),
    tg: planKeys('tg').map(k => { const p = tp.val?.plans.find(x => x.key === k); return { key: k, label: fullPlanLabel('tg', k), enabled: p?.enabled ?? true, serviceFee: p ? Number(p.serviceFee) : null }; }),
    socialDefaults: getSetting('socialDefaults'), fx: getSetting('fx').usdCny,
    paymentConfigured: !!getSetting('payment').productCode,
    errors: [offers.error, xp.error, tp.error].filter(Boolean),
  });
});

admin.get('/batches', requireRole('support'), async c => c.json({ list: (await q.all<any>(`SELECT b.*, s.name strategy_name, u.name creator,
  (SELECT COUNT(*) FROM codes WHERE batch_id = b.id AND status = 'redeemed') redeemed FROM batches b JOIN strategies s ON s.id = b.strategy_id LEFT JOIN users u ON u.id = b.created_by ORDER BY b.created_at DESC LIMIT 100`))
  .map(b => ({ id: b.id, product: b.product, plan: b.plan, label: fullPlanLabel(b.product, b.plan), quantity: b.quantity, redeemed: b.redeemed, mode: b.mode, strategy: b.strategy_name, memo: b.memo, cost: b.cost_usd, creator: b.creator, createdAt: b.created_at })) }));
admin.post('/batches', requireRole('operator'), async c => {
  const b = await body<any>(c);
  const r = await B.generateBatch({
    product: oneOf(b.product, 'product', PRODUCTS), plan: str(b.plan, 'plan', { max: 40 }), quantity: int(b.quantity, '数量', 1, 50),
    strategyId: str(b.strategyId, '策略'), memo: str(b.memo, '备注', { opt: true, max: 100 }), idemKey: str(b.idemKey, 'idemKey', { min: 8, max: 128 }),
    social: b.social, userId: c.get('user').id,
  });
  if (!r.replayed) await audit(c, 'cdk.generate', `${r.label} × ${r.codes.length + r.missing}`, r.batchId);
  return c.json(r);
});
admin.post('/batches/:id/export', requireRole('operator'), async c => {
  const ids = (await q.all<{ id: string }>('SELECT id FROM codes WHERE batch_id = ? ORDER BY seq', [c.req.param('id')])).map(r => r.id);
  if (!ids.length) throw notFound('批次不存在');
  const out = await B.exportCodes(ids);
  await audit(c, 'cdk.export', `批次 ${c.req.param('id')}`, `${out.length} 张`);
  return c.json({ list: out });
});

/* ================= 兑换记录 ================= */
const ATTN = "(r.status IN ('manual_review','requires_action') OR (r.status = 'approved'))";
/** 兑换记录的筛选条件（列表和导出共用） */
function redFilter(c: any) {
  const f = c.req.query('f') || 'all', where = ['1=1'], args: any[] = [];
  const map: Record<string, string> = {
    attention: ATTN, running: "r.status IN ('processing','funding','funded','retrying','paid_pending_delivery','started','quoted')",
    completed: "r.status = 'completed'", blocked: "r.status = 'blocked'", failed: "r.status IN ('failed','expired','cancelled')",
  };
  if (map[f]) where.push(map[f]);
  if (c.req.query('product')) { where.push('r.product = ?'); args.push(c.req.query('product')); }
  if (c.req.query('strategy')) { where.push('r.strategy_id = ?'); args.push(c.req.query('strategy')); }
  const s = c.req.query('q');
  if (s) { where.push('(LOWER(r.id) LIKE LOWER(?) OR LOWER(r.account) LIKE LOWER(?) OR LOWER(c.display) LIKE LOWER(?) OR c.code_hash = ?)'); args.push(`%${s}%`, `%${s}%`, `%${s.toUpperCase()}%`, lookupHash(normalizeCode(s))); }
  if (c.req.query('from')) { where.push('r.created_at >= ?'); args.push(c.req.query('from')); }
  if (c.req.query('to')) { where.push('r.created_at < ?'); args.push(c.req.query('to')); }
  return { base: `FROM redemptions r JOIN codes c ON c.id = r.code_id JOIN strategies st ON st.id = r.strategy_id WHERE ${where.join(' AND ')}`, args };
}
const RED_ST: Record<string, string> = { started: '已输码', quoted: '待确认', blocked: '策略拦截', manual_review: '待审核', approved: '已通过', funding: '准备付款', funded: '待用户付款', processing: '处理中', retrying: '自动重试', requires_action: '需处理', paid_pending_delivery: '已付待交付', completed: '已完成', failed: '失败', expired: '已超时', cancelled: '已取消' };
/** 导出当前筛选条件下的兑换记录（最多 1 万条，不含完整兑换码） */
admin.get('/redemptions/export', requireRole('operator'), async c => {
  const { base, args } = redFilter(c);
  const rows = await q.all<any>(`SELECT r.*, c.display code, st.name strategy_name ${base} ORDER BY r.created_at DESC LIMIT 10000`, args);
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['记录号', '产品', '套餐', '兑换码', '策略', '状态', '账号', '成本(USD)', '国家', 'IP', '失败原因', '创建时间', '完成时间'];
  const lines = rows.map(r => [r.id, r.product, fullPlanLabel(r.product, r.plan), r.code, r.strategy_name, RED_ST[r.status] || r.status, r.account, r.cost_usd, r.country, r.ip, r.error_msg, r.created_at, r.completed_at].map(cell).join(','));
  await audit(c, 'redemption.export', '', { n: lines.length });
  return c.body('\ufeff' + [head.join(','), ...lines].join('\n'), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="redemptions-${new Date().toISOString().slice(0, 10)}.csv"` });
});
admin.get('/redemptions', requireRole('support'), async c => {
  const { base, args } = redFilter(c);
  const total = (await q.get<{ n: number }>(`SELECT COUNT(*) n ${base}`, args))!.n;
  const p = page(c.req.query('page')), sz = size(c.req.query('size'));
  const list = (await q.all<any>(`SELECT r.*, c.display code, c.mode, st.name strategy_name ${base} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, [...args, sz, (p - 1) * sz])).map(redView);
  const counts = {
    attention: (await q.get<{ n: number }>(`SELECT COUNT(*) n FROM redemptions r WHERE ${ATTN}`))!.n,
    running: (await q.get<{ n: number }>("SELECT COUNT(*) n FROM redemptions WHERE status IN ('processing','funding','retrying','paid_pending_delivery')"))!.n,
    blockedToday: (await q.get<{ n: number }>("SELECT COUNT(*) n FROM redemptions WHERE status = 'blocked' AND created_at >= ?", [new Date(Date.now() - 86400e3).toISOString()]))!.n,
    today: await q.get<any>("SELECT COUNT(*) n, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) ok FROM redemptions WHERE created_at >= ?", [new Date(Date.now() - 86400e3).toISOString()]),
  };
  return c.json({ total, list, counts });
});
function redView(r: any) {
  return {
    id: r.id, product: r.product, plan: r.plan, planLabel: fullPlanLabel(r.product, r.plan), code: r.code, codeId: r.code_id, mode: r.mode,
    strategy: { id: r.strategy_id, name: r.strategy_name }, status: r.status, stage: r.stage, review: r.review, account: r.account,
    cost: r.cost_usd, rule: r.rule, message: r.error_msg, errorCode: r.error_code, attempts: r.attempts, ip: r.ip, country: r.country,
    cardLast4: undefined, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
  };
}
admin.get('/redemptions/:id', requireRole('support'), async c => {
  const r = await q.get<any>('SELECT r.*, c.display code, c.mode, st.name strategy_name FROM redemptions r JOIN codes c ON c.id = r.code_id JOIN strategies st ON st.id = r.strategy_id WHERE r.id = ?', [c.req.param('id')]);
  if (!r) throw notFound('记录不存在');
  const txs = (await q.all<any>('SELECT id, auth_time, data FROM transactions WHERE redemption_id = ? ORDER BY auth_time', [r.id])).map(t => ({ id: t.id, at: t.auth_time, ...parse(t.data, {}) }));
  return c.json({ ...redView(r), quote: parse(r.quote, null), progress: parse(r.progress, []), invoiceUrls: parse(r.invoice_urls, []), orderId: r.order_id,
    clientRequestId: r.client_request_id, hasSession: R.hasSession(r.id), transactions: txs });
});

admin.post('/redemptions/:id/:action{approve|reject|retry|release}', requireRole('operator'), async c => {
  const id = c.req.param('id'), action = c.req.param('action');
  if (action === 'approve') await R.adminApprove(id);
  else if (action === 'reject') { const b = await c.req.json().catch(() => ({})); await R.adminReject(id, b.reason); }
  else if (action === 'retry') await R.adminRetry(id);
  else await R.adminRelease(id);
  await audit(c, `redemption.${action}`, id);
  // 返回处理后的实际状态：例如「通过」后仍被资金护栏拦下，页面要能提示原因
  const after = await q.get<any>('SELECT status, stage, rule FROM redemptions WHERE id = ?', [id]);
  return c.json({ ok: true, status: after?.status, stage: after?.stage, rule: after?.rule });
});

/* ================= 策略 ================= */
admin.get('/strategies', requireRole('support'), async c => c.json({ list: await S.listStrategies() }));
admin.post('/strategies', requireRole('admin'), async c => { const s = await S.saveStrategy({ ...(await body<any>(c)), id: undefined }); await audit(c, 'strategy.create', s.name, s.id); return c.json(s); });
admin.put('/strategies/:id', requireRole('admin'), async c => { const s = await S.saveStrategy({ ...(await body<any>(c)), id: c.req.param('id') }); await audit(c, 'strategy.update', s.name, s.id); return c.json(s); });
admin.delete('/strategies/:id', requireRole('admin'), async c => { const s = await S.getStrategy(c.req.param('id')); await S.deleteStrategy(s.id); await audit(c, 'strategy.delete', s.name, s.id); return c.json({ ok: true }); });
/** 规则测试：只读模拟，不写入任何记录 */
admin.post('/strategies/test', requireRole('support'), async c => {
  const b = await body<any>(c);
  const code = normalizeCode(str(b.code, '兑换码'));
  const row = await q.get<any>('SELECT c.*, b.cost_usd FROM codes c JOIN batches b ON b.id = c.batch_id WHERE c.code_hash = ?', [lookupHash(code)]);
  let s: S.Strategy;
  if (row) s = await S.getStrategy(row.strategy_id);
  else {
    const prefix = code.split('-')[0];
    s = (await S.listStrategies()).filter(x => x.on).find(x => x.mode === 'own' && x.prefix === prefix) || await S.defaultStrategy();
  }
  const product = row?.product || s.prod[0];
  const gate = await S.checkGates(s, { ip: b.ip || '0.0.0.0', device: b.device || 'test-device', country: b.country || null, codeCreatedAt: row?.created_at || now(), codeExpiresAt: row?.expires_at || null });
  const accText = String(b.account || '').trim();
  const acc = { key: accText ? lookupHash(product === 'gpt' ? `gpt:${accText}` : `${product}:${accText.replace(/^@/, '').toLowerCase()}`) : null, display: accText, email: accText.includes('@') && !accText.startsWith('@') ? accText : undefined, currentPlan: b.currentPlan };
  const account = await S.checkAccount(s, product, acc);
  const base = row?.cost_usd ? Number(row.cost_usd) : null;
  const price = S.checkPrice(s, base, b.price !== undefined && b.price !== '' ? Number(b.price) : base);
  const checks = [{ name: '匹配策略', ok: true, detail: `${s.name}${row ? '' : '（码不存在，按前缀匹配）'}` }, ...gate.checks.filter(x => x.name !== '人机验证' || x.ok !== true), ...account.checks, ...price.checks];
  const first = [gate, account, price].find(v => !v.ok && v.action !== 'captcha');
  return c.json({ strategy: { id: s.id, name: s.name }, codeFound: !!row, checks, result: first ? (first.action === 'manual' ? 'manual' : 'block') : 'pass', rule: first?.rule });
});

/* ================= 售价与利润 ================= */
admin.get('/pricing', requireRole('support'), async c => c.json(await ST.pricing()));
admin.put('/pricing/retail', requireRole('admin'), async c => {
  const b = await body<{ key: string; price: number | null }>(c);
  const [p, plan] = String(b.key).split('.');
  if (!PRODUCTS.includes(p as any) || !planKeys(p).includes(plan)) throw bad('套餐不正确');
  const r = getSetting('retail');
  if (b.price === null || b.price === undefined || (b.price as any) === '') delete r[b.key]; else { const v = Number(b.price); if (!(v >= 0 && v < 1e6)) throw bad('零售价不正确'); r[b.key] = v; }
  await setSetting('retail', r);
  return c.json({ ok: true });
});
admin.put('/pricing/fx', requireRole('admin'), async c => { const b = await body<any>(c); const v = Number(b.usdCny); if (!(v > 0 && v < 100)) throw bad('汇率不正确'); await setSetting('fx', { usdCny: v }); return c.json({ ok: true }); });
admin.put('/pricing/social-defaults', requireRole('admin'), async c => {
  const b = await body<any>(c);
  const [p, plan] = String(b.key).split('.');
  if (!['x', 'tg'].includes(p) || !planKeys(p).includes(plan)) throw bad('套餐不正确');
  const currency = str(b.currency, '币种', { min: 3, max: 3 }).toLowerCase();
  const maxOfficialAmountMinor = int(Number(b.maxOfficialAmountMinor), '官方金额上限', 1, 1e9);
  const fundingAmountUsd = str(b.fundingAmountUsd, '预付额');
  if (!/^\d+(\.\d{1,4})?$/.test(fundingAmountUsd)) throw bad('预付额格式不正确');
  const d = getSetting('socialDefaults'); d[b.key] = { currency, maxOfficialAmountMinor, fundingAmountUsd }; await setSetting('socialDefaults', d);
  await audit(c, 'pricing.social_defaults', b.key, d[b.key]);
  return c.json({ ok: true });
});
admin.post('/pricing/refresh', requireRole('support'), c => { invalidateCatalog(); return c.json({ ok: true }); });

/* ================= 支付流水 ================= */
admin.get('/transactions', requireRole('support'), async c => c.json(await W.listTransactions({ product: c.req.query('product'), status: c.req.query('status'), type: c.req.query('type'), q: c.req.query('q'), page: page(c.req.query('page')), size: size(c.req.query('size'), 50) })));
admin.post('/transactions/sync', requireRole('operator'), async c => c.json({ synced: await W.syncTransactions() }));

/* ================= Webhook ================= */
admin.get('/webhooks', requireRole('support'), async c => c.json({
  url: `${config.publicUrl}/api/webhooks/avanfinity`, secretSet: !!avanCredentials().webhookSecret,
  stats: await W.eventStats(), events: await W.listEvents({ failed: c.req.query('failed') === '1', limit: 100 }),
}));
admin.put('/webhooks/secret', requireRole('admin'), async c => {
  const { secret } = await body<{ secret: string }>(c);
  if (!/^whsec_[0-9a-f]{64}$/.test(String(secret || '').trim())) throw bad('签名密钥格式应为 whsec_ 加 64 位十六进制');
  await saveAvanCredentials({ webhookSecret: secret }); await audit(c, 'webhook.secret'); return c.json({ ok: true });
});
/** 用当前密钥给自己发一条签名的测试事件，验证接收链路 */
admin.post('/webhooks/self-test', requireRole('operator'), async c => {
  const secret = avanCredentials().webhookSecret;
  if (!secret) throw bad('请先填写签名密钥');
  const id = `evt_${hex(4)}_${hex(4)}_${hex(4)}_${hex(4)}`;
  const raw = JSON.stringify({ id, type: 'webhook.test', apiVersion: '2026-08-01', createdAt: now(), data: { object: { test: true } } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`http://127.0.0.1:${config.port}/api/webhooks/avanfinity`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Avanfinity-Webhook-Id': id, 'X-Avanfinity-Webhook-Timestamp': ts, 'X-Avanfinity-Signature': webhookSignature(secret, ts, raw) }, body: raw });
  return c.json({ status: res.status, ok: res.ok });
});
admin.post('/webhooks/:id/reprocess', requireRole('operator'), async c => c.json({ ok: await W.reprocess(c.req.param('id')) }));

/* ================= 设置 ================= */
admin.get('/settings', requireRole('admin'), c => {
  const a = avanCredentials(), r = getSetting('redeemPage');
  return c.json({
    avan: { baseUrl: a.baseUrl, appId: a.appId, appSecretMasked: mask(a.appSecret), webhookSecretSet: !!a.webhookSecret },
    payment: getSetting('payment'), notify: (({ tgTokenEnc, lastReportDay, ...n }) => ({ ...n, tgTokenSet: !!tgTokenEnc }))(getSetting('notify')),
    redeem: { ...r, turnstileSecretEnc: undefined, turnstileSecretSet: !!r.turnstileSecretEnc },
    server: { publicUrl: config.publicUrl, timezone: config.timezone, trustProxy: config.trustProxy },
  });
});
admin.put('/settings/avan', requireRole('admin'), async c => {
  const b = await body<any>(c);
  if (b.baseUrl !== undefined && b.baseUrl && !/^https?:\/\/[^\s]+$/.test(b.baseUrl)) throw bad('卡台地址应以 http(s):// 开头');
  if (b.appId && !/^app_[0-9a-zA-Z_]+$/.test(b.appId)) throw bad('App-Id 格式应为 app_ 开头');
  if (b.appSecret && !/^sk_[0-9a-zA-Z_]+$/.test(b.appSecret)) throw bad('App-Secret 格式应为 sk_ 开头');
  await saveAvanCredentials(b); invalidateCatalog(); await audit(c, 'settings.avan', '', { baseUrl: b.baseUrl, appId: b.appId, secretChanged: !!b.appSecret });
  return c.json({ ok: true });
});
admin.post('/settings/avan/test', requireRole('admin'), async c => {
  invalidateCatalog();
  const t0 = Date.now();
  try {
    const offers = await avan.gptOffers();
    const checks: Record<string, string> = { 'cdk:read': '✓' };
    for (const k of ['x', 'tg'] as const) checks[`${k}-direct`] = await avan.socialPlans(k).then(() => '✓', (e: AvanError) => `✕ ${e.status}`);
    return c.json({ ok: true, ms: Date.now() - t0, offers: offers.length, checks });
  } catch (e) { return c.json({ ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e), status: (e as AvanError).status }); }
});
admin.get('/settings/products', requireRole('admin'), async c => {
  try { return c.json({ list: (await avan.products()).map((p: any) => ({ productCode: p.productCode, label: `${p.network || ''} ${p.issuingArea || ''} · 通道费 $${p.openFee ?? '?'}`.trim() })) }); }
  catch (e) { return c.json({ list: [], error: e instanceof Error ? e.message : String(e) }); }
});
admin.put('/settings/payment', requireRole('admin'), async c => {
  const b = await body<any>(c);
  await setSetting('payment', { productCode: str(b.productCode, '付款通道', { max: 64 }), firstName: str(b.firstName || 'CDK', '名', { max: 64 }).toUpperCase(), lastName: str(b.lastName || 'USER', '姓', { max: 64 }).toUpperCase() });
  await audit(c, 'settings.payment', b.productCode); return c.json({ ok: true });
});
admin.put('/settings/redeem', requireRole('admin'), async c => {
  const b = await body<any>(c), cur = getSetting('redeemPage');
  const next = {
    ...cur,
    desc: str(b.desc ?? cur.desc, '页面说明', { opt: true, max: 300 }), contact: str(b.contact ?? cur.contact, '客服', { opt: true, max: 100 }),
    maintenance: !!(b.maintenance ?? cur.maintenance), maintenanceMsg: str(b.maintenanceMsg ?? cur.maintenanceMsg, '维护提示', { opt: true, max: 200 }),
    products: { gpt: !!(b.products?.gpt ?? cur.products.gpt), x: !!(b.products?.x ?? cur.products.x), tg: !!(b.products?.tg ?? cur.products.tg) },
    turnstileSiteKey: str(b.turnstileSiteKey ?? cur.turnstileSiteKey, 'Turnstile Site Key', { opt: true, max: 100 }),
    turnstileSecretEnc: b.turnstileSecret === '' ? null : b.turnstileSecret ? encryptOpt(b.turnstileSecret) : cur.turnstileSecretEnc,
  };
  await setSetting('redeemPage', next); await audit(c, 'settings.redeem'); return c.json({ ok: true });
});
admin.put('/settings/notify', requireRole('admin'), async c => {
  const b = await body<any>(c);
  const chat = str(b.tgChatId ?? getSetting('notify').tgChatId, 'Chat ID', { opt: true, max: 40 });
  if (chat && !/^-?\d+$|^@[A-Za-z0-9_]{4,}$/.test(chat)) throw bad('Chat ID 应为数字，或 @频道用户名');
  if (b.tgToken && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(String(b.tgToken).trim())) throw bad('Bot Token 格式不正确');
  await patchSetting('notify', {
    failAlert: !!b.failAlert, shopAlert: !!(b.shopAlert ?? getSetting('notify').shopAlert), lowStock: !!b.lowStock, dailyReport: !!b.dailyReport,
    lowStockThreshold: int(Number(b.lowStockThreshold ?? 20), '库存阈值', 1, 10000), tgChatId: chat,
    ...(b.tgToken === '' ? { tgTokenEnc: null } : b.tgToken ? { tgTokenEnc: encryptOpt(String(b.tgToken).trim()) } : {}),
  });
  await audit(c, 'settings.notify'); return c.json({ ok: true });
});
admin.post('/settings/notify/test', requireRole('admin'), async c => {
  try { await sendTelegram('✅ CDK 系统通知测试成功\n\n' + await dailyReportText()); return c.json({ ok: true }); }
  catch (e) { throw bad(e instanceof Error ? e.message : String(e)); }
});

/* ================= 主题 ================= */
const pickOne = (v: unknown, list: string[], d: string) => (typeof v === 'string' && list.includes(v) ? v : d);
/** Logo 图片：只接受 png / jpeg / webp / svg 的 data URL，最大约 150KB */
function logoImg(v: unknown) {
  const s = String(v || '');
  if (!s) return '';
  if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s)) throw bad('Logo 图片格式不正确，请上传 PNG / JPG / WebP / SVG');
  if (s.length > 200_000) throw bad('Logo 图片太大，请压缩到 150KB 以内');
  return s;
}
admin.get('/theme', requireRole('support'), c => c.json(getSetting('theme')));
admin.put('/theme', requireRole('admin'), async c => {
  const b = await body<any>(c), t = getSetting('theme');
  const color = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
  const num = (v: unknown, min: number, max: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d; };
  await setSetting('theme', {
    preset: str(b.preset ?? t.preset, 'preset', { max: 20 }), mode: ['dark', 'light', 'auto'].includes(b.mode) ? b.mode : t.mode,
    a1: color(b.a1, t.a1), a2: color(b.a2, t.a2), a3: color(b.a3, t.a3), r: num(b.r, 4, 28, t.r), blur: num(b.blur, 0, 40, t.blur), glow: num(b.glow, 0, 100, t.glow),
    name: str(b.name ?? t.name, '品牌名称', { min: 1, max: 20 }), logo: str(b.logo ?? t.logo, 'Logo', { min: 1, max: 2 }), slogan: str(b.slogan ?? t.slogan, '标语', { opt: true, max: 24 }),
    bg: pickOne(b.bg, ['aurora', 'mesh', 'grid', 'dots', 'plain'], t.bg || 'aurora'), font: pickOne(b.font, ['modern', 'rounded', 'serif', 'tech'], t.font || 'modern'),
    card: pickOne(b.card, ['glass', 'solid', 'outline', 'neo'], t.card || 'glass'), btn: pickOne(b.btn, ['gradient', 'solid', 'glow'], t.btn || 'gradient'), shape: pickOne(b.shape, ['round', 'pill', 'square'], t.shape || 'round'),
    motion: b.motion === undefined ? t.motion ?? true : !!b.motion,
    logoImg: logoImg(b.logoImg ?? t.logoImg ?? ''), tagline: str(b.tagline ?? t.tagline ?? '', '副标题', { opt: true, max: 60 }),
    // 自定义 CSS 只给管理员填；去掉能跳出 <style> 的写法
    customCss: String(b.customCss ?? t.customCss ?? '').slice(0, 20000).replace(/<\/?style/gi, '').replace(/<\//g, ''),
  });
  await audit(c, 'theme.update'); return c.json(getSetting('theme'));
});

/* ================= 管理员 / 审计 ================= */
admin.get('/users', requireRole('admin'), async c => c.json({ list: await q.all('SELECT id, email, name, role, totp_enabled totpEnabled, disabled, created_at createdAt, last_login_at lastLoginAt, last_login_ip lastLoginIp FROM users ORDER BY id') }));
admin.post('/users', requireRole('admin'), async c => {
  const b = await body<any>(c);
  const id = await createUser({ email: str(b.email, '邮箱', { max: 120 }).toLowerCase(), name: str(b.name, '名称', { max: 40 }), role: oneOf(b.role, '角色', ['admin', 'operator', 'support'] as const), password: str(b.password, '密码', { min: 8, max: 200 }) });
  await audit(c, 'user.create', b.email, b.role); return c.json({ id });
});
admin.patch('/users/:id', requireRole('admin'), async c => {
  const id = Number(c.req.param('id')), b = await body<any>(c);
  if (id === c.get('user').id && (b.disabled || (b.role && b.role !== 'admin'))) throw bad('不能停用或降级自己');
  if (b.role) await q.run('UPDATE users SET role = ? WHERE id = ?', [oneOf(b.role, '角色', ['admin', 'operator', 'support'] as const), id]);
  if (b.disabled !== undefined) { await q.run('UPDATE users SET disabled = ? WHERE id = ?', [b.disabled ? 1 : 0, id]); if (b.disabled) await q.run('DELETE FROM sessions WHERE user_id = ?', [id]); }
  await audit(c, 'user.update', String(id), b); return c.json({ ok: true });
});
admin.delete('/users/:id', requireRole('admin'), async c => {
  const id = Number(c.req.param('id'));
  if (id === c.get('user').id) throw bad('不能删除自己');
  if (((await q.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", [id]))!.n) < 1) throw bad('至少保留一个管理员');
  await q.run('DELETE FROM users WHERE id = ?', [id]); await audit(c, 'user.delete', String(id)); return c.json({ ok: true });
});
admin.get('/audit', requireRole('admin'), async c => c.json({ list: await q.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', [size(c.req.query('size'), 50)]) }));

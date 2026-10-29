/**
 * 本地模拟卡台（仅开发 / 测试用）
 *   npm run mock   → http://localhost:8090
 * 鉴权：X-App-Id = app_mock / X-App-Secret = sk_mock
 * 触发失败的约定：
 *   GPT session 里的 email 含 "decline"  → 支付被拒，CDK 释放
 *   GPT session 里的 email 含 "expired"  → 预检 422（Session 无效）
 *   GPT session 里 "plan":"plus"         → currentPlan = plus
 *   X/TG 接收方含 "prem"                  → ineligible（已是会员）
 *   X/TG 接收方含 "fail"                  → failed_precharge，canRetryPreflight = true
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { payMock } from './pay-mock.ts';

const PORT = Number(process.env.MOCK_PORT || 8090);
const APP_ID = process.env.MOCK_APP_ID || 'app_mock';
const APP_SECRET = process.env.MOCK_APP_SECRET || 'sk_mock';
const WEBHOOK_URL = process.env.MOCK_WEBHOOK_URL || 'http://localhost:8080/api/webhooks/avanfinity';
const WEBHOOK_SECRET = process.env.MOCK_WEBHOOK_SECRET || 'whsec_' + '0'.repeat(64);
const SPEED = Number(process.env.MOCK_SPEED || 1); // 状态推进速度倍率

const app = new Hono();
const hexs = (n: number) => randomBytes(n).toString('hex');
const ok0 = (data: unknown) => ({ code: 0, data });
const ok200 = (data: unknown) => ({ code: 200, data });
const err = (c: any, status: number, error: string, errorCode?: string) => c.json({ error, ...(errorCode ? { errorCode } : {}) }, status);
const later = (ms: number, fn: () => void) => setTimeout(fn, ms / SPEED);

/* ---------------- 状态 ---------------- */
const GPT_PRICES: Record<string, string | null> = { go: '4.90', plus: '19.80', pro_5x: '99.00', pro_20x: '199.00', pro_25x: null };
const GPT_LABEL: Record<string, string> = { go: 'ChatGPT Go', plus: 'ChatGPT Plus', pro_5x: 'ChatGPT Pro 5x', pro_20x: 'ChatGPT Pro 20x', pro_25x: 'ChatGPT Pro 25x' };
interface GptCdk { id: string; code: string; plan: string; status: string; forceNewCard: boolean; salePrice: string; device?: string; orderId?: string; redemptionToken?: string; email?: string; updatedAt: string }
interface GptOrder { id: string; cdkId: string; plan: string; status: string; stage: string; email: string; progress: any[]; cardLastFour: string | null; nextAction: string; failure?: any; invoiceUrls: string[]; willRenew: boolean; decline: boolean }
const gptCdks = new Map<string, GptCdk>();         // by id
const gptByCode = new Map<string, string>();       // code -> id
const gptByToken = new Map<string, string>();      // redemptionToken -> id
const preflights = new Map<string, { cdkId: string; email: string; decline: boolean; exp: number }>();
const orders = new Map<string, GptOrder>();
const idem = new Map<string, unknown>();

interface SocialCdk { id: string; kind: 'x' | 'tg'; code: string; plan: string; status: string; recipient: string | null; device?: string; clientRequestId?: string; amountMinor?: number; currency: string; maxWalletDebitUsd: string; maxOfficialAmountMinor: number; fundingAmountUsd: string; serviceFee: string; createdAt: string; canRetryPreflight?: boolean; errorCode?: string | null; message?: string | null }
const social = new Map<string, SocialCdk>();
const socialByCode = new Map<string, string>();
const txs: any[] = [];
let txId = 900000;

/* ---------------- Webhook 推送 ---------------- */
async function emit(type: string, object: unknown) {
  const id = `evt_${hexs(4)}_${hexs(4)}_${hexs(4)}_${hexs(4)}`;
  const body = JSON.stringify({ id, type, apiVersion: '2026-08-01', createdAt: new Date().toISOString(), data: { object } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v1=' + createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
  try {
    await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Avanfinity-Webhook-Id': id, 'X-Avanfinity-Webhook-Timestamp': ts, 'X-Avanfinity-Signature': sig }, body, signal: AbortSignal.timeout(5000) });
  } catch { /* 接收方没启动时忽略 */ }
}
async function addTx(merchant: string, amount: string, status: 'APPROVED' | 'DECLINED', reason?: string) {
  const last4 = String(1000 + Math.floor(Math.random() * 8999));
  const t = { id: ++txId, authId: 'auth_' + hexs(6), cardId: 10000 + Math.floor(Math.random() * 99), type: 'AUTH', status, authAmount: amount, settleAmount: amount, authCurrency: 'USD', settleCurrency: 'USD', merchantName: merchant, merchantCountry: 'US', failedReason: reason || null, authTime: new Date().toISOString(), createdAt: new Date().toISOString(), cardNumberMasked: '5319 93** **** ' + last4 };
  txs.unshift(t);
  await emit('card.transaction.updated', { transactionId: t.id, cardId: t.cardId, type: t.type, status: t.status, authAmount: amount, settleAmount: amount, authCurrency: 'USD', settleCurrency: 'USD', merchantName: merchant, merchantCountry: 'US', authTime: t.authTime });
  return last4;
}

/* ---------------- 鉴权 ---------------- */
app.use('/api/v1/*', async (c, next) => {
  if (c.req.header('x-app-id') !== APP_ID || c.req.header('x-app-secret') !== APP_SECRET) return err(c, 401, '鉴权失败', 'AUTH_REQUIRED');
  await next();
});
const idemKey = (c: any) => {
  const k = c.req.header('idempotency-key');
  if (!k || k.length < 8) throw new Error('missing idem');
  return k as string;
};

/* ---------------- 目录 ---------------- */
app.get('/api/v1/gpt-direct/cdk-offers', c => c.json(ok0({ offers: Object.entries(GPT_PRICES).map(([plan, p]) => ({ plan, enabled: !!p, salePrice: p, pricingStatus: p ? 'READY' : 'WAITING_QUOTE', stock: p ? 100 + plan.length * 37 : 0 })) })));
app.get('/api/v1/gpt-direct/plans', c => c.json(ok0({ version: 7, externalCardServiceFee: '1.00', plans: Object.keys(GPT_PRICES).map(k => ({ key: k, label: GPT_LABEL[k], currency: 'usd', enabled: !!GPT_PRICES[k], serviceFeeUsdMinor: 80, customerServiceFee: directMock.badFee ? 'abc' : '0.80', expectedAmountMinor: GPT_PRICES[k] ? Math.round(Number(GPT_PRICES[k]) * 100) : null, minAmountMinor: null, maxAmountMinor: null })),
  checkoutCountries: [{ country: 'US', currency: 'USD' }, { country: 'PH', currency: 'PHP' }], batchConcurrencyByCountry: { US: 8, PH: 3 }, cdkRegionSelectionEnabled: directMock.regionSelection })));
const X_PLANS = [['premium_3m', 'Premium 3 个月', 'premium', 3, '1.00'], ['premium_6m', 'Premium 6 个月', 'premium', 6, '1.20'], ['premium_12m', 'Premium 12 个月', 'premium', 12, '1.50'], ['premium_plus_3m', 'Premium+ 3 个月', 'premium_plus', 3, '1.50'], ['premium_plus_6m', 'Premium+ 6 个月', 'premium_plus', 6, '2.00'], ['premium_plus_12m', 'Premium+ 12 个月', 'premium_plus', 12, '2.50']] as const;
const TG_PLANS = [['premium_3m', 'Premium 3 个月', 'premium', 3, '0.60'], ['premium_6m', 'Premium 6 个月', 'premium', 6, '0.80'], ['premium_12m', 'Premium 12 个月', 'premium', 12, '1.00']] as const;
const OFFICIAL: Record<string, number> = { 'x.premium_3m': 2400, 'x.premium_6m': 4600, 'x.premium_12m': 8400, 'x.premium_plus_3m': 6200, 'x.premium_plus_6m': 11800, 'x.premium_plus_12m': 22900, 'tg.premium_3m': 1199, 'tg.premium_6m': 1599, 'tg.premium_12m': 2899 };
for (const K of ['x', 'tg'] as const) app.get('/api/v1/' + K + '-direct/plans', c => {
  const list = K === 'x' ? X_PLANS : TG_PLANS;
  return c.json(ok200({ paymentsEnabled: true, plans: list.map(([key, label, tier, months, fee]) => ({ key, label, tier, months, enabled: true, serviceFee: fee, pricingVersion: 14 })) }));
});
app.get('/api/v1/products', c => c.json(ok0([{ productCode: 'MOCK-VISA-US', issuer: 'Mock', network: 'VISA', issuingArea: 'US', cardType: 'virtual', openFee: '0.50', rechargeRate: '0.015', minAmount: '5', maxAmount: '5000' }])));

/* ---------------- GPT CDK 生成 ---------------- */
app.post('/api/v1/gpt-direct/cdks/generate', async c => {
  const key = idemKey(c);
  if (idem.has(key)) return c.json(ok0({ ...(idem.get(key) as any), replayed: true }));
  const b = await c.req.json();
  // 和真实卡台一样：请求体不接受未知字段；不支持选地区时传 paymentCountry 会被拒绝
  if (b.paymentCountry && !directMock.regionSelection) return err(c, 400, 'unknown field paymentCountry');
  if (!GPT_PRICES[b.plan]) return err(c, 409, '该套餐等待报价', 'WAITING_QUOTE');
  if (!(b.quantity >= 1 && b.quantity <= 50)) return err(c, 400, 'quantity 1-50');
  const items = Array.from({ length: b.quantity }, () => {
    const id = randomUUID(), code = 'AVF-' + hexs(16).toUpperCase();
    gptCdks.set(id, { id, code, plan: b.plan, status: 'unused', forceNewCard: !!b.forceNewCard, salePrice: GPT_PRICES[b.plan]!, updatedAt: new Date().toISOString() });
    gptByCode.set(code, id);
    return { saleId: randomUUID(), cdkId: id, code, codePrefix: code.slice(0, 12) };
  });
  const data = { saleId: items[0].saleId, cdkId: items[0].cdkId, code: items[0].code, codePrefix: items[0].codePrefix, plan: b.plan, salePrice: GPT_PRICES[b.plan], quantity: b.quantity, totalSalePrice: (Number(GPT_PRICES[b.plan]) * b.quantity).toFixed(2), items, balance: '10000.00', replayed: false, generated: true, forceNewCard: !!b.forceNewCard,
    checkoutRegion: { country: b.paymentCountry || 'US', currency: b.paymentCountry === 'PH' ? 'PHP' : 'USD' } };
  if (b.paymentCountry) directMock.cdkRegions.push(b.paymentCountry);
  idem.set(key, data);
  return c.json(ok0(data));
});
app.get('/api/v1/gpt-direct/cdks', c => c.json(ok0({ total: gptCdks.size, forceNewCardEnabled: true, list: [...gptCdks.values()].slice(-100).reverse().map(x => ({ id: x.id, codePrefix: 'AVF-********', plan: x.plan, forceNewCard: x.forceNewCard, status: x.status, inventoryStatus: x.status, salePrice: x.salePrice, updatedAt: x.updatedAt })) })));

/* ---------------- GPT 公开兑换 ---------------- */
const dev = (c: any) => c.req.header('x-redemption-device');
app.post('/api/public/cdk/preview', async c => {
  const { code } = await c.req.json();
  const id = gptByCode.get(String(code).toUpperCase());
  const k = id && gptCdks.get(id);
  if (!k) return err(c, 404, '兑换码不存在', 'CDK_NOT_FOUND');
  if (!dev(c)) return err(c, 400, '缺少设备标识');
  if (k.status === 'consumed') return err(c, 409, '兑换码已使用', 'CDK_CONSUMED');
  if (k.status === 'reserved' && k.device !== dev(c)) return err(c, 409, '兑换码正在被其他设备兑换', 'CDK_RESERVED');
  if (['frozen', 'disabled'].includes(k.status)) return err(c, 409, '兑换码不可用', 'CDK_DISABLED');
  k.device = dev(c); k.redemptionToken = 'rt_' + hexs(16); gptByToken.set(k.redemptionToken, k.id);
  return c.json(ok0({ redemptionToken: k.redemptionToken, plan: k.plan, planLabel: GPT_LABEL[k.plan], status: k.status }));
});
app.post('/api/public/cdk/preflight', async c => {
  const b = await c.req.json();
  const id = gptByToken.get(b.redemptionToken), k = id && gptCdks.get(id);
  if (!k || k.device !== dev(c)) return err(c, 409, 'redemptionToken 无效', 'PREFLIGHT_REQUIRED');
  let s: any = {}; try { s = JSON.parse(b.credential?.session || '{}'); } catch { return err(c, 422, 'Session 格式不正确', 'SESSION_INVALID'); }
  const email: string = s.user?.email || s.email || 'user@example.com';
  if (email.includes('expired')) return err(c, 422, 'Session 已过期，请重新获取', 'SESSION_EXPIRED');
  const pt = 'pf_' + hexs(16);
  preflights.set(pt, { cdkId: k.id, email, decline: email.includes('decline'), exp: Date.now() + 10 * 60e3 });
  const masked = email.replace(/^(.).*(@.*)$/, '$1***$2');
  const amount = Math.round(Number(GPT_PRICES[k.plan]) * 100) + 20;
  return c.json(ok0({ preflightToken: pt, preflightExpiresAt: new Date(Date.now() + 10 * 60e3).toISOString(), email: masked, currentPlan: s.plan || 'free', plan: k.plan,
    quote: { country: 'US', currency: 'usd', plan: k.plan, amountMinor: amount, amountMajor: (amount / 100).toFixed(2), minorUnitExponent: 2, fetchedAt: Date.now() }, quoteEstimatesUsd: { [k.plan]: (amount / 100).toFixed(2) } }));
});
const step = (name: string, status = 'done') => ({ step: name, status, occurredAt: new Date().toISOString() });
function orderView(o: GptOrder) {
  return { order: { id: o.id, status: o.status, stage: o.stage, plan: o.plan, maskedEmail: o.email.replace(/^(.).*(@.*)$/, '$1***$2'), nextAction: o.nextAction, failure: o.failure || null, invoiceUrls: o.invoiceUrls, willRenew: o.willRenew, recoveryMessage: o.failure?.message || '' }, progress: o.progress, cardLastFour: o.cardLastFour };
}
app.post('/api/public/cdk/redeem', async c => {
  const b = await c.req.json();
  const id = gptByToken.get(b.redemptionToken), k = id && gptCdks.get(id);
  if (!k || k.device !== dev(c)) return err(c, 409, 'redemptionToken 无效', 'PREFLIGHT_REQUIRED');
  if (k.orderId && orders.get(k.orderId) && !['declined', 'failed', 'cancelled'].includes(orders.get(k.orderId)!.status)) return c.json(ok0(orderView(orders.get(k.orderId)!)));
  const pf = preflights.get(b.preflightToken);
  if (!pf || pf.cdkId !== k.id || pf.exp < Date.now()) return err(c, 409, '预检令牌无效或已过期', 'PREFLIGHT_REQUIRED');
  preflights.delete(b.preflightToken);
  const o: GptOrder = { id: randomUUID(), cdkId: k.id, plan: k.plan, status: 'queued', stage: 'queued', email: pf.email, progress: [step('兑换码已确认'), step('账号与报价已确认')], cardLastFour: null, nextAction: 'wait', invoiceUrls: [], willRenew: true, decline: pf.decline };
  orders.set(o.id, o); k.orderId = o.id; k.status = 'reserved'; k.email = pf.email; k.updatedAt = new Date().toISOString();
  await emit('openai.cdk.reserved', { eventId: randomUUID(), cdkId: k.id, status: 'reserved', occurredAt: k.updatedAt });
  later(1200, async () => { o.status = 'running'; o.stage = 'paying'; o.progress.push(step('正在付款', 'running')); await emit('openai.direct.progress', { eventId: randomUUID(), orderId: o.id, cdkId: k.id, status: o.status, stage: o.stage }); });
  later(2600, async () => {
    o.progress[o.progress.length - 1].status = o.decline ? 'failed' : 'done';
    if (o.decline) {
      o.cardLastFour = await addTx('OPENAI *CHATGPT SUBSCR', GPT_PRICES[k.plan]!, 'DECLINED', 'do_not_honor');
      o.status = 'declined'; o.stage = 'payment_declined'; o.nextAction = 'change_card_and_reorder'; o.failure = { code: 'card_declined', message: '支付被拒（do_not_honor）' };
      k.status = 'unused'; k.orderId = undefined; k.device = undefined;
      await emit('openai.direct.failed', { eventId: randomUUID(), orderId: o.id, cdkId: k.id, status: 'declined', order: orderView(o).order });
      await emit('openai.cdk.released', { eventId: randomUUID(), cdkId: k.id, status: 'unused' });
    } else {
      o.cardLastFour = await addTx('OPENAI *CHATGPT SUBSCR', GPT_PRICES[k.plan]!, 'APPROVED');
      o.progress.push(step('会员已开通'), step('自动续费已关闭'));
      o.status = 'completed'; o.stage = 'completed'; o.nextAction = 'none'; o.willRenew = false; o.invoiceUrls = ['https://invoice.stripe.com/i/mock_' + hexs(6)];
      k.status = 'consumed';
      await emit('openai.direct.completed', { eventId: randomUUID(), orderId: o.id, cdkId: k.id, status: 'completed', order: orderView(o).order });
      await emit('openai.cdk.consumed', { eventId: randomUUID(), cdkId: k.id, status: 'consumed' });
    }
    k.updatedAt = new Date().toISOString();
  });
  return c.json(ok0(orderView(o)), 202);
});
app.post('/api/public/cdk/result', async c => {
  const b = await c.req.json();
  const id = gptByToken.get(b.redemptionToken), k = id && gptCdks.get(id);
  if (!k) return err(c, 404, '找不到兑换');
  const o = [...orders.values()].filter(x => x.cdkId === k.id).pop();
  if (!o) return c.json(ok0({ plan: k.plan, status: k.status }));
  return c.json(ok0(orderView(o)));
});
app.post('/api/public/cdk/receipt', async c => {
  const { code } = await c.req.json();
  const id = gptByCode.get(String(code).toUpperCase()), k = id && gptCdks.get(id);
  const o = k && [...orders.values()].filter(x => x.cdkId === k.id).pop();
  if (!o) return err(c, 404, '找不到订单');
  return c.json(ok0(orderView(o)));
});
app.post('/api/public/cdk/cancel-renewal', c => c.json(ok0({ renewalCancel: 'requested' }), 202));
app.post('/api/v1/gpt-direct/orders/:id/session', c => {
  // 直充订单补交 Session：继续原订单并完成
  const d = directOrders.get(c.req.param('id'));
  if (d && d.status === 'requires_action') {
    d.status = 'running'; d.nextAction = 'wait';
    later(800, () => finishDirect(d, true));
  }
  return c.json(ok0({ accepted: true }), 202);
});

/* ---------------- GPT 直充（自动选卡） ----------------
 * Session 邮箱约定：含 decline → 两张卡都被拒，任务 failed；含 needsess → requires_action（补交 Session 后完成）
 *                  含 seller → requires_action（需卖家在卡台核对），约 24 秒（按 MOCK_SPEED 缩放）后卡台侧完成；含 renew → 完成后自动续费仍开启
 * 测试开关 POST /mock/direct：{ fail5xxOnce, balance, regionSelection, insufficient }
 */
/* 故障注入：truncateOnce 受理后响应体传到一半断开；badFee 目录服务费格式错误；detailFail 订单详情接口接下来失败 N 次；heldFees 费用明细停在 held（还没结清） */
const directMock = { fail5xxOnce: false, truncateOnce: false, badFee: false, detailFail: 0, heldFees: false, balance: '1000.00', regionSelection: true, insufficient: false, cdkRegions: [] as string[] };
interface DirectOrder { id: string; status: string; stage: string; nextAction: string; cardLastFour: string; email: string; plan: string; amount: number; task?: DirectTask; invoiceUrls: string[] }
interface DirectTask { id: string; plan: string; forceNewCard: boolean; status: string; failureCode: string | null; maxTotalDebitUsd: string; reservedDebitUsd: string; attempts: any[]; body: string; createdAt: string; updatedAt: string }
const directPf = new Map<string, { email: string; plan: string }>();
const directTasks = new Map<string, DirectTask>();
const directOrders = new Map<string, DirectOrder>();
const autoByIdem = new Map<string, string>();
const taskView = (t: DirectTask) => { const { body: _b, ...v } = t; return { ...v, attemptCount: t.attempts.length }; };

app.post('/api/v1/gpt-direct/preflight', async c => {
  const b = await c.req.json();
  let s: any = {}; try { s = JSON.parse(b.credential?.session || '{}'); } catch { return err(c, 422, 'Session 格式不正确', 'SESSION_INVALID'); }
  if (!s.accessToken) return err(c, 422, 'Session 缺少 accessToken', 'SESSION_INVALID');
  const email: string = s.user?.email || 'user@example.com';
  if (email.includes('expired')) return err(c, 422, 'Session 已过期，请重新获取', 'SESSION_EXPIRED');
  const country = b.paymentCountry || 'US', currency = b.paymentCurrency || (country === 'PH' ? 'PHP' : 'USD');
  const pt = 'dpf_' + hexs(12);
  directPf.set(pt, { email, plan: '' });
  const quotes: Record<string, any> = {}, usd: Record<string, string> = {};
  for (const [k, p] of Object.entries(GPT_PRICES)) if (p && k !== 'pro_25x') {
    const amt = Math.round(Number(p) * 100) + 20;
    quotes[k] = { country, currency, plan: k, amountMinor: country === 'PH' ? amt * 56 : amt, amountMajor: ((country === 'PH' ? amt * 56 : amt) / 100).toFixed(2), minorUnitExponent: 2, fetchedAt: Date.now() };
    usd[k] = (amt / 100).toFixed(2);
  }
  return c.json(ok0({ email: email.replace(/^(.).*(@.*)$/, '$1***$2'), currentPlan: s.plan || 'free', credentialMode: 'session', preflightToken: pt, preflightExpiresAt: new Date(Date.now() + 10 * 60e3).toISOString(),
    paymentCountry: country, paymentCurrency: currency, quotes, quoteError: '', quoteEstimatesUsd: usd }));
});

async function finishDirect(o: DirectOrder, ok: boolean) {
  const t = o.task!, a = t.attempts[t.attempts.length - 1];
  if (ok) {
    o.status = 'completed'; o.stage = 'completed'; o.nextAction = 'none'; o.invoiceUrls = ['https://invoice.stripe.com/i/mock_' + hexs(6)];
    a.status = 'completed'; t.status = 'completed';
    await addTx('OPENAI *CHATGPT SUBSCR', (o.amount / 100).toFixed(2), 'APPROVED');
    await emit('openai.direct.completed', { eventId: randomUUID(), orderId: o.id, status: 'completed' });
  } else {
    o.status = 'declined'; o.stage = 'payment_declined'; o.nextAction = 'change_card_and_reorder';
    a.status = 'failed'; a.failureCode = 'card_declined';
    await addTx('OPENAI *CHATGPT SUBSCR', (o.amount / 100).toFixed(2), 'DECLINED', 'do_not_honor');
  }
  t.updatedAt = new Date().toISOString();
}
function runAttempt(t: DirectTask, email: string, n: number) {
  const o: DirectOrder = { id: randomUUID(), status: 'running', stage: 'paying', nextAction: 'wait', cardLastFour: String(4000 + n), email, plan: t.plan, amount: Math.round(Number(GPT_PRICES[t.plan]) * 100) + 20, task: t, invoiceUrls: [] };
  directOrders.set(o.id, o);
  t.attempts.push({ attempt: n, newCard: true, cardId: 20000 + n, cardLastFour: o.cardLastFour, orderId: o.id, status: 'funding', failureCode: null, reservedDebitUsd: '0.50' });
  t.status = 'running';
  later(500, () => { t.attempts[n - 1].status = 'payment'; });
  later(1200, async () => {
    if (email.includes('needsess')) { o.status = 'requires_action'; o.nextAction = 'submit_session'; t.status = 'requires_action'; t.attempts[n - 1].status = 'pending'; return; }
    if (email.includes('seller')) {
      o.status = 'requires_action'; o.nextAction = 'reconcile_original_payment'; t.status = 'requires_action'; t.attempts[n - 1].status = 'pending';
      later(24000, () => finishDirect(o, true)); // 卖家在卡台核对完成
      return;
    }
    const declined = email.includes('decline');
    await finishDirect(o, !declined);
    if (declined) {
      if (n < 2 && !t.forceNewCard) runAttempt(t, email, n + 1);
      else { t.status = 'failed'; t.failureCode = 'card_declined'; t.reservedDebitUsd = (0.5 * n).toFixed(2); await emit('openai.direct.failed', { eventId: randomUUID(), orderId: o.id, status: 'declined' }); }
    }
  });
}
app.post('/api/v1/gpt-direct/auto-orders', async c => {
  const key = idemKey(c), raw = await c.req.text(), b = JSON.parse(raw);
  const prev = autoByIdem.get(key);
  if (prev) {
    const t = directTasks.get(prev)!;
    if (t.body !== raw) return err(c, 409, '同一幂等键的请求内容不一致', 'IDEMPOTENCY_CONFLICT');
    return c.json(ok0(taskView(t)), 202);
  }
  for (const k of ['plan', 'paymentCountry', 'paymentCurrency', 'expectedAmountUsd', 'expectedCustomerServiceFee', 'pricingVersion', 'maxTotalDebitUsd']) if (b[k] === undefined) return err(c, 400, `缺少 ${k}`);
  if (!['go', 'plus', 'pro_5x', 'pro_20x'].includes(b.plan)) return err(c, 400, 'plan 不支持');
  if (b.pricingVersion !== 7) return err(c, 409, '报价已变化', 'PRICE_CHANGED');
  if (directMock.insufficient) return err(c, 409, '可用余额不足', 'SPENDABLE_BALANCE_INSUFFICIENT');
  let s: any = {}; try { s = JSON.parse(b.credential?.session || '{}'); } catch { /* 上面预检已校验 */ }
  const t: DirectTask = { id: randomUUID(), plan: b.plan, forceNewCard: !!b.forceNewCard, status: 'queued', failureCode: null, maxTotalDebitUsd: b.maxTotalDebitUsd, reservedDebitUsd: '0.00', attempts: [], body: raw, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  directTasks.set(t.id, t); autoByIdem.set(key, t.id);
  later(300, () => runAttempt(t, s.user?.email || 'user@example.com', 1));
  // 模拟「卡台已受理，但响应丢了」：调用方必须用同一个幂等键重放
  if (directMock.fail5xxOnce) { directMock.fail5xxOnce = false; return err(c, 502, 'bad gateway'); }
  if (directMock.truncateOnce) {
    directMock.truncateOnce = false;
    // 响应头 202 已发出，响应体写了一半连接就断了：调用方读响应体会失败
    const body = new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('{"code":0,"data":{"id":"')); setTimeout(() => ctl.error(new Error('connection reset')), 50); } });
    return new Response(body, { status: 202, headers: { 'Content-Type': 'application/json' } });
  }
  return c.json(ok0(taskView(t)), 202);
});
app.get('/api/v1/gpt-direct/auto-orders/:id', c => {
  const t = directTasks.get(c.req.param('id'));
  return t ? c.json(ok0(taskView(t))) : err(c, 404, '任务不存在');
});
app.get('/api/v1/gpt-direct/orders/:id', c => {
  if (directMock.detailFail > 0) { directMock.detailFail--; return err(c, 503, '订单详情暂不可用'); }
  const o = directOrders.get(c.req.param('id'));
  if (!o) return err(c, 404, '订单不存在');
  const usd = (o.amount / 100).toFixed(2), done = o.status === 'completed';
  return c.json(ok0({ order: { id: o.id, status: o.status, stage: o.stage, nextAction: o.nextAction, cardLastFour: o.cardLastFour, maskedEmail: o.email.replace(/^(.).*(@.*)$/, '$1***$2'), invoiceUrls: o.invoiceUrls,
    recoveryMessage: o.nextAction === 'submit_session' ? 'ChatGPT 登录已过期，请补交 Session' : '',
    willRenew: o.status === 'completed' ? o.email.includes('renew') : null,
    // 完成：订阅和服务费已扣款；被拒：订阅没扣、服务费退回、开卡费照扣；进行中：都还在预授权
    financials: (() => {
      const declined = ['declined', 'failed'].includes(o.status);
      const sub = done ? [{ amount: usd, currency: 'usd', status: 'charged', attemptOrderId: o.id }] : declined ? [] : [{ amount: usd, currency: 'usd', status: 'pending', attemptOrderId: o.id }];
      const fee = { amount: '0.80', currency: 'usd', status: directMock.heldFees || (!done && !declined) ? 'held' : done ? 'charged' : 'released', attemptOrderId: o.id };
      return { subscriptionPayments: sub, serviceFees: [fee], cardFunding: [], cardOpenFees: [{ amount: '0.50', currency: 'usd', status: 'charged', attemptOrderId: o.id }], cardRechargeFees: [] };
    })() }, events: [] }));
});
app.get('/api/v1/balance', c => c.json(ok0({ balance: directMock.balance, totalBalance: directMock.balance, riskLockedBalance: '0.00' })));
app.post('/mock/direct', async c => { Object.assign(directMock, await c.req.json()); return c.json({ ...directMock, tasks: directTasks.size }); });

/* ---------------- X / TG CDK ---------------- */
const issuerItem = (s: SocialCdk, withCode = false) => ({ id: s.id, plan: s.plan, status: s.status, ...(withCode ? { code: s.code } : {}), codePrefix: s.code.slice(0, 9), recipient: s.recipient, maxWalletDebitUsd: s.maxWalletDebitUsd, maxOfficialAmountMinor: s.maxOfficialAmountMinor, currency: s.currency, fundingAmountUsd: s.fundingAmountUsd, serviceFee: s.serviceFee, pricingVersion: 14, totalWalletDebitUsd: (Number(s.fundingAmountUsd) + Number(s.serviceFee) + 0.9).toFixed(4), cardId: null, fundingDispatched: ['funding', 'funded', 'paying', 'completed'].includes(s.status), paymentDispatched: ['paying', 'completed'].includes(s.status), fundingFeeUsd: '0.4000', openFeeUsd: '0.5000', createdAt: s.createdAt });
for (const K of ['x', 'tg'] as const) app.post('/api/v1/' + K + '-direct/cdks/generate', async c => {
  const kind = K as 'x' | 'tg', key = kind + idemKey(c);
  if (idem.has(key)) return c.json(ok200({ list: idem.get(key), replayed: true }));
  const b = await c.req.json();
  if (!!b.cardId === !!b.autoCard) return err(c, 400, 'cardId 与 autoCard 二选一');
  const plans = kind === 'x' ? X_PLANS : TG_PLANS;
  const plan = plans.find(p => p[0] === b.plan); if (!plan) return err(c, 400, 'plan 不正确');
  const list = Array.from({ length: b.quantity }, () => {
    const s: SocialCdk = { id: randomUUID(), kind, code: (kind === 'x' ? 'XCDK-' : 'TGCD-') + hexs(12).toUpperCase(), plan: b.plan, status: 'unused', recipient: null, currency: String(b.currency).toLowerCase(), maxWalletDebitUsd: b.maxWalletDebitUsd, maxOfficialAmountMinor: b.maxOfficialAmountMinor, fundingAmountUsd: b.fundingAmountUsd, serviceFee: plan[4], createdAt: new Date().toISOString() };
    social.set(s.id, s); socialByCode.set(s.code, s.id);
    return issuerItem(s, true);
  });
  idem.set(key, list);
  return c.json(ok200({ list, replayed: false }));
});
for (const K of ['x', 'tg'] as const) app.get('/api/v1/' + K + '-direct/cdks', c => c.json(ok200({ list: [...social.values()].filter(s => s.kind === K).slice(-100).reverse().map(s => issuerItem(s)) })));
for (const K of ['x', 'tg'] as const) app.get('/api/v1/' + K + '-direct/cdks/:id/export', c => { const s = social.get(c.req.param('id')!); return s ? c.json(ok200({ id: s.id, code: s.code })) : err(c, 404, 'not found'); });
for (const K of ['x', 'tg'] as const) app.post('/api/v1/' + K + '-direct/cdks/:id/revoke', c => {
  idemKey(c); const s = social.get(c.req.param('id')!); if (!s) return err(c, 404, 'not found');
  if (!['unused', 'prepared', 'preparing', 'review_required', 'ineligible', 'revoked'].includes(s.status)) return err(c, 409, '已派发资金操作，不能撤销', 'CDK_NOT_REVOCABLE');
  s.status = 'revoked'; return c.json(ok200(issuerItem(s)));
});

const pubView = (s: SocialCdk) => ({ plan: s.plan, status: s.status, recipient: s.recipient, amountMinor: s.amountMinor ?? null, currency: s.amountMinor ? s.currency : null, message: s.message ?? null, errorCode: s.errorCode ?? null, invoiceUrls: s.status === 'completed' ? ['https://help.x.com/receipt/mock_' + s.id.slice(0, 6)] : null, canRetryPreflight: !!s.canRetryPreflight, ...(s.kind === 'tg' ? { deliveryStatus: s.status === 'completed' ? 'delivered' : s.status === 'paying' ? 'pending' : null, giftMessageId: s.status === 'completed' ? 4242 : null, giftDays: s.status === 'completed' ? ({ premium_3m: 91, premium_6m: 182, premium_12m: 365 } as any)[s.plan] : null } : {}) });
function socialFind(K: string, b: any) {
  const id = socialByCode.get(String(b.code || '').toUpperCase()), s = id && social.get(id);
  if (!s || s.kind !== K) return null;
  return s;
}
for (const K of ['x', 'tg'] as const) app.post('/api/public/' + K + '-cdk/preview', async c => {
  const b = await c.req.json(); const s = socialFind(K, b);
  if (!s) return err(c, 404, '兑换码不存在');
  if (s.device && s.device !== b.deviceToken) return err(c, 409, '兑换码已绑定其他设备', 'DEVICE_MISMATCH');
  return c.json(ok200(pubView(s)));
});
for (const K of ['x', 'tg'] as const) app.post('/api/public/' + K + '-cdk/preflight', async c => {
  const b = await c.req.json(); const s = socialFind(K, b);
  if (!s) return err(c, 404, '兑换码不存在');
  if (s.status === 'revoked') return err(c, 409, '兑换码已撤销', 'CDK_REVOKED');
  if (s.device && s.device !== b.deviceToken) return err(c, 409, '兑换码已绑定其他设备', 'DEVICE_MISMATCH');
  const rebinding = s.clientRequestId && s.clientRequestId !== b.clientRequestId;
  if (rebinding && !s.canRetryPreflight) return c.json(ok200(pubView(s)));
  if (!['unused', 'prepared', 'ineligible', 'failed_precharge'].includes(s.status) && !rebinding) return c.json(ok200(pubView(s)));
  s.device = b.deviceToken; s.clientRequestId = b.clientRequestId; s.recipient = b.recipient; s.canRetryPreflight = false; s.errorCode = null; s.message = null;
  if (/prem/i.test(b.recipient)) { s.status = 'ineligible'; s.errorCode = 'already_premium'; s.message = '该账号已是 Premium 会员'; s.canRetryPreflight = true; return c.json(ok200(pubView(s))); }
  s.amountMinor = OFFICIAL[`${s.kind}.${s.plan}`]; s.status = 'prepared';
  if (s.amountMinor > s.maxOfficialAmountMinor) { s.status = 'failed_precharge'; s.errorCode = 'official_amount_exceeds_cap'; s.message = '官方金额超过发行者授权上限'; }
  return c.json(ok200(pubView(s)));
});
for (const K of ['x', 'tg'] as const) app.post('/api/public/' + K + '-cdk/redeem', async c => {
  const b = await c.req.json(); const s = socialFind(K, b);
  if (!s) return err(c, 404, '兑换码不存在');
  if (s.device !== b.deviceToken || s.clientRequestId !== b.clientRequestId) return err(c, 409, '绑定信息不匹配', 'BINDING_MISMATCH');
  if (s.amountMinor !== b.expectedAmountMinor || s.currency !== b.currency) return err(c, 409, '报价已变化', 'QUOTE_CHANGED');
  if (s.status === 'prepared') {
    s.status = 'funding';
    later(1500, () => {
      if (/fail/i.test(s.recipient || '')) { s.status = 'failed_precharge'; s.errorCode = 'funding_failed'; s.message = '卡片准备失败'; s.canRetryPreflight = true; return; }
      s.status = 'funded';
    });
  } else if (s.status === 'funded') {
    s.status = 'paying';
    later(2000, async () => { await addTx(s.kind === 'x' ? 'X CORP. PAID FEATURES' : 'TELEGRAM PREMIUM', (s.amountMinor! / 100).toFixed(2), 'APPROVED'); s.status = 'completed'; });
  }
  return c.json(ok200(pubView(s)));
});
for (const K of ['x', 'tg'] as const) app.post('/api/public/' + K + '-cdk/result', async c => {
  const b = await c.req.json(); const s = socialFind(K, b);
  if (!s || s.device !== b.deviceToken) return err(c, 404, '找不到兑换');
  return c.json(ok200(pubView(s)));
});

/* ---------------- 流水 ---------------- */
app.get('/api/v1/cards/all-transactions', c => c.json(ok0({ total: txs.length, list: txs.slice(0, 100), source: 'db', activityTotal: 0, activities: [] })));

/* ---------------- 测试辅助 ---------------- */
// 修改 GPT 售价（测试价格保护）
app.post('/mock/price', async c => { const b = await c.req.json(); GPT_PRICES[b.plan] = b.price; return c.json({ ok: true }); });
// 假的 Telegram Bot API：记录收到的消息
const tgMessages: any[] = [];
app.post('/:bot/sendMessage', async c => { const b = await c.req.json(); tgMessages.push({ token: c.req.param('bot').replace(/^bot/, ''), ...b }); return c.json({ ok: true, result: { message_id: tgMessages.length } }); });
app.get('/mock/telegram', c => c.json(tgMessages));

payMock(app, process.env.MOCK_PUBLIC_URL || `http://localhost:${PORT}`);

app.onError((e, c) => { console.error('[mock]', e.message); return err(c, e.message === 'missing idem' ? 400 : 500, e.message); });
serve({ fetch: app.fetch, port: PORT }, () => console.log(`[mock] 模拟卡台已启动 http://localhost:${PORT}  (App-Id=${APP_ID}  Secret=${APP_SECRET})\n[mock] Webhook → ${WEBHOOK_URL}`));

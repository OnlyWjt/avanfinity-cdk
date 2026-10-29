/**
 * 端到端测试：对本地模拟卡台跑完整流程
 *   1) npm run mock      2) DATA_DIR=data-e2e npm start      3) npm run test:e2e
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.E2E_BASE || 'http://localhost:8080';
let cookie = '';
let fails = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data: any = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => Promise<any>, pred: (v: any) => boolean, ms = 20000) {
  const t = Date.now(); let v;
  while (Date.now() - t < ms) { v = await fn(); if (pred(v)) return v; await sleep(700); }
  return v;
}

const sess = (email: string, plan = 'free') => JSON.stringify({ user: { id: 'user-' + email, email }, accessToken: 'tok_' + email, plan });

// ---- 初始化 ----
const setup = await api('GET', '/api/auth/setup');
if (setup.data.needSetup) await api('POST', '/api/auth/setup', { email: 'admin@test.com', password: 'password123', name: 'Admin' });
const login = await api('POST', '/api/auth/login', { email: 'admin@test.com', password: 'password123' });
ok(login.status === 200, '管理员登录');
ok((await api('PUT', '/api/admin/settings/avan', { baseUrl: process.env.MOCK_BASE || 'http://localhost:8090', appId: 'app_mock', appSecret: 'sk_mock' })).status === 200, '保存卡台凭据');
await api('PUT', '/api/admin/webhooks/secret', { secret: 'whsec_' + '0'.repeat(64) });
await api('PUT', '/api/admin/settings/payment', { productCode: 'MOCK-VISA-US' });
const t = await api('POST', '/api/admin/settings/avan/test');
ok(t.data.ok, '卡台连接测试 ' + JSON.stringify(t.data.checks || t.data.error));

// ---- 策略 ----
const strat = await api('POST', '/api/admin/strategies', { name: 'E2E 严格' + Date.now() % 1000, prod: ['gpt', 'x', 'tg'], mode: 'own', prefix: 'E' + (Date.now() % 1000), accN: 1, accDays: 30, freeOnly: true, failAct: 'retry', retryN: 1, priceTol: 10, priceAct: 'manual', ipH: 500, devD: 100, captcha: 100 });
ok(strat.status === 200, '创建自有码策略 ' + (strat.data.error || strat.data.prefix));
const hosted = (await api('GET', '/api/admin/strategies')).data.list.find((s: any) => s.isDefault);
await api('PUT', `/api/admin/strategies/${hosted.id}`, { ...hosted, mode: 'hosted', ipH: 500, devD: 100, captcha: 100 });

// ---- 生成 ----
const gOwn = await api('POST', '/api/admin/batches', { product: 'gpt', plan: 'plus', quantity: 3, strategyId: strat.data.id, idemKey: 'gen-' + randomUUID() });
ok(gOwn.data.codes?.length === 3, `生成 GPT 自有码 ×3 ${gOwn.data.codes?.[0] || gOwn.data.error}`);
const gHost = await api('POST', '/api/admin/batches', { product: 'gpt', plan: 'go', quantity: 1, strategyId: hosted.id, idemKey: 'gen-' + randomUUID() });
ok(gHost.data.codes?.[0]?.startsWith('AVF-'), `生成 GPT 托管码 ${gHost.data.codes?.[0] || gHost.data.error}`);
const idem = 'gen-' + randomUUID();
const xOwn = await api('POST', '/api/admin/batches', { product: 'x', plan: 'premium_3m', quantity: 1, strategyId: strat.data.id, idemKey: idem });
ok(xOwn.data.codes?.length === 1, `生成 X 自有码 ${xOwn.data.error || ''}`);
const replay = await api('POST', '/api/admin/batches', { product: 'x', plan: 'premium_3m', quantity: 1, strategyId: strat.data.id, idemKey: idem });
ok(replay.data.replayed && replay.data.batchId === xOwn.data.batchId, '相同幂等键重放同一批次');
const tgHost = await api('POST', '/api/admin/batches', { product: 'tg', plan: 'premium_6m', quantity: 1, strategyId: hosted.id, idemKey: 'gen-' + randomUUID() });
ok(tgHost.data.codes?.[0]?.startsWith('TGCD-'), `生成 TG 托管码 ${tgHost.data.codes?.[0] || tgHost.data.error}`);

// ---- 公开兑换 ----
const dev = randomUUID();
const pubApi = (p: string, b: any) => api('POST', '/api/public' + p, { device: dev, ...b });
const status = (rid: string) => api('GET', `/api/public/redeem/status?rid=${rid}&device=${dev}`).then(r => r.data);

// 1. GPT 自有码正常
let s = await pubApi('/redeem/start', { code: gOwn.data.codes[0].toLowerCase() });
ok(s.data.needs === 'session', `GPT 自有码输码 → ${s.data.status || s.data.error}`);
let a = await pubApi('/redeem/account', { rid: s.data.rid, session: sess('alice@gmail.com') });
ok(a.data.needs === 'confirm', `GPT 预检 → ${a.data.status || a.data.error} ${a.data.account || ''}`);
let cf = await pubApi('/redeem/confirm', { rid: s.data.rid });
ok(['processing', 'completed'].includes(cf.data.status), `GPT 确认 → ${cf.data.status || cf.data.error}`);
let fin = await until(() => status(s.data.rid), v => ['completed', 'failed'].includes(v.status));
ok(fin.status === 'completed', `GPT 自有码开通 → ${fin.status} ${fin.message || ''}`);
const again = await pubApi('/redeem/start', { code: gOwn.data.codes[0] });
ok(again.data.code === 'ALREADY_REDEEMED', '已兑换的码不能再兑');

// 2. 同一账号第二张码 → 策略拦截，码不消耗
s = await pubApi('/redeem/start', { code: gOwn.data.codes[1] });
a = await pubApi('/redeem/account', { rid: s.data.rid, session: sess('alice@gmail.com') });
ok(a.data.status === 'blocked' && a.data.codeReusable, `同账号限兑 → ${a.data.status}：${a.data.message}`);
// 3. 已是 Plus 的账号 → 只允许 Free
a = await pubApi('/redeem/account', { rid: s.data.rid, session: sess('bob@gmail.com', 'plus') });
ok(a.data.status === 'blocked', `只允许 Free → ${a.data.status}：${a.data.message}`);
// 4. 失败自动重试（decline 账号两次都失败 → 释放）
a = await pubApi('/redeem/account', { rid: s.data.rid, session: sess('decline@gmail.com') });
cf = await pubApi('/redeem/confirm', { rid: s.data.rid });
fin = await until(() => status(s.data.rid), v => v.status === 'failed', 30000);
ok(fin.status === 'failed' && fin.attempts === 2 && fin.codeReusable, `拒付 → 自动重试 1 次后释放 (attempts=${fin.attempts}) ${fin.message}`);
// 释放后换账号可以再兑
a = await pubApi('/redeem/account', { rid: s.data.rid, session: sess('carol@gmail.com') });
ok(a.data.needs === 'confirm', `释放后换账号重新兑换 → ${a.data.status || a.data.error}`);

// 5. GPT 托管码
s = await pubApi('/redeem/start', { code: gHost.data.codes[0] });
a = await pubApi('/redeem/account', { rid: s.data.rid, session: sess('dave@outlook.com') });
await pubApi('/redeem/confirm', { rid: s.data.rid });
fin = await until(() => status(s.data.rid), v => ['completed', 'failed'].includes(v.status));
ok(fin.status === 'completed', `GPT 托管码开通 → ${fin.status}`);

// 6. X 自有码两阶段
s = await pubApi('/redeem/start', { code: xOwn.data.codes[0] });
ok(s.data.needs === 'recipient', `X 输码 → ${s.data.status || s.data.error}`);
a = await pubApi('/redeem/account', { rid: s.data.rid, recipient: '@already_prem' });
ok(a.data.status === 'blocked', `X 已是会员 → ${a.data.status}：${a.data.message}`);
a = await pubApi('/redeem/account', { rid: s.data.rid, recipient: '@elonfan' });
ok(a.data.needs === 'confirm', `X 换账号报价 → ${a.data.status || a.data.error} ${JSON.stringify(a.data.quote)}`);
cf = await pubApi('/redeem/confirm', { rid: s.data.rid });
let fd = await until(() => status(s.data.rid), v => v.status === 'funded');
ok(fd.needs === 'pay', `X 第一阶段准备完成 → ${fd.status}`);
await pubApi('/redeem/confirm', { rid: s.data.rid });
fin = await until(() => status(s.data.rid), v => ['completed', 'failed'].includes(v.status));
ok(fin.status === 'completed', `X 付款完成 → ${fin.status}`);

// 7. TG 托管码
s = await pubApi('/redeem/start', { code: tgHost.data.codes[0] });
a = await pubApi('/redeem/account', { rid: s.data.rid, recipient: 'neko_dev' });
await pubApi('/redeem/confirm', { rid: s.data.rid });
await until(() => status(s.data.rid), v => v.status === 'funded');
await pubApi('/redeem/confirm', { rid: s.data.rid });
fin = await until(() => status(s.data.rid), v => ['completed', 'failed'].includes(v.status));
ok(fin.status === 'completed', `TG 托管码开通 → ${fin.status}`);

// 8. 凭证、其他设备
ok((await pubApi('/receipt', { code: tgHost.data.codes[0] })).data.status === 'completed', '同设备查询凭证');
ok((await api('POST', '/api/public/receipt', { device: randomUUID(), code: tgHost.data.codes[0] })).status === 404, '其他设备查不到凭证');

// ---- 管理端 ----
await sleep(1500);
const ov = await api('GET', '/api/admin/overview');
ok(ov.data.today?.redeemed >= 4, `总览今日兑换 ${ov.data.today?.redeemed}，拦截 ${ov.data.blockedToday?.total}`);
const reds = await api('GET', '/api/admin/redemptions?f=blocked');
ok(reds.data.total >= 2, `兑换记录：策略拦截 ${reds.data.total} 条`);
const wh = await api('GET', '/api/admin/webhooks');
ok(wh.data.stats.total24h > 0, `收到 Webhook ${wh.data.stats.total24h} 条，失败 ${wh.data.stats.failed24h}`);
const sync = await api('POST', '/api/admin/transactions/sync');
const txs = await api('GET', '/api/admin/transactions');
ok(txs.data.total > 0 && !JSON.stringify(txs.data).match(/cardId|cardNumber/), `支付流水 ${txs.data.total} 条，不含卡信息（关联 ${txs.data.list.filter((x: any) => x.redemptionId).length} 条）`);
const codes = await api('GET', '/api/admin/codes?product=gpt');
const unusedOwn = codes.data.list.find((c: any) => c.status === 'unused' && c.mode === 'own');
const rv = await api('POST', '/api/admin/codes/revoke', { ids: [unusedOwn.id] });
ok(rv.data.results?.[0]?.ok, '撤销自有码');
const ex = await api('POST', '/api/admin/codes/export', { ids: [unusedOwn.id] });
ok(ex.data.list?.[0]?.code?.startsWith(strat.data.prefix + '-'), '导出自有码');
const test = await api('POST', '/api/admin/strategies/test', { code: gOwn.data.codes[1], account: 'alice@gmail.com', currentPlan: 'free' });
ok(test.data.result, `规则测试 → ${test.data.result} ${test.data.rule || ''}`);

console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);

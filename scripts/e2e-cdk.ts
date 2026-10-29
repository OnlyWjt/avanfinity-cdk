/**
 * GPT 卡台 CDK：点数（Credits）和结账地区 端到端测试（对本地模拟卡台）
 *   npm test 会自动跑；单独跑：先启动 mock 和系统，再 node --no-warnings scripts/e2e-cdk.ts
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.E2E_BASE || 'http://localhost:8080';
const MOCK = process.env.MOCK_BASE || 'http://localhost:8090';
let cookie = '', fails = 0;
// 独立的来源 IP（npm test 下 TRUST_PROXY=1）：不和其他测试脚本共用登录 / 接口限流额度
const newIp = () => `10.78.${(Math.random() * 250) | 1}.${(Math.random() * 250) | 1}`;
let IP = newIp();
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Forwarded-For': IP }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) as any };
}
const mock = (path: string, body?: unknown) => fetch(MOCK + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json() as any);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 20000) {
  const t = Date.now(); let v = await fn();
  while (!pred(v) && Date.now() - t < ms) { await sleep(900); v = await fn(); }
  return v;
}
let mailN = 0;
const mail = (kind: string) => `${kind}${++mailN}.${Date.now() % 100000}` + String.fromCharCode(64) + 'example.com';
const sess = (email: string, plan = 'free') => JSON.stringify({ user: { id: 'user-' + email, email }, accessToken: 'tok_' + email, sessionToken: 'st_' + email, plan });

/** 走一遍兑换：输码 → 贴 Session → 确认，等到结束 */
async function redeem(code: string, session: string) {
  const device = randomUUID();
  IP = newIp();
  const pub = (p: string, b: any) => api('POST', '/api/public' + p, { device, ...b }).then(r => r.data);
  const s = await pub('/redeem/start', { code });
  if (!s.rid) return { error: s.error };
  const a = await pub('/redeem/account', { rid: s.rid, session });
  if (a.needs !== 'confirm') return { rid: s.rid, ...a };
  await pub('/redeem/confirm', { rid: s.rid });
  const fin = await until(() => api('GET', `/api/public/redeem/status?rid=${s.rid}&device=${device}`).then(r => r.data), v => ['completed', 'failed', 'manual_review', 'requires_action', 'blocked'].includes(v.status));
  return { rid: s.rid, ...fin };
}
const gen = (plan: string, quantity: number, strategyId: string) => api('POST', '/api/admin/batches', { product: 'gpt', plan, quantity, strategyId, idemKey: 'gen-' + randomUUID() });

// ---- 准备 ----
const setup = await api('GET', '/api/auth/setup');
if (setup.data.needSetup) await api('POST', '/api/auth/setup', { email: 'admin@test.com', password: 'password123', name: 'Admin' });
ok((await api('POST', '/api/auth/login', { email: 'admin@test.com', password: 'password123' })).status === 200, '管理员登录');
await api('PUT', '/api/admin/settings/avan', { baseUrl: MOCK, appId: 'app_mock', appSecret: 'sk_mock' });
await mock('/mock/cdk', { regionSelection: true, creditUsd: 0.04, cdkRegions: [], generated: [] });
await api('POST', '/api/admin/pricing/refresh');

const tag = Date.now() % 1000;
const base = { prod: ['gpt'], ipH: 5000, devD: 1000, captcha: 1000, accN: 100, priceTol: 50, priceAct: 'manual' };
const own = (await api('POST', '/api/admin/strategies', { ...base, name: '点数' + tag, mode: 'own', prefix: 'CR' + tag, freeOnly: true })).data;
const hosted = (await api('POST', '/api/admin/strategies', { ...base, name: '托管' + tag, mode: 'hosted' })).data;
ok(own.id && hosted.id, '创建自有码 / 托管码策略');

// 1. 目录：点数固定面额，成本按套餐目录估算，没有库存
const cat = (await api('GET', '/api/admin/catalog')).data;
const c1000 = cat.gpt.find((p: any) => p.key === 'credits_1000');
ok(c1000?.credits && c1000.enabled && c1000.cost === 40.8 && c1000.stock == null && c1000.label === 'ChatGPT 1,000 点数', `目录里有点数套餐：${c1000?.label} 预估 $${c1000?.cost}（$40 + 服务费 $0.80）`);
ok(cat.gpt.find((p: any) => p.key === 'plus')?.credits === false, '订阅套餐不是点数');

// 2. 生成：固定面额、自定义点数；托管码 / 非法点数被拒绝
let g = await gen('credits_1000', 2, own.id);
ok(g.status === 200 && g.data.codes?.length === 2, `自有码策略生成 1000 点 ×2 ${g.data.error || ''}`);
const codes1000 = g.data.codes as string[];
g = await gen('credits_800', 1, own.id);
ok(g.status === 200 && g.data.label === 'ChatGPT 800 点数', `自定义 800 点生成成功，标签「${g.data.label}」`);
const code800 = g.data.codes?.[0];
const batch800 = (await api('GET', '/api/admin/batches')).data.list.find((b: any) => b.id === g.data.batchId) || {};
ok(Math.abs(Number(batch800.cost) - 32.8) < 0.01, `自定义点数按最接近面额的单价估算成本 $${batch800.cost}（800 × $0.04 + $0.80）`);
g = await gen('credits_1000', 1, hosted.id);
ok(g.status === 400 && /自有码/.test(g.data.error), `托管码策略不能生成点数 → ${g.data.error}`);
for (const bad of ['credits_249', 'credits_0800', 'credits_10000000', 'credits_abc']) ok((await gen(bad, 1, own.id)).status === 400, `${bad} 被拒绝`);
// 卡台生成在兑换时才发生（自有码）：这里先确认还没有向卡台生成点数码
ok(!(await mock('/mock/cdk', {})).generated.some((p: string) => p.startsWith('credits_')), '自有码生成时不向卡台下单（兑换时才生成）');

// 3. 兑换：点数不受「只允许 Free」限制；按点数报价扣费；完成页没有续费
let r = await redeem(codes1000[0], sess(mail('plususer'), 'plus'));
ok(r.status === 'completed', `已订阅 Plus 的账号也能兑换点数（策略只允许 Free 账号）→ ${r.status} ${r.message || r.error || ''}`);
ok((await mock('/mock/cdk', {})).generated.includes('credits_1000'), '兑换时向卡台生成了 credits_1000 的 CDK');
ok(r.planLabel === 'ChatGPT 1,000 点数' && r.quote?.amountMinor === 4020, `报价按点数计：${r.quote?.amountMinor} 分（1000 × $0.04 + 模拟税费）`);
r = await redeem(code800, sess(mail('free')));
ok(r.status === 'completed' && (await mock('/mock/cdk', {})).generated.includes('credits_800'), `自定义 800 点兑换完成 → ${r.status}`);
// 订阅套餐仍然受「只允许 Free」限制
const sub = await gen('go', 1, own.id);
r = await redeem(sub.data.codes[0], sess(mail('plususer'), 'plus'));
ok(r.status === 'blocked', `订阅套餐仍然按「只允许 Free」拦截 Plus 账号 → ${r.status}`);

// 4. 结账地区：卡台支持时带上 paymentCountry，不支持时省略；卡台不支持的地区不能生成
const ph = (await api('POST', '/api/admin/strategies', { ...base, name: '托管PH' + tag, mode: 'hosted', country: 'PH' })).data;
await mock('/mock/cdk', { cdkRegions: [] });
let h = await gen('go', 1, ph.id);
ok(h.data.codes?.length === 1 && (await mock('/mock/cdk', {})).cdkRegions.includes('PH'), '卡台支持选地区时，生成 CDK 带上 paymentCountry=PH');
await mock('/mock/cdk', { regionSelection: false });
await api('POST', '/api/admin/pricing/refresh');
h = await gen('go', 1, ph.id);
ok(h.data.codes?.length === 1, `卡台不支持选地区时省略该字段，照常生成 ${h.data.error || ''}`);
await mock('/mock/cdk', { regionSelection: true });
await api('POST', '/api/admin/pricing/refresh');
const jp = (await api('POST', '/api/admin/strategies', { ...base, name: '托管JP' + tag, mode: 'hosted', country: 'JP' })).data;
ok((await gen('go', 1, jp.id)).status === 400, '卡台不支持的结账地区不能生成');

// 5. 直充接口已经去掉
ok((await api('GET', '/api/admin/direct/guard')).status === 404, '直充资金护栏接口已移除');

console.log(fails ? `✗ ${fails} 项失败` : '✓ 全部通过');
process.exit(fails ? 1 : 0);

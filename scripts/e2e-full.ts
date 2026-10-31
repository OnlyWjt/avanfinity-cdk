/**
 * 扩展测试：安全、权限、校验、价格保护审核、时段 / 维护 / 撤销、两步验证、通知
 * 前置：模拟卡台 + 服务已启动（服务需带 TELEGRAM_API_BASE=http://localhost:8090 NOTIFY_SCAN_MS=2000），并已跑过 e2e.ts
 */
import { randomUUID, createHmac } from 'node:crypto';

const BASE = process.env.E2E_BASE || 'http://localhost:8080';
const MOCK = process.env.MOCK_BASE || 'http://localhost:8090';
let fails = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) if (sc.startsWith('cdk_sid=')) cookie = sc.split(';')[0];
    const data: any = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
}
const admin = client();
const sess = (id: string, email: string, plan = 'free') => JSON.stringify({ user: { id, email }, accessToken: 't', plan });
async function until(fn: () => Promise<any>, pred: (v: any) => boolean, ms = 20000) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (pred(v)) return v; await sleep(700); } return v; }

/* ---------- 准备 ---------- */
ok((await admin('POST', '/api/auth/login', { email: 'admin@test.com', password: 'password123' })).status === 200, '管理员登录');
const anon = client();

/* ---------- 安全 ---------- */
ok((await anon('GET', '/api/admin/overview')).status === 401, '未登录访问管理接口 → 401');
ok((await admin('POST', '/api/admin/codes/revoke', 'ids=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status === 415, '管理接口拒绝非 JSON 提交（防跨站表单）→ 415');
ok((await anon('POST', '/api/auth/login', { email: 'admin@test.com', password: 'wrong' })).status === 401, '密码错误 → 401');
ok((await anon('POST', '/api/auth/setup', { email: 'x@x.com', password: '12345678' })).status === 403, '已有管理员时不能再初始化 → 403');
const page = await fetch(BASE + '/admin/index.html', { redirect: 'manual' });
ok(page.status === 302, '未登录打开后台页面会跳转登录');

const secret = 'whsec_' + '0'.repeat(64);
async function hook(body: object, opts: { id?: string; ts?: number; sig?: string } = {}) {
  const raw = JSON.stringify(body), id = opts.id || `evt_${randomUUID().replace(/-/g, '').slice(0, 8)}_00000000_00000000_00000000`, ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = opts.sig || 'v1=' + createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  const r = await fetch(BASE + '/api/webhooks/avanfinity', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Avanfinity-Webhook-Id': id, 'X-Avanfinity-Webhook-Timestamp': ts, 'X-Avanfinity-Signature': sig }, body: raw });
  return r.status;
}
ok(await hook({ type: 'webhook.test' }, { sig: 'v1=' + 'a'.repeat(64) }) === 401, 'Webhook 伪造签名 → 401');
ok(await hook({ type: 'webhook.test' }, { ts: Math.floor(Date.now() / 1000) - 3600 }) === 400, 'Webhook 时间戳过期 → 400');
const dupId = `evt_${randomUUID().replace(/-/g, '').slice(0, 8)}_11111111_22222222_33333333`;
ok(await hook({ type: 'webhook.test', data: { object: {} } }, { id: dupId }) === 200 && await hook({ type: 'webhook.test', data: { object: {} } }, { id: dupId }) === 200, 'Webhook 重复投递返回 200');
const evs = (await admin('GET', '/api/admin/webhooks')).data.events.filter((e: any) => e.id === dupId);
ok(evs.length === 1, 'Webhook 重复事件只记录一次（去重）');

/* ---------- 校验 ---------- */
const strategies = (await admin('GET', '/api/admin/strategies')).data.list;
const def = strategies.find((s: any) => s.isDefault);
ok((await admin('DELETE', '/api/admin/strategies/' + def.id)).status === 400, '默认策略不能删除');
ok((await admin('PUT', '/api/admin/strategies/' + def.id, { ...def, mode: def.mode === 'own' ? 'hosted' : 'own', prefix: 'ZZZ' })).status === 400, '已生成过码的策略不能切换码模式');
const used = strategies.find((s: any) => s.mode === 'own');
ok((await admin('POST', '/api/admin/strategies', { name: '重复前缀', prod: ['gpt'], mode: 'own', prefix: used.prefix })).status === 400, '自有码前缀不能重复');
ok((await admin('POST', '/api/admin/strategies', { name: '坏前缀', prod: ['gpt'], mode: 'own', prefix: 'A' })).status === 400, '前缀太短被拒绝');
ok((await admin('POST', '/api/admin/strategies', { name: '无产品', prod: [], mode: 'own', prefix: 'NOP' })).status === 400, '没有适用产品被拒绝');
ok((await admin('POST', '/api/admin/batches', { product: 'gpt', plan: 'plus', quantity: 51, strategyId: def.id, idemKey: 'gen-' + randomUUID() })).status === 400, '一次生成超过 50 张被拒绝');
const wq = await admin('POST', '/api/admin/batches', { product: 'gpt', plan: 'pro_25x', quantity: 1, strategyId: def.id, idemKey: 'gen-' + randomUUID() });
ok(wq.status === 409, `等待报价的套餐不能生成 → ${wq.status} ${wq.data.error}`);
ok((await admin('POST', '/api/admin/batches', { product: 'gpt', plan: 'nope', quantity: 1, strategyId: def.id, idemKey: 'gen-' + randomUUID() })).status === 400, '不存在的套餐被拒绝');

/* ---------- 新策略：价格保护转人工 ---------- */
const pfx = 'P' + String(Date.now()).slice(-4);
const st = (await admin('POST', '/api/admin/strategies', { name: '测试价格保护 ' + pfx, prod: ['gpt', 'tg'], mode: 'own', prefix: pfx, ipH: 500, devD: 100, captcha: 100, accN: 5, priceTol: 5, priceAct: 'manual', failAct: 'release' })).data;
ok(st.id, '创建价格保护策略');
const gen = (await admin('POST', '/api/admin/batches', { product: 'gpt', plan: 'go', quantity: 4, strategyId: st.id, idemKey: 'gen-' + randomUUID() })).data;
ok(gen.codes?.length === 4, '生成 4 张 Go 自有码');
await fetch(MOCK + '/mock/price', { method: 'POST', body: JSON.stringify({ plan: 'go', price: '5.90' }) });   // +20%
await admin('POST', '/api/admin/pricing/refresh');

const dev = randomUUID();
const pub = (p: string, b: any, d = dev) => anon('POST', '/api/public/redeem/' + p, { device: d, ...b });
const status = (rid: string, d = dev) => anon('GET', `/api/public/redeem/status?rid=${rid}&device=${d}`).then(r => r.data);

let s = await pub('start', { code: gen.codes[0] });
let a = await pub('account', { rid: s.data.rid, session: sess('u-price-1', 'price1@gmail.com') });
ok(a.data.status === 'manual_review', `售价上涨 20% → 转人工审核：${a.data.message}`);
ok((await anon('GET', `/api/public/redeem/status?rid=${s.data.rid}&device=${randomUUID()}`)).status === 404, '其他设备查不到这条兑换');
ok((await anon('GET', `/api/public/redeem/status?rid=${s.data.rid}&device=bad`)).status === 400, '非法设备 ID → 400');
const ap = await admin('POST', `/api/admin/redemptions/${s.data.rid}/approve`);
ok(ap.status === 200, '管理员通过审核');
let fin = await until(() => status(s.data.rid), v => ['completed', 'failed'].includes(v.status));
ok(fin.status === 'completed', `审核通过后自动开通 → ${fin.status}`);

s = await pub('start', { code: gen.codes[1] });
a = await pub('account', { rid: s.data.rid, session: sess('u-price-2', 'price2@gmail.com') });
await admin('POST', `/api/admin/redemptions/${s.data.rid}/reject`, { reason: '测试拒绝' });
const rj = await status(s.data.rid);
ok(rj.status === 'blocked' && rj.codeReusable, `管理员拒绝 → 用户看到拦截，码仍可用：${rj.message}`);
await fetch(MOCK + '/mock/price', { method: 'POST', body: JSON.stringify({ plan: 'go', price: '4.90' }) });
await admin('POST', '/api/admin/pricing/refresh');

/* ---------- 撤销 / 时段 / 维护 / 产品关闭 ---------- */
const codes = (await admin('GET', `/api/admin/codes?product=gpt&strategy=${st.id}&status=unused`)).data.list;
const toRevoke = codes.find((c: any) => c.display.startsWith(pfx)) ;
await admin('POST', '/api/admin/codes/revoke', { ids: [toRevoke.id] });
const revokedFull = (await admin('POST', '/api/admin/codes/export', { ids: [toRevoke.id] })).data.list[0].code;
ok((await pub('start', { code: revokedFull })).data.code === 'REVOKED', '撤销后的码不能兑换');
ok((await pub('start', { code: 'NOPE-AAAA-BBBB-CCCC' })).data.code === 'INVALID_CODE', '不存在的码 → 无效');

await admin('PUT', '/api/admin/strategies/' + st.id, { ...st, timeOn: true, from: '03:00', to: '03:01' });
const remain = (await admin('GET', `/api/admin/codes?product=gpt&strategy=${st.id}&status=unused`)).data.list[0];
const remainFull = (await admin('POST', '/api/admin/codes/export', { ids: [remain.id] })).data.list[0].code;
const tw = await pub('start', { code: remainFull });
ok(tw.data.code === 'BLOCKED' && /兑换时间/.test(tw.data.error), `不在兑换时段 → 拦截：${tw.data.error}`);
await admin('PUT', '/api/admin/strategies/' + st.id, { ...st, timeOn: false });

await admin('PUT', '/api/admin/settings/redeem', { maintenance: true, maintenanceMsg: '维护测试' });
ok((await pub('start', { code: remainFull })).data.code === 'MAINTENANCE', '维护模式下不能兑换');
await admin('PUT', '/api/admin/settings/redeem', { maintenance: false, products: { gpt: false, x: true, tg: true } });
ok((await pub('start', { code: remainFull })).data.code === 'PRODUCT_CLOSED', '关闭 ChatGPT 后不能兑换 GPT 码');
await admin('PUT', '/api/admin/settings/redeem', { products: { gpt: true, x: true, tg: true } });
ok((await pub('start', { code: remainFull })).data.needs === 'session', '重新开放后可以兑换');

/* ---------- 权限 ---------- */
const email = `support${Date.now()}@test.com`;
await admin('POST', '/api/admin/users', { name: '客服', email, password: 'support123', role: 'support' });
const sup = client();
ok((await sup('POST', '/api/auth/login', { email, password: 'support123' })).status === 200, '客服账号登录');
ok((await sup('GET', '/api/admin/codes?product=gpt')).status === 200, '客服可以查看兑换码');
ok((await sup('POST', '/api/admin/codes/export', { ids: [remain.id] })).status === 403, '客服不能导出完整码 → 403');
ok((await sup('POST', '/api/admin/strategies', { name: 'x', prod: ['gpt'], mode: 'hosted' })).status === 403, '客服不能新建策略 → 403');
ok((await sup('GET', '/api/admin/settings')).status === 403, '客服不能查看卡台设置 → 403');
ok((await sup('PUT', '/api/admin/theme', { name: 'hack' })).status === 403, '客服不能改主题 → 403');

/* ---------- 两步验证 ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const totp = (secretB32: string) => {
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of secretB32) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(out)).update(buf).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
};
const setup = (await sup('POST', '/api/auth/totp/setup')).data;
ok((await sup('POST', '/api/auth/totp/enable', { code: '000000' })).status === 400, '错误的验证码不能开启两步验证');
ok((await sup('POST', '/api/auth/totp/enable', { code: totp(setup.secret) })).status === 200, '开启两步验证');
const sup2 = client();
const l1 = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'support123' }) });
const tmp = l1.headers.getSetCookie().find(c => c.startsWith('cdk_tmp='))!.split(';')[0];
ok((await l1.json() as any).needTotp, '开启后登录需要验证码');
const l2 = await fetch(BASE + '/api/auth/totp', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: tmp }, body: JSON.stringify({ code: totp(setup.secret) }) });
ok(l2.status === 200, '输入正确验证码后登录成功');
const bad = await fetch(BASE + '/api/auth/totp', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: tmp }, body: JSON.stringify({ code: totp(setup.secret) }) });
ok(bad.status === 401, '临时登录凭证只能用一次');
void sup2;

/* ---------- 通知 ---------- */
const tok = '123456:' + 'A'.repeat(35);
ok((await admin('PUT', '/api/admin/settings/notify', { tgToken: 'bad', tgChatId: '1' })).status === 400, '错误的 Bot Token 被拒绝');
ok((await admin('PUT', '/api/admin/settings/notify', { tgToken: tok, tgChatId: '10001', failAlert: true, lowStock: true, dailyReport: false, lowStockThreshold: 20 })).status === 200, '保存 Telegram 通知设置');
const t = await admin('POST', '/api/admin/settings/notify/test');
const msgs = await fetch(MOCK + '/mock/telegram').then(r => r.json()) as any[];
ok(t.status === 200 && msgs.some(m => m.chat_id === '10001' && /测试成功/.test(m.text)), `发送测试通知 ${t.data.error || ''}`);
// 触发一笔需要关注的兑换（价格保护）
await fetch(MOCK + '/mock/price', { method: 'POST', body: JSON.stringify({ plan: 'go', price: '5.90' }) });
await admin('POST', '/api/admin/pricing/refresh');
s = await pub('start', { code: remainFull });
a = await pub('account', { rid: s.data.rid, session: sess('u-notify', 'notify@gmail.com') });
const got = await until(() => fetch(MOCK + '/mock/telegram').then(r => r.json()), (m: any[]) => m.some(x => /需要关注/.test(x.text)), 15000);
ok(got.some((x: any) => /需要关注/.test(x.text) && /待审核/.test(x.text)), '兑换转人工后推送了 Telegram 提醒');
await admin('POST', `/api/admin/redemptions/${s.data.rid}/reject`, {});
await fetch(MOCK + '/mock/price', { method: 'POST', body: JSON.stringify({ plan: 'go', price: '4.90' }) });
await admin('POST', '/api/admin/pricing/refresh');
await admin('PUT', '/api/admin/settings/notify', { tgToken: '', tgChatId: '', failAlert: false, lowStock: false, dailyReport: false });

/* ---------- 审计 ---------- */
const au = (await admin('GET', '/api/admin/audit')).data.list;
ok(au.some((x: any) => x.action === 'cdk.export') && au.some((x: any) => x.action === 'redemption.approve'), '导出和审核操作写入了审计日志');

console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);

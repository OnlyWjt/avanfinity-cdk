/**
 * GPT 直充 + 资金护栏 端到端测试（对本地模拟卡台）
 *   npm test 会自动跑；单独跑：先启动 mock 和系统，再 node --no-warnings scripts/e2e-direct.ts
 */
import { randomUUID, createHmac } from 'node:crypto';

const BASE = process.env.E2E_BASE || 'http://localhost:8080';
const MOCK = process.env.MOCK_BASE || 'http://localhost:8090';
let cookie = '', fails = 0;
// 独立的来源 IP（npm test 下 TRUST_PROXY=1）：不和其他测试脚本共用登录 / 接口限流额度
const newIp = () => `10.77.${(Math.random() * 250) | 1}.${(Math.random() * 250) | 1}`;
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
/** 测试邮箱：前缀决定模拟卡台的行为（decline 拒付 / needsess 需补交 Session / 其他正常） */
const mail = (kind: string) => `${kind}${++mailN}.${Date.now() % 100000}` + String.fromCharCode(64) + "example.com";
const sess = (email: string) => JSON.stringify({ user: { id: 'user-' + email, email }, accessToken: 'tok_' + email, sessionToken: 'st_' + email });
const tgCount = async (word: string) => (await mock('/mock/telegram')).filter((m: any) => String(m.text).includes(word)).length;
const tasks = async () => (await mock('/mock/direct', {})).tasks as number;

/** 走一遍兑换：输码 → 贴 Session → 确认，等到停在某个状态 */
async function redeem(code: string, email: string, stopAt = ['completed', 'failed', 'manual_review', 'requires_action']) {
  const device = randomUUID();
  IP = newIp(); // 每个买家用自己的 IP，和真实情况一样分摊接口限流
  const pub = (p: string, b: any) => api('POST', '/api/public' + p, { device, ...b }).then(r => r.data);
  const s = await pub('/redeem/start', { code });
  if (!s.rid) { console.log('  输码失败：' + s.error); return { error: s.error, s }; }
  const a = await pub('/redeem/account', { rid: s.rid, session: sess(email) });
  if (a.needs !== 'confirm') return { rid: s.rid, device, ...a };
  await pub('/redeem/confirm', { rid: s.rid });
  const poll = () => api('GET', `/api/public/redeem/status?rid=${s.rid}&device=${device}`).then(r => r.data);
  const fin = await until(poll, v => stopAt.includes(v.status));
  return { rid: s.rid, device, ...fin, pub, poll };
}
const detail = (rid: string) => api('GET', '/api/admin/redemptions/' + rid).then(r => r.data);
const guard = (b: any) => api('PUT', '/api/admin/direct/guard', b).then(r => r.data);

// ---- 准备 ----
const setup = await api('GET', '/api/auth/setup');
if (setup.data.needSetup) await api('POST', '/api/auth/setup', { email: 'admin@test.com', password: 'password123', name: 'Admin' });
ok((await api('POST', '/api/auth/login', { email: 'admin@test.com', password: 'password123' })).status === 200, '管理员登录');
await api('PUT', '/api/admin/settings/avan', { baseUrl: MOCK, appId: 'app_mock', appSecret: 'sk_mock' });
await api('PUT', '/api/admin/settings/payment', { productCode: 'MOCK-VISA-US' });
await api('PUT', '/api/admin/settings/notify', { tgToken: '123456:' + 'A'.repeat(35), tgChatId: '10001', failAlert: true, lowStock: false, dailyReport: false });
await mock('/mock/direct', { fail5xxOnce: false, insufficient: false, balance: '1000.00', regionSelection: true });
await api('POST', '/api/admin/direct/guard/resume');
let g = await guard({ perOrderMaxUsd: 60, bufferPct: 15, feeBufferUsd: 2, dailyMaxUsd: 2000, maxPerCode: 3, failTrip: 0, tripAccounts: 2, lowBalanceUsd: 100 });
ok(g.perOrderMaxUsd === 60 && g.paused === false, `护栏设置 单笔 $${g.perOrderMaxUsd} / 每日 $${g.dailyMaxUsd}`);
ok((await api('PUT', '/api/admin/direct/guard', { perOrderMaxUsd: 100, dailyMaxUsd: 50 })).status === 400, '每日总额小于单笔上限被拒绝');

// ---- 策略与生成 ----
const tag = Date.now() % 1000;
const base = { prod: ['gpt'], mode: 'own', ipH: 5000, devD: 1000, captcha: 1000, accN: 100, freeOnly: false, priceTol: 50, priceAct: 'manual' };
ok((await api('POST', '/api/admin/strategies', { ...base, name: '托管直充' + tag, mode: 'hosted', delivery: 'direct' })).status === 400, '托管码策略不能选直充');
const st = await api('POST', '/api/admin/strategies', { ...base, name: '直充' + tag, prefix: 'D' + tag, delivery: 'direct', country: 'US', failAct: 'retry', retryN: 1 });
ok(st.status === 200 && st.data.delivery === 'direct', `创建直充策略 ${st.data.error || st.data.prefix}`);
const gen = (plan: string, quantity: number, strategyId = st.data.id) => api('POST', '/api/admin/batches', { product: 'gpt', plan, quantity, strategyId, idemKey: 'gen-' + randomUUID() });
const p25 = await gen('pro_25x', 1);
ok(p25.status === 400, `直充不支持 Pro 25x → ${p25.data.error}`);
const b = await gen('plus', 30);
ok(b.data.codes?.length === 30, `生成直充码 ×30 ${b.data.error || ''}`);
const codes: string[] = b.data.codes;
const firstId = (await api('GET', `/api/admin/codes?product=gpt&strategy=${st.data.id}`)).data.list[0].id;
const cd = (await api('GET', '/api/admin/codes/' + firstId)).data;
ok(cd.params?.delivery === 'direct' && cd.params?.country === 'US', `批次快照交付方式和地区 ${JSON.stringify(cd.params)}`);
ok(Math.abs(Number(cd.cost) - 20.6) < 0.01 && cd.params?.costBasis === 'direct', `直充成本快照 = 目录金额 + 服务费 → $${cd.cost}（口径 ${cd.params?.costBasis}）`);
const catG = (await api('GET', '/api/admin/catalog')).data.gpt;
ok(catG.find((x: any) => x.key === 'pro_25x')?.direct === false && Math.abs(catG.find((x: any) => x.key === 'plus')?.directCost - 20.6) < 0.01, '生成页目录：标出直充不支持的套餐，并给出直充预估成本');
// 商品和策略组合：直充不支持的套餐不能挂在直充策略上（否则买家付款后发不出货）
const bad25 = await api('POST', '/api/admin/shop/products', { product: 'gpt', plan: 'pro_25x', title: 'Pro25 测试', price: 1500, agentPrice: 1400, strategyId: st.data.id, enabled: false });
ok(bad25.status === 400, `直充策略不能绑定 Pro 25x 商品 → ${bad25.data.error}`);

// 1. 正常直充
let t0 = await tasks();
let r: any = await redeem(codes[0], mail('ok'));
ok(r.status === 'completed', `直充开通 → ${r.status} ${r.message || r.error || ''}`);
ok(r.direct === true && r.willRenew === false, `兑换页知道这是直充（续费提示按订单结果：willRenew=${r.willRenew}）`);
let d = await detail(r.rid);
ok(d.directSpend?.[0]?.status === 'spent' && Math.abs(Number(d.directSpend[0].actualUsd) - 21.3) < 0.01, `额度账本记实际花费 $${d.directSpend?.[0]?.actualUsd}（订阅 + 服务费 + 开卡费）`);
ok(d.quote?.country === 'US' && d.quote?.currency === 'USD', `按策略地区预检 ${d.quote?.country}/${d.quote?.currency}`);
ok((await tasks()) === t0 + 1, '卡台只创建了 1 个自动直充任务');
const rsv = Number(d.directSpend?.[0]?.reservedUsd);
ok(rsv > 25 && rsv < 27, `每单预算按预估计算（20.80 × 1.15 + 2 = $${rsv}），不再一律预留单笔上限`);
ok(d.directSpend[0].costVerified === 1, '费用按卡台明细核对过（订阅 + 服务费 + 开卡费都已扣款）');
ok((await api('POST', `/api/admin/redemptions/${r.rid}/resolve-direct`, { outcome: 'failed', actualUsd: 0, note: '测试' })).status === 400, '已经结束的直充不能再人工核对');
const used1 = (await api('GET', `/api/admin/codes?product=gpt&strategy=${st.data.id}&status=redeemed`)).data.list[0];
ok(used1 && (await api('GET', '/api/admin/codes/' + used1.id)).data.upstream.length === 0, '直充没有生成卡台 CDK');

// 2. 拒付：卡台内部换卡后仍失败 → 释放码，不叠加我方自动重试
r = await redeem(codes[1], mail('decline'));
ok(r.status === 'failed' && r.codeReusable && r.attempts === 1, `拒付 → ${r.status}，attempts=${r.attempts}，码可重兑=${r.codeReusable}`);
d = await detail(r.rid);
ok(d.directSpend?.[0]?.status === 'released' && Number(d.directSpend[0].actualUsd) === 1 && d.directSpend[0].costVerified === 1, `失败也按明细核对花费：两张卡的开卡费 $${d.directSpend?.[0]?.actualUsd}`);
const steps = (d.progress || []).map((p: any) => p.step);
ok(steps.length === 4 && steps[2].startsWith('开通尝试 1'), `进度：两步已完成 + 卡台两次尝试 ${steps.join(' / ')}`);
ok(!/付款|card_declined/.test(steps.join() + r.message) && d.errorCode === 'card_declined', `买家看不到「付款」和错误码（「${r.message}」），后台保留错误码 ${d.errorCode}`);

// 3. 需要补交 Session
const nsMail = mail('needsess');
r = await redeem(codes[2], nsMail);
ok(r.status === 'requires_action' && r.needs === 'resubmit', `需要补交 Session → ${r.status} / ${r.needs}`);
ok((await r.poll()).progress?.length === 3, '补交前进度停在第三步（开通中）');
await r.pub('/redeem/session', { rid: r.rid, session: sess(nsMail) });
let fin = await until(r.poll, (v: any) => v.status === 'completed');
ok(fin.status === 'completed', `补交后完成 → ${fin.status}`);

// 4. 下单响应丢失（502，但卡台已受理）→ 用原幂等键重放，不重复下单
t0 = await tasks();
await mock('/mock/direct', { fail5xxOnce: true });
r = await redeem(codes[3], mail('ok'));
ok(r.status === 'completed', `响应丢失后重放 → ${r.status}`);
ok((await tasks()) === t0 + 1, `卡台侧仍只有 1 个任务（新增 ${(await tasks()) - t0}）`);

// 5. 单笔上限
t0 = await tasks();
await guard({ perOrderMaxUsd: 10 });
r = await redeem(codes[4], mail('ok'));
d = await detail(r.rid);
ok(r.status === 'manual_review' && d.stage === 'guard' && /单笔上限/.test(d.rule), `超过单笔上限 → ${r.status}：${d.rule}`);
ok((await tasks()) === t0, '被拦下时没有向卡台下单');
await guard({ perOrderMaxUsd: 60 });
await api('POST', `/api/admin/redemptions/${r.rid}/approve`);
fin = await until(r.poll, (v: any) => ['completed', 'failed'].includes(v.status));
ok(fin.status === 'completed', `调高上限后卖家通过 → ${fin.status}`);

// 6. 每日总额
g = (await api('GET', '/api/admin/direct/guard')).data;
ok(g.usedToday > 60, `今日已占用 $${g.usedToday}`);
await guard({ dailyMaxUsd: Math.ceil(g.usedToday) + 10 });
let tg0 = await tgCount('今日额度已用完');
r = await redeem(codes[5], mail('ok'));
d = await detail(r.rid);
ok(r.status === 'manual_review' && /每日总额/.test(d.rule), `每日总额用完 → ${r.status}：${d.rule}`);
ok(await until(() => tgCount('今日额度已用完'), n => n > tg0, 5000) > tg0, 'Telegram 推送了额度告警');
await guard({ dailyMaxUsd: 2000 });
await api('POST', `/api/admin/redemptions/${r.rid}/approve`);
fin = await until(r.poll, (v: any) => v.status === 'completed');
ok(fin.status === 'completed', `恢复额度后通过 → ${fin.status}`);

// 7. 连续失败熔断
await guard({ failTrip: 2, tripAccounts: 2 });
tg0 = await tgCount('自动熔断');
const sameAcc = mail('decline');
await redeem(codes[6], sameAcc);
await redeem(codes[7], sameAcc);
g = (await api('GET', '/api/admin/direct/guard')).data;
ok(!g.paused, '同一个账号连续失败 2 笔不熔断（防止一个人让全站停摆）');
await redeem(codes[10], mail('decline'));
g = (await api('GET', '/api/admin/direct/guard')).data;
ok(g.paused && /涉及 2 个账号/.test(g.pausedReason), `失败涉及 2 个账号 → 自动暂停：${g.pausedReason}`);
ok(await until(() => tgCount('自动熔断'), n => n > tg0, 5000) > tg0, 'Telegram 推送了熔断告警');
r = await redeem(codes[8], mail('ok'));
d = await detail(r.rid);
ok(r.status === 'manual_review' && /暂停/.test(d.rule), `暂停期间 → ${r.status}：${d.rule}`);
const early = (await api('POST', `/api/admin/redemptions/${r.rid}/approve`)).data;
ok(early.status === 'manual_review' && /暂停/.test(early.rule), `还没恢复就点通过 → 接口返回仍被拦下（${early.status}）`);
ok((await api('POST', '/api/admin/direct/guard/resume')).data.paused === false, '管理员恢复直充');
await api('POST', `/api/admin/redemptions/${r.rid}/approve`);
fin = await until(r.poll, (v: any) => v.status === 'completed');
ok(fin.status === 'completed', `恢复后通过 → ${fin.status}`);
await guard({ failTrip: 0 });

// 7b. 每张码的直充次数上限：失败后买家可以重兑，每次都有开卡费
await guard({ maxPerCode: 2 });
await redeem(codes[11], mail('decline'));
await redeem(codes[11], mail('decline'));
r = await redeem(codes[11], mail('ok'));
d = await detail(r.rid);
ok(r.status === 'manual_review' && /同一张码已直充 2 次/.test(d.rule), `同一张码第 3 次直充 → ${r.status}：${d.rule}`);
await api('POST', `/api/admin/redemptions/${r.rid}/release`);
await guard({ maxPerCode: 3 });

// 7c. 需要卖家处理：买家页面不提示补交 Session；慢速查询，卖家在卡台处理好后自动完成
r = await redeem(codes[12], mail('seller'));
ok(r.status === 'requires_action' && r.needs === null, `需要卖家处理 → ${r.status}，needs=${r.needs}`);
ok((await api('POST', '/api/public/redeem/session', { device: r.device, rid: r.rid, session: sess(mail('x')) })).status === 400, '这时不能补交 Session');
fin = await until(r.poll, (v: any) => v.status === 'completed', 25000);
ok(fin.status === 'completed', `卖家在卡台处理好后，慢速查询自动跟上 → ${fin.status}`);

// 7d. 自动续费以订单实际返回为准
r = await redeem(codes[13], mail('renew'));
ok(r.status === 'completed' && r.willRenew === true, `订单自动续费仍开启 → 完成页提示（willRenew=${r.willRenew}）`);

// 8. 卡台以余额不足拒绝下单
await mock('/mock/direct', { insufficient: true });
r = await redeem(codes[9], mail('ok'));
d = await detail(r.rid);
ok(r.status === 'manual_review' && /余额不足/.test(d.rule) && d.directSpend?.[0]?.status === 'cancelled', `余额不足 → ${r.status}，额度预留已退回（${d.directSpend?.[0]?.status}）`);
await mock('/mock/direct', { insufficient: false });

// 9. 钱包余额告警
tg0 = await tgCount('钱包余额不足');
await mock('/mock/direct', { balance: '20.00' });
ok(await until(() => tgCount('钱包余额不足'), n => n > tg0, 8000) > tg0, 'Telegram 推送了钱包余额告警');
await mock('/mock/direct', { balance: '1000.00' });
g = (await api('GET', '/api/admin/direct/guard')).data;
ok(g.inUse && g.today.orders >= 8, `后台护栏面板：今日直充 ${g.today.orders} 笔，成功 ${g.today.ok}，失败 ${g.today.failed}`);

// 10. 卡台 CDK 的结账地区
const hk = await api('POST', '/api/admin/strategies', { ...base, name: '托管PH' + tag, mode: 'hosted', country: 'PH' });
ok(hk.status === 200, '创建带结账地区的托管码策略');
await mock('/mock/direct', { cdkRegions: [] });
let h = await gen('go', 1, hk.data.id);
ok(h.data.codes?.length === 1 && (await mock('/mock/direct', {})).cdkRegions.includes('PH'), '卡台支持选地区时，生成 CDK 带上 paymentCountry=PH');
await mock('/mock/direct', { regionSelection: false });
await api('POST', '/api/admin/pricing/refresh');
h = await gen('go', 1, hk.data.id);
ok(h.data.codes?.length === 1, `卡台不支持选地区时省略该字段，照常生成 ${h.data.error || ''}`);
await mock('/mock/direct', { regionSelection: true });
await api('POST', '/api/admin/pricing/refresh');
const jp = await api('POST', '/api/admin/strategies', { ...base, name: '托管JP' + tag, mode: 'hosted', country: 'JP' });
ok((await gen('go', 1, jp.data.id)).status === 400, '卡台不支持的结账地区不能生成');

// 12. 结果没出来时不能释放 / 拒绝 / 撤销；人工核对把兑换、码、额度一起更新
r = await redeem(codes[14], mail('seller'));
ok(r.status === 'requires_action', `需要卖家处理 → ${r.status}`);
ok((await api('POST', `/api/admin/redemptions/${r.rid}/release`)).status === 400, '直充没结果时不能释放兑换码（钱可能已经付了）');
ok((await api('POST', `/api/admin/redemptions/${r.rid}/reject`, { reason: 'x' })).status === 400, '也不能拒绝');
d = await detail(r.rid);
const rv = (await api('POST', '/api/admin/codes/revoke', { ids: [d.codeId] })).data;
ok(rv.results?.[0]?.ok === false && /没有结果/.test(rv.results[0].msg), `也不能撤销码 → ${rv.results?.[0]?.msg}`);
ok((await api('POST', `/api/admin/redemptions/${r.rid}/resolve-direct`, { outcome: 'completed', actualUsd: 21.3, note: '' })).status === 400, '人工核对必须写核对依据');
ok((await api('POST', `/api/admin/redemptions/${r.rid}/resolve-direct`, { outcome: 'completed', note: '卡台订单已完成' })).status === 400, '登记结果必须填实际花费');
const rs = await api('POST', `/api/admin/redemptions/${r.rid}/resolve-direct`, { outcome: 'completed', actualUsd: 21.3, note: '卡台订单已完成' });
d = await detail(r.rid);
const st12 = await r.poll();
ok(rs.status === 200 && d.status === 'completed' && st12.status === 'completed' && !st12.codeReusable, `人工核对「已开通」→ 兑换完成、码已兑换（买家页面 ${st12.status}）`);
ok(d.directSpend[0].status === 'spent' && Number(d.directSpend[0].actualUsd) === 21.3 && d.directSpend[0].costVerified === 1, '额度按填写的实际花费结算');
r = await redeem(codes[15], mail('seller'));
await api('POST', `/api/admin/redemptions/${r.rid}/resolve-direct`, { outcome: 'failed', actualUsd: 0.5, note: '卡台显示付款失败，只扣了开卡费' });
d = await detail(r.rid);
const st12b = await r.poll();
ok(d.status === 'failed' && st12b.codeReusable && d.directSpend[0].status === 'released' && Number(d.directSpend[0].actualUsd) === 0.5, `人工核对「没开通」→ 码释放可重兑，额度记开卡费 $${d.directSpend[0].actualUsd}`);

// 13. 下单响应体传到一半断开（卡台其实已受理）：按结果未知处理，用原幂等键重放，不会重新下单
t0 = await tasks();
await mock('/mock/direct', { truncateOnce: true });
r = await redeem(codes[16], mail('ok'));
ok(r.status === 'completed', `响应体中断后重放 → ${r.status}`);
ok((await tasks()) === t0 + 1, `卡台侧只有 1 个任务（新增 ${(await tasks()) - t0}）`);

// 14. 卡台报价金额格式异常：拒绝，不下单
t0 = await tasks();
await mock('/mock/direct', { badFee: true });
await api('POST', '/api/admin/pricing/refresh');
const dev14 = randomUUID();
const s14 = (await api('POST', '/api/public/redeem/start', { device: dev14, code: codes[17] })).data;
const a14 = await api('POST', '/api/public/redeem/account', { device: dev14, rid: s14.rid, session: sess(mail('ok')) });
ok(a14.status === 400 && a14.data.code === 'PREFLIGHT_FAILED' && (await tasks()) === t0, `服务费格式错误 → 拒绝（${a14.data.error}），没有下单`);
await mock('/mock/direct', { badFee: false });
await api('POST', '/api/admin/pricing/refresh');

// 15. 费用明细暂时拿不到：先按预算计入额度、标记待核对，续费状态显示「待确认」；后台对账补齐
await mock('/mock/direct', { detailFail: 2 });
r = await redeem(codes[18], mail('ok'));
d = await detail(r.rid);
ok(r.status === 'completed' && d.directSpend[0].costVerified === 0 && r.willRenew === null, `明细拿不到 → 兑换完成，费用待核对（verified=${d.directSpend[0].costVerified}），续费状态待确认（${r.willRenew}）`);
g = (await api('GET', '/api/admin/direct/guard')).data;
ok(g.unverified >= 1, `护栏面板显示 ${g.unverified} 笔费用待核对`);
const fixed = await until(() => detail(r.rid), (v: any) => v.directSpend[0].costVerified === 1, 15000);
ok(Number(fixed.directSpend[0].actualUsd) === 21.3 && (await r.poll()).willRenew === false, `后台对账补齐：实际 $${fixed.directSpend[0].actualUsd}，续费已关闭`);

// 16. 同一账号用两张码各自预检，确认时才占名额：第二张被拦下
const one = await api('POST', '/api/admin/strategies', { ...base, name: '限一次' + tag, prefix: 'L' + tag, delivery: 'direct', accN: 1, failAct: 'release' });
const lb = (await gen('go', 2, one.data.id)).data.codes;
const acct = mail('ok'), devA = randomUUID(), devB = randomUUID();
IP = newIp();
const sA = (await api('POST', '/api/public/redeem/start', { device: devA, code: lb[0] })).data;
const sB = (await api('POST', '/api/public/redeem/start', { device: devB, code: lb[1] })).data;
const qA = (await api('POST', '/api/public/redeem/account', { device: devA, rid: sA.rid, session: sess(acct) })).data;
const qB = (await api('POST', '/api/public/redeem/account', { device: devB, rid: sB.rid, session: sess(acct) })).data;
ok(qA.needs === 'confirm' && qB.needs === 'confirm', '同一账号两张码都通过了预检（预检不占名额）');
const [cA, cB] = await Promise.all([api('POST', '/api/public/redeem/confirm', { device: devA, rid: sA.rid }), api('POST', '/api/public/redeem/confirm', { device: devB, rid: sB.rid })]);
const blockedOne = [cA.data, cB.data].filter((x: any) => x.status === 'blocked');
ok(blockedOne.length === 1 && blockedOne[0].codeReusable, `并发确认：只有一张提交，另一张被拦下且码不消耗（${cA.data.status} / ${cB.data.status}）`);

// 17. 直充就绪检查（只读）
const ready = (await api('GET', '/api/admin/direct/readiness')).data;
ok(ready.ready === true && ready.checks.some((c: any) => c.name === '写权限' && c.ok === 'warn'), `就绪检查：只读项通过，写权限标为需要真实下单确认（${ready.checks.map((c: any) => c.name + ':' + c.ok).join(' ')}）`);

// 18. 已开启两步验证时，换密钥必须验证密码和当前验证码；换的过程中旧的仍然有效
const totp = (secret: string) => {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const out: number[] = [];
  for (const ch of secret) { const i = B.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(out)).update(buf).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};
const opEmail = mail('op');
await api('POST', '/api/admin/users', { email: opEmail, name: '两步验证测试', role: 'support', password: 'oppass1234' });
let opCookie = '';
const op = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Cookie: opCookie, 'X-Forwarded-For': IP }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc && sc.startsWith('cdk_sid=')) opCookie = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) as any };
};
await op('POST', '/api/auth/login', { email: opEmail, password: 'oppass1234' });
const s1 = (await op('POST', '/api/auth/totp/setup', {})).data;
ok((await op('POST', '/api/auth/totp/enable', { code: totp(s1.secret) })).status === 200, '开启两步验证');
const noAuth = await op('POST', '/api/auth/totp/setup', {});
ok(noAuth.status === 400 && noAuth.data.code === 'REAUTH_REQUIRED', '已开启时，只有登录会话不能换密钥');
ok((await op('GET', '/api/auth/me')).data.user.totpEnabled === true, '换密钥被拒后两步验证仍然开启');
const s2 = await op('POST', '/api/auth/totp/setup', { password: 'oppass1234', code: totp(s1.secret) });
ok(s2.status === 200 && s2.data.secret !== s1.secret && (await op('GET', '/api/auth/me')).data.user.totpEnabled === true, '验证密码和当前验证码后生成新密钥；确认前旧的两步验证仍然有效');
ok((await op('POST', '/api/auth/totp/enable', { code: totp(s2.data.secret) })).status === 200, '用新密钥确认后替换');

// 11. 原有卡台 CDK 自有码不受影响
const cdkS = await api('POST', '/api/admin/strategies', { ...base, name: 'CDK自有' + tag, prefix: 'K' + tag, failAct: 'release' });
const kb = await gen('go', 1, cdkS.data.id);
// 已有直充不支持的商品挂在这条策略上时，不能把它改成直充
const prod25 = await api('POST', '/api/admin/shop/products', { product: 'gpt', plan: 'pro_25x', title: 'Pro25 测试', price: 1500, agentPrice: 1400, strategyId: cdkS.data.id, enabled: false });
ok(prod25.status === 200, `卡台 CDK 策略可以绑定 Pro 25x 商品 ${prod25.data.error || ''}`);
const toDirect = await api('PUT', `/api/admin/strategies/${cdkS.data.id}`, { ...cdkS.data, delivery: 'direct' });
ok(toDirect.status === 400 && /不支持直充/.test(toDirect.data.error), `改成直充被拦下 → ${toDirect.data.error}`);
r = await redeem(kb.data.codes[0], mail('ok'));
ok(r.status === 'completed', `卡台 CDK 自有码照常开通 → ${r.status}`);

console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);

/**
 * 商城测试：商品、四种支付、发货、邮件、查询、优惠券、买家账户、代理分销、退款
 * 前置：模拟卡台 + 服务已启动（服务需带 MAIL_OUTBOX、SHOP_TICK_MS、SHOP_QUERY_AFTER_MS、USDT_SCAN_MS），并已跑过 e2e.ts
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.E2E_BASE || 'http://localhost:8080';
const MOCK = process.env.MOCK_BASE || 'http://localhost:8090';
const OUTBOX = process.env.MAIL_OUTBOX || 'data-test/mail';
let fails = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 20000) { const t = Date.now(); let v!: T; while (Date.now() - t < ms) { v = await fn(); if (pred(v)) return v; await sleep(500); } return v; }

function client(ip: string) {
  const jar: Record<string, string> = {};
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const data: any = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
}
const mock = async (path: string, body?: unknown) => (await fetch(MOCK + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
const mails = () => existsSync(resolve(OUTBOX, 'outbox.jsonl')) ? readFileSync(resolve(OUTBOX, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
/** 模拟买家打开易支付收银台并付款 */
const epayPay = async (o: any, extra: object = {}) => { await fetch(o.data.pay.url); return mock('/mock/epay/pay', { out_trade_no: new URL(o.data.pay.url).searchParams.get('out_trade_no'), ...extra }); };
const outTradeNo = async (no: string) => (await admin('GET', '/api/admin/shop/orders/' + no)).data.payments.at(-1).id as string;

const admin = client('10.0.0.1');
let ipN = 10;
const guest = () => client(`10.9.${Math.floor(ipN / 200)}.${ipN++ % 200}`);

/* ---------- 准备：支付渠道、商城设置、商品 ---------- */
ok((await admin('POST', '/api/auth/login', { email: 'admin@test.com', password: 'password123' })).status === 200, '管理员登录');
const keys = await mock('/mock/pay/keys');
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const mpriv = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TRON = 'TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm';
ok((await admin('PUT', '/api/admin/shop/settings/pay/epay', { enabled: true, name: '在线支付', apiUrl: keys.epay.apiUrl, pid: keys.epay.pid, key: keys.epay.key, types: 'alipay,wxpay' })).data.ready === true, '配置易支付（支付宝 / 微信两种子方式）');
ok((await admin('PUT', '/api/admin/shop/settings/pay/alipay', { enabled: true, appId: '2021000000000001', privateKey: mpriv, alipayPublicKey: keys.alipay.alipayPublicKey, gateway: keys.alipay.gateway, mode: 'precreate' })).data.ready === true, '配置支付宝当面付');
ok((await admin('PUT', '/api/admin/shop/settings/pay/wechat', { enabled: true, mchId: '1900000001', appId: 'wx0000000000000001', serialNo: 'SERIAL0001', privateKey: mpriv, apiV3Key: keys.wechat.apiV3Key, publicKeyId: keys.wechat.publicKeyId, publicKey: keys.wechat.publicKey, api: keys.wechat.api })).data.ready === true, '配置微信支付 v3');
ok((await admin('PUT', '/api/admin/shop/settings/pay/usdt', { address: 'Tbad', rate: 7 })).status === 400, 'USDT 地址格式错误被拒绝');
ok((await admin('PUT', '/api/admin/shop/settings/pay/usdt', { enabled: true, address: TRON, rate: 7, tronApi: keys.tron.tronApi })).data.ready === true, '配置 USDT（TRC20）');
const st = await admin('GET', '/api/admin/shop/settings');
const stJson = JSON.stringify(st.data);
ok(!stJson.includes(keys.epay.key) && !stJson.includes('PRIVATE KEY') && !stJson.includes(keys.wechat.apiV3Key) && st.data.pay.epay.keySet === true, '设置接口不返回任何密钥，只显示「已设置」');
ok((await admin('PUT', '/api/admin/shop/settings/pay/epay', { name: '在线支付' })).data.ready === true, '只改名称时密钥保留');
await admin('PUT', '/api/admin/settings/notify', { tgToken: '123456:' + 'A'.repeat(35), tgChatId: '10002', failAlert: false, shopAlert: true, lowStock: false, dailyReport: false });
ok((await admin('PUT', '/api/admin/shop/settings/shop', { enabled: true, title: '测试商城', allowRegister: true, allowAgentApply: true, freezeDays: 0, minWithdraw: 5 })).status === 200, '开启商城、注册、代理申请');

const strategies = (await admin('GET', '/api/admin/strategies')).data.list;
const gptStrat = strategies.find((s: any) => s.prod.includes('gpt') && s.isDefault) || strategies.find((s: any) => s.prod.includes('gpt'));
const xStrat = strategies.find((s: any) => s.prod.includes('x'));
const P = (await admin('POST', '/api/admin/shop/products', { product: 'gpt', plan: 'plus', title: 'ChatGPT Plus 月卡', price: '39.90', agentPrice: '30', strategyId: gptStrat.id, stockLimit: 8, maxPerOrder: 5, badge: '热销' })).data;
ok(P.id && P.price === 3990 && P.agent_price === 3000, '创建商品：零售 39.90，代理基础价 30.00，库存 8');
ok((await admin('POST', '/api/admin/shop/products', { product: 'gpt', plan: 'plus', price: '10', agentPrice: '20', strategyId: gptStrat.id })).status === 400, '代理价高于零售价被拒绝');
const PX = (await admin('POST', '/api/admin/shop/products', { product: 'x', plan: 'premium_3m', price: '50', strategyId: xStrat.id, enabled: false })).data;
const g1 = guest();
const plist = (await g1('GET', '/api/shop/products')).data.list;
ok(plist.some((p: any) => p.id === P.id && p.available === 8) && !plist.some((p: any) => p.id === PX.id), '前台只显示上架商品，带可售库存');
const cfg = (await g1('GET', '/api/shop/config')).data;
ok(cfg.payMethods.map((m: any) => m.sub || m.method).join(',') === 'alipay,wxpay,alipay,wechat,usdt', '前台支付方式：易支付×2 / 支付宝 / 微信 / USDT');

/* ---------- 下单校验 ---------- */
const order = (c: ReturnType<typeof client>, o: any) => c('POST', '/api/shop/orders', { productId: P.id, quantity: 1, email: 'buyer@test.com', queryPassword: '1234', payMethod: 'epay', paySub: 'alipay', ...o });
ok((await order(g1, { email: 'bad' })).status === 400, '邮箱格式错误被拒绝');
ok((await order(g1, { queryPassword: '' })).status === 400, '免注册下单必须设查询密码');
ok((await order(g1, { quantity: 6 })).status === 400, '超过每单上限被拒绝');
ok((await order(g1, { payMethod: 'paypal' })).status === 400, '不存在的支付方式被拒绝');
ok((await order(g1, { productId: PX.id })).status === 400, '下架商品不能下单');

/* ---------- 易支付：下单 → 跳转收银台 → 回调 → 自动发货 → 邮件 ---------- */
const o1 = await order(g1, { quantity: 2, contact: 'tg:@buyer' });
ok(o1.status === 200 && o1.data.pay.type === 'redirect' && o1.data.pay.url.includes('/epay/submit.php'), '易支付下单返回收银台跳转地址');
const cashier = await fetch(o1.data.pay.url);
ok(cashier.status === 200 && (await cashier.text()).includes('79.80'), '收银台签名通过，金额 79.80（服务端算价）');
const v0 = (await g1('GET', `/api/shop/orders/${o1.data.no}?t=${o1.data.token}`)).data;
ok(v0.status === 'pending' && v0.total === 7980 && v0.codes.length === 0, '订单待付款，未付款看不到兑换码');
ok((await g1('GET', `/api/shop/orders/${o1.data.no}?t=wrong`)).status === 404, '凭错误令牌看不到订单');
const pid1 = await outTradeNo(o1.data.no);
ok((await mock('/mock/epay/pay', { out_trade_no: pid1, money: '0.01' })).notifyStatus === 400, '回调金额被篡改 → 拒绝入账');
ok((await g1('GET', `/api/shop/orders/${o1.data.no}?t=${o1.data.token}`)).data.status === 'pending', '篡改金额后订单仍是待付款');
const forged = await fetch(`${BASE}/api/pay/notify/epay?pid=1000&out_trade_no=${pid1}&trade_no=X1&money=79.80&trade_status=TRADE_SUCCESS&sign=${'0'.repeat(32)}&sign_type=MD5`);
ok(forged.status === 400, '伪造签名的回调 → 400');
ok((await mock('/mock/epay/pay', { out_trade_no: pid1 })).notifyStatus === 200, '正确回调 → 回复 success');
const v1 = await until(() => g1('GET', `/api/shop/orders/${o1.data.no}?t=${o1.data.token}`).then(r => r.data), v => v.status === 'delivered');
ok(v1.status === 'delivered' && v1.codes.length === 2 && v1.codes.every((c: any) => /^[A-Z0-9]+-/.test(c.code)), `自动发货 2 张兑换码（${v1.codes[0]?.code.slice(0, 8)}…）`);
ok((await mock('/mock/epay/pay', { out_trade_no: pid1 })).notifyStatus === 200, '重复回调仍回复 success');
await sleep(800);
const d1 = (await admin('GET', '/api/admin/shop/orders/' + o1.data.no)).data;
ok(d1.codes.length === 2 && d1.payments.filter((p: any) => p.status === 'paid').length === 1, '重复回调不重复入账、不重复发码');
const m1 = await until(async () => mails().filter(m => m.ref === o1.data.no), l => l.length > 0, 5000);
ok(m1.length === 1 && m1[0].to === 'buyer@test.com' && v1.codes.every((c: any) => m1[0].text.includes(c.code)) && m1[0].html.includes('/redeem#code='), '发货邮件包含兑换码和一键兑换链接');
ok((await admin('GET', '/api/admin/shop/products')).data.list.find((p: any) => p.id === P.id).available === 6, '库存扣减：8 → 6');

/* ---------- 回调丢失：主动查单补单 ---------- */
const o2 = await order(g1, {});
await epayPay(o2, { notify: false });
const v2 = await until(() => g1('GET', `/api/shop/orders/${o2.data.no}?t=${o2.data.token}`).then(r => r.data), v => v.status === 'delivered', 25000);
ok(v2.status === 'delivered', '没收到回调时，后台主动查单后发货');

/* ---------- 支付宝当面付 ---------- */
const g2 = guest();
const o3 = await order(g2, { payMethod: 'alipay', paySub: undefined, email: 'ali@test.com' });
ok(o3.status === 200 && o3.data.pay.type === 'qr' && o3.data.pay.qr.includes('/mock/pay/scan/'), '支付宝当面付返回二维码（网关响应已验签）');
ok((await mock('/mock/alipay/pay', { out_trade_no: await outTradeNo(o3.data.no) })).notifyStatus === 200, '支付宝异步通知 RSA2 验签通过');
ok((await until(() => g2('GET', `/api/shop/orders/${o3.data.no}?t=${o3.data.token}`).then(r => r.data), v => v.status === 'delivered')).codes.length === 1, '支付宝付款后发货');

/* ---------- 微信支付 v3 ---------- */
const o4 = await order(g2, { payMethod: 'wechat', paySub: undefined, email: 'wx@test.com' });
ok(o4.status === 200 && o4.data.pay.type === 'qr', '微信 Native 返回二维码（响应已验签）');
ok((await mock('/mock/wechat/pay', { out_trade_no: await outTradeNo(o4.data.no) })).notifyStatus === 200, '微信回调验签 + 解密通过');
ok((await until(() => g2('GET', `/api/shop/orders/${o4.data.no}?t=${o4.data.token}`).then(r => r.data), v => v.status === 'delivered')).codes.length === 1, '微信付款后发货');

/* ---------- 库存 ---------- */
ok((await admin('GET', '/api/admin/shop/products')).data.list.find((p: any) => p.id === P.id).available === 3, '库存 3');
ok((await order(g2, { quantity: 4 })).data.code === 'OUT_OF_STOCK', '超过可售库存 → 库存不足');

/* ---------- USDT ---------- */
const g3 = guest();
const o5 = await order(g3, { payMethod: 'usdt', paySub: undefined, email: 'usdt@test.com' });
const amt = o5.data.pay?.amount;
ok(o5.data.pay?.type === 'crypto' && o5.data.pay.address === TRON && Number(amt) > 5.7 && Number(amt) < 5.8, `USDT 唯一金额 ${amt}（39.90 ÷ 7 + 随机尾数）`);
ok((await admin('GET', '/api/admin/shop/products')).data.list.find((p: any) => p.id === P.id).available === 2, '待付款订单占用库存');
await mock('/mock/tron/send', { to: TRON, amount: (Number(amt) + 0.0001).toFixed(4) });
await sleep(4000);
ok((await g3('GET', `/api/shop/orders/${o5.data.no}?t=${o5.data.token}`)).data.status === 'pending', '金额差 0.0001 的转账不会匹配');
await mock('/mock/tron/send', { to: TRON, amount: amt });
ok((await until(() => g3('GET', `/api/shop/orders/${o5.data.no}?t=${o5.data.token}`).then(r => r.data), v => v.status === 'delivered')).status === 'delivered', '链上到账金额一致 → 自动发货');

/* ---------- 取消 / 关单后到账 ---------- */
const o6 = await order(g3, { email: 'late@test.com' });
ok((await g3('POST', `/api/shop/orders/${o6.data.no}/cancel`, { t: o6.data.token })).status === 200, '买家取消订单');
ok((await admin('GET', '/api/admin/shop/products')).data.list.find((p: any) => p.id === P.id).available === 2, '取消后释放库存');
await epayPay(o6);
ok((await until(() => g3('GET', `/api/shop/orders/${o6.data.no}?t=${o6.data.token}`).then(r => r.data), v => v.status === 'delivered')).status === 'delivered', '关单后才到账：照样发货（钱已收到）');
await admin('PUT', '/api/admin/shop/products/' + P.id, { ...P, price: '39.90', agentPrice: '30', strategyId: gptStrat.id, stockLimit: '' });

/* ---------- 订单查询 ---------- */
const g4 = guest();
const qr = await g4('POST', '/api/shop/query', { key: 'buyer@test.com', password: '1234' });
ok(qr.status === 200 && qr.data.list.length === 2 && qr.data.list.every((o: any) => o.token), '邮箱 + 查询密码查到 2 个订单');
ok((await g4('POST', '/api/shop/query', { key: 'buyer@test.com', password: '9999' })).status === 404, '查询密码错误查不到');
ok((await g4('POST', '/api/shop/query', { key: o3.data.no, password: '1234' })).data.list?.[0]?.no === o3.data.no, '订单号 + 查询密码查到');

/* ---------- 优惠券 ---------- */
ok((await admin('POST', '/api/admin/shop/coupons', { code: 'save5', name: '立减 5 元', type: 'amount', value: '5', minAmount: '30', maxUses: 1 })).status === 200, '创建优惠券 SAVE5：满 30 减 5，限 1 张');
ok((await admin('POST', '/api/admin/shop/coupons', { code: 'OFF20', type: 'percent', value: 20, maxDiscount: '6' })).status === 200, '创建优惠券 OFF20：8 折，最多减 6');
const g5 = guest();
ok((await g5('POST', '/api/shop/coupon', { code: 'SAVE5', productId: P.id, quantity: 1 })).data.discount === 500, '校验券码：减 5.00');
ok((await g5('POST', '/api/shop/coupon', { code: 'OFF20', productId: P.id, quantity: 2 })).data.discount === 600, '折扣券封顶 6.00');
ok((await g5('POST', '/api/shop/coupon', { code: 'NOPE', productId: P.id })).status === 400, '不存在的券码');
const o7 = await order(g5, { coupon: 'SAVE5', email: 'c1@test.com' });
ok(o7.status === 200 && (await g5('GET', `/api/shop/orders/${o7.data.no}?t=${o7.data.token}`)).data.total === 3490, '用券下单实付 34.90');
ok((await order(g5, { coupon: 'SAVE5', email: 'c2@test.com' })).status === 400, '限量券被占用后其他人不能用');
await g5('POST', `/api/shop/orders/${o7.data.no}/cancel`, { t: o7.data.token });
const o8 = await order(g5, { coupon: 'SAVE5', email: 'c2@test.com' });
ok(o8.status === 200, '订单取消后优惠券释放，可以再用');
await epayPay(o8);
await until(() => g5('GET', `/api/shop/orders/${o8.data.no}?t=${o8.data.token}`).then(r => r.data), v => v.status === 'delivered');
ok((await admin('GET', '/api/admin/shop/coupons')).data.list.find((c: any) => c.code === 'SAVE5').used === 1, '付款后优惠券核销 used = 1');
ok((await admin('DELETE', '/api/admin/shop/coupons/' + (await admin('GET', '/api/admin/shop/coupons')).data.list.find((c: any) => c.code === 'SAVE5').id)).status === 400, '用过的券不能删除');

/* ---------- 买家账户：注册认领订单、充值、余额支付 ---------- */
const u1 = guest();
ok((await u1('POST', '/api/shop/account/register', { email: 'buyer@test.com', password: 'short' })).status === 400, '密码太短');
const reg = await u1('POST', '/api/shop/account/register', { email: 'Buyer@Test.com', password: 'buyerpass1' });
ok(reg.status === 200 && reg.data.me.email === 'buyer@test.com', '注册并自动登录');
ok((await u1('POST', '/api/shop/account/register', { email: 'buyer@test.com', password: 'buyerpass1' })).status === 409, '重复注册 → 409');
ok((await u1('GET', '/api/shop/account/orders')).data.list.length === 0, '注册不会自动认领同邮箱的免注册订单（防止别人用你的邮箱注册看到兑换码）');
ok((await guest()('POST', '/api/shop/query', { key: 'buyer@test.com', password: '1234' })).data.list?.length === 2, '那些订单仍然可以用查询密码查到');
const t1 = await u1('POST', '/api/shop/account/topup', { amount: 100, payMethod: 'epay', paySub: 'wxpay' });
ok(t1.status === 200 && t1.data.pay.type === 'redirect', '充值 100 元下单');
await epayPay(t1);
const me1 = await until(() => u1('GET', '/api/shop/account/me').then(r => r.data.me), m => m.balance === 10000);
ok(me1.balance === 10000, '充值到账，余额 100.00');
const ob = await u1('POST', '/api/shop/orders', { productId: P.id, quantity: 2, payMethod: 'balance' });
ok(ob.status === 200 && ob.data.pay.type === 'done', '余额支付，无需跳转');
ok((await until(() => u1('GET', `/api/shop/orders/${ob.data.no}`).then(r => r.data), v => v.status === 'delivered')).codes.length === 2, '登录用户凭会话查看订单，已发货 2 张');
ok((await u1('GET', '/api/shop/account/me')).data.me.balance === 10000 - 7980, '余额扣减 79.80');
const before = (await u1('GET', '/api/shop/account/orders')).data.list.length;
ok((await u1('POST', '/api/shop/orders', { productId: P.id, quantity: 1, payMethod: 'balance' })).data.code === 'INSUFFICIENT_BALANCE', '余额不足时拒绝');
ok((await u1('GET', '/api/shop/account/orders')).data.list.length === before, '余额不足不会留下待付款的孤儿订单');
ok((await guest()('POST', '/api/shop/orders', { productId: P.id, email: 'x@test.com', queryPassword: '1234', payMethod: 'balance' })).status === 400, '未登录不能用余额');
// 订单链接（view token）只能用来查看订单，不能替下单账户动用余额
const pend = await u1('POST', '/api/shop/orders', { productId: P.id, quantity: 1, payMethod: 'epay', paySub: 'alipay' });
const steal = await guest()('POST', `/api/shop/orders/${pend.data.no}/pay`, { t: pend.data.token, payMethod: 'balance' });
ok(steal.status === 403 && steal.data.code === 'BALANCE_FORBIDDEN', `拿到订单链接的其他人不能用下单账户的余额付款 → ${steal.status} ${steal.data.code}`);
await u1('POST', `/api/shop/orders/${pend.data.no}/cancel`, { t: pend.data.token });
ok((await u1('GET', '/api/shop/account/ledger')).data.list.map((l: any) => l.type).join(',') === 'spend,topup', '余额流水：充值、消费');
await u1('POST', '/api/shop/account/logout', {});
ok((await u1('GET', '/api/shop/account/me')).data.me === null, '退出登录');
ok((await u1('POST', '/api/shop/account/login', { email: 'buyer@test.com', password: 'wrongpass' })).status === 401, '密码错误不能登录');
ok((await u1('POST', '/api/shop/account/login', { email: 'buyer@test.com', password: 'buyerpass1' })).status === 200, '重新登录');
await u1('POST', '/api/shop/account/reset/send', { email: 'buyer@test.com' });
const rm = await until(async () => mails().filter(m => m.ref === 'reset'), l => l.length > 0, 5000);
const code = rm.at(-1)?.text.match(/\d{6}/)?.[0];
ok(code && (await u1('POST', '/api/shop/account/reset', { email: 'buyer@test.com', code: '000000', password: 'newpass12' })).status === 400, '找回密码：错误验证码被拒');
ok((await u1('POST', '/api/shop/account/reset', { email: 'buyer@test.com', code, password: 'newpass12' })).status === 200 && (await u1('POST', '/api/shop/account/login', { email: 'buyer@test.com', password: 'newpass12' })).status === 200, '邮件验证码重置密码后可用新密码登录');
await u1('POST', '/api/shop/account/reset/send', { email: 'buyer@test.com' });
const code2 = (await until(async () => mails().filter(m => m.ref === 'reset'), l => l.length > 1, 5000)).at(-1)?.text.match(/d{6}/)?.[0];
for (let i = 0; i < 5; i++) await u1('POST', '/api/shop/account/reset', { email: 'buyer@test.com', code: code2 === '111111' ? '222222' : '111111', password: 'x12345678' });
ok((await u1('POST', '/api/shop/account/reset', { email: 'buyer@test.com', code: code2, password: 'x12345678' })).status === 400, '验证码输错 5 次后作废，正确的码也不能再用（防爆破）');

/* ---------- 代理：申请、分站自定价、推广返佣、批发、提现 ---------- */
const ag = guest();
await ag('POST', '/api/shop/account/register', { email: 'agent@test.com', password: 'agentpass1' });
ok((await ag('POST', '/api/shop/agent/apply', { slug: 'admin', shopName: '我的店' })).status === 400, '保留的店铺地址不能用');
ok((await ag('POST', '/api/shop/agent/apply', { slug: 'mystore', shopName: '小明的店', contact: 'tg:@xm' })).status === 200, '申请代理');
ok((await ag('GET', '/api/shop/agent/products')).status === 403, '审核前不能进代理中心');
const al = (await admin('GET', '/api/admin/shop/agents?status=pending')).data;
const agentId = al.list.find((a: any) => a.slug === 'mystore').customer_id;
const lv = (await admin('POST', '/api/admin/shop/levels', { name: '金牌', wholesalePct: 90, commissionPct: 10 })).data.id;
ok((await admin('POST', `/api/admin/shop/agents/${agentId}/approve`, { levelId: lv })).status === 200, '管理员审核通过，等级「金牌」（进货 9 折、佣金 10%）');
const ap = (await ag('GET', '/api/shop/agent/products')).data.list.find((p: any) => p.id === P.id);
ok(ap.cost === 2700 && ap.myPrice === 3990, '进货价 = 30 × 90% = 27.00，默认售价 = 主站价');
ok((await ag('PUT', `/api/shop/agent/prices/${P.id}`, { price: '20' })).status === 400, '分站售价不能低于进货价');
ok((await ag('PUT', `/api/shop/agent/prices/${P.id}`, { price: '35' })).status === 200, '分站自定价 35.00');
ok((await fetch(BASE + '/s/mystore')).status === 200, '分站页面 /s/mystore 可以打开');
const sb = guest();
const sp = (await sb('GET', '/api/shop/products?store=mystore')).data.list.find((p: any) => p.id === P.id);
ok(sp.price === 3500, '分站显示代理的售价 35.00');
ok((await sb('GET', '/api/shop/config?store=mystore')).data.shop.title === '小明的店', '分站显示代理的店铺名');
ok((await order(sb, { store: 'mystore', coupon: 'OFF20', email: 's1@test.com' })).status === 400, '分站订单不能用主站优惠券');
const os = await order(sb, { store: 'mystore', email: 's1@test.com' });
await epayPay(os);
await until(() => sb('GET', `/api/shop/orders/${os.data.no}?t=${os.data.token}`).then(r => r.data), v => v.status === 'delivered');
const dos = (await admin('GET', '/api/admin/shop/orders/' + os.data.no)).data;
ok(dos.total === 3500 && dos.source === 'store' && dos.agentProfit === 800, '分站订单 35.00，代理利润 = 35 − 27 = 8.00');
const rb = guest();
const orf = await order(rb, { ref: 'mystore', email: 'r1@test.com' });
await epayPay(orf);
await until(() => rb('GET', `/api/shop/orders/${orf.data.no}?t=${orf.data.token}`).then(r => r.data), v => v.status === 'delivered');
const dorf = (await admin('GET', '/api/admin/shop/orders/' + orf.data.no)).data;
ok(dorf.source === 'ref' && dorf.total === 3990 && dorf.commission === 399, '推广订单按主站价成交，佣金 10% = 3.99');
const self = guest();
const oself = await order(self, { ref: 'mystore', email: 'agent@test.com' });
ok((await admin('GET', '/api/admin/shop/orders/' + oself.data.no)).data.source === 'site', '代理退出登录用自己的邮箱走自己的推广链接：不计佣');
await self('POST', `/api/shop/orders/${oself.data.no}/cancel`, { t: oself.data.token });
const dash = await until(() => ag('GET', '/api/shop/agent/dashboard').then(r => r.data), d => d.agent?.earnings === 1199, 8000);
ok(dash.agent.earnings === 1199 && dash.agent.frozen === 0, '冻结期 0 天：收益 11.99 已转为可提现');
ok(dash.today.n === 2 && dash.level.name === '金牌', '代理中心：今日 2 单、等级金牌');
ok((await ag('GET', '/api/shop/agent/orders')).data.list.every((o: any) => o.email.includes('***')), '代理看到的买家邮箱已打码');
ok((await ag('POST', '/api/shop/agent/to-balance', { amount: 5 })).status === 200 && (await ag('GET', '/api/shop/account/me')).data.me.balance === 500, '收益 5.00 转入余额');
await admin('POST', `/api/admin/shop/customers/${agentId}/adjust`, { amount: 100, note: '测试加款' });
ok((await ag('GET', '/api/shop/account/me')).data.me.balance === 10500, '后台给代理加款 100');
const ow = await ag('POST', '/api/shop/agent/wholesale', { productId: P.id, quantity: 3, payMethod: 'balance' });
ok(ow.status === 200 && ow.data.pay.type === 'done', '批发 3 张，用余额按进货价付款');
await until(() => ag('GET', `/api/shop/orders/${ow.data.no}`).then(r => r.data), v => v.status === 'delivered');
ok((await ag('GET', '/api/shop/account/me')).data.me.balance === 10500 - 8100, '批发扣款 3 × 27.00 = 81.00');
ok((await ag('GET', '/api/shop/agent/stock')).data.list.length === 3, '代理库存里有 3 张批发的码');
ok((await ag('POST', '/api/shop/agent/withdrawals', { amount: 100000, method: 'alipay', account: 'a@b.com' })).status === 400, '提现超过可提现金额被拒');
ok((await ag('POST', '/api/shop/agent/withdrawals', { amount: 6.99, method: 'alipay', account: 'agent@alipay.com', name: '小明' })).status === 200, '申请提现 6.99');
ok((await ag('POST', '/api/shop/agent/withdrawals', { amount: 5, method: 'alipay', account: 'x' })).status === 400, '有待审核提现时不能再申请');
const wd = (await admin('GET', '/api/admin/shop/withdrawals?status=pending')).data.list[0];
ok(wd.account === 'agent@alipay.com' && (await admin('POST', `/api/admin/shop/withdrawals/${wd.id}/paid`, { note: '已转账' })).status === 200, '后台看到收款账号并标记已打款');
ok((await ag('GET', '/api/shop/agent/withdrawals')).data.list[0].account.includes('****'), '代理端收款账号打码显示');

/* ---------- 退款 ---------- */
const rf0 = await admin('POST', `/api/admin/shop/orders/${os.data.no}/refund`, { note: '买家申请退款' });
ok(rf0.status === 409 && rf0.data.code === 'REFUND_CONFIRM' && rf0.data.hostedGpt === 1, '卡台 GPT 码无法真正撤销：退款前先要求确认');
const [rf, rf2] = await Promise.all([admin('POST', `/api/admin/shop/orders/${os.data.no}/refund`, { note: '买家申请退款', force: true }), admin('POST', `/api/admin/shop/orders/${os.data.no}/refund`, { note: '并发再点一次', force: true })]);
const rfOk = [rf, rf2].filter(r => r.status === 200), rfNo = [rf, rf2].filter(r => r.status === 400);
ok(rfOk.length === 1 && rfNo.length === 1, `后台确认退款；同时点两次只退一次（${rf.status} / ${rf2.status} ${rfNo[0]?.data.error || ''}）`);
const drf = (await admin('GET', '/api/admin/shop/orders/' + os.data.no)).data;
ok(drf.status === 'refunded' && drf.codes.every((c: any) => c.status === 'revoked'), '退款后兑换码作废');
ok((await ag('GET', '/api/shop/agent/dashboard')).data.agent.earnings === 1199 - 500 - 699 - 800, '退款冲回代理利润（可提现变为负数，等后续收益抵扣）');
const bal = (await u1('GET', '/api/shop/account/me')).data.me.balance;
await admin('POST', `/api/admin/shop/orders/${ob.data.no}/refund`, { note: '测试', force: true });
ok((await u1('GET', '/api/shop/account/me')).data.me.balance === bal + 7980, '余额支付的订单退款退回余额');
ok((await admin('POST', `/api/admin/shop/orders/${ob.data.no}/refund`, { note: '再退' })).status === 400, '不能重复退款');

/* ---------- 重复付款：两个渠道都付了 ---------- */
const g7 = guest();
const od = await order(g7, { payMethod: 'alipay', paySub: undefined, email: 'double@test.com' });
const aliPid = await outTradeNo(od.data.no);
const sw = await g7('POST', `/api/shop/orders/${od.data.no}/pay`, { t: od.data.token, payMethod: 'epay', paySub: 'alipay' });
await epayPay({ data: { pay: sw.data.pay } });
await until(() => g7('GET', `/api/shop/orders/${od.data.no}?t=${od.data.token}`).then(r => r.data), v => v.status === 'delivered');
ok((await mock('/mock/alipay/pay', { out_trade_no: aliPid })).notifyStatus === 200, '第二个渠道也付了：回调照常回复成功（钱已收到）');
const dd = (await admin('GET', '/api/admin/shop/orders/' + od.data.no)).data;
ok(dd.codes.length === 1 && dd.payments.some((p: any) => p.status === 'overpaid') && (await admin('GET', '/api/admin/shop/orders?size=1')).data.overpaid >= 1, '不重复发货，支付单标记为「重复付款」，后台提醒人工退款');

/* ---------- 手动确认收款 / 统计 / 首页 ---------- */
const g6 = guest();
const om = await order(g6, { email: 'manual@test.com' });
ok((await admin('POST', `/api/admin/shop/orders/${om.data.no}/paid`, { note: '线下收款' })).status === 200, '后台手动确认收款');
ok((await until(() => g6('GET', `/api/shop/orders/${om.data.no}?t=${om.data.token}`).then(r => r.data), v => v.status === 'delivered')).status === 'delivered', '手动确认后自动发货');
const ls = (await admin('GET', '/api/admin/shop/orders?status=delivered')).data;
ok(ls.total >= 10 && ls.today.count >= 10, `后台订单列表 ${ls.total} 单，今日成交 ${ls.today.count} 单`);
ok((await admin('GET', '/api/admin/shop/orders?q=' + o3.data.no)).data.list.length === 1, '按订单号搜索');
const ss = (await admin('GET', '/api/admin/shop/stats')).data;
ok(ss.sales > 0 && ss.profit === ss.sales - ss.cost - ss.agentShare, `今日销售 ${(ss.sales / 100).toFixed(2)}，成本 ${(ss.cost / 100).toFixed(2)}`);
const home0 = await (await fetch(BASE + '/')).text();
await admin('PUT', '/api/admin/shop/settings/shop', { homepage: 'shop' });
const home1 = await (await fetch(BASE + '/')).text();
const redeem = await (await fetch(BASE + '/redeem')).text();
ok(home0 !== home1 && redeem === home0, '首页可切换为商城，兑换页移到 /redeem');
await admin('PUT', '/api/admin/shop/settings/shop', { homepage: 'redeem' });
await admin('PUT', '/api/admin/shop/settings/shop', { enabled: false });
ok((await order(guest(), {})).data.code === 'SHOP_CLOSED', '商城关闭后不能下单');
await admin('PUT', '/api/admin/shop/settings/shop', { enabled: true });
ok((await fetch(BASE + '/api/shop/orders', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status === 415, '商城接口拒绝非 JSON 提交');

/* ---------- 后台：导出、筛选、客户详情、搜索、总览 ---------- */
const csvRes = await fetch(BASE + '/api/admin/shop/orders/export?status=delivered', { headers: { Cookie: (await (async () => { const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.com', password: 'password123' }) }); return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; '); })()) } });
const csv = await csvRes.text();
ok(csvRes.headers.get('content-type')?.includes('text/csv') && csv.split('\n').length > 5 && csv.includes('订单号') && !csv.includes('待付款'), `导出 CSV：${csv.split('\n').length - 1} 条已完成订单`);
ok((await admin('GET', `/api/admin/shop/orders?agent=${agentId}`)).data.list.every((o: any) => o.agent?.id === agentId), '按代理筛选订单');
ok((await admin('GET', '/api/admin/shop/orders?from=' + new Date(Date.now() + 3600e3).toISOString())).data.total === 0, '按时间筛选订单');
const cd = (await admin('GET', '/api/admin/shop/customers/' + agentId)).data;
ok(cd.customer.email === 'agent@test.com' && cd.orders.length > 0 && cd.ledger.length > 0, '客户详情：订单 + 余额明细');
const sr = (await admin('GET', '/api/admin/search?q=' + o3.data.no)).data.list;
ok(sr.some((x: any) => x.kind === 'order' && x.id === o3.data.no), '全局搜索能搜到商城订单');
const redCsv = await fetch(BASE + '/api/admin/redemptions/export?f=completed', { headers: { Cookie: (await (async () => { const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.com', password: 'password123' }) }); return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; '); })()) } }).then(r => r.text());
ok(redCsv.includes('记录号') && redCsv.includes('已完成') && !redCsv.includes('策略拦截'), '兑换记录导出 CSV（按状态筛选）');
const agPage = (await admin('GET', '/api/admin/shop/agents?size=1&q=mystore')).data;
ok(agPage.total === 1 && agPage.list.length === 1 && agPage.list[0].slug === 'mystore', '代理列表：服务端搜索 + 分页');
const sum = (await admin('GET', '/api/admin/shop/summary')).data;
ok(sum.enabled && sum.today.orders > 0 && typeof sum.undelivered === 'number' && sum.channels === 4, `总览商城数据：今日 ${sum.today.orders} 单`);

/* ---------- 商品分类（两级）、后台手动建客户 ---------- */
const c1 = (await admin('POST', '/api/admin/shop/categories', { name: 'ChatGPT', sort: 1 })).data.id;
const c2 = (await admin('POST', '/api/admin/shop/categories', { name: 'Plus 会员', parentId: c1 })).data.id;
ok((await admin('POST', '/api/admin/shop/categories', { name: '三级', parentId: c2 })).status === 400, '分类最多两级');
await admin('PUT', '/api/admin/shop/products/' + P.id, { ...P, price: '39.90', agentPrice: '30', strategyId: gptStrat.id, stockLimit: '', categoryId: c2 });
const sp2 = (await guest()('GET', '/api/shop/products')).data;
ok(sp2.list.find((p: any) => p.id === P.id).categoryId === c2 && sp2.categories.map((c: any) => c.id).sort().join() === [c1, c2].sort().join(), '前台拿到商品分类，只返回有商品的分类和它的上级');
ok((await admin('DELETE', '/api/admin/shop/categories/' + c2)).status === 400 && (await admin('DELETE', '/api/admin/shop/categories/' + c1)).status === 400, '有商品 / 有二级分类的分类不能删除');
const nc = await admin('POST', '/api/admin/shop/customers', { email: 'Manual@Test.com', password: 'manualpw1', name: '线下客户', balance: 50, note: '线下转账' });
ok(nc.status === 200 && (await guest()('POST', '/api/shop/account/login', { email: 'manual@test.com', password: 'manualpw1' })).status === 200, '后台手动创建客户，客户可以直接登录');
ok((await admin('GET', '/api/admin/shop/customers/' + nc.data.id)).data.customer.balance === 5000, '创建时给的初始余额已到账');
ok((await admin('POST', '/api/admin/shop/customers', { email: 'manual@test.com', password: 'manualpw1' })).status === 409, '重复邮箱不能再建');
await admin('POST', `/api/admin/shop/customers/${nc.data.id}/password`, { password: 'resetpw12' });
ok((await guest()('POST', '/api/shop/account/login', { email: 'manual@test.com', password: 'resetpw12' })).status === 200, '后台重置客户密码');

/* ---------- 客户区分普通用户 / 代理，后台直接设为代理 ---------- */
const cl = (await admin('GET', '/api/admin/shop/customers?type=agent')).data;
ok(cl.list.length > 0 && cl.list.every((c: any) => ['active', 'disabled'].includes(c.agent_status)) && cl.counts.all === cl.counts.normal + cl.counts.agent + cl.counts.pending, `客户按类型筛选：普通 ${cl.counts.normal} / 代理 ${cl.counts.agent} / 待审核 ${cl.counts.pending}`);
ok((await admin('GET', '/api/admin/shop/customers?type=normal')).data.list.every((c: any) => !c.agent_status || c.agent_status === 'rejected'), '普通用户筛选里没有代理');
const mk = await admin('POST', '/api/admin/shop/customers', { email: 'onlyWjt.441@gmail.com', password: 'agentnew12', agent: { slug: 'newshop', shopName: '新开的店' } });
ok(mk.status === 200 && (await admin('GET', '/api/admin/shop/customers/' + mk.data.id)).data.agent?.status === 'active', '新建客户时直接开通代理');
ok((await fetch(BASE + '/s/newshop')).status === 200 && (await guest()('GET', '/api/shop/config?store=newshop')).data.store?.name === '新开的店', '新代理的分站立即可用');
ok((await admin('POST', `/api/admin/shop/customers/${nc.data.id}/agent`, { slug: 'newshop', shopName: 'x' })).status === 400, '店铺地址重复时不能设为代理');
ok((await admin('POST', `/api/admin/shop/customers/${nc.data.id}/agent`, { slug: 'offline', shopName: '线下店' })).status === 200, '把已有的普通客户设为代理');
ok((await admin('POST', `/api/admin/shop/customers/${nc.data.id}/agent`, { slug: 'offline2', shopName: '线下店' })).status === 400, '已经是代理的不能重复设置');

/* ---------- 没开 / 没配好的支付渠道不出现在前台，也不能用来下单 ---------- */
await admin('PUT', '/api/admin/shop/settings/pay/usdt', { enabled: false });
await admin('PUT', '/api/admin/shop/settings/pay/wechat', { apiV3Key: '' });
const pm2 = (await guest()('GET', '/api/shop/config')).data.payMethods.map((m: any) => m.method);
ok(!pm2.includes('usdt') && !pm2.includes('wechat') && pm2.includes('epay'), `关闭 USDT、微信缺密钥后，前台只剩 ${[...new Set(pm2)].join(' / ')}`);
ok((await order(guest(), { payMethod: 'usdt', paySub: undefined, email: 'off@test.com' })).status === 400, '已关闭的渠道不能用来下单');
await admin('PUT', '/api/admin/shop/settings/pay/usdt', { enabled: true });
await admin('PUT', '/api/admin/shop/settings/pay/wechat', { apiV3Key: keys.wechat.apiV3Key });

/* ---------- 点数（Credits）商品：只能绑自有码策略 ---------- */
const crTag = Date.now() % 1000;
const hostedS = (await admin('POST', '/api/admin/strategies', { name: '托管测试' + crTag, prod: ['gpt'], mode: 'hosted', ipH: 5000, devD: 1000, captcha: 1000 })).data;
const ownS = (await admin('POST', '/api/admin/strategies', { name: '自有测试' + crTag, prod: ['gpt'], mode: 'own', prefix: 'CS' + crTag, ipH: 5000, devD: 1000, captcha: 1000 })).data;
const crBad = await admin('POST', '/api/admin/shop/products', { product: 'gpt', plan: 'credits_1000', title: '1000 点', price: '80', agentPrice: '70', strategyId: hostedS.id });
ok(crBad.status === 400 && /自有码/.test(crBad.data.error), `点数商品不能绑卡台托管码策略 → ${crBad.data.error}`);
const crOk = await admin('POST', '/api/admin/shop/products', { product: 'gpt', plan: 'credits_800', price: '70', agentPrice: '60', strategyId: ownS.id, enabled: false });
ok(crOk.status === 200 && crOk.data.title === 'ChatGPT 800 点数', `自定义点数商品可以上架，默认标题「${crOk.data.title}」${crOk.data.error || ""}`);
ok((await admin('POST', '/api/admin/shop/products', { product: 'gpt', plan: 'credits_0800', price: '70', agentPrice: '60', strategyId: ownS.id })).status === 400, '点数带前导零被拒绝');
ok((await admin('POST', '/api/admin/shop/products', { product: 'gpt', plan: 'credits_249', price: '70', agentPrice: '60', strategyId: ownS.id })).status === 400, '点数低于 250 被拒绝');
await admin('DELETE', '/api/admin/shop/products/' + crOk.data.id);

/* ---------- 主题：新增的外观维度、Logo 图片、自定义 CSS ---------- */
const th0 = (await admin('GET', '/api/admin/theme')).data;
const th = (await admin('PUT', '/api/admin/theme', { ...th0, bg: 'mesh', font: 'serif', card: 'neo', btn: 'glow', shape: 'pill', motion: false, tagline: '官方渠道开通', customCss: '.x{color:red}</style><script>alert(1)</script>' })).data;
ok(th.bg === 'mesh' && th.font === 'serif' && th.card === 'neo' && th.btn === 'glow' && th.shape === 'pill' && th.motion === false && th.tagline === '官方渠道开通', '主题保存背景 / 字体 / 卡片 / 按钮 / 形状 / 动效 / 副标题');
ok(!th.customCss.includes('</style') && !th.customCss.includes('</'), '自定义 CSS 去掉了能跳出 <style> 的写法');
ok((await admin('PUT', '/api/admin/theme', { ...th0, bg: 'evil' })).data.bg === 'mesh', '不认识的背景值被忽略，保持原来的设置');
ok((await admin('PUT', '/api/admin/theme', { ...th0, logoImg: 'javascript:alert(1)' })).status === 400, 'Logo 图片只接受图片 data URL');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
ok((await admin('PUT', '/api/admin/theme', { ...th0, logoImg: png })).data.logoImg === png && (await guest()('GET', '/api/shop/config')).data.theme.logoImg === png, 'Logo 图片保存后前台可以拿到');
await admin('PUT', '/api/admin/theme', { ...th0 });

const tg = await until(() => mock('/mock/telegram'), (m: any[]) => m.some(x => /新成交/.test(x.text)) && m.some(x => /新的代理申请/.test(x.text)) && m.some(x => /新的提现申请/.test(x.text)), 8000);
await admin('PUT', '/api/admin/settings/notify', { tgToken: '', tgChatId: '', failAlert: false, shopAlert: false, lowStock: false, dailyReport: false });
ok(tg.some((x: any) => /新成交/.test(x.text)) && tg.some((x: any) => /新的提现申请/.test(x.text)), 'Telegram 推送商城动态：新成交、代理申请、提现申请');

console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 商城测试全部通过');
process.exit(fails ? 1 : 0);

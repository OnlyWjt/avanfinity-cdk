/**
 * 本地体验用：给本地服务开商城、接上模拟支付网关、建几个示例商品
 *   前置：npm run mock + 服务已启动，已有管理员
 *   E2E_BASE=http://localhost:8080 ADMIN_EMAIL=… ADMIN_PASSWORD=… node --no-warnings scripts/seed-shop.ts
 */
import { generateKeyPairSync } from 'node:crypto';

const BASE = process.env.E2E_BASE || 'http://localhost:8080';
const MOCK = process.env.MOCK_BASE || 'http://localhost:8090';
let cookie = '';
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const sc of r.headers.getSetCookie()) cookie = sc.split(';')[0];
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${d.error || ''}`);
  return d;
}
await api('POST', '/api/auth/login', { email: process.env.ADMIN_EMAIL || 'admin@test.com', password: process.env.ADMIN_PASSWORD || 'password123' });
const keys = await (await fetch(MOCK + '/mock/pay/keys')).json() as any;
const mpriv = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
await api('PUT', '/api/admin/shop/settings/pay/epay', { enabled: true, name: '在线支付', apiUrl: keys.epay.apiUrl, pid: keys.epay.pid, key: keys.epay.key, types: 'alipay,wxpay' });
await api('PUT', '/api/admin/shop/settings/pay/alipay', { enabled: true, appId: '2021000000000001', privateKey: mpriv, alipayPublicKey: keys.alipay.alipayPublicKey, gateway: keys.alipay.gateway, mode: 'precreate' });
await api('PUT', '/api/admin/shop/settings/pay/wechat', { enabled: true, mchId: '1900000001', appId: 'wx0000000000000001', serialNo: 'SERIAL0001', privateKey: mpriv, apiV3Key: keys.wechat.apiV3Key, publicKeyId: keys.wechat.publicKeyId, publicKey: keys.wechat.publicKey, api: keys.wechat.api });
await api('PUT', '/api/admin/shop/settings/pay/usdt', { enabled: true, address: 'TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm', rate: 7.2, tronApi: keys.tron.tronApi });
await api('PUT', '/api/admin/shop/settings/shop', { enabled: true, title: '会员商城', notice: '本地体验环境：支付走模拟网关，收银台上点「模拟支付成功」即可完成付款。', allowRegister: true, allowAgentApply: true, freezeDays: 0, minWithdraw: 10 });

const strategies = (await api('GET', '/api/admin/strategies')).list;
const pick = (p: string) => (strategies.find((s: any) => s.prod.includes(p) && s.isDefault) || strategies.find((s: any) => s.prod.includes(p)))?.id;
const existing = (await api('GET', '/api/admin/shop/products')).list;
const items = [
  { product: 'gpt', plan: 'plus', title: 'ChatGPT Plus 月卡', subtitle: '官方开通 · 自动关闭续费', badge: '热销', price: '168', agentPrice: '150', description: '购买后获得兑换码，打开兑换页粘贴 ChatGPT 会话即可开通。\n开通后自动关闭续费，到期不会扣费。', sort: 1 },
  { product: 'gpt', plan: 'go', title: 'ChatGPT Go 月卡', subtitle: '入门套餐', price: '45', agentPrice: '38', sort: 2 },
  { product: 'x', plan: 'premium_3m', title: 'X Premium 3 个月', subtitle: '官方赠送方式开通', price: '268', agentPrice: '240', stockLimit: 20, sort: 3 },
  { product: 'tg', plan: 'premium_3m', title: 'Telegram Premium 3 个月', subtitle: '填用户名即可', badge: '新品', price: '128', agentPrice: '110', sort: 4 },
];
let n = 0;
for (const it of items) {
  if (existing.some((p: any) => p.title === it.title)) continue;
  const strategyId = pick(it.product);
  if (!strategyId) { console.log(`跳过 ${it.title}：没有适用的策略`); continue; }
  await api('POST', '/api/admin/shop/products', { ...it, strategyId, maxPerOrder: 5 }); n++;
}
console.log(`✓ 商城已开启，4 个模拟支付渠道可用，新建 ${n} 个商品。打开 ${BASE}/shop/ 体验`);

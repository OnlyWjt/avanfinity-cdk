/**
 * 逐页 UI 截图：每个页面 × 电脑 / 手机 × 深色 / 浅色，用来人工检查视觉细节
 *   前置：服务在 E2E_BASE（默认 18080，用 npm test 之后的 data-test 数据）
 *   node --no-warnings scripts/ui-shots.ts [页面名过滤，逗号分隔] [模式：desk-dark,desk-light,mob-dark,mob-light]
 * 输出：data-test/ui/{页面}-{模式}.png
 */
import puppeteer, { type Page, type BrowserContext } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE || 'http://localhost:18080';
const MOCK = process.env.MOCK_BASE || 'http://localhost:18090';
const OUT = process.env.SHOTS_DIR || 'data-test/ui';
mkdirSync(OUT, { recursive: true });
const only = (process.argv[2] || '').split(',').filter(Boolean);
const modes = (process.argv[3] || 'desk-dark,desk-light,mob-dark').split(',');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const problems: string[] = [];

async function ctxFor(role: string): Promise<BrowserContext> {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  if (role === 'admin') {
    await p.goto(BASE + '/admin/login.html', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#s1:not(.hidden)');
    await p.type('#em', 'admin@test.com'); await p.type('#pw', 'password123');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('#go')]);
  } else if (role === 'buyer' || role === 'agent') {
    await p.goto(BASE + '/shop/', { waitUntil: 'networkidle0' });
    const cred = role === 'buyer' ? { email: 'buyer@test.com', password: 'newpass12' } : { email: 'agent@test.com', password: 'agentpass1' };
    await p.evaluate(async c => { await fetch('/api/shop/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) }); }, cred);
  }
  await p.close();
  return ctx;
}
const ctxs: Record<string, BrowserContext> = {};
const ctx = async (role: string) => (ctxs[role] ??= await ctxFor(role));

/* 准备几种状态的订单（待付款二维码 / USDT / 已完成 / 已关闭 / 已退款） */
const admin = await ctx('admin');
const ap = await admin.newPage();
await ap.goto(BASE + '/admin/index.html', { waitUntil: 'networkidle0' });
const orders = await ap.evaluate(async () => {
  const j = (u: string) => fetch(u).then(r => r.json());
  const pick = async (st: string) => (await j('/api/admin/shop/orders?size=1&kind=buy&status=' + st)).list[0];
  const view = async (o: any) => o ? (await j('/api/admin/shop/orders/' + o.no)).viewLink : null;
  return { delivered: await view(await pick('delivered')), closed: await view(await pick('closed')), refunded: await view(await pick('refunded')) };
});
await ap.close();
const gp = await (await ctx('guest')).newPage();
await gp.goto(BASE + '/shop/', { waitUntil: 'networkidle0' });
const fresh = await gp.evaluate(async () => {
  const p = (await (await fetch('/api/shop/products')).json()).list[0];
  const mk = (m: string) => fetch('/api/shop/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: p.id, quantity: 2, email: 'shots@test.com', queryPassword: '1234', payMethod: m }) }).then(r => r.json());
  const a = await mk('alipay'), u = await mk('usdt'), e = await mk('epay');
  return { qr: `/shop/order.html?no=${a.no}&t=${a.token}`, usdt: `/shop/order.html?no=${u.no}&t=${u.token}`, epay: `/shop/order.html?no=${e.no}&t=${e.token}` };
});
await gp.close();

type Shot = { name: string; role: string; url: string; act?: (p: Page) => Promise<unknown> };
const click = (sel: string, wait = 500) => async (p: Page) => { await p.click(sel); await sleep(wait); };
const SHOTS: Shot[] = [
  // 前台
  { name: 'redeem', role: 'guest', url: '/redeem' },
  { name: 'receipt', role: 'guest', url: '/receipt.html' },
  { name: 'shop', role: 'guest', url: '/shop/' },
  { name: 'shop-buy', role: 'guest', url: '/shop/', act: click('.prod[data-id]:not(.sold)', 600) },
  { name: 'shop-buy-user', role: 'buyer', url: '/shop/', act: click('.prod[data-id]:not(.sold)', 600) },
  { name: 'order-redirect', role: 'guest', url: fresh.epay },
  { name: 'order-qr', role: 'guest', url: fresh.qr },
  { name: 'order-usdt', role: 'guest', url: fresh.usdt },
  { name: 'order-delivered', role: 'admin', url: orders.delivered },
  { name: 'order-closed', role: 'admin', url: orders.closed },
  { name: 'order-refunded', role: 'admin', url: orders.refunded },
  { name: 'order-404', role: 'guest', url: '/shop/order.html?no=S000&t=x' },
  { name: 'query', role: 'guest', url: '/shop/query.html' },
  { name: 'login', role: 'guest', url: '/account/' },
  { name: 'register', role: 'guest', url: '/account/?tab=register' },
  { name: 'account', role: 'buyer', url: '/account/' },
  { name: 'account-topup', role: 'buyer', url: '/account/', act: click('#topup') },
  { name: 'agent', role: 'agent', url: '/agent/' },
  { name: 'agent-wholesale', role: 'agent', url: '/agent/', act: click('#tab [data-v="wholesale"]', 700) },
  { name: 'agent-ledger', role: 'agent', url: '/agent/', act: click('#tab [data-v="ledger"]', 700) },
  { name: 'store', role: 'guest', url: '/s/mystore' },
  // 后台
  { name: 'a-login', role: 'guest', url: '/admin/login.html' },
  { name: 'a-index', role: 'admin', url: '/admin/index.html' },
  { name: 'a-cdks', role: 'admin', url: '/admin/cdks.html' },
  { name: 'a-cdks-detail', role: 'admin', url: '/admin/cdks.html', act: click('#tbody tr[data-id]', 700) },
  { name: 'a-generate', role: 'admin', url: '/admin/generate.html' },
  { name: 'a-orders', role: 'admin', url: '/admin/orders.html' },
  { name: 'a-orders-detail', role: 'admin', url: '/admin/orders.html', act: click('#tbody tr[data-id]', 700) },
  { name: 'a-strategy', role: 'admin', url: '/admin/strategy.html' },
  { name: 'a-pricing', role: 'admin', url: '/admin/pricing.html' },
  { name: 'a-products', role: 'admin', url: '/admin/products.html' },
  { name: 'a-products-edit', role: 'admin', url: '/admin/products.html', act: click('#tbody tr[data-id]', 700) },
  { name: 'a-shop-orders', role: 'admin', url: '/admin/shop-orders.html' },
  { name: 'a-shop-orders-detail', role: 'admin', url: '/admin/shop-orders.html?status=delivered', act: click('#tbody tr[data-no]', 700) },
  { name: 'a-coupons', role: 'admin', url: '/admin/coupons.html' },
  { name: 'a-coupons-edit', role: 'admin', url: '/admin/coupons.html', act: click('#add', 700) },
  { name: 'a-agents', role: 'admin', url: '/admin/agents.html' },
  { name: 'a-agents-wd', role: 'admin', url: '/admin/agents.html', act: click('#tab [data-v="withdrawals"]', 700) },
  { name: 'a-agents-levels', role: 'admin', url: '/admin/agents.html', act: click('#tab [data-v="levels"]', 700) },
  { name: 'a-customers', role: 'admin', url: '/admin/customers.html' },
  { name: 'a-customers-detail', role: 'admin', url: '/admin/customers.html', act: click('#tbody tr[data-id]', 700) },
  { name: 'a-insights', role: 'admin', url: '/admin/insights.html' },
  { name: 'a-transactions', role: 'admin', url: '/admin/transactions.html' },
  { name: 'a-webhooks', role: 'admin', url: '/admin/webhooks.html' },
  { name: 'a-settings', role: 'admin', url: '/admin/settings.html' },
  { name: 'a-settings-redeem', role: 'admin', url: '/admin/settings.html?tab=redeem' },
  { name: 'a-settings-shop', role: 'admin', url: '/admin/settings.html?tab=shop' },
  { name: 'a-settings-pay', role: 'admin', url: '/admin/settings.html?tab=pay' },
  { name: 'a-settings-mail', role: 'admin', url: '/admin/settings.html?tab=mail' },
  { name: 'a-settings-team', role: 'admin', url: '/admin/settings.html?tab=team' },
  { name: 'a-settings-security', role: 'admin', url: '/admin/settings.html?tab=security' },
  { name: 'a-theme', role: 'admin', url: '/admin/theme.html' },
];

for (const s of SHOTS) {
  if (only.length && !only.some(o => s.name === o || (o.endsWith('*') && s.name.startsWith(o.slice(0, -1))))) continue;
  if (!s.url) { console.log('跳过（没有数据）', s.name); continue; }
  for (const m of modes) {
    const [dev, mode] = m.split('-');
    const p = await (await ctx(s.role)).newPage();
    p.on('pageerror', e => problems.push(`${s.name}/${m} JS: ${(e as Error).message}`));
    await p.setViewport(dev === 'mob' ? { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true } : { width: 1440, height: 900 });
    await p.goto(BASE + '/shop/query.html', { waitUntil: 'domcontentloaded' });
    await p.evaluate(md => localStorage.setItem('cdk-mode', md), mode);
    await p.goto(BASE + s.url, { waitUntil: 'networkidle0' }).catch(() => {});
    await sleep(900);
    if (s.act) await s.act(p).catch(e => problems.push(`${s.name}/${m} 操作失败: ${e.message}`));
    await p.screenshot({ path: `${OUT}/${s.name}-${m}.png`, fullPage: !s.act });
    await p.close();
  }
  console.log('✓', s.name);
}
await browser.close();
console.log(problems.length ? '问题：\n' + problems.join('\n') : '无 JS 错误');
void MOCK;

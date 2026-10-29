/**
 * 浏览器 UI 检查：打开每个页面，收集 JS 报错 / 接口失败，截图到 data-e2e/shots
 * 前置：服务和模拟卡台在运行，且已跑过 e2e（有管理员 admin@test.com / password123 和数据）
 *   node --no-warnings scripts/ui-check.ts
 */
import puppeteer, { type Page } from 'puppeteer-core';
import jsqrMod from 'jsqr';
const jsQR = ((jsqrMod as any).default ?? jsqrMod) as typeof import('jsqr').default;
import { mkdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE || 'http://localhost:8080';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SHOTS_DIR || 'data-e2e/shots';
mkdirSync(OUT, { recursive: true });
// 输出里以 ✗ 开头的行都算失败
const _log = console.log; let uiFails = 0;
console.log = (...a: unknown[]) => { if (String(a[0]).startsWith('✗')) uiFails++; _log(...a); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1500,1000'], defaultViewport: { width: 1500, height: 1000 } });
const page = await browser.newPage();
const problems: string[] = [];
let current = '';
page.on('pageerror', e => problems.push(`[${current}] JS 错误: ${(e as Error).message}`));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[${current}] console: ${m.text()}`); });
page.on('response', r => { const u = r.url(); if (u.includes('/api/') && r.status() >= 400 && !u.includes('/api/auth/me') && !(current === 'layers' && r.status() === 409)) problems.push(`[${current}] ${r.status()} ${r.request().method()} ${u.replace(BASE, '')}`); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 登录
current = 'login';
await page.goto(BASE + '/admin/login.html', { waitUntil: 'networkidle0' });
await page.waitForSelector('#s1:not(.hidden)');
await page.type('#em', 'admin@test.com'); await page.type('#pw', 'password123');
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#go')]);
console.log('✓ 登录 →', page.url().replace(BASE, ''));

for (const p of ['index', 'cdks', 'generate', 'orders', 'strategy', 'pricing', 'insights', 'transactions', 'webhooks', 'settings', 'theme']) {
  current = p;
  await page.goto(`${BASE}/admin/${p}.html`, { waitUntil: 'networkidle0' });
  await sleep(600);
  await page.screenshot({ path: `${OUT}/${p}.png` });
  console.log('✓', p);
}

// 交互：CDK 详情抽屉、兑换记录详情、策略规则测试、生成一批
current = 'cdks-detail';
await page.goto(`${BASE}/admin/cdks.html?p=gpt`, { waitUntil: 'networkidle0' });
await page.click('#tbody tr[data-id]'); await sleep(800);
await page.screenshot({ path: `${OUT}/cdks-detail.png` });
current = 'orders-detail';
await page.goto(`${BASE}/admin/orders.html?f=blocked`, { waitUntil: 'networkidle0' });
await page.click('#tbody tr[data-id]'); await sleep(800);
await page.screenshot({ path: `${OUT}/orders-detail.png` });
current = 'strategy-test';
await page.goto(`${BASE}/admin/strategy.html`, { waitUntil: 'networkidle0' });
await page.type('#tCode', 'E123-AAAA'); await page.type('#tAcc', 'someone@gmail.com');
await page.click('#runTest'); await sleep(800);
await page.screenshot({ path: `${OUT}/strategy-test.png`, fullPage: true });
current = 'generate-run';
await page.goto(`${BASE}/admin/generate.html?p=gpt`, { waitUntil: 'networkidle0' });
await page.click('#go'); await sleep(1500);
const genOk = await page.$eval('.dlg h2', e => e.textContent).catch(() => '');
console.log(genOk?.includes('已生成') ? '✓ 页面生成兑换码' : '✗ 页面生成失败');
const code = await page.$eval('.codes div', e => e.firstChild?.textContent?.trim() || '').catch(() => '');
await page.screenshot({ path: `${OUT}/generate-result.png` });

// 买家兑换页：用刚生成的码走一遍 GPT 流程
const buyer = await browser.newPage();
buyer.on('pageerror', e => problems.push(`[redeem] JS 错误: ${(e as Error).message}`));
await buyer.setViewport({ width: 1300, height: 900 });
current = 'redeem';
await buyer.bringToFront();
await buyer.goto(BASE + '/', { waitUntil: 'networkidle0' });
await buyer.screenshot({ path: `${OUT}/redeem-1.png` });
await buyer.type('#code', code.toLowerCase());
await buyer.click('#next'); await buyer.waitForSelector('#sess', { timeout: 10000 });
await buyer.screenshot({ path: `${OUT}/redeem-2.png` });
await buyer.type('#sess', JSON.stringify({ user: { id: 'user-ui-' + Date.now(), email: `ui${Date.now()}@gmail.com` }, accessToken: 'x' }));
await buyer.click('#next'); await buyer.waitForSelector('#cd', { timeout: 10000 });
await buyer.screenshot({ path: `${OUT}/redeem-3.png` });
await buyer.click('#next');
await buyer.waitForFunction(() => document.querySelector('.bigicon') && document.body.innerText.includes('开通成功'), { timeout: 20000 }).then(() => console.log('✓ 兑换页 GPT 全流程开通成功'), () => console.log('✗ 兑换页没有等到成功'));
await buyer.screenshot({ path: `${OUT}/redeem-4.png` });
current = 'receipt';
await buyer.goto(BASE + '/receipt.html', { waitUntil: 'networkidle0' });
await buyer.type('#code', code); await buyer.click('#go'); await sleep(800);
await buyer.screenshot({ path: `${OUT}/receipt.png` });

// 浅色模式抽查
current = 'light';
await page.bringToFront();
await page.evaluate(() => localStorage.setItem('cdk-mode', 'light'));
await page.goto(`${BASE}/admin/index.html`, { waitUntil: 'networkidle0' }); await sleep(500);
await page.screenshot({ path: `${OUT}/index-light.png` });
await page.evaluate(() => localStorage.removeItem('cdk-mode'));

// 下拉框：鼠标选择 → 列表按状态筛选；键盘操作
current = 'dropdown';
await page.bringToFront();
await page.goto(`${BASE}/admin/cdks.html?p=gpt`, { waitUntil: 'networkidle0' });
const ddCount = await page.$$eval('.dd', e => e.length), nativeVisible = await page.$$eval('select.field', s => s.filter(x => x.getBoundingClientRect().width > 2).length);
console.log(ddCount >= 3 && nativeVisible === 0 ? `✓ 下拉框已替换（${ddCount} 个，原生 select 已隐藏）` : `✗ 下拉框替换异常 dd=${ddCount} 原生可见=${nativeVisible}`);
await page.click('#stSel + .dd'); await sleep(250);
await page.screenshot({ path: `${OUT}/dropdown-open.png` });
const optTexts = await page.$$eval('.dd-pop .dd-opt', e => e.map(x => x.textContent?.trim()));
await page.evaluate(() => (([...document.querySelectorAll('.dd-pop .dd-opt')] as HTMLElement[]).find(x => x.textContent?.includes('已兑换')))!.click());
await page.waitForNetworkIdle(); await sleep(300);
const rowsOk = await page.$$eval('#tbody tr[data-id] td:nth-child(5)', tds => tds.length > 0 && tds.every(td => td.textContent!.includes('已兑换')));
const label = await page.$eval('#stSel + .dd .dd-label', e => e.textContent);
console.log(rowsOk && label === '已兑换' ? `✓ 下拉框选择「已兑换」后列表正确筛选（选项：${optTexts.join('/')}）` : `✗ 下拉框筛选不正确 label=${label}`);
await page.focus('#planSel + .dd'); await page.keyboard.press('ArrowDown'); await sleep(150); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
await page.waitForNetworkIdle(); await sleep(200);
const planLabel = await page.$eval('#planSel + .dd .dd-label', e => e.textContent), planVal = await page.$eval('#planSel', e => (e as HTMLSelectElement).value);
console.log(planVal && planLabel !== '全部套餐' ? `✓ 下拉框键盘选择 → ${planLabel}（${planVal}）` : '✗ 下拉框键盘选择失败');
await page.keyboard.press('Escape');
current = 'dropdown-light';
await page.evaluate(() => localStorage.setItem('cdk-mode', 'light'));
await page.goto(`${BASE}/admin/orders.html`, { waitUntil: 'networkidle0' });
await page.click('#stratSel + .dd'); await sleep(250);
await page.screenshot({ path: `${OUT}/dropdown-light.png` });
await page.evaluate(() => localStorage.removeItem('cdk-mode'));
current = 'dropdown-settings';
await page.goto(`${BASE}/admin/settings.html`, { waitUntil: 'networkidle0' });
await page.click('#productCode + .dd'); await sleep(250);
await page.screenshot({ path: `${OUT}/dropdown-settings.png` });

// X 两阶段兑换（页面上点）
current = 'redeem-x';
await page.bringToFront();
const xCode = await page.evaluate(async () => {
  const st = (await (await fetch('/api/admin/strategies')).json()).list.find((s: any) => s.mode === 'own' && s.prod.includes('x') && s.on);
  const r = await (await fetch('/api/admin/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product: 'x', plan: 'premium_6m', quantity: 1, strategyId: st.id, idemKey: 'gen-ui-' + Date.now(), social: { maxWalletDebitUsd: '60.00', currency: 'usd', maxOfficialAmountMinor: 5500, fundingAmountUsd: '50.00' } }) })).json();
  return r.codes[0];
});
const bxCtx = await browser.createBrowserContext();
const bx = await bxCtx.newPage();
bx.on('pageerror', e => problems.push(`[redeem-x] JS 错误: ${(e as Error).message}`));
await bx.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
await bx.bringToFront();
await bx.goto(BASE + '/', { waitUntil: 'networkidle0' });
await bx.screenshot({ path: `${OUT}/mobile-1.png` });
await bx.type('#code', xCode); await bx.click('#next');
await bx.waitForSelector('#rec', { timeout: 10000 });
await bx.type('#rec', 'ui_x_user_' + String(Date.now()).slice(-5)); await bx.click('#next');
await bx.waitForSelector('#cd', { timeout: 10000 });
await bx.screenshot({ path: `${OUT}/mobile-2.png` });
await bx.click('#next');
await bx.waitForSelector('#pay', { timeout: 20000 }).then(() => console.log('✓ X 第一阶段完成，页面出现「确认付款」'), () => console.log('✗ X 没有进入确认付款'));
await bx.screenshot({ path: `${OUT}/mobile-3.png` });
await bx.click('#pay');
await bx.waitForFunction(() => document.body.innerText.includes('开通成功'), { timeout: 20000 }).then(() => console.log('✓ 手机端 X 两阶段兑换开通成功'), () => console.log('✗ X 没有等到成功'));
await bx.screenshot({ path: `${OUT}/mobile-4.png` });
// 刷新后恢复结果
await bx.reload({ waitUntil: 'networkidle0' }); await sleep(500);
console.log((await bx.evaluate(() => document.body.innerText.includes('开通成功'))) ? '✓ 刷新页面后恢复兑换结果' : '✗ 刷新后没有恢复');

// 客服角色：页面上看不到操作按钮
current = 'support-ui';
await page.bringToFront();
const supEmail = `ui-support-${Date.now()}@test.com`;
await page.evaluate(async e => { await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '客服UI', email: e, password: 'support123', role: 'support' }) }); }, supEmail);
const ctx2 = await browser.createBrowserContext();
const sp = await ctx2.newPage();
sp.on('pageerror', e => problems.push(`[support-ui] JS 错误: ${(e as Error).message}`));
await sp.goto(BASE + '/admin/login.html', { waitUntil: 'networkidle0' });
await sp.waitForSelector('#s1:not(.hidden)');
await sp.type('#em', supEmail); await sp.type('#pw', 'support123');
await Promise.all([sp.waitForNavigation({ waitUntil: 'networkidle0' }), sp.click('#go')]);
await sp.goto(BASE + '/admin/cdks.html', { waitUntil: 'networkidle0' }); await sleep(400);
const genVisible = await sp.$eval('#genLink', e => !e.classList.contains('hidden'));
await sp.goto(BASE + '/admin/generate.html', { waitUntil: 'networkidle0' }); await sleep(400);
const noGen = await sp.evaluate(() => document.body.innerText.includes('没有生成权限'));
console.log(!genVisible && noGen ? '✓ 客服角色看不到生成入口，生成页提示无权限' : `✗ 客服角色权限显示不正确 genVisible=${genVisible}`);
await ctx2.close();

// 弹层统一：抽屉结构、Esc 关闭、滚动锁定、错误显示在弹窗内
current = 'layers';
await page.bringToFront();
await page.goto(`${BASE}/admin/orders.html`, { waitUntil: 'networkidle0' });
await page.click('#tbody tr[data-id]'); await sleep(450);
const sh = await page.evaluate(() => ({ head: !!document.querySelector('.sheet.show .dlg-h h2'), foot: document.querySelectorAll('.sheet.show .dlg-f .btn').length, lock: document.documentElement.classList.contains('layer-open') }));
await page.keyboard.press('Escape'); await sleep(400);
const closed = await page.evaluate(() => !document.querySelector('.sheet') && !document.documentElement.classList.contains('layer-open'));
console.log(sh.head && sh.foot >= 1 && sh.lock && closed ? '✓ 抽屉：统一标题栏 / 底部按钮 / 打开时锁定滚动 / Esc 关闭' : `✗ 抽屉结构或关闭异常 ${JSON.stringify(sh)} closed=${closed}`);
await page.goto(`${BASE}/admin/settings.html?tab=team`, { waitUntil: 'networkidle0' }); await sleep(300);
await page.click('#invite'); await sleep(300);
await page.type('.dlg.show #n', '重复'); await page.type('.dlg.show #e', 'admin@test.com');
await page.click('.dlg.show .dlg-f .btn.primary'); await sleep(600);
const errIn = await page.evaluate(() => { const e = document.querySelector('.dlg.show .dlg-err'); return e && !e.classList.contains('hidden') ? e.textContent : null; });
await page.screenshot({ path: `${OUT}/dialog-error.png` });
console.log(errIn ? `✓ 弹窗内显示错误且不关闭：${errIn}` : '✗ 弹窗没有显示错误');
await page.keyboard.press('Escape'); await sleep(300);
await page.goto(`${BASE}/admin/cdks.html?p=gpt`, { waitUntil: 'networkidle0' });
await page.click('#bRevoke').catch(() => {});
await page.click('#tbody input[data-sel]'); await page.click('#bRevoke'); await sleep(350);
await page.screenshot({ path: `${OUT}/dialog-confirm.png` });
const conf = await page.evaluate(() => ({ title: document.querySelector('.dlg.show h2')?.textContent, ic: !!document.querySelector('.dlg.show .dlg-ic.bad'), btns: [...document.querySelectorAll('.dlg.show .dlg-f .btn')].map(b => b.textContent) }));
console.log(conf.ic && conf.btns.join('/') === '取消/撤销' ? `✓ 确认框：危险图标 + 「取消 / 撤销」（${conf.title}）` : `✗ 确认框结构异常 ${JSON.stringify(conf)}`);
await page.keyboard.press('Escape'); await sleep(300);

// 主题页不覆盖个人深浅色偏好
current = 'theme-mode';
await page.evaluate(() => localStorage.setItem('cdk-mode', 'light'));
await page.goto(`${BASE}/admin/theme.html`, { waitUntil: 'networkidle0' }); await sleep(500);
const tm = await page.evaluate(() => ({ page: document.documentElement.dataset.mode, pref: localStorage.getItem('cdk-mode'), prev: (document.querySelector('#prevBox') as HTMLElement | null)?.dataset.mode }));
await page.screenshot({ path: `${OUT}/theme-light.png` });
await page.click('#modeSeg button[data-v="light"]'); await sleep(200);
const prevAfter = await page.$eval('#prevBox', e => (e as HTMLElement).dataset.mode);
await page.click('#modeSeg button[data-v="dark"]'); await sleep(200);
const pageAfter = await page.evaluate(() => document.documentElement.dataset.mode);
console.log(tm.page === 'light' && tm.pref === 'light' && prevAfter === 'light' && pageAfter === 'light' ? `✓ 主题页保持你的浅色模式；预览区按兑换页默认外观（${tm.prev}）切换` : `✗ 主题页深浅色异常 ${JSON.stringify(tm)} prevAfter=${prevAfter} pageAfter=${pageAfter}`);
await page.evaluate(() => localStorage.removeItem('cdk-mode'));

/* ================= 商城（需要先跑过 e2e-shop.ts：已配置模拟支付、商品、买家和代理） ================= */
const MOCKB = process.env.MOCK_BASE || 'http://localhost:8090';
const watch = (p: Page, name: string) => {
  p.on('pageerror', e => problems.push(`[${name}] JS 错误: ${(e as Error).message}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[${name}] console: ${m.text()}`); });
  p.on('response', r => { const u = r.url(); if (u.startsWith(BASE) && u.includes('/api/') && r.status() >= 400 && !u.includes('/api/auth/me')) problems.push(`[${name}] ${r.status()} ${r.request().method()} ${u.replace(BASE, '')}`); });
};
await page.bringToFront();
for (const p of ['products', 'shop-orders', 'coupons', 'agents', 'customers']) {
  current = p;
  await page.goto(`${BASE}/admin/${p}.html`, { waitUntil: 'networkidle0' }); await sleep(400);
  await page.screenshot({ path: `${OUT}/${p}.png` });
  const rows = await page.$$eval('#tbody tr[data-id],#tbody tr[data-no],#pane tbody tr[data-id],#tbody tr', e => e.length);
  console.log(rows > 0 ? `✓ 后台 ${p}` : `✗ 后台 ${p} 没有数据`);
}
current = 'products-edit';
await page.goto(`${BASE}/admin/products.html`, { waitUntil: 'networkidle0' });
await page.click('#tbody tr[data-id]'); await sleep(450);
const pe = await page.evaluate(() => ({ plan: (document.querySelector('.sheet.show #eplan') as HTMLSelectElement)?.value, price: (document.querySelector('.sheet.show #epr') as HTMLInputElement)?.value, cost: document.querySelector('.sheet.show #costHelp')?.textContent }));
await page.screenshot({ path: `${OUT}/products-edit.png` });
console.log(pe.plan && pe.price && pe.cost ? `✓ 商品编辑抽屉：${pe.plan} ¥${pe.price}（${pe.cost}）` : `✗ 商品编辑抽屉异常 ${JSON.stringify(pe)}`);
await page.keyboard.press('Escape'); await sleep(300);
current = 'shop-orders-detail';
await page.goto(`${BASE}/admin/shop-orders.html?status=delivered`, { waitUntil: 'networkidle0' });
await page.click('#tbody tr[data-no]'); await sleep(450);
const od = await page.evaluate(() => ({ codes: document.querySelectorAll('.sheet.show .codes div').length, btns: [...document.querySelectorAll('.sheet.show .dlg-f .btn')].map(b => b.textContent) }));
await page.screenshot({ path: `${OUT}/shop-orders-detail.png` });
console.log(od.codes > 0 && od.btns.includes('退款') && od.btns.includes('补发邮件') ? `✓ 订单详情：${od.codes} 张码，操作 ${od.btns.join('/')}` : `✗ 订单详情异常 ${JSON.stringify(od)}`);
await page.keyboard.press('Escape'); await sleep(300);
for (const t of ['shop', 'pay', 'mail']) {
  current = 'settings-' + t;
  await page.goto(`${BASE}/admin/settings.html?tab=${t}`, { waitUntil: 'networkidle0' }); await sleep(400);
  await page.screenshot({ path: `${OUT}/settings-${t}.png`, fullPage: true });
}
await page.goto(`${BASE}/admin/settings.html?tab=pay`, { waitUntil: 'networkidle0' }); await sleep(400);
const ready = await page.$$eval('#payGrid [data-ch] h3 .badge.ok', e => e.length);
const leaked = await page.evaluate(() => [...document.querySelectorAll('#payGrid [data-secret]')].some(i => (i as HTMLInputElement).value));
console.log(ready === 4 && !leaked ? '✓ 支付设置：4 个渠道可用，密钥输入框为空（不回显）' : `✗ 支付设置异常 ready=${ready} leaked=${leaked}`);

// 免注册买家：商城下单 → 易支付收银台 → 付款 → 回到订单页看到兑换码 → 一键兑换
current = 'shop-buy';
const gctx = await browser.createBrowserContext();
const g = await gctx.newPage(); watch(g, 'shop-buy');
await g.setViewport({ width: 1300, height: 900 });
await g.goto(BASE + '/shop/', { waitUntil: 'networkidle0' });
await g.waitForSelector('.prod[data-id]');
await g.screenshot({ path: `${OUT}/shop-home.png` });
const cards = await g.$$eval('.prod[data-id]', e => e.length);
await g.click('.prod[data-id]:not(.sold)'); await g.waitForSelector('.dlg.show #email');
await g.type('.dlg.show #email', 'ui-buyer@test.com'); await g.type('.dlg.show #qpw', '5678');
await g.click('.dlg.show #inc'); await sleep(100);
const total = await g.$eval('.dlg.show #sum .total b', e => e.textContent);
await g.screenshot({ path: `${OUT}/shop-buy.png` });
await Promise.all([g.waitForNavigation({ waitUntil: 'networkidle0' }), g.click('.dlg.show #payBtn')]);
const onCashier = g.url().startsWith(MOCKB) && (await g.$('#mockPay')) !== null;
console.log(cards > 0 && onCashier ? `✓ 商城 ${cards} 个商品，下单 2 件 ${total} → 跳转易支付收银台` : `✗ 没有跳到收银台 ${g.url()}`);
await Promise.all([g.waitForNavigation({ waitUntil: 'networkidle0' }), g.click('#mockPay')]);
await g.waitForFunction(() => document.querySelectorAll('.ocode').length >= 2, { timeout: 20000 }).catch(() => {});
const codes = await g.$$eval('.ocode .mono', e => e.map(x => x.textContent));
await g.screenshot({ path: `${OUT}/shop-delivered.png` });
console.log(codes.length === 2 && g.url().includes('/shop/order.html') ? `✓ 付款后回到订单页，自动发货 2 张：${codes[0]?.slice(0, 9)}…` : `✗ 订单页没有显示兑换码 ${g.url()}`);
await Promise.all([g.waitForNavigation({ waitUntil: 'networkidle0' }), g.click('.ocode a.btn.primary')]);
await sleep(400);
const prefilled = await g.$eval('#code', e => (e as HTMLInputElement).value).catch(() => '');
console.log(prefilled && codes[0]?.toUpperCase().startsWith(prefilled.slice(0, 6)) ? '✓ 点「去兑换」打开兑换页，兑换码已自动填好' : `✗ 兑换页没有自动填码 ${prefilled}`);
current = 'shop-query';
await g.goto(BASE + '/shop/query.html', { waitUntil: 'networkidle0' });
const recent = await g.$$eval('#recent a', e => e.length);
await g.type('#key', 'ui-buyer@test.com'); await g.type('#pw', '5678');
await Promise.all([g.waitForNavigation({ waitUntil: 'networkidle0' }), g.click('#go')]);
console.log(recent >= 1 && g.url().includes('/shop/order.html') ? '✓ 查询页：本机最近订单 + 邮箱 / 查询密码查到订单' : `✗ 查询订单失败 ${g.url()}`);

// 支付宝扫码：订单页二维码能被识别出正确的链接
current = 'shop-qr';
const qr = await g.evaluate(async () => {
  const p = (await (await fetch('/api/shop/products')).json()).list[0];
  const r = await (await fetch('/api/shop/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: p.id, email: 'ui-qr@test.com', queryPassword: '1234', payMethod: 'alipay' }) })).json();
  return r;
});
await g.goto(`${BASE}/shop/order.html?no=${qr.no}&t=${qr.token}`, { waitUntil: 'networkidle0' });
await g.waitForSelector('#qr svg');
const px = await g.evaluate(async () => {
  const svg = document.querySelector('#qr svg')!.outerHTML, img = new Image(), S = 300;
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d')!; x.drawImage(img, 0, 0, S, S);
  return { w: S, data: Array.from(x.getImageData(0, 0, S, S).data) };
});
const dec = jsQR(Uint8ClampedArray.from(px.data), px.w, px.w);
await g.screenshot({ path: `${OUT}/shop-qr.png` });
console.log(dec?.data === qr.pay.qr ? `✓ 支付宝订单页二维码可识别：${dec!.data.replace(MOCKB, '')}` : `✗ 二维码识别失败 ${dec?.data} ≠ ${qr.pay.qr}`);
// 扫码付款（模拟）后页面自动刷新为已发货
await fetch(MOCKB + '/mock/alipay/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ out_trade_no: new URL(qr.pay.qr).pathname.split('/').pop() }) });
const autoDone = await g.waitForFunction(() => document.querySelectorAll('.ocode').length > 0, { timeout: 15000 }).then(() => true, () => false);
console.log(autoDone ? '✓ 扫码付款后订单页自动刷新出兑换码' : '✗ 订单页没有自动刷新');
// USDT
current = 'shop-usdt';
const uo = await g.evaluate(async () => {
  const p = (await (await fetch('/api/shop/products')).json()).list[0];
  return (await fetch('/api/shop/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: p.id, email: 'ui-usdt@test.com', queryPassword: '1234', payMethod: 'usdt' }) })).json();
});
await g.goto(`${BASE}/shop/order.html?no=${uo.no}&t=${uo.token}`, { waitUntil: 'networkidle0' });
const ut = await g.evaluate(() => document.body.innerText);
await g.screenshot({ path: `${OUT}/shop-usdt.png`, fullPage: true });
console.log(ut.includes(uo.pay.amount) && ut.includes(uo.pay.address) && ut.includes('TRC20') ? `✓ USDT 订单页显示精确金额 ${uo.pay.amount} 和收款地址` : '✗ USDT 订单页信息不全');
await g.evaluate(async no => { await fetch(`/api/shop/orders/${no}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: new URLSearchParams(location.search).get('t') }) }); }, uo.no);
await gctx.close();

// 注册用户：登录 → 我的账户 → 余额购买
current = 'account';
const actx = await browser.createBrowserContext();
const a = await actx.newPage(); watch(a, 'account');
await a.setViewport({ width: 1300, height: 900 });
await a.goto(BASE + '/account/', { waitUntil: 'networkidle0' });
await a.type('#email', 'buyer@test.com'); await a.type('#pw', 'newpass12');
await a.click('#go'); await a.waitForSelector('.balance .v');
await a.waitForSelector('#list tbody tr'); await sleep(300);
const acc = await a.evaluate(() => ({ bal: document.querySelector('.balance .v')?.textContent, rows: document.querySelectorAll('#list tbody tr.click').length, top: document.querySelector('#shopTop nav')?.textContent }));
await a.screenshot({ path: `${OUT}/account.png` });
console.log(acc.rows >= 2 && acc.top?.includes('我的') ? `✓ 买家登录：余额 ${acc.bal}，${acc.rows} 个订单` : `✗ 买家中心异常 ${JSON.stringify(acc)}`);
await a.click('#tab [data-v="ledger"]'); await sleep(400);
await a.click('#topup'); await sleep(300);
await a.screenshot({ path: `${OUT}/account-topup.png` });
await a.keyboard.press('Escape'); await sleep(250);
await a.goto(BASE + '/shop/', { waitUntil: 'networkidle0' });
await a.click('.prod[data-id]:not(.sold)'); await a.waitForSelector('.dlg.show #pm');
const hasBal = await a.$eval('.dlg.show #pm .opt.on', e => e.textContent?.includes('余额'));
await Promise.all([a.waitForNavigation({ waitUntil: 'networkidle0' }), a.click('.dlg.show #payBtn')]);
await a.waitForFunction(() => document.querySelectorAll('.ocode').length > 0, { timeout: 15000 }).catch(() => {});
console.log(hasBal && (await a.$$('.ocode')).length === 1 ? '✓ 登录用户默认余额支付，直接发货' : '✗ 余额支付流程异常');

// 代理中心
current = 'agent';
await a.evaluate(() => fetch('/api/shop/account/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
await a.evaluate(() => sessionStorage.clear());
await a.goto(BASE + '/account/', { waitUntil: 'networkidle0' });
await a.type('#email', 'agent@test.com'); await a.type('#pw', 'agentpass1');
await a.click('#go'); await a.waitForSelector('.balance');
await Promise.all([a.waitForNavigation({ waitUntil: 'networkidle0' }), a.click('a[href="/agent/"]')]);
await a.waitForSelector('#pane tbody tr'); await sleep(300);
await a.screenshot({ path: `${OUT}/agent.png`, fullPage: true });
const tabsOk: string[] = [];
for (const t of ['orders', 'wholesale', 'stock', 'ledger', 'store']) { await a.click(`#tab [data-v="${t}"]`); await sleep(450); if (await a.$('#pane .card')) tabsOk.push(t); await a.screenshot({ path: `${OUT}/agent-${t}.png` }); }
console.log(tabsOk.length === 5 ? '✓ 代理中心：定价 / 订单 / 批发 / 库存 / 收益 / 店铺 页面正常' : `✗ 代理中心标签异常 ${tabsOk.join(',')}`);
current = 'store';
await a.goto(BASE + '/s/mystore', { waitUntil: 'networkidle0' });
await a.waitForSelector('.prod[data-id]');
const st = await a.evaluate(() => ({ title: document.querySelector('#title')?.textContent, brand: document.querySelector('#shopTop .brand span')?.textContent, price: document.querySelector('.prod .price')?.textContent }));
await a.screenshot({ path: `${OUT}/store.png` });
console.log(st.title === '小明的店' && st.brand === '小明的店' ? `✓ 分站 /s/mystore：店铺名和代理售价（${st.price}）` : `✗ 分站异常 ${JSON.stringify(st)}`);
await actx.close();

// 手机端商城
current = 'shop-mobile';
const mctx = await browser.createBrowserContext();
const m = await mctx.newPage(); watch(m, 'shop-mobile');
await m.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
await m.goto(BASE + '/shop/', { waitUntil: 'networkidle0' }); await m.waitForSelector('.prod[data-id]');
await m.screenshot({ path: `${OUT}/shop-mobile.png` });
await m.click('.prod[data-id]:not(.sold)'); await sleep(400);
await m.screenshot({ path: `${OUT}/shop-mobile-buy.png` });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log(!overflow ? '✓ 手机端商城无横向溢出' : '✗ 手机端商城横向溢出');
await mctx.close();

/* ================= 体验修复回归 ================= */
// 总览里有商城数据
current = 'index-shop';
await page.bringToFront();
await page.goto(`${BASE}/admin/index.html`, { waitUntil: 'networkidle0' }); await sleep(500);
const shopRow = await page.$eval('#shopRow', e => !e.classList.contains('hidden') && e.textContent || '').catch(() => '');
console.log(shopRow.includes('商城 · 今日') && shopRow.includes('销售额') ? '✓ 总览显示商城今日成交和待处理事项' : `✗ 总览没有商城数据`);
// 窄屏后台：菜单按钮打开侧边栏抽屉
current = 'admin-mobile';
const amctx = await browser.createBrowserContext();
const am = await amctx.newPage(); watch(am, 'admin-mobile');
await am.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await am.goto(BASE + '/admin/login.html', { waitUntil: 'networkidle0' });
await am.waitForSelector('#s1:not(.hidden)');
await am.type('#em', 'admin@test.com'); await am.type('#pw', 'password123');
await Promise.all([am.waitForNavigation({ waitUntil: 'networkidle0' }), am.click('#go')]);
const sideHidden = await am.$eval('.side', e => getComputedStyle(e).display === 'none');
await am.click('#menuBtn'); await sleep(300);
const sideShown = await am.$eval('.side', e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 100);
await am.screenshot({ path: `${OUT}/admin-mobile-nav.png` });
await am.click('.nav a[href="shop-orders.html"]'); await am.waitForSelector('#tbody tr'); await sleep(300);
await am.screenshot({ path: `${OUT}/admin-mobile-orders.png` });
const amOverflow = await am.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log(sideHidden && sideShown && am.url().includes('shop-orders') ? `✓ 手机端后台：菜单按钮打开导航并能跳转${amOverflow ? '（页面有横向滚动）' : ''}` : `✗ 手机端后台导航异常 hidden=${sideHidden} shown=${sideShown}`);
await amctx.close();

// 余额不够时不默认选余额
current = 'pay-picker';
const pctx = await browser.createBrowserContext();
const pp = await pctx.newPage(); watch(pp, 'pay-picker');
await pp.setViewport({ width: 1300, height: 900 });
await pp.goto(BASE + '/account/', { waitUntil: 'networkidle0' });
await pp.type('#email', 'buyer@test.com'); await pp.type('#pw', 'newpass12');
await pp.click('#go'); await pp.waitForSelector('.balance .v');
await pp.goto(BASE + '/shop/', { waitUntil: 'networkidle0' });
await pp.click('.prod[data-id]:not(.sold)'); await pp.waitForSelector('.dlg.show #pm');
for (let i = 0; i < 9; i++) { await pp.click('.dlg.show #inc'); await sleep(30); }
await sleep(200);
const pk = await pp.evaluate(() => { const b = document.querySelector('.dlg.show #pm [data-i="0"]') as HTMLButtonElement; const on = document.querySelector('.dlg.show #pm .opt.on'); return { balDisabled: b?.disabled, note: b?.textContent, on: on?.textContent }; });
await pp.screenshot({ path: `${OUT}/pay-picker-short.png` });
console.log(pk.balDisabled && pk.note?.includes('还差') && !pk.on?.includes('余额') ? `✓ 余额不够时余额选项置灰并提示差额，默认改选「${pk.on?.trim().slice(0, 6)}」` : `✗ 余额不足处理异常 ${JSON.stringify(pk)}`);
await pctx.close();

// 「去兑换」带来的新码覆盖已经结束的旧兑换
current = 'redeem-override';
const rctx = await browser.createBrowserContext();
const rp = await rctx.newPage();  // 故意放了不存在的旧记录，404 是预期的，不挂接口监控
await rp.goto(BASE + '/redeem', { waitUntil: 'networkidle0' });
await rp.evaluate(() => localStorage.setItem('cdk-rid', 'R-does-not-exist'));
await rp.goto(BASE + '/receipt.html', { waitUntil: 'networkidle0' });
await rp.goto(BASE + '/redeem#code=ABCD-1234-EFGH', { waitUntil: 'networkidle0' }); await sleep(300);
const rv = await rp.$eval('#code', e => (e as HTMLInputElement).value).catch(() => '');
console.log(rv === 'ABCD-1234-EFGH' ? '✓ 兑换页：链接带来的兑换码优先于本机旧记录' : `✗ 兑换页没有用链接里的码 ${rv}`);
await rctx.close();

// 主题页：选预设 → 右侧嵌入的真实商城页实时换肤，未发布前不影响线上
current = 'theme-preview';
await page.bringToFront();
await page.goto(`${BASE}/admin/theme.html`, { waitUntil: 'networkidle0' }); await sleep(1200);
const presetN = await page.$$eval('.pre', e => e.length);
await page.click('.pre[data-k="cyber"]'); await sleep(900);
const fr = page.frames().find(f => f.url().includes('preview=1'));
const pv = fr ? await fr.evaluate(() => ({ bg: document.documentElement.dataset.bg, font: document.documentElement.dataset.font, a1: getComputedStyle(document.documentElement).getPropertyValue('--a1').trim(), passes: document.querySelectorAll('.prod.pass').length })) : null;
const live = (await page.evaluate(async () => (await (await fetch('/api/shop/config')).json()).theme.preset));
await page.screenshot({ path: `${OUT}/theme-cyber.png` });
console.log(presetN >= 16 && pv?.bg === 'grid' && pv.font === 'tech' && pv.a1 === '#ff2bd6' && pv.passes > 0 && live !== 'cyber' ? `✓ 主题页：${presetN} 套预设，选「赛博」后预览里的商城实时换成网格背景 + 科技字体，未发布不影响线上` : `✗ 主题预览异常 ${JSON.stringify({ presetN, pv, live })}`);
await page.evaluate(() => { location.reload(); });
await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {});

await browser.close();
console.log(problems.length ? `\n✗ 发现 ${problems.length} 个问题：\n` + [...new Set(problems)].join('\n') : '\n✓ 所有页面无 JS 报错、无接口失败');

process.exit(problems.length || uiFails ? 1 : 0);

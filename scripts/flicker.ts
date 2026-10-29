/**
 * 闪屏诊断：录下切换页面时的每一帧（CDP screencast），找出「内容区变空 / 侧边栏消失 / 背景跳色」的帧
 *   前置：服务在 E2E_BASE 运行，且有管理员 admin@test.com / password123
 *   node --no-warnings scripts/flicker.ts
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE || 'http://localhost:8080';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SHOTS_DIR || 'data-test/flicker';
const MODE = process.env.MODE || 'dark';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
await page.goto(BASE + '/admin/login.html', { waitUntil: 'networkidle0' });
await page.evaluate(m => localStorage.setItem('cdk-mode', m), MODE);
await page.waitForSelector('#s1:not(.hidden)');
await page.type('#em', 'admin@test.com'); await page.type('#pw', 'password123');
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#go')]);

const cdp = await page.createCDPSession();
// 模拟真实网络延迟（本机接口几乎零延迟，闪屏不明显）
if (process.env.LATENCY) { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: Number(process.env.LATENCY), downloadThroughput: -1, uploadThroughput: -1 }); }
const ROUND = process.env.ROUNDS ? Number(process.env.ROUNDS) : 1;
type F = { t: number; data: string };
let frames: F[] = [];
cdp.on('Page.screencastFrame', async (f: any) => { frames.push({ t: Date.now(), data: f.data }); await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });

// 用浏览器自己解码帧，统计几个区域的平均亮度：侧边栏、内容区、顶栏
async function analyze(fs: F[]) {
  return page.evaluate(async (list: string[]) => {
    const out: any[] = [];
    for (const d of list) {
      const img = new Image(); img.src = 'data:image/jpeg;base64,' + d; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d')!; x.drawImage(img, 0, 0);
      const W = img.width, H = img.height;
      const reg = (x0: number, y0: number, x1: number, y1: number) => {
        const p = x.getImageData(x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H).data; let s = 0, v = 0; const n = p.length / 4;
        for (let i = 0; i < p.length; i += 4) { const l = (p[i] + p[i + 1] + p[i + 2]) / 3; s += l; v += l * l; }
        const m = s / n; return { m: Math.round(m), sd: Math.round(Math.sqrt(Math.max(0, v / n - m * m))) };
      };
      out.push({ side: reg(0.01, 0.1, 0.16, 0.9), main: reg(0.2, 0.12, 0.98, 0.95), top: reg(0.2, 0.01, 0.98, 0.09) });
    }
    return out;
  }, fs.map(f => f.data));
}

const NAV = ['index', 'cdks', 'generate', 'orders', 'strategy', 'pricing', 'products', 'shop-orders', 'coupons', 'agents', 'customers', 'insights', 'transactions', 'webhooks', 'settings', 'theme', 'index'];
const report: string[] = [];
await page.goto(`${BASE}/admin/index.html`, { waitUntil: 'networkidle0' });
for (let round = 1; round <= ROUND; round++) for (let i = 1; i < NAV.length; i++) {
  const from = NAV[i - 1], to = NAV[i];
  frames = [];
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 });
  await new Promise(r => setTimeout(r, 150));
  const t0 = Date.now();
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click(`.nav a[href="${to}.html"]`)]);
  await new Promise(r => setTimeout(r, 500));
  await cdp.send('Page.stopScreencast');
  const st = await analyze(frames);
  const base = st[0];
  // 可疑帧：侧边栏亮度/纹理突变、内容区变成纯色（标准差很小）
  const bad = st.map((s, k) => ({ k, s, dt: frames[k].t - t0 }))
    .filter(({ s }) => Math.abs(s.side.m - base.side.m) > 12 || Math.abs(s.top.m - base.top.m) > 12 || s.main.sd < 4 || s.side.sd < 4);
  const line = `${from} → ${to}: ${frames.length} 帧` + (bad.length ? `，可疑 ${bad.length} 帧 ` + bad.slice(0, 4).map(b => `#${b.k}@${b.dt}ms side=${b.s.side.m}/${b.s.side.sd} main=${b.s.main.m}/${b.s.main.sd} top=${b.s.top.m}`).join(' | ') : '，无异常');
  report.push(line); console.log(line);
  bad.slice(0, 3).forEach(b => writeFileSync(`${OUT}/${from}-${to}-${b.k}.jpg`, Buffer.from(frames[b.k].data, 'base64')));
  // 把整段帧序列也存下来：每帧主区亮度，方便看「暗 → 亮」跳变
  writeFileSync(`${OUT}/r${round}-${from}-${to}.json`, JSON.stringify(st.map((s, k) => ({ dt: frames[k].t - t0, ...s }))));
}
await browser.close();

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie } from 'hono/cookie';
import { relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { config, ROOT, publicUrlOk } from './config.ts';
import { q } from './db.ts';
import { HttpError, type AppEnv } from './http.ts';
import { AvanError } from './avan/client.ts';
import { auth, SID } from './routes/auth.ts';
import { admin } from './routes/admin.ts';
import { pub } from './routes/public.ts';
import { sessionUser } from './services/auth.ts';
import { ensureDefaultStrategy } from './services/strategy.ts';
import { verify, receive, syncTransactions } from './services/webhook.ts';
import { tick } from './services/redeem.ts';
import { avanCredentials } from './services/settings.ts';
import { startNotifier } from './services/notify.ts';
import { startDirectGuard } from './services/direct.ts';
import { shop, payNotify } from './routes/shop.ts';
import { adminShop } from './routes/admin-shop.ts';
import { tickShop, markPaid } from './services/shop.ts';
import { scanUsdt } from './services/pay/usdt.ts';
import { allChannels } from './services/pay/index.ts';
import { ensureDefaultLevel } from './services/agents.ts';
import { getSetting } from './services/settings.ts';
import { readFile } from 'node:fs/promises';

ensureDefaultStrategy();
ensureDefaultLevel();

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  if (!c.req.path.startsWith('/api/')) c.header('X-Frame-Options', 'SAMEORIGIN');
});

/* ---------- 卡台 Webhook：必须用原始请求体验签 ---------- */
app.post('/api/webhooks/avanfinity', async c => {
  const raw = await c.req.text();
  const v = verify(raw, { id: c.req.header('x-avanfinity-webhook-id'), ts: c.req.header('x-avanfinity-webhook-timestamp'), sig: c.req.header('x-avanfinity-signature') });
  if (!v.ok) return c.json({ error: v.reason }, v.status as any);
  receive(c.req.header('x-avanfinity-webhook-id')!, raw);
  return c.json({ ok: true });
});

/* ---------- 健康检查：给 systemd / 负载均衡 / 监控用，只做一次数据库读 ---------- */
app.get('/healthz', c => {
  try { q.get('SELECT 1'); return c.json({ ok: true, uptime: Math.round(process.uptime()) }, 200, { 'Cache-Control': 'no-store' }); }
  catch (e) { return c.json({ ok: false, error: String((e as Error)?.message || e) }, 503); }
});

app.route('/api/auth', auth);
app.route('/api/public', pub);
app.route('/api/shop', shop);
app.route('/api/pay/notify', payNotify);

/* ---------- 管理接口：登录 + 只接受 JSON，防跨站提交 ---------- */
app.use('/api/admin/*', async (c, next) => {
  const s = sessionUser(getCookie(c, SID));
  if (!s) throw new HttpError(401, '请先登录', 'AUTH_REQUIRED');
  if (!['GET', 'HEAD'].includes(c.req.method) && !(c.req.header('content-type') || '').includes('application/json')) throw new HttpError(415, '只接受 JSON 请求');
  c.set('user', s.user); c.set('sid', s.sid);
  await next();
});
app.route('/api/admin/shop', adminShop);
app.route('/api/admin', admin);
app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));

/* ---------- 前端静态页面 ---------- */
const webRoot = relative(process.cwd(), resolve(ROOT, 'web')) || '.';
// 后台页面未登录时跳转登录页（接口本身也有鉴权，这里只是体验）
app.use('/admin/*', async (c, next) => {
  const p = c.req.path;
  if (p.startsWith('/admin/login') || !p.endsWith('.html') && !p.endsWith('/')) return next();
  if (!sessionUser(getCookie(c, SID))) return c.redirect('/admin/login.html');
  await next();
});
app.get('/admin', c => c.redirect('/admin/'));
// 首页：后台可切换为商城；兑换页始终可从 /redeem 进入
const sendPage = async (c: any, file: string) => c.html(await readFile(resolve(ROOT, 'web', file), 'utf8'), 200, { 'Cache-Control': 'no-cache' });
app.get('/', (c, next) => (getSetting('shop').enabled && getSetting('shop').homepage === 'shop' ? sendPage(c, 'shop/index.html') : next()));
app.get('/redeem', c => sendPage(c, 'index.html'));
app.get('/shop', c => c.redirect('/shop/'));
app.get('/s/:slug', c => sendPage(c, 'shop/index.html'));
// 静态文件缓存：ETag 协商（没变返回 304），脚本样式再缓存 5 分钟，切换页面不用重新下载
app.use('/*', async (c, next) => {
  if (c.req.method !== 'GET' || c.req.path.startsWith('/api/')) return next();
  let p = c.req.path.endsWith('/') ? c.req.path + 'index.html' : c.req.path;
  if (p.includes('..')) return next();
  const st = await stat(resolve(ROOT, 'web', '.' + p)).catch(() => null);
  if (!st?.isFile()) return next();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const cache = p.startsWith('/assets/') ? 'public, max-age=300' : 'no-cache';
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag, 'Cache-Control': cache });
  await next();
  if (c.res.status === 200) { c.header('ETag', etag); c.header('Cache-Control', cache); }
});
app.use('/*', serveStatic({ root: webRoot }));
app.get('/', serveStatic({ path: resolve(ROOT, 'web/index.html') }));
app.notFound(c => (c.req.path.startsWith('/api/') ? c.json({ error: '接口不存在' }, 404) : c.text('404 Not Found', 404)));

app.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message, code: e.code, ...e.extra }, e.status as any);
  if (e instanceof AvanError) {
    console.warn(`[avan] ${e.status} ${e.code || ''} ${e.message} ${e.requestId || ''}`);
    return c.json({ error: `卡台：${e.message}`, code: e.code || 'UPSTREAM', upstreamStatus: e.status, requestId: e.requestId }, e.status === 0 || e.status >= 500 ? 502 : 409);
  }
  console.error('[error]', c.req.method, c.req.path, e);
  return c.json({ error: '服务器内部错误' }, 500);
});

/* ---------- 后台任务 ---------- */
let ticking = false;
setInterval(async () => {
  if (ticking) return; ticking = true;
  try { await tick(); } catch (e) { console.error('[tick]', e); } finally { ticking = false; }
}, 4000).unref();
setInterval(() => {
  const a = avanCredentials();
  if (a.baseUrl && a.appId && a.appSecret) syncTransactions().catch(e => console.warn('[sync] transactions:', e.message));
}, 5 * 60e3).unref();

let shopTicking = false;
setInterval(async () => {
  if (shopTicking) return; shopTicking = true;
  try { await tickShop(); } catch (e) { console.error('[shop]', e); } finally { shopTicking = false; }
}, Number(process.env.SHOP_TICK_MS) || 10e3).unref();
setInterval(() => { const u = getSetting('pay').usdt; if (u.enabled && u.address) scanUsdt(r => markPaid(r, 'usdt')).catch(e => console.warn('[usdt]', e.message)); }, Number(process.env.USDT_SCAN_MS) || 15e3).unref();

startNotifier();
startDirectGuard();

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  console.log(`[cdk] 已启动 http://localhost:${info.port}`);
  console.log(`[cdk] 兑换页 ${config.publicUrl}/   后台 ${config.publicUrl}/admin/`);
  if (allChannels.some(c => c.enabled()) && !publicUrlOk())
    console.warn(`[cdk] ⚠ 已开启在线支付，但 PUBLIC_URL=${config.publicUrl} 不是外网 https 地址，支付平台的回调到不了，订单只能靠主动查单入账`);
});

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { type AppEnv, body, clientIp, rateLimit, HttpError, audit, str } from '../http.ts';
import * as A from '../services/auth.ts';
import { totpUri } from '../crypto.ts';

export const SID = 'cdk_sid';
const TMP = 'cdk_tmp';
const cookieOpts = (maxAge: number) => ({ httpOnly: true, sameSite: 'Lax' as const, secure: config.cookieSecure, path: '/', maxAge });

export const auth = new Hono<AppEnv>();

/** 首次部署：还没有任何管理员时，允许创建第一个 */
auth.get('/setup', async c => c.json({ needSetup: await A.userCount() === 0 }));
auth.post('/setup', async c => {
  if (await A.userCount() > 0) throw new HttpError(403, '已经初始化过了');
  const b = await body<any>(c);
  await A.createUser({ email: str(b.email, '邮箱', { max: 120 }).toLowerCase(), name: str(b.name || '管理员', '名称', { max: 40 }), role: 'admin', password: str(b.password, '密码', { min: 8, max: 200 }) });
  return c.json({ ok: true });
});

auth.post('/login', async c => {
  const ip = clientIp(c);
  if (!rateLimit(`login:${ip}`, 10, 15 * 60e3)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试', 'RATE_LIMITED');
  const b = await body<any>(c);
  const r = await A.login(str(b.email, '邮箱').toLowerCase(), String(b.password || ''), ip, c.req.header('user-agent') || '');
  if (r.needTotp) { setCookie(c, TMP, r.token, cookieOpts(300)); return c.json({ needTotp: true }); }
  setCookie(c, SID, r.token, cookieOpts(12 * 3600));
  return c.json({ user: r.user });
});
auth.post('/totp', async c => {
  const ip = clientIp(c);
  if (!rateLimit(`totp:${ip}`, 10, 15 * 60e3)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试', 'RATE_LIMITED');
  const b = await body<any>(c);
  const r = await A.loginTotp(getCookie(c, TMP) || '', String(b.code || ''), ip, c.req.header('user-agent') || '');
  deleteCookie(c, TMP, { path: '/' });
  setCookie(c, SID, r.token, cookieOpts(12 * 3600));
  return c.json({ user: r.user });
});
auth.post('/logout', async c => { await A.logout(getCookie(c, SID)); deleteCookie(c, SID, { path: '/' }); return c.json({ ok: true }); });

/* 以下需要登录 */
const me = async (c: any) => { const s = await A.sessionUser(getCookie(c, SID)); if (!s) throw new HttpError(401, '请先登录', 'AUTH_REQUIRED'); return s.user; };
auth.get('/me', async c => c.json({ user: await me(c) }));
auth.post('/password', async c => {
  const u = await me(c), b = await body<any>(c);
  await A.changePassword(u.id, String(b.oldPassword || ''), String(b.newPassword || ''));
  deleteCookie(c, SID, { path: '/' });
  return c.json({ ok: true });
});
auth.post('/totp/setup', async c => {
  const u = await me(c);
  if (!rateLimit(`totp-setup:${u.id}`, 10, 15 * 60e3)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试', 'RATE_LIMITED');
  const b = await c.req.json().catch(() => ({})) as any;
  const secret = await A.totpSetup(u.id, { password: typeof b.password === 'string' ? b.password : undefined, code: typeof b.code === 'string' ? b.code : undefined });
  c.set('user', u); await audit(c, 'auth.totp_setup');
  return c.json({ secret, uri: totpUri(secret, u.email) });
});
auth.post('/totp/enable', async c => { const u = await me(c); await A.totpEnable(u.id, String((await body<any>(c)).code || '')); c.set('user', u); await audit(c, 'auth.totp_enable'); return c.json({ ok: true }); });
auth.post('/totp/disable', async c => { const u = await me(c); await A.totpDisable(u.id, String((await body<any>(c)).code || '')); c.set('user', u); await audit(c, 'auth.totp_disable'); return c.json({ ok: true }); });

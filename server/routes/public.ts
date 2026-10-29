/** 买家兑换页调用的公开接口：不需要登录，按浏览器设备 ID 绑定 */
import { Hono } from 'hono';
import { body, clientIp, clientCountry, rateLimit, HttpError, str } from '../http.ts';
import * as R from '../services/redeem.ts';
import { publicConfig } from '../services/settings.ts';

export const pub = new Hono();

const deviceOf = (v: unknown) => {
  const d = typeof v === 'string' ? v.trim() : '';
  if (!/^[0-9a-f-]{32,40}$/i.test(d)) throw new HttpError(400, '页面已过期，请刷新后重试', 'BAD_DEVICE');
  return d;
};
// 公开接口的粗粒度限流（策略里的 IP 规则是细粒度的）
pub.use('*', async (c, next) => {
  if (!rateLimit(`pub:${clientIp(c)}`, 120, 60e3)) throw new HttpError(429, '请求太频繁，请稍后再试', 'RATE_LIMITED');
  await next();
  c.header('Cache-Control', 'no-store');
});

pub.get('/config', c => c.json(publicConfig()));

pub.post('/redeem/start', async c => {
  const b = await body<any>(c);
  return c.json(await R.start(str(b.code, '兑换码', { max: 80 }), { ip: clientIp(c), device: deviceOf(b.device), country: clientCountry(c), captchaToken: b.captchaToken }));
});
pub.post('/redeem/account', async c => {
  const b = await body<any>(c);
  return c.json(await R.submitAccount(str(b.rid, 'rid'), deviceOf(b.device), { session: typeof b.session === 'string' ? b.session.slice(0, 20000) : undefined, recipient: typeof b.recipient === 'string' ? b.recipient : undefined }));
});
pub.post('/redeem/confirm', async c => {
  const b = await body<any>(c);
  return c.json(await R.confirm(str(b.rid, 'rid'), deviceOf(b.device)));
});
pub.post('/redeem/session', async c => {
  const b = await body<any>(c);
  return c.json(await R.resubmitSession(str(b.rid, 'rid'), deviceOf(b.device), str(b.session, 'session', { max: 20000 })));
});
pub.get('/redeem/status', async c => c.json(await R.status(c.req.query('rid') || '', deviceOf(c.req.query('device')))));
pub.post('/receipt', async c => {
  const b = await body<any>(c);
  if (!rateLimit(`receipt:${clientIp(c)}`, 20, 3600e3)) throw new HttpError(429, '查询次数过多，请稍后再试', 'RATE_LIMITED');
  return c.json(R.receipt(str(b.code, '兑换码', { max: 80 }), deviceOf(b.device)));
});

/**
 * 支付宝开放平台（公钥模式，RSA2）
 *   当面付：alipay.trade.precreate → qr_code
 *   网页支付：alipay.trade.page.pay（电脑）/ alipay.trade.wap.pay（手机），表单 GET 跳转
 *   异步通知：POST application/x-www-form-urlencoded，用支付宝公钥验签，回复 success
 *   查单：alipay.trade.query
 * 签名：除 sign 外的参数按 key 升序 k=v& 拼接，SHA256withRSA，Base64
 * 通知验签：除 sign、sign_type 外的参数升序拼接
 */
import { createSign, createVerify } from 'node:crypto';
import { getSetting } from '../settings.ts';
import { decryptOpt } from '../../crypto.ts';
import { type Channel, yuan, cents } from './types.ts';

const cfg = () => { const c = getSetting('pay').alipay; return { ...c, privateKey: decryptOpt(c.privateKeyEnc) || '' }; };
const pem = (key: string, type: 'PRIVATE' | 'PUBLIC') => key.includes('-----BEGIN') ? key : `-----BEGIN ${type === 'PRIVATE' ? 'PRIVATE KEY' : 'PUBLIC KEY'}-----\n${key.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n')}\n-----END ${type === 'PRIVATE' ? 'PRIVATE KEY' : 'PUBLIC KEY'}-----`;
const sortJoin = (p: Record<string, string>, skip: string[]) => Object.keys(p).filter(k => !skip.includes(k) && p[k] !== '' && p[k] != null).sort().map(k => `${k}=${p[k]}`).join('&');
const ts = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

export function alipaySign(p: Record<string, string>, privateKey: string) {
  return createSign('RSA-SHA256').update(sortJoin(p, ['sign']), 'utf8').sign(pem(privateKey, 'PRIVATE'), 'base64');
}
export function alipayVerify(p: Record<string, string>, publicKey: string) {
  if (!p.sign) return false;
  try { return createVerify('RSA-SHA256').update(sortJoin(p, ['sign', 'sign_type']), 'utf8').verify(pem(publicKey, 'PUBLIC'), p.sign, 'base64'); } catch { return false; }
}
function common(method: string, biz: object, extra: Record<string, string> = {}) {
  const c = cfg();
  const p: Record<string, string> = { app_id: c.appId, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', timestamp: ts(), version: '1.0', biz_content: JSON.stringify(biz), ...extra };
  p.sign = alipaySign(p, c.privateKey);
  return p;
}
async function call(method: string, biz: object, extra?: Record<string, string>) {
  const c = cfg();
  const r = await fetch(c.gateway, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(common(method, biz, extra)), signal: AbortSignal.timeout(12_000) });
  const text = await r.text();
  const d = JSON.parse(text);
  const key = method.replace(/\./g, '_') + '_response';
  const resp = d[key];
  // 响应验签：签名覆盖的是原文中 xxx_response 对应的 JSON 字符串
  const raw = text.match(new RegExp(`"${key}"\\s*:\\s*(\\{.*?\\})\\s*,\\s*"sign"`, 's'))?.[1];
  if (raw && d.sign && c.alipayPublicKey) {
    const ok = createVerify('RSA-SHA256').update(raw, 'utf8').verify(pem(c.alipayPublicKey, 'PUBLIC'), d.sign, 'base64');
    if (!ok) throw new Error('支付宝响应验签失败');
  }
  if (!resp || resp.code !== '10000') throw new Error(`支付宝：${resp?.sub_msg || resp?.msg || '请求失败'}`);
  return resp;
}

export const alipay: Channel = {
  key: 'alipay',
  label: () => '支付宝',
  missing: () => { const c = cfg(); return ([[!!c.appId, 'APPID'], [!!c.privateKey, '应用私钥'], [!!c.alipayPublicKey, '支付宝公钥']] as [boolean, string][]).filter(([ok]) => !ok).map(([, n]) => n); },
  enabled: () => cfg().enabled && !alipay.missing().length,
  async create(i) {
    const c = cfg();
    // 支付宝侧的过期时间和订单一致（北京时间 yyyy-MM-dd HH:mm:ss）
    const timeExpire = new Date(new Date(i.payment.expires_at).getTime() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
    const biz = { out_trade_no: i.payment.id, total_amount: yuan(i.payment.amount), subject: i.title.slice(0, 128), time_expire: timeExpire };
    if (c.mode === 'precreate') {
      const r = await call('alipay.trade.precreate', biz, { notify_url: i.notifyUrl });
      return { type: 'qr', qr: r.qr_code };
    }
    const method = i.mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
    const p = common(method, { ...biz, product_code: i.mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY' }, { notify_url: i.notifyUrl, return_url: i.returnUrl });
    return { type: 'redirect', url: `${c.gateway}?${new URLSearchParams(p)}` };
  },
  async notify(req) {
    const p = Object.fromEntries(new URLSearchParams(req.body));
    const c = cfg();
    if (!alipayVerify(p, c.alipayPublicKey) || p.app_id !== c.appId) return { result: null, response: { status: 400, body: 'fail' } };
    const paid = p.trade_status === 'TRADE_SUCCESS' || p.trade_status === 'TRADE_FINISHED';
    return { result: { paymentId: p.out_trade_no, paid, tradeNo: 'alipay:' + p.trade_no, amount: cents(p.total_amount), raw: p }, response: { status: 200, body: 'success' } };
  },
  async query(pay) {
    try {
      const r = await call('alipay.trade.query', { out_trade_no: pay.id });
      return { paymentId: pay.id, paid: r.trade_status === 'TRADE_SUCCESS' || r.trade_status === 'TRADE_FINISHED', tradeNo: 'alipay:' + r.trade_no, amount: cents(r.total_amount), raw: r };
    } catch { return null; }
  },
};

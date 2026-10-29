/**
 * 微信支付 APIv3（Native 扫码，微信支付公钥验签模式）
 *   下单：POST /v3/pay/transactions/native → code_url
 *   请求签名：Authorization: WECHATPAY2-SHA256-RSA2048 mchid,nonce_str,timestamp,serial_no,signature
 *             签名串 = METHOD\nURL\ntimestamp\nnonce\nbody\n，商户私钥 SHA256withRSA
 *   回调：用微信支付公钥验 Wechatpay-Signature（签名串 = timestamp\nnonce\nbody\n），
 *         再用 APIv3 密钥 AEAD_AES_256_GCM 解密 resource；回复 200 {"code":"SUCCESS"}
 *   查单：GET /v3/pay/transactions/out-trade-no/{id}?mchid=
 */
import { createSign, createVerify, createDecipheriv, randomBytes } from 'node:crypto';
import { getSetting } from '../settings.ts';
import { decryptOpt } from '../../crypto.ts';
import type { Channel } from './types.ts';

const cfg = () => { const c = getSetting('pay').wechat; return { ...c, privateKey: decryptOpt(c.privateKeyEnc) || '', apiV3Key: decryptOpt(c.apiV3KeyEnc) || '', api: c.api.replace(/\/+$/, '') }; };
const pem = (k: string, t: 'PRIVATE KEY' | 'PUBLIC KEY') => k.includes('-----BEGIN') ? k : `-----BEGIN ${t}-----\n${k.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n')}\n-----END ${t}-----`;

export function wxAuth(method: string, path: string, body: string, c = cfg()) {
  const t = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
  const sig = createSign('RSA-SHA256').update(`${method}\n${path}\n${t}\n${nonce}\n${body}\n`).sign(pem(c.privateKey, 'PRIVATE KEY'), 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchId}",nonce_str="${nonce}",timestamp="${t}",serial_no="${c.serialNo}",signature="${sig}"`;
}
export function wxVerify(h: Record<string, string>, body: string, c = cfg()) {
  const t = h['wechatpay-timestamp'], nonce = h['wechatpay-nonce'], sig = h['wechatpay-signature'], serial = h['wechatpay-serial'];
  if (!t || !nonce || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  if (c.publicKeyId && serial && serial !== c.publicKeyId) return false;
  try { return createVerify('RSA-SHA256').update(`${t}\n${nonce}\n${body}\n`).verify(pem(c.publicKey, 'PUBLIC KEY'), sig, 'base64'); } catch { return false; }
}
export function wxDecrypt(r: { ciphertext: string; nonce: string; associated_data?: string }, key: string) {
  const buf = Buffer.from(r.ciphertext, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(r.nonce, 'utf8'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  if (r.associated_data) d.setAAD(Buffer.from(r.associated_data, 'utf8'));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
}
async function req(method: 'GET' | 'POST', path: string, body?: object) {
  const c = cfg(), raw = body ? JSON.stringify(body) : '';
  const r = await fetch(c.api + path, { method, headers: { Authorization: wxAuth(method, path, raw, c), Accept: 'application/json', 'Content-Type': 'application/json', 'Wechatpay-Serial': c.publicKeyId }, body: body ? raw : undefined, signal: AbortSignal.timeout(12_000) });
  const text = await r.text();
  if (c.publicKey && text && !wxVerify(Object.fromEntries([...r.headers].map(([k, v]) => [k.toLowerCase(), v])), text, c)) throw new Error('微信支付响应验签失败');
  const d = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`微信支付：${d.message || r.status}`);
  return d;
}

export const wechat: Channel = {
  key: 'wechat',
  label: () => '微信支付',
  enabled: () => { const c = cfg(); return c.enabled && !!c.mchId && !!c.appId && !!c.serialNo && !!c.privateKey && !!c.apiV3Key && !!c.publicKey; },
  async create(i) {
    const c = cfg();
    const d = await req('POST', '/v3/pay/transactions/native', {
      appid: c.appId, mchid: c.mchId, description: i.title.slice(0, 120), out_trade_no: i.payment.id, notify_url: i.notifyUrl,
      time_expire: new Date(i.payment.expires_at).toISOString().replace(/\.\d+Z$/, '+00:00'), amount: { total: i.payment.amount, currency: 'CNY' },
    });
    return { type: 'qr', qr: d.code_url };
  },
  async notify(r) {
    const c = cfg();
    if (!wxVerify(r.headers, r.body, c)) return { result: null, response: { status: 401, body: JSON.stringify({ code: 'FAIL', message: '签名错误' }), type: 'application/json' } };
    try {
      const evt = JSON.parse(r.body);
      const t = JSON.parse(wxDecrypt(evt.resource, c.apiV3Key));
      if (t.mchid !== c.mchId) return { result: null, response: { status: 400, body: JSON.stringify({ code: 'FAIL', message: 'mchid' }), type: 'application/json' } };
      return { result: { paymentId: t.out_trade_no, paid: t.trade_state === 'SUCCESS', tradeNo: 'wx:' + t.transaction_id, amount: t.amount?.total, raw: t }, response: { status: 200, body: JSON.stringify({ code: 'SUCCESS' }), type: 'application/json' } };
    } catch { return { result: null, response: { status: 400, body: JSON.stringify({ code: 'FAIL', message: '解密失败' }), type: 'application/json' } }; }
  },
  async query(pay) {
    try {
      const t = await req('GET', `/v3/pay/transactions/out-trade-no/${pay.id}?mchid=${cfg().mchId}`);
      return { paymentId: pay.id, paid: t.trade_state === 'SUCCESS', tradeNo: 'wx:' + t.transaction_id, amount: t.amount?.total, raw: t };
    } catch { return null; }
  },
};

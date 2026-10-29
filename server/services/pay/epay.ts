/**
 * 易支付（彩虹易支付等通用协议）
 *   下单：{apiUrl}/submit.php 页面跳转
 *   回调：GET/POST notify_url，trade_status=TRADE_SUCCESS，回复 success
 *   查单：{apiUrl}/api.php?act=order&pid=&key=&out_trade_no=
 *   签名：参数按键名 ASCII 升序拼接 k=v&k=v（去掉 sign、sign_type、空值）后直接拼接商户密钥，取 MD5 小写
 */
import { createHash } from 'node:crypto';
import { getSetting } from '../settings.ts';
import { decryptOpt, safeEqual } from '../../crypto.ts';
import { type Channel, type PayResult, yuan, cents } from './types.ts';

const SUB_LABEL: Record<string, string> = { alipay: '支付宝', wxpay: '微信支付', qqpay: 'QQ 钱包', bank: '网银', usdt: 'USDT' };
const cfg = () => { const c = getSetting('pay').epay; return { ...c, key: decryptOpt(c.keyEnc) || '', apiUrl: c.apiUrl.replace(/\/+$/, '') }; };

export function epaySign(params: Record<string, string>, key: string) {
  const s = Object.keys(params).filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null).sort().map(k => `${k}=${params[k]}`).join('&');
  return createHash('md5').update(s + key, 'utf8').digest('hex');
}

export const epay: Channel = {
  key: 'epay',
  label: () => cfg().name || '在线支付',
  enabled: () => { const c = cfg(); return c.enabled && !!c.apiUrl && !!c.pid && !!c.key; },
  subs: () => cfg().types.map(k => ({ key: k, label: SUB_LABEL[k] || k })),
  async create(i) {
    const c = cfg();
    const p: Record<string, string> = {
      pid: c.pid, type: i.payment.sub || c.types[0] || 'alipay', out_trade_no: i.payment.id,
      notify_url: i.notifyUrl, return_url: i.returnUrl, name: i.title.slice(0, 60), money: yuan(i.payment.amount),
    };
    p.sign = epaySign(p, c.key); p.sign_type = 'MD5';
    return { type: 'redirect', url: `${c.apiUrl}/submit.php?${new URLSearchParams(p)}` };
  },
  async notify(req) {
    const c = cfg();
    const p = { ...req.query, ...(req.method === 'POST' ? Object.fromEntries(new URLSearchParams(req.body)) : {}) };
    const ok = !!p.sign && String(p.pid) === String(c.pid) && safeEqual(epaySign(p, c.key), String(p.sign).toLowerCase());
    if (!ok) return { result: null, response: { status: 400, body: 'sign error' } };
    const result: PayResult = { paymentId: p.out_trade_no, paid: p.trade_status === 'TRADE_SUCCESS', tradeNo: `epay:${p.trade_no}`, amount: cents(p.money), raw: p };
    return { result, response: { status: 200, body: 'success' } };
  },
  async query(pay) {
    const c = cfg();
    const r = await fetch(`${c.apiUrl}/api.php?${new URLSearchParams({ act: 'order', pid: c.pid, key: c.key, out_trade_no: pay.id })}`, { signal: AbortSignal.timeout(10_000) });
    const d: any = await r.json().catch(() => null);
    if (!d || Number(d.code) !== 1) return null;
    return { paymentId: pay.id, paid: Number(d.status) === 1, tradeNo: `epay:${d.trade_no}`, amount: cents(d.money), raw: d };
  },
};

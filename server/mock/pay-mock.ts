/**
 * 模拟支付网关（仅开发 / 测试用），挂在模拟卡台同一个端口上
 *   易支付   {base}/epay          商户号 1000，密钥 epay_mock_key
 *   支付宝   {base}/alipay/gateway.do
 *   微信 v3  {base}/wechat
 *   TronGrid {base}/tron
 * 后台填写所需的公钥 / 密钥：GET /mock/pay/keys
 * 测试辅助：POST /mock/{epay|alipay|wechat}/pay {out_trade_no, money?, notify?}   POST /mock/tron/send {to, amount}
 * 收银台页面上点「模拟支付成功」等同于调用上面的接口
 */
import type { Hono } from 'hono';
import { createHash, createSign, createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';

const EPAY_PID = '1000', EPAY_KEY = 'epay_mock_key';
const ali = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wx = generateKeyPairSync('rsa', { modulusLength: 2048 });
const WX_KEY_ID = 'PUB_KEY_ID_MOCK0001', WX_V3 = 'mockapiv3key0123456789abcdefABCD'; // 32 字节
const pemOf = (k: typeof ali.publicKey) => k.export({ type: 'spki', format: 'pem' }).toString();

interface Order { method: 'epay' | 'alipay' | 'wechat'; outTradeNo: string; amount: string; notifyUrl: string; returnUrl?: string; status: 'WAIT' | 'PAID'; tradeNo?: string; extra: Record<string, string> }
const orders = new Map<string, Order>();
const tronTxs: any[] = [];
const hexs = (n: number) => randomBytes(n).toString('hex');
const sortJoin = (p: Record<string, string>, skip: string[]) => Object.keys(p).filter(k => !skip.includes(k) && p[k] !== '' && p[k] != null).sort().map(k => `${k}=${p[k]}`).join('&');
const epaySign = (p: Record<string, string>) => createHash('md5').update(sortJoin(p, ['sign', 'sign_type']) + EPAY_KEY).digest('hex');
const aliSign = (s: string) => createSign('RSA-SHA256').update(s, 'utf8').sign(ali.privateKey, 'base64');
const wxHeaders = (body: string) => {
  const t = String(Math.floor(Date.now() / 1000)), n = hexs(16);
  return { 'Wechatpay-Timestamp': t, 'Wechatpay-Nonce': n, 'Wechatpay-Serial': WX_KEY_ID, 'Wechatpay-Signature': createSign('RSA-SHA256').update(`${t}\n${n}\n${body}\n`).sign(wx.privateKey, 'base64') };
};
const cashier = (o: Order) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>模拟收银台</title>
<body style="font-family:system-ui;background:#f4f5fa;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;padding:32px 36px;border-radius:16px;box-shadow:0 10px 40px #0001;text-align:center;min-width:280px">
<div style="color:#888;font-size:13px">模拟${{ epay: '易支付', alipay: '支付宝', wechat: '微信支付' }[o.method]}收银台</div>
<div style="font-size:34px;font-weight:800;margin:10px 0 4px">¥ ${o.amount}</div><div style="color:#888;font-size:12px;margin-bottom:22px">${o.outTradeNo}</div>
<form method="post" action="/mock/${o.method}/pay-form"><input type="hidden" name="out_trade_no" value="${o.outTradeNo}">
<button id="mockPay" style="background:#3b5bff;color:#fff;border:0;border-radius:10px;padding:12px 28px;font-size:15px;cursor:pointer">模拟支付成功</button></form></div>`;

/** 把订单标记为已付并回调商户；返回回调的 HTTP 状态 */
async function pay(no: string, opt: { money?: string; notify?: boolean } = {}) {
  const o = orders.get(no);
  if (!o) throw new Error('order not found');
  o.status = 'PAID'; o.tradeNo ||= (o.method === 'wechat' ? '4200' : '2026') + Date.now() + hexs(3);
  if (opt.notify === false) return 0;
  const money = opt.money || o.amount;
  if (o.method === 'epay') {
    const p: Record<string, string> = { pid: EPAY_PID, trade_no: o.tradeNo, out_trade_no: no, type: o.extra.type || 'alipay', name: o.extra.name || '', money, trade_status: 'TRADE_SUCCESS' };
    p.sign = epaySign(p); p.sign_type = 'MD5';
    return (await fetch(`${o.notifyUrl}?${new URLSearchParams(p)}`)).status;
  }
  if (o.method === 'alipay') {
    const p: Record<string, string> = { notify_time: new Date().toISOString(), notify_type: 'trade_status_sync', notify_id: hexs(8), app_id: o.extra.app_id, charset: 'utf-8', version: '1.0', trade_no: o.tradeNo, out_trade_no: no, trade_status: 'TRADE_SUCCESS', total_amount: money, receipt_amount: money, sign_type: 'RSA2' };
    p.sign = aliSign(sortJoin(p, ['sign', 'sign_type']));
    return (await fetch(o.notifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p) })).status;
  }
  const res = { mchid: o.extra.mchid, appid: o.extra.appid, out_trade_no: no, transaction_id: o.tradeNo, trade_state: 'SUCCESS', amount: { total: Math.round(Number(money) * 100), currency: 'CNY' } };
  const nonce = hexs(6), c = createCipheriv('aes-256-gcm', Buffer.from(WX_V3), Buffer.from(nonce));
  c.setAAD(Buffer.from('transaction'));
  const ct = Buffer.concat([c.update(JSON.stringify(res)), c.final(), c.getAuthTag()]).toString('base64');
  const body = JSON.stringify({ id: hexs(8), event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext: ct, nonce, associated_data: 'transaction' } });
  return (await fetch(o.notifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...wxHeaders(body) }, body })).status;
}

export function payMock(app: Hono, base: string) {
  app.get('/mock/pay/keys', c => c.json({ epay: { apiUrl: `${base}/epay`, pid: EPAY_PID, key: EPAY_KEY }, alipay: { gateway: `${base}/alipay/gateway.do`, alipayPublicKey: pemOf(ali.publicKey) }, wechat: { api: `${base}/wechat`, publicKeyId: WX_KEY_ID, publicKey: pemOf(wx.publicKey), apiV3Key: WX_V3 }, tron: { tronApi: `${base}/tron` } }));
  app.get('/mock/pay/orders', c => c.json([...orders.values()]));
  for (const m of ['epay', 'alipay', 'wechat']) {
    app.post(`/mock/${m}/pay`, async c => { const b = await c.req.json(); return c.json({ notifyStatus: await pay(b.out_trade_no, b) }); });
    app.post(`/mock/${m}/pay-form`, async c => {
      const no = String((await c.req.parseBody()).out_trade_no);
      await pay(no);
      const o = orders.get(no)!;
      return o.returnUrl ? c.redirect(o.returnUrl) : c.html('<meta charset="utf-8"><p style="font-family:system-ui;text-align:center;margin-top:80px">支付成功，可以关闭这个页面</p>');
    });
  }
  app.get('/mock/pay/scan/:no', c => { const o = orders.get(c.req.param('no')); return o ? c.html(cashier(o)) : c.text('not found', 404); });

  /* ---- 易支付 ---- */
  app.get('/epay/submit.php', c => {
    const p = c.req.query();
    if (p.pid !== EPAY_PID || epaySign(p) !== p.sign) return c.html('<meta charset="utf-8">签名错误', 400);
    const o: Order = orders.get(p.out_trade_no) || { method: 'epay', outTradeNo: p.out_trade_no, amount: p.money, notifyUrl: p.notify_url, returnUrl: p.return_url, status: 'WAIT', extra: { type: p.type, name: p.name } };
    Object.assign(o, { amount: p.money, notifyUrl: p.notify_url, returnUrl: p.return_url });
    orders.set(o.outTradeNo, o);
    return c.html(cashier(o));
  });
  app.get('/epay/api.php', c => {
    const p = c.req.query();
    if (p.pid !== EPAY_PID || p.key !== EPAY_KEY) return c.json({ code: -1, msg: 'KEY 校验失败' });
    const o = orders.get(p.out_trade_no);
    if (!o) return c.json({ code: -1, msg: '订单号不存在' });
    return c.json({ code: 1, msg: '查询订单号成功！', trade_no: o.tradeNo || '', out_trade_no: o.outTradeNo, type: o.extra.type, pid: EPAY_PID, money: o.amount, status: o.status === 'PAID' ? 1 : 0 });
  });

  /* ---- 支付宝 ---- */
  const aliResp = (c: any, key: string, data: object) => { const inner = JSON.stringify(data); return c.body(`{"${key}":${inner},"sign":"${aliSign(inner)}"}`, 200, { 'Content-Type': 'application/json;charset=utf-8' }); };
  app.post('/alipay/gateway.do', async c => {
    const p = Object.fromEntries(new URLSearchParams(await c.req.text()));
    const biz = JSON.parse(p.biz_content || '{}'), key = p.method.replace(/\./g, '_') + '_response';
    if (p.method === 'alipay.trade.precreate') {
      orders.set(biz.out_trade_no, { method: 'alipay', outTradeNo: biz.out_trade_no, amount: biz.total_amount, notifyUrl: p.notify_url, status: 'WAIT', extra: { app_id: p.app_id } });
      return aliResp(c, key, { code: '10000', msg: 'Success', out_trade_no: biz.out_trade_no, qr_code: `${base}/mock/pay/scan/${biz.out_trade_no}` });
    }
    if (p.method === 'alipay.trade.query') {
      const o = orders.get(biz.out_trade_no);
      if (!o) return aliResp(c, key, { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST', sub_msg: '交易不存在' });
      return aliResp(c, key, { code: '10000', msg: 'Success', out_trade_no: o.outTradeNo, trade_no: o.tradeNo || '', trade_status: o.status === 'PAID' ? 'TRADE_SUCCESS' : 'WAIT_BUYER_PAY', total_amount: o.amount });
    }
    return aliResp(c, key, { code: '40004', msg: 'Business Failed', sub_msg: '模拟网关不支持 ' + p.method });
  });
  app.get('/alipay/gateway.do', c => {
    const p = c.req.query(), biz = JSON.parse(p.biz_content || '{}');
    const o: Order = { method: 'alipay', outTradeNo: biz.out_trade_no, amount: biz.total_amount, notifyUrl: p.notify_url, returnUrl: p.return_url, status: 'WAIT', extra: { app_id: p.app_id } };
    orders.set(o.outTradeNo, o);
    return c.html(cashier(o));
  });

  /* ---- 微信支付 v3 ---- */
  const wxJson = (c: any, status: number, data: object) => { const body = JSON.stringify(data); return c.body(body, status, { 'Content-Type': 'application/json', ...wxHeaders(body) }); };
  app.post('/wechat/v3/pay/transactions/native', async c => {
    if (!(c.req.header('authorization') || '').startsWith('WECHATPAY2-SHA256-RSA2048 ')) return wxJson(c, 401, { code: 'SIGN_ERROR', message: '缺少签名' });
    const b = await c.req.json();
    orders.set(b.out_trade_no, { method: 'wechat', outTradeNo: b.out_trade_no, amount: (b.amount.total / 100).toFixed(2), notifyUrl: b.notify_url, status: 'WAIT', extra: { mchid: b.mchid, appid: b.appid } });
    return wxJson(c, 200, { code_url: `${base}/mock/pay/scan/${b.out_trade_no}` });
  });
  app.get('/wechat/v3/pay/transactions/out-trade-no/:no', c => {
    const o = orders.get(c.req.param('no'));
    if (!o) return wxJson(c, 404, { code: 'ORDER_NOT_EXIST', message: '订单不存在' });
    return wxJson(c, 200, { mchid: o.extra.mchid, appid: o.extra.appid, out_trade_no: o.outTradeNo, transaction_id: o.tradeNo || '', trade_state: o.status === 'PAID' ? 'SUCCESS' : 'NOTPAY', amount: { total: Math.round(Number(o.amount) * 100), currency: 'CNY' } });
  });

  /* ---- TronGrid ---- */
  app.post('/mock/tron/send', async c => {
    const b = await c.req.json();
    const tx = { transaction_id: hexs(32), from: 'TMockSender' + hexs(11).slice(0, 23), to: b.to, value: String(Math.round(Number(b.amount) * 1e6)), block_timestamp: Date.now(), token_info: { address: b.contract || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT' }, type: 'Transfer' };
    tronTxs.unshift(tx);
    return c.json(tx);
  });
  app.get('/tron/v1/accounts/:addr/transactions/trc20', c => {
    const min = Number(c.req.query('min_timestamp') || 0);
    return c.json({ data: tronTxs.filter(t => t.to === c.req.param('addr') && t.block_timestamp >= min), success: true, meta: { at: Date.now(), page_size: tronTxs.length } });
  });
}

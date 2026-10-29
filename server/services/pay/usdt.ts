/**
 * USDT（TRC20）：固定收款地址 + 唯一金额
 *   - 订单金额（人民币）÷ 汇率 → USDT，再加 0.0001–0.0999 的随机尾数，保证待付订单之间金额唯一
 *   - 后台每 15 秒查询 TronGrid 的 TRC20 入账记录，按「金额完全一致 + 时间在订单有效期内」匹配
 *   - 交易哈希写入 payments.trade_no（唯一约束），同一笔转账不会给两个订单入账
 *   - 订单超时关闭后 GRACE 分钟内的到账照样匹配（链上确认有延迟）；这段时间内它的金额也不会分配给新订单
 */
import { q, now } from '../../db.ts';
import { getSetting } from '../settings.ts';
import { decryptOpt } from '../../crypto.ts';
import type { Channel, PaymentRow } from './types.ts';

const MICRO = 1_000_000;
const GRACE = 15 * 60e3;
const cfg = () => { const c = getSetting('pay').usdt; return { ...c, apiKey: decryptOpt(c.apiKeyEnc) || '', tronApi: c.tronApi.replace(/\/+$/, '') }; };
export const fmtUsdt = (micro: number) => (micro / MICRO).toFixed(4);

/** 人民币（分）→ 唯一的 USDT 金额（1e-6 单位，精确到 0.0001） */
export function uniqueAmount(cents: number): number {
  const { rate } = cfg();
  const base = Math.ceil((cents / 100 / rate) * 100) * 10_000; // 先按 0.01 USDT 向上取整
  const taken = new Set(q.all<{ crypto_amount: number }>("SELECT crypto_amount FROM payments WHERE method = 'usdt' AND status IN ('pending','closed') AND expires_at > ?", [new Date(Date.now() - GRACE).toISOString()]).map(r => r.crypto_amount));
  for (let i = 0; i < 2000; i++) {
    const v = base + (1 + Math.floor(Math.random() * 999)) * 100; // +0.0001 ~ +0.0999
    if (!taken.has(v)) return v;
  }
  throw new Error('当前待付款的 USDT 订单太多，请稍后再试');
}

export const usdt: Channel = {
  key: 'usdt',
  label: () => 'USDT',
  enabled: () => { const c = cfg(); return c.enabled && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(c.address) && c.rate > 0; },
  async create(i) {
    const c = cfg();
    return { type: 'crypto', address: c.address, amount: fmtUsdt(i.payment.crypto_amount!), network: 'TRC20' };
  },
  async notify() { return { result: null, response: { status: 404, body: 'not supported' } }; },
};

/** 扫描链上入账，返回成功入账的支付单 */
export async function scanUsdt(markPaid: (r: { paymentId: string; paid: boolean; tradeNo: string; cryptoAmount: number; raw: unknown }) => Promise<unknown>) {
  if (!usdt.enabled()) return 0;
  const pend = q.all<PaymentRow>("SELECT * FROM payments WHERE method = 'usdt' AND status IN ('pending','closed') AND expires_at > ? ORDER BY created_at", [new Date(Date.now() - GRACE).toISOString()]);
  if (!pend.length) return 0;
  const c = cfg();
  const since = Math.min(...pend.map(p => new Date(p.created_at).getTime())) - 60e3;
  const url = `${c.tronApi}/v1/accounts/${c.address}/transactions/trc20?${new URLSearchParams({ only_to: 'true', only_confirmed: 'true', limit: '200', contract_address: c.contract, min_timestamp: String(since) })}`;
  const r = await fetch(url, { headers: c.apiKey ? { 'TRON-PRO-API-KEY': c.apiKey } : {}, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`TronGrid HTTP ${r.status}`);
  const d: any = await r.json();
  let n = 0;
  for (const t of d.data || []) {
    if (t.to !== c.address || t.token_info?.address !== c.contract) continue;
    const dec = Number(t.token_info?.decimals ?? 6);
    const micro = Math.round(Number(t.value) * 10 ** (6 - dec));
    if (q.get('SELECT 1 FROM payments WHERE trade_no = ?', ['tron:' + t.transaction_id])) continue;
    // 允许到账时间在订单创建后、过期后 10 分钟内（链上确认有延迟）
    const p = pend.find(x => x.crypto_amount === micro && t.block_timestamp >= new Date(x.created_at).getTime() - 60e3 && t.block_timestamp <= new Date(x.expires_at).getTime() + GRACE);
    if (!p) { if (micro >= MICRO) console.warn(`[usdt] 未匹配的转账 ${fmtUsdt(micro)} USDT tx=${t.transaction_id}（金额对不上任何订单，请人工核对）`); continue; }
    await markPaid({ paymentId: p.id, paid: true, tradeNo: 'tron:' + t.transaction_id, cryptoAmount: micro, raw: { tx: t.transaction_id, from: t.from, value: t.value, at: t.block_timestamp } }).then(() => n++, e => console.warn('[usdt] 入账失败', p.id, e.message));
  }
  return n;
}

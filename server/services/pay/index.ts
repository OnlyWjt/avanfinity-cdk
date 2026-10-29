import { config } from '../../config.ts';
import { getSetting } from '../settings.ts';
import type { Channel } from './types.ts';
import { epay } from './epay.ts';
import { usdt } from './usdt.ts';
import { alipay } from './alipay.ts';
import { wechat } from './wechat.ts';

const ALL: Channel[] = [epay, alipay, wechat, usdt];
export const channel = (key: string) => ALL.find(c => c.key === key);
export const notifyUrl = (key: string) => `${config.publicUrl}/api/pay/notify/${key}`;

/** 前台可选的支付方式（易支付按子类型展开） */
export function channels() {
  const out: { method: string; sub?: string; label: string; icon: string; note?: string }[] = [];
  for (const c of ALL) {
    if (!c.enabled()) continue;
    if (c.subs) for (const s of c.subs()) out.push({ method: c.key, sub: s.key, label: s.label, icon: s.key, note: `${c.label()} · 跳转收银台` });
    else out.push({ method: c.key, label: c.label(), icon: c.key, note: c.key === 'usdt' ? 'TRC20 网络' : c.key === 'alipay' && getSetting('pay').alipay.mode === 'page' ? '跳转支付宝收银台' : '手机扫码支付' });
  }
  return out;
}
export { ALL as allChannels };

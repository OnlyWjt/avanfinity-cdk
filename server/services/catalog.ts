/** 卡台报价目录（带短缓存）。卡台不可用时返回最近一次成功的结果 */
import { avan, type CdkOffer, type SocialPlan, type SocialKind } from '../avan/client.ts';

interface Entry<T> { at: number; val: T }
const cache = new Map<string, Entry<unknown>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<{ val: T | null; error?: string; stale?: boolean }> {
  const e = cache.get(key) as Entry<T> | undefined;
  if (e && Date.now() - e.at < ttlMs) return { val: e.val };
  try {
    const val = await fn();
    cache.set(key, { at: Date.now(), val });
    return { val };
  } catch (err: any) {
    return { val: e?.val ?? null, error: err?.message || String(err), stale: !!e };
  }
}
export function invalidateCatalog() { cache.clear(); }

/** GPT 订阅套餐 + 固定面额的点数（Credits）；点数也可以是自定义的 credits_N（N 为 250–9999999） */
export const GPT_PLAN_KEYS = ['go', 'plus', 'pro_5x', 'pro_20x', 'pro_25x', 'credits_250', 'credits_1000', 'credits_2500', 'credits_5000'] as const;
export const X_PLAN_KEYS = ['premium_3m', 'premium_6m', 'premium_12m', 'premium_plus_3m', 'premium_plus_6m', 'premium_plus_12m'] as const;
export const TG_PLAN_KEYS = ['premium_3m', 'premium_6m', 'premium_12m'] as const;
export const planKeys = (p: string): readonly string[] => (p === 'gpt' ? GPT_PLAN_KEYS : p === 'x' ? X_PLAN_KEYS : TG_PLAN_KEYS);

/** 点数套餐 credits_N：N 为 250–9999999 的整数，不能有前导零（和卡台的校验一致） */
const CREDITS = /^credits_(25[0-9]|2[6-9][0-9]|[3-9][0-9]{2}|[1-9][0-9]{3,6})$/;
export const creditsOf = (plan: string): number | null => (CREDITS.test(plan) ? Number(plan.slice(8)) : null);
export const isCredits = (plan: string) => creditsOf(plan) != null;
/** 套餐是否有效：固定列表里的，或 GPT 的自定义点数 */
export const validPlan = (product: string, plan: string) => planKeys(product).includes(plan) || (product === 'gpt' && isCredits(plan));

const GPT_LABEL: Record<string, string> = { go: 'Go', plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x', pro_25x: 'Pro 25x' };
const SOCIAL_LABEL: Record<string, string> = { premium_3m: 'Premium 3 个月', premium_6m: 'Premium 6 个月', premium_12m: 'Premium 12 个月', premium_plus_3m: 'Premium+ 3 个月', premium_plus_6m: 'Premium+ 6 个月', premium_plus_12m: 'Premium+ 12 个月' };
export const PRODUCT_NAME: Record<string, string> = { gpt: 'ChatGPT', x: 'X', tg: 'Telegram' };
export function planLabel(product: string, plan: string) {
  if (product === 'gpt') { const n = creditsOf(plan); return n != null ? `${n.toLocaleString('en-US')} 点数` : GPT_LABEL[plan] || plan; }
  return SOCIAL_LABEL[plan] || plan;
}
export const fullPlanLabel = (product: string, plan: string) => `${PRODUCT_NAME[product]} ${planLabel(product, plan)}`;

export const gptOffers = () => cached<CdkOffer[]>('gptOffers', 60_000, () => avan.gptOffers());
export const gptPlans = () => cached('gptPlans', 300_000, () => avan.gptPlans());
export const socialPlans = (k: SocialKind) => cached<{ plans: SocialPlan[]; paymentsEnabled: boolean }>(`plans:${k}`, 300_000, () => avan.socialPlans(k));

/** 目录里一个套餐的参考成本（USD）：预期金额 + 服务费；没开放、币种不是美元或金额格式异常时返回 null */
export async function catalogUsd(key: string): Promise<{ usd: number; fee: number } | null> {
  const p = (await gptPlans()).val?.plans.find(x => x.key === key);
  if (!p || !p.enabled || !Number.isInteger(p.expectedAmountMinor) || p.expectedAmountMinor! <= 0 || String(p.currency || '').toLowerCase() !== 'usd') return null;
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(String(p.customerServiceFee ?? ''))) return null;
  const fee = Math.round(Number(p.customerServiceFee) * 100);
  return { usd: (p.expectedAmountMinor! + fee) / 100, fee: fee / 100 };
}

/**
 * GPT 当前成本（USD），拿不到返回 null。
 *   - 订阅套餐：卡台 CDK 售价
 *   - 点数：CDK 生成免费，兑换时按当时的点数报价扣费，没有 CDK 售价，用套餐目录估算：
 *     固定面额直接用目录金额 + 服务费；自定义点数按最接近的固定面额的单价折算（服务费按一份算）
 */
export async function gptSalePrice(plan: string): Promise<number | null> {
  const r = await gptOffers();
  const o = r.val?.find(x => x.plan === plan);
  if (o && o.enabled && o.salePrice) return Number(o.salePrice);
  const n = creditsOf(plan);
  if (n == null) return null;
  const exact = await catalogUsd(plan);
  if (exact) return exact.usd;
  const tiers = (await Promise.all(GPT_PLAN_KEYS.filter(isCredits).map(async k => ({ n: creditsOf(k)!, c: await catalogUsd(k) }))))
    .filter(t => t.c).sort((a, b) => Math.abs(a.n - n) - Math.abs(b.n - n));
  const t = tiers[0];
  if (!t) return null;
  const per = (t.c!.usd - t.c!.fee) / t.n;
  return Math.ceil((per * n + t.c!.fee) * 100) / 100;
}

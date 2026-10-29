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

export const GPT_PLAN_KEYS = ['go', 'plus', 'pro_5x', 'pro_20x', 'pro_25x'] as const;
export const X_PLAN_KEYS = ['premium_3m', 'premium_6m', 'premium_12m', 'premium_plus_3m', 'premium_plus_6m', 'premium_plus_12m'] as const;
export const TG_PLAN_KEYS = ['premium_3m', 'premium_6m', 'premium_12m'] as const;
/** 卡台自动直充接口支持的 GPT 套餐（不含 pro_25x、Credits） */
export const GPT_DIRECT_PLAN_KEYS: readonly string[] = ['go', 'plus', 'pro_5x', 'pro_20x'];
export const planKeys = (p: string): readonly string[] => (p === 'gpt' ? GPT_PLAN_KEYS : p === 'x' ? X_PLAN_KEYS : TG_PLAN_KEYS);

const GPT_LABEL: Record<string, string> = { go: 'Go', plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x', pro_25x: 'Pro 25x' };
const SOCIAL_LABEL: Record<string, string> = { premium_3m: 'Premium 3 个月', premium_6m: 'Premium 6 个月', premium_12m: 'Premium 12 个月', premium_plus_3m: 'Premium+ 3 个月', premium_plus_6m: 'Premium+ 6 个月', premium_plus_12m: 'Premium+ 12 个月' };
export const PRODUCT_NAME: Record<string, string> = { gpt: 'ChatGPT', x: 'X', tg: 'Telegram' };
export function planLabel(product: string, plan: string) {
  return product === 'gpt' ? GPT_LABEL[plan] || plan : SOCIAL_LABEL[plan] || plan;
}
export const fullPlanLabel = (product: string, plan: string) => `${PRODUCT_NAME[product]} ${planLabel(product, plan)}`;

export const gptOffers = () => cached<CdkOffer[]>('gptOffers', 60_000, () => avan.gptOffers());
export const gptPlans = () => cached('gptPlans', 300_000, () => avan.gptPlans());
export const socialPlans = (k: SocialKind) => cached<{ plans: SocialPlan[]; paymentsEnabled: boolean }>(`plans:${k}`, 300_000, () => avan.socialPlans(k));

/** GPT 直充的参考成本（USD）：套餐目录的预期金额 + 服务费；目录币种不是美元或缺金额时返回 null */
export async function gptDirectEstimate(plan: string): Promise<number | null> {
  const p = (await gptPlans()).val?.plans.find(x => x.key === plan);
  if (!p || !p.enabled || !Number.isInteger(p.expectedAmountMinor) || p.expectedAmountMinor! <= 0 || String(p.currency || '').toLowerCase() !== 'usd') return null;
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(String(p.customerServiceFee ?? ''))) return null; // 格式异常不给估算，生成页按无报价处理
  return (p.expectedAmountMinor! + Math.round(Number(p.customerServiceFee) * 100)) / 100;
}

/** GPT CDK 当前售价（即我方成本）；拿不到返回 null */
export async function gptSalePrice(plan: string): Promise<number | null> {
  const r = await gptOffers();
  const o = r.val?.find(x => x.plan === plan);
  return o && o.enabled && o.salePrice ? Number(o.salePrice) : null;
}

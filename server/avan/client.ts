/**
 * Avanfinity 卡台 API 客户端（只封装 CDK 系统用得到的接口）
 * - v1 接口：{base}/api/v1/...，X-App-Id / X-App-Secret 鉴权
 * - 公开兑换接口：{base}/api/public/...，不带密钥；GPT 用 X-Redemption-Device，TG 用 body.deviceToken
 */
import { avanCredentials } from '../services/settings.ts';

export class AvanError extends Error {
  status: number; code?: string; requestId?: string; data?: any;
  constructor(status: number, message: string, code?: string, requestId?: string, data?: any) {
    super(message); this.status = status; this.code = code; this.requestId = requestId; this.data = data;
  }
  /** 网络错误、超时、5xx：结果未知，应该用相同标识重试 / 先查询 */
  get uncertain() { return this.status === 0 || this.status === 408 || this.status >= 500; }
}

/** 卡台在售的产品线（X Premium 已下线） */
export type Product = 'gpt' | 'tg';
export type SocialKind = 'tg';

interface ReqOpts { body?: unknown; idem?: string; device?: string; publicApi?: boolean; query?: Record<string, string | number | undefined>; timeoutMs?: number }

async function request<T = any>(method: string, path: string, o: ReqOpts = {}): Promise<T> {
  const cred = avanCredentials();
  if (!cred.baseUrl) throw new AvanError(0, '尚未配置卡台地址', 'NOT_CONFIGURED');
  if (!o.publicApi && (!cred.appId || !cred.appSecret)) throw new AvanError(0, '尚未配置卡台 App-Id / App-Secret', 'NOT_CONFIGURED');
  const url = new URL(cred.baseUrl + (o.publicApi ? '/api' : '/api/v1') + path);
  for (const [k, v] of Object.entries(o.query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!o.publicApi) { headers['X-App-Id'] = cred.appId; headers['X-App-Secret'] = cred.appSecret!; }
  if (o.idem) headers['Idempotency-Key'] = o.idem;
  if (o.device) headers['X-Redemption-Device'] = o.device;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';

  // 网络层失败时重试一次：写接口都带幂等键 / clientRequestId，重放是安全的
  let lastErr: AvanError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(o.timeoutMs ?? 25_000) });
    } catch (e: any) {
      lastErr = new AvanError(0, e?.name === 'TimeoutError' ? '卡台请求超时' : `无法连接卡台：${e?.message || e}`, 'NETWORK');
      await new Promise(r => setTimeout(r, 600));
      continue;
    }
    const rid = res.headers.get('x-request-id') || undefined;
    // 响应头已经到了、响应体读到一半断了：卡台可能已经处理了这个请求，只能按「结果未知」处理
    let text: string;
    try { text = await res.text(); } catch (e: any) { throw new AvanError(0, `卡台响应中断，结果未知：${e?.message || e}`, 'RESPONSE_INTERRUPTED', rid); }
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch {
      // 成功状态却不是 JSON（网关 / 代理返回的页面等）：同样不能当成成功或失败
      if (res.ok) throw new AvanError(0, `卡台返回了无法解析的内容（HTTP ${res.status}），结果未知`, 'BAD_RESPONSE', rid);
    }
    if (!res.ok) {
      throw new AvanError(res.status, data?.error || data?.message || `卡台返回 HTTP ${res.status}`, data?.errorCode, rid, data?.data);
    }
    return (data && typeof data === 'object' && 'data' in data ? data.data : data) as T;
  }
  throw lastErr!;
}

/* ---------------- 目录 / 报价 ---------------- */
export interface CdkOffer { plan: string; enabled: boolean; salePrice: string | null; pricingStatus: 'READY' | 'WAITING_QUOTE'; stock: number }
export interface GptPlan { key: string; label: string; currency: string; enabled: boolean; customerServiceFee: string; expectedAmountMinor: number | null }
export interface CheckoutRegion { country: string; currency: string }
export interface GptPlansData {
  version: number; plans: GptPlan[];
  /** 以下三个字段新版卡台才有；旧版缺失时按「不支持选地区」处理 */
  checkoutCountries?: CheckoutRegion[]; batchConcurrencyByCountry?: Record<string, number> | null; cdkRegionSelectionEnabled?: boolean;
}
export interface SocialPlan { key: string; label: string; tier?: string; months: number; enabled: boolean; serviceFee: string; pricingVersion: number }

export const avan = {
  gptOffers: () => request<{ offers: CdkOffer[] }>('GET', '/gpt-direct/cdk-offers').then(d => d.offers),
  gptPlans: () => request<GptPlansData>('GET', '/gpt-direct/plans'),
  socialPlans: (k: SocialKind) => request<{ plans: SocialPlan[]; paymentsEnabled: boolean }>('GET', `/${k}-direct/plans`),
  products: () => request<{ list?: any[] } | any[]>('GET', '/products').then(d => (Array.isArray(d) ? d : d.list || (d as any).products || [])),

  /* ---------------- GPT CDK ---------------- */
  /** paymentCountry 只在卡台目录 cdkRegionSelectionEnabled 为 true 时传（旧版卡台会拒绝未知字段） */
  gptGenerate: (p: { plan: string; quantity: number; forceNewCard: boolean; paymentCountry?: string }, idem: string) =>
    request<{ saleId: string; salePrice: string; items: { cdkId: string; code: string | null; codePrefix: string }[]; replayed: boolean; forceNewCard: boolean; checkoutRegion?: CheckoutRegion | null }>(
      'POST', '/gpt-direct/cdks/generate', { body: p, idem }),
  gptCdks: (page = 1, pageSize = 100) => request<{ total: number; list: { id: string; codePrefix: string; plan: string; status: string; inventoryStatus: string; salePrice: string | null; updatedAt: string; forceNewCard: boolean }[] }>(
    'GET', '/gpt-direct/cdks', { query: { page, page_size: pageSize } }),
  gptPublic: (step: 'preview' | 'preflight' | 'redeem' | 'result' | 'receipt' | 'cancel-renewal', body: unknown, device: string) =>
    request<any>('POST', `/public/cdk/${step}`, { body, device, publicApi: true }),
  gptOrderSession: (orderId: string, session: string) =>
    request<any>('POST', `/gpt-direct/orders/${orderId}/session`, { body: { credential: { mode: 'session', session } } }),

  /* ---------------- Telegram CDK ---------------- */
  socialGenerate: (k: SocialKind, p: { plan: string; quantity: number; maxWalletDebitUsd: string; maxOfficialAmountMinor: number; currency: string; fundingAmountUsd: string; cardId?: number; autoCard?: { productCode: string; firstName: string; lastName: string } }, idem: string) =>
    request<{ list: SocialIssuerItem[]; replayed: boolean }>('POST', `/${k}-direct/cdks/generate`, { body: p, idem }),
  socialCdks: (k: SocialKind) => request<{ list: SocialIssuerItem[] } | SocialIssuerItem[]>('GET', `/${k}-direct/cdks`).then(d => (Array.isArray(d) ? d : d.list)),
  socialExport: (k: SocialKind, id: string) => request<{ id: string; code: string }>('GET', `/${k}-direct/cdks/${id}/export`),
  socialRevoke: (k: SocialKind, id: string, idem: string) => request<any>('POST', `/${k}-direct/cdks/${id}/revoke`, { idem }),
  socialPublic: (k: SocialKind, step: 'preview' | 'preflight' | 'redeem' | 'result', body: unknown) =>
    request<SocialPublicData>('POST', `/public/${k}-cdk/${step}`, { body, publicApi: true }),

  /* ---------------- 流水 ---------------- */
  allTransactions: (page = 1, pageSize = 100) => request<{ total: number; list: any[] }>('GET', '/cards/all-transactions', { query: { page, page_size: pageSize } }),

  /* ---------------- 钱包（只读） ---------------- */
  balance: () => request<AvanBalance>('GET', '/balance'),
};

/** 卡台钱包余额：金额都是十进制字符串（USD），不要转浮点做资金计算 */
export interface AvanBalance {
  /** 可用余额 */
  balance: string;
  totalBalance: string;
  /** 支付风控锁定的部分 */
  riskLockedBalance: string;
  retryReservedBalance?: string;
  promoBalance?: string;
}

export interface SocialIssuerItem {
  id: string; plan: string; status: string; code?: string; codePrefix: string; recipient: string | null;
  maxWalletDebitUsd: string; maxOfficialAmountMinor: number; currency: string; fundingAmountUsd: string;
  serviceFee: string; totalWalletDebitUsd: string; fundingDispatched: boolean; paymentDispatched: boolean; createdAt: string;
}
export interface SocialPublicData {
  plan: string; status: string; recipient?: string | null; amountMinor?: number | null; currency?: string | null;
  message?: string | null; errorCode?: string | null; invoiceUrls?: string[] | null; canRetryPreflight?: boolean;
  deliveryStatus?: 'pending' | 'delivered' | null; giftDays?: number | null;
}

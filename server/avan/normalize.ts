/**
 * GPT 公开兑换接口（/api/public/cdk/*）的 data 在 OpenAPI 中是开放对象（additionalProperties: true），
 * 文档只说明「按步骤返回 redemptionToken、preflightToken、套餐、报价、订单、公开进度时间线」。
 * 这里集中做字段兼容：同一个字段依次在顶层、order、preflight、quote 等位置查找。
 * 接入真实卡台后如发现字段名不同，只需要改这个文件。
 */

const TERMINAL = new Set(['completed', 'declined', 'failed', 'failed_precharge', 'cancelled']);
const FAILED = new Set(['declined', 'failed', 'failed_precharge', 'cancelled']);

function pick(objs: any[], ...keys: string[]): any {
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
}

export interface GptPublicView {
  redemptionToken?: string;
  preflightToken?: string;
  preflightExpiresAt?: string;
  plan?: string;
  planLabel?: string;
  cdkStatus?: string;
  email?: string;
  currentPlan?: string;
  quote?: { currency?: string; amountMinor?: number; amountMajor?: string; country?: string; usd?: string };
  orderId?: string;
  orderStatus?: string;
  stage?: string;
  nextAction?: string;
  terminal: boolean;
  success: boolean;
  failed: boolean;
  errorCode?: string;
  message?: string;
  cardLast4?: string | null;
  progress: { step: string; status?: string; message?: string; at?: string }[];
  invoiceUrls: string[];
  willRenew?: boolean | null;
}

export function normalizeGptPublic(data: any): GptPublicView {
  const d = data && typeof data === 'object' ? data : {};
  const order = d.order || d.directOrder || d.result?.order || null;
  const pf = d.preflight || d.account || null;
  const cdk = d.cdk || null;
  const all = [d, order, pf, cdk, d.result];

  const orderStatus: string | undefined = order?.status ?? pick([d, d.result], 'orderStatus', 'status');
  const quotes = pick([pf, d], 'quotes');
  const planKey = pick([cdk, d, order], 'plan', 'planKey');
  let quote = pick([pf, d], 'quote');
  if (!quote && quotes && planKey && quotes[planKey]) quote = quotes[planKey];
  const usd = pick([pf, d], 'quoteEstimatesUsd')?.[planKey] ?? quote?.usd ?? quote?.estimatedUsd;

  const progressRaw = pick([d, order, d.result], 'progress', 'timeline', 'steps', 'events') || [];
  const progress = Array.isArray(progressRaw) ? progressRaw.map((p: any) => ({
    step: String(p.step ?? p.stageLabel ?? p.stage ?? p.type ?? p.name ?? ''),
    status: p.status ?? undefined,
    message: p.publicMessage ?? p.message ?? undefined,
    at: p.occurredAt ?? p.at ?? p.time ?? undefined,
  })) : [];

  const isTerminal = orderStatus ? TERMINAL.has(orderStatus) : false;
  const failure = order?.failure || d.failure || null;
  return {
    redemptionToken: pick(all, 'redemptionToken'),
    preflightToken: pick(all, 'preflightToken'),
    preflightExpiresAt: pick(all, 'preflightExpiresAt', 'expiresAt'),
    plan: planKey,
    planLabel: pick([cdk, d, order], 'planLabel', 'label', 'planName'),
    cdkStatus: pick([cdk, d], 'cdkStatus', 'inventoryStatus') ?? (order ? undefined : d.status),
    email: pick([pf, d, order], 'email', 'maskedEmail'),
    currentPlan: pick([pf, d], 'currentPlan', 'observedPlan'),
    quote: quote ? { currency: quote.currency, amountMinor: quote.amountMinor, amountMajor: quote.amountMajor, country: quote.country, usd } : (usd ? { usd } : undefined),
    orderId: order?.id ?? pick([d], 'orderId'),
    orderStatus,
    stage: order?.stage ?? d.stage,
    nextAction: order?.nextAction ?? d.nextAction,
    terminal: isTerminal,
    success: orderStatus === 'completed',
    failed: orderStatus ? FAILED.has(orderStatus) : false,
    errorCode: failure?.code ?? order?.publicCode ?? d.errorCode ?? d.publicCode,
    message: order?.recoveryMessage ?? order?.publicMessage ?? failure?.message ?? d.message ?? d.publicMessage,
    cardLast4: pick([d, order], 'cardLastFour', 'cardLast4') ?? null,
    progress,
    invoiceUrls: (order?.invoiceUrls || (order?.invoiceUrl ? [order.invoiceUrl] : []) || []).filter(Boolean),
    willRenew: order?.willRenew ?? null,
  };
}

/** 支付渠道统一接口 */
export interface PaymentRow {
  id: string; order_no: string; method: string; sub: string | null;
  amount: number; crypto_amount: number | null; status: string; trade_no: string | null;
  pay_url: string | null; qr: string | null; created_at: string; expires_at: string;
}
export interface CreateInput { payment: PaymentRow; title: string; notifyUrl: string; returnUrl: string; clientIp: string; mobile: boolean }
/** 返回给前端的支付指引 */
export interface PayAction { type: 'redirect' | 'qr' | 'crypto' | 'done'; url?: string; qr?: string; address?: string; amount?: string; network?: string }
/** 回调 / 查单的结论：paid 时必须带平台流水号和平台确认的金额 */
export interface PayResult { paymentId: string; paid: boolean; tradeNo?: string; amount?: number; cryptoAmount?: number; raw?: unknown }

export interface Channel {
  key: 'epay' | 'usdt' | 'alipay' | 'wechat';
  label(): string;
  /** 开关打开、必填项都填了：买家结账时能看到 */
  enabled(): boolean;
  /** 还没填的必填项（字段的中文名，不管开关是否打开）；后台支付页据此提示「还差几项」 */
  missing(): string[];
  /** 子类型（易支付：alipay / wxpay …） */
  subs?(): { key: string; label: string }[];
  create(i: CreateInput): Promise<PayAction>;
  /** 校验回调。返回 null 表示签名不对；response 是要回给平台的内容 */
  notify(req: { method: string; query: Record<string, string>; body: string; headers: Record<string, string> }): Promise<{ result: PayResult | null; response: { status: number; body: string; type?: string } }>;
  query?(p: PaymentRow): Promise<PayResult | null>;
}
export const yuan = (cents: number) => (cents / 100).toFixed(2);
export const cents = (yuanStr: string | number) => Math.round(Number(yuanStr) * 100);

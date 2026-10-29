import { q, now, parse, json } from '../db.ts';
import { encryptOpt, decryptOpt } from '../crypto.ts';
import { config } from '../config.ts';

export interface Theme {
  preset: string; mode: 'dark' | 'light' | 'auto'; a1: string; a2: string; a3: string; r: number; blur: number; glow: number; name: string; logo: string; slogan: string;
  /** 背景：aurora 极光 | mesh 流光 | grid 网格 | dots 点阵 | plain 纯色 */
  bg: string;
  /** 字体气质：modern 现代 | rounded 圆润 | serif 宋体 | tech 科技 */
  font: string;
  /** 卡片：glass 玻璃 | solid 实色 | outline 描边 | neo 浮雕 */
  card: string;
  /** 主按钮：gradient 渐变 | solid 纯色 | glow 霓虹；形状：round 圆角 | pill 胶囊 | square 直角 */
  btn: string; shape: string;
  /** 背景缓慢流动 */
  motion: boolean;
  /** Logo 图片（data URL，可选），同时用作网站图标 */
  logoImg: string;
  /** 商城首页的副标题 */
  tagline: string;
  /** 自定义 CSS（管理员填写，所有前台和后台页面生效） */
  customCss: string;
}
export interface RedeemPage { desc: string; products: { gpt: boolean; x: boolean; tg: boolean }; contact: string; maintenance: boolean; maintenanceMsg: string; turnstileSiteKey: string; turnstileSecretEnc: string | null }
export interface AvanSettings { baseUrl: string; appId: string; appSecretEnc: string | null; webhookSecretEnc: string | null }
/** X / TG 兑换时自动开卡用的产品（对用户和管理界面都不展示卡信息） */
export interface PaymentSettings { productCode: string; firstName: string; lastName: string }
/** X / TG 每个套餐的默认生成参数 */
export interface SocialPlanDefaults { currency: string; maxOfficialAmountMinor: number; fundingAmountUsd: string }
export interface Notify { failAlert: boolean; shopAlert: boolean; lowStock: boolean; dailyReport: boolean; autoCancelRenewal: boolean; lowStockThreshold: number; tgTokenEnc: string | null; tgChatId: string; lastReportDay: string }

/** 商城 */
export interface ShopSettings {
  enabled: boolean; homepage: 'redeem' | 'shop'; title: string; notice: string;
  orderExpireMin: number;      // 未付款订单自动关闭（分钟）
  freezeDays: number;          // 代理收益冻结天数
  minWithdraw: number;         // 最低提现（分）
  refDays: number;             // 推广链接归因天数
  allowAgentApply: boolean;
  allowRegister: boolean;
}
/** 支付渠道；*Enc 字段为加密后的密钥 */
export interface PaySettings {
  epay: { enabled: boolean; name: string; apiUrl: string; pid: string; keyEnc: string | null; types: string[] };
  usdt: { enabled: boolean; address: string; rate: number; tronApi: string; apiKeyEnc: string | null; contract: string };
  alipay: { enabled: boolean; appId: string; privateKeyEnc: string | null; alipayPublicKey: string; gateway: string; mode: 'precreate' | 'page' };
  wechat: { enabled: boolean; mchId: string; appId: string; serialNo: string; privateKeyEnc: string | null; apiV3KeyEnc: string | null; publicKeyId: string; publicKey: string; api: string };
}
export interface MailSettings { enabled: boolean; host: string; port: number; secure: boolean; user: string; passEnc: string | null; from: string; fromName: string }

const DEFAULTS = {
  theme: { preset: 'aurora', mode: 'dark', a1: '#8b7cff', a2: '#4fd8ff', a3: '#ff7ac6', r: 18, blur: 24, glow: 60, name: 'CDK Console', logo: 'C', slogan: '一码开通你的会员',
    bg: 'aurora', font: 'modern', card: 'glass', btn: 'gradient', shape: 'round', motion: true, logoImg: '', tagline: '', customCss: '' } as Theme,
  redeemPage: {
    desc: '输入你拿到的兑换码，我们会先核对账号和套餐，确认无误后自动开通。整个过程不需要你付款，也不需要提供任何支付信息。',
    products: { gpt: true, x: true, tg: true }, contact: '', maintenance: false, maintenanceMsg: '系统维护中，请稍后再来兑换。',
    turnstileSiteKey: '', turnstileSecretEnc: null,
  } as RedeemPage,
  avan: { baseUrl: config.avanBase, appId: '', appSecretEnc: null, webhookSecretEnc: null } as AvanSettings,
  payment: { productCode: '', firstName: 'CDK', lastName: 'USER' } as PaymentSettings,
  socialDefaults: {
    'x.premium_3m': { currency: 'usd', maxOfficialAmountMinor: 3000, fundingAmountUsd: '26.00' },
    'x.premium_6m': { currency: 'usd', maxOfficialAmountMinor: 5500, fundingAmountUsd: '50.00' },
    'x.premium_12m': { currency: 'usd', maxOfficialAmountMinor: 9500, fundingAmountUsd: '88.00' },
    'x.premium_plus_3m': { currency: 'usd', maxOfficialAmountMinor: 7000, fundingAmountUsd: '64.00' },
    'x.premium_plus_6m': { currency: 'usd', maxOfficialAmountMinor: 13000, fundingAmountUsd: '122.00' },
    'x.premium_plus_12m': { currency: 'usd', maxOfficialAmountMinor: 25000, fundingAmountUsd: '235.00' },
    'tg.premium_3m': { currency: 'usd', maxOfficialAmountMinor: 1300, fundingAmountUsd: '13.00' },
    'tg.premium_6m': { currency: 'usd', maxOfficialAmountMinor: 1700, fundingAmountUsd: '17.00' },
    'tg.premium_12m': { currency: 'usd', maxOfficialAmountMinor: 3100, fundingAmountUsd: '30.00' },
  } as Record<string, SocialPlanDefaults>,
  /** 零售价（人民币），键为 product.plan */
  retail: {} as Record<string, number>,
  /** 计算利润用的汇率 USD→CNY */
  fx: { usdCny: 7.1 },
  shop: { enabled: false, homepage: 'redeem', title: '会员商城', notice: '', orderExpireMin: 15, freezeDays: 3, minWithdraw: 1000, refDays: 30, allowAgentApply: true, allowRegister: true } as ShopSettings,
  pay: {
    epay: { enabled: false, name: '在线支付', apiUrl: '', pid: '', keyEnc: null, types: ['alipay', 'wxpay'] },
    usdt: { enabled: false, address: '', rate: 7.2, tronApi: 'https://api.trongrid.io', apiKeyEnc: null, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
    alipay: { enabled: false, appId: '', privateKeyEnc: null, alipayPublicKey: '', gateway: 'https://openapi.alipay.com/gateway.do', mode: 'precreate' },
    wechat: { enabled: false, mchId: '', appId: '', serialNo: '', privateKeyEnc: null, apiV3KeyEnc: null, publicKeyId: '', publicKey: '', api: 'https://api.mch.weixin.qq.com' },
  } as PaySettings,
  mail: { enabled: false, host: '', port: 465, secure: true, user: '', passEnc: null, from: '', fromName: '' } as MailSettings,
  notify: { failAlert: true, shopAlert: true, lowStock: true, dailyReport: false, autoCancelRenewal: true, lowStockThreshold: 20, tgTokenEnc: null, tgChatId: '', lastReportDay: '' } as Notify,
};
type Defaults = typeof DEFAULTS;
export type SettingKey = keyof Defaults;

/**
 * 设置全部缓存在内存里（只有一个进程），启动时 loadSettings 一次性读入，之后读是同步的。
 * 写入时先更新缓存再落库，所以 setSetting 返回前缓存就已经是新值
 */
const cache = new Map<string, unknown>();
const merge = (key: SettingKey, raw: string) => {
  const def = DEFAULTS[key];
  return Array.isArray(def) || typeof def !== 'object' ? parse(raw, def) : { ...def, ...parse(raw, {}) };
};
export async function loadSettings() {
  cache.clear();
  for (const r of await q.all<{ key: string; value: string }>('SELECT "key", value FROM settings'))
    if (r.key in DEFAULTS) cache.set(r.key, merge(r.key as SettingKey, r.value));
}

export function getSetting<K extends SettingKey>(key: K): Defaults[K] {
  if (!cache.has(key)) cache.set(key, structuredClone(DEFAULTS[key]));
  return structuredClone(cache.get(key)) as Defaults[K];
}
export async function setSetting<K extends SettingKey>(key: K, value: Defaults[K]) {
  cache.set(key, structuredClone(value));
  await q.upsert('settings', { key, value: json(value), updated_at: now() }, ['key'], ['value', 'updated_at']);
}
export async function patchSetting<K extends SettingKey>(key: K, patch: Partial<Defaults[K]>) {
  await setSetting(key, { ...getSetting(key), ...patch });
}

/* ---------- 卡台凭据（解密只在服务端使用） ---------- */
export function avanCredentials() {
  const s = getSetting('avan');
  return {
    baseUrl: (s.baseUrl || config.avanBase).replace(/\/$/, ''),
    appId: s.appId,
    appSecret: decryptOpt(s.appSecretEnc),
    webhookSecret: decryptOpt(s.webhookSecretEnc),
  };
}
export async function saveAvanCredentials(p: { baseUrl?: string; appId?: string; appSecret?: string; webhookSecret?: string }) {
  const s = getSetting('avan');
  if (p.baseUrl !== undefined) s.baseUrl = p.baseUrl.trim().replace(/\/$/, '');
  if (p.appId !== undefined) s.appId = p.appId.trim();
  if (p.appSecret) s.appSecretEnc = encryptOpt(p.appSecret.trim());
  if (p.webhookSecret) s.webhookSecretEnc = encryptOpt(p.webhookSecret.trim());
  await setSetting('avan', s);
}
export const mask = (s: string | null, keep = 4) => (s ? s.slice(0, Math.min(8, s.length - keep)) + '…' + s.slice(-keep) : '');

/** 给前端的公开配置（兑换页） */
export function publicConfig() {
  const t = getSetting('theme'), r = getSetting('redeemPage'), sh = getSetting('shop');
  return {
    theme: t, shop: { enabled: sh.enabled, title: sh.title },
    redeem: { desc: r.desc, products: r.products, contact: r.contact, maintenance: r.maintenance, maintenanceMsg: r.maintenanceMsg, turnstileSiteKey: r.turnstileSiteKey },
  };
}

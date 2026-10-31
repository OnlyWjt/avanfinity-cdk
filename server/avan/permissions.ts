/**
 * 本系统用到的卡台 API Key 权限（scope）。
 * 读权限可以调一次只读接口自动检查；写权限调一次就会产生费用或改动数据，只能提示去勾选。
 * 卡台的 403 表示「账户、scope 或来源 IP 不允许」，IP 白名单只管写接口，所以读接口的 403 基本就是缺权限。
 */
import { avan, AvanError } from './client.ts';

export interface AvanPerm { key: string; what: string; check?: () => Promise<unknown> }

export const AVAN_PERMS: AvanPerm[] = [
  { key: 'cdk:read', what: 'GPT CDK 售价和库存', check: () => avan.gptOffers() },
  { key: 'gpt:read', what: 'GPT 套餐报价（点数成本估算）', check: () => avan.gptPlans() },
  { key: 'x-direct:read', what: 'X 套餐和服务费', check: () => avan.socialPlans('x') },
  { key: 'tg-direct:read', what: 'Telegram 套餐和服务费', check: () => avan.socialPlans('tg') },
  { key: 'products:read', what: 'X / TG 付款通道的卡产品列表', check: () => avan.products() },
  { key: 'cards:read', what: '同步支付流水', check: () => avan.allTransactions(1, 1) },
  { key: 'account:read', what: '显示卡台余额', check: () => avan.balance() },
  { key: 'cdk:purchase', what: '生成 GPT CDK（自有码在兑换时生成）' },
  { key: 'gpt:write', what: '买家重新提交 ChatGPT Session' },
  { key: 'x-direct:write', what: '生成、导出、撤销 X CDK' },
  { key: 'tg-direct:write', what: '生成、导出、撤销 Telegram CDK' },
];
export const AVAN_PERM_KEYS = AVAN_PERMS.map(p => p.key);

/** 把卡台错误说成运营能直接处理的话：403 时写明缺哪个权限 */
export function permError(e: unknown, need: string, write = false): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (!(e instanceof AvanError) || e.status !== 403) return msg;
  return write ? `API Key 缺少 ${need} 权限，或服务器 IP 不在卡台白名单里` : `API Key 缺少 ${need} 权限`;
}

/** 逐个检查读权限（并行，互不影响） */
export async function checkPerms() {
  return Promise.all(AVAN_PERMS.map(async p => {
    if (!p.check) return { key: p.key, what: p.what, ok: null as boolean | null, error: '' };
    try { await p.check(); return { key: p.key, what: p.what, ok: true as boolean | null, error: '' }; }
    catch (e) { return { key: p.key, what: p.what, ok: false as boolean | null, error: permError(e, p.key) }; }
  }));
}

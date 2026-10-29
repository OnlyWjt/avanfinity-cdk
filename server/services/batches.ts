/** 生成批次、码列表、导出、撤销 */
import { q, tx, now, json, parse } from '../db.ts';
import { encrypt, decryptOpt, lookupHash, ownCode, hex, uuid } from '../crypto.ts';
import { avan, AvanError, type SocialKind } from '../avan/client.ts';
import { bad, HttpError, notFound } from '../http.ts';
import { getStrategy, type Strategy } from './strategy.ts';
import { getSetting } from './settings.ts';
import { pendingDirect } from './direct.ts';
import { gptSalePrice, gptDirectEstimate, gptPlans, planKeys, socialPlans, fullPlanLabel, GPT_DIRECT_PLAN_KEYS } from './catalog.ts';

export type Product = 'gpt' | 'x' | 'tg';

export interface SocialParams { maxWalletDebitUsd: string; maxOfficialAmountMinor: number; currency: string; fundingAmountUsd: string }
/** delivery / country 只对 GPT 有意义；旧批次没有这两个字段，按卡台 CDK、默认地区处理 */
export interface BatchParams { forceNewCard?: boolean; social?: SocialParams; delivery?: 'cdk' | 'direct'; country?: string; costBasis?: 'direct' | 'cdk' }
export const deliveryOf = (p: BatchParams) => (p.delivery === 'direct' ? 'direct' : 'cdk');

/** 生成卡台 GPT CDK 时要不要带地区：卡台明确支持选地区才带，否则省略（旧版卡台会拒绝未知字段） */
export async function cdkRegionArg(country?: string): Promise<{ paymentCountry?: string }> {
  if (!country) return {};
  const plans = (await gptPlans()).val;
  return plans?.cdkRegionSelectionEnabled === true ? { paymentCountry: country } : {};
}

export function displayCode(code: string): string {
  if (code.startsWith('AVF-')) return code.slice(0, 12) + '…';
  const parts = code.split('-');
  return parts.length >= 3 ? `${parts[0]}-${parts[1]}-••••` : code.slice(0, 8) + '…';
}

const usd = (n: number) => n.toFixed(2);
function socialParamsFor(product: SocialKind, plan: string, s: Strategy, override?: Partial<SocialParams>): SocialParams {
  const d = getSetting('socialDefaults')[`${product}.${plan}`] || { currency: 'usd', maxOfficialAmountMinor: 3000, fundingAmountUsd: '30.00' };
  const p: SocialParams = {
    maxWalletDebitUsd: override?.maxWalletDebitUsd || usd(s.costCap),
    maxOfficialAmountMinor: override?.maxOfficialAmountMinor || d.maxOfficialAmountMinor,
    currency: (override?.currency || d.currency).toLowerCase(),
    fundingAmountUsd: override?.fundingAmountUsd || d.fundingAmountUsd,
  };
  if (!/^\d+(\.\d{1,4})?$/.test(p.maxWalletDebitUsd) || Number(p.maxWalletDebitUsd) <= 0) throw bad('成本上限格式不正确');
  if (!/^\d+(\.\d{1,4})?$/.test(p.fundingAmountUsd)) throw bad('注资额格式不正确');
  if (!/^[a-z]{3}$/.test(p.currency)) throw bad('币种应为 3 位字母');
  if (!Number.isInteger(p.maxOfficialAmountMinor) || p.maxOfficialAmountMinor < 1) throw bad('官方金额上限不正确');
  if (Number(p.fundingAmountUsd) >= Number(p.maxWalletDebitUsd)) throw bad('注资额必须小于单码成本上限（上限还要覆盖开卡费和服务费）');
  return p;
}
export function autoCard() {
  const p = getSetting('payment');
  if (!p.productCode) throw new HttpError(409, '还没有在「设置 → 卡台 API」里选择 X / TG 的付款通道', 'PAYMENT_NOT_CONFIGURED');
  return { productCode: p.productCode, firstName: p.firstName || 'CDK', lastName: p.lastName || 'USER' };
}

/**
 * 生成一个批次
 * - 自有码：只在本地生成；用户兑换时才向卡台临时生成 1 张卡台码
 * - 托管码：立即向卡台生成，完整码加密保存在本地
 * idemKey 由前端按表单内容生成：网络超时后重试会复用，卡台侧不会重复生成
 */
export async function generateBatch(p: { product: Product; plan: string; quantity: number; strategyId: string; memo?: string; idemKey: string; social?: Partial<SocialParams>; userId: number }) {
  if (!['gpt', 'x', 'tg'].includes(p.product)) throw bad('产品不正确');
  if (!planKeys(p.product).includes(p.plan)) throw bad('套餐不正确');
  if (!Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > 50) throw bad('数量 1–50');
  if (!/^[!#-~]{8,128}$/.test(p.idemKey)) throw bad('幂等键不正确');
  const replay = q.get<{ id: string }>('SELECT id FROM batches WHERE idem_key = ?', [p.idemKey]);
  if (replay) return { ...batchResult(replay.id), replayed: true };

  const s = getStrategy(p.strategyId);
  if (!s.on) throw bad('这条策略已停用');
  if (!s.prod.includes(p.product)) throw bad(`策略「${s.name}」不适用于这个产品`);

  const params: BatchParams = {};
  let costUsd: string | null = null;
  if (p.product === 'gpt') {
    params.forceNewCard = s.payMode === 'own';
    params.delivery = s.mode === 'own' ? s.delivery : 'cdk';
    if (s.country) {
      params.country = s.country;
      const regions = (await gptPlans()).val?.checkoutCountries;
      if (regions?.length && !regions.some(r => r.country === s.country)) throw bad(`卡台当前不支持结账地区 ${s.country}（可选：${regions.map(r => r.country).join('、')}）`);
    }
    let price: number | null;
    if (params.delivery === 'direct') {
      if (!GPT_DIRECT_PLAN_KEYS.includes(p.plan)) throw bad(`直充暂不支持 ${fullPlanLabel('gpt', p.plan)}，请换一条走卡台 CDK 的策略`);
      // 成本快照：直充按「目录预期金额 + 服务费」估算；目录不是美元时退回 CDK 售价，只作统计参考，兑换时不拿它做价格保护
      const est = await gptDirectEstimate(p.plan);
      params.costBasis = est != null ? 'direct' : 'cdk';
      price = est ?? (await gptSalePrice(p.plan));
    } else price = await gptSalePrice(p.plan);
    if (price == null) throw new HttpError(409, '这个套餐当前没有有效报价，暂时不能生成', 'WAITING_QUOTE');
    costUsd = usd(price);
  } else {
    const plans = await socialPlans(p.product);
    const plan = plans.val?.plans.find(x => x.key === p.plan);
    if (plans.val && (!plan || !plan.enabled)) throw bad('这个套餐暂未开放');
    params.social = socialParamsFor(p.product, p.plan, s, p.social);
    costUsd = params.social.maxWalletDebitUsd;
  }

  const batchId = 'b_' + hex(8);
  const created = now();
  const expiresAt = s.expire ? new Date(Date.now() + s.expire * 86400e3).toISOString() : null;
  type NewCode = { code: string | null; upstreamId: string | null; upstreamStatus: string | null };
  let codes: NewCode[] = [];

  if (s.mode === 'own') {
    const seen = new Set<string>();
    while (codes.length < p.quantity) {
      const c = ownCode(s.prefix);
      if (seen.has(c) || q.get('SELECT 1 FROM codes WHERE code_hash = ?', [lookupHash(c)])) continue;
      seen.add(c); codes.push({ code: c, upstreamId: null, upstreamStatus: null });
    }
  } else if (p.product === 'gpt') {
    const r = await avan.gptGenerate({ plan: p.plan, quantity: p.quantity, forceNewCard: !!params.forceNewCard, ...(await cdkRegionArg(params.country)) }, p.idemKey);
    if (params.country && r.checkoutRegion && r.checkoutRegion.country !== params.country) console.warn(`[batch] 卡台返回的结账地区 ${r.checkoutRegion.country} 和请求的 ${params.country} 不一致`);
    costUsd = r.salePrice || costUsd;
    codes = r.items.map(i => ({ code: i.code, upstreamId: i.cdkId, upstreamStatus: 'unused' }));
  } else {
    const r = await avan.socialGenerate(p.product, { plan: p.plan, quantity: p.quantity, ...params.social!, autoCard: autoCard() }, p.idemKey);
    codes = r.list.map(i => ({ code: i.code || null, upstreamId: i.id, upstreamStatus: i.status }));
  }

  tx(() => {
    q.run('INSERT INTO batches(id, product, plan, quantity, mode, strategy_id, params, cost_usd, memo, idem_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [batchId, p.product, p.plan, codes.length, s.mode, s.id, json(params), costUsd, (p.memo || '').slice(0, 100), p.idemKey, p.userId, created]);
    for (const c of codes) {
      q.run('INSERT INTO codes(id, batch_id, product, plan, mode, strategy_id, code_enc, code_hash, display, status, upstream_id, upstream_status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['c_' + hex(8), batchId, p.product, p.plan, s.mode, s.id, c.code ? encrypt(c.code) : null, c.code ? lookupHash(c.code) : null,
          c.code ? displayCode(c.code) : (c.upstreamId ? 'AVF-********' : '—'), 'unused', c.upstreamId, c.upstreamStatus, expiresAt, created]);
    }
  });
  return { ...batchResult(batchId), replayed: false };
}

function batchResult(batchId: string) {
  const b = q.get<any>('SELECT * FROM batches WHERE id = ?', [batchId])!;
  const rows = q.all<any>('SELECT code_enc FROM codes WHERE batch_id = ? ORDER BY rowid', [batchId]);
  return { batchId, product: b.product, plan: b.plan, mode: b.mode, strategyId: b.strategy_id, label: fullPlanLabel(b.product, b.plan), codes: rows.map(r => decryptOpt(r.code_enc)).filter(Boolean) as string[], missing: rows.filter(r => !r.code_enc).length };
}

/* ---------------- 列表 / 详情 ---------------- */
export function listCodes(f: { product: Product; status?: string; plan?: string; strategy?: string; q?: string; page: number; size: number }) {
  const where = ['c.product = ?'], args: any[] = [f.product];
  if (f.status) { where.push('c.status = ?'); args.push(f.status); }
  if (f.plan) { where.push('c.plan = ?'); args.push(f.plan); }
  if (f.strategy) { where.push('c.strategy_id = ?'); args.push(f.strategy); }
  if (f.q) {
    const qq = f.q.trim().toUpperCase();
    where.push('(c.display LIKE ? OR c.account LIKE ? OR c.batch_id LIKE ? OR b.memo LIKE ? OR c.code_hash = ?)');
    args.push(`%${qq.slice(0, 12)}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`, lookupHash(qq));
  }
  const w = where.join(' AND ');
  const total = q.get<{ n: number }>(`SELECT COUNT(*) n FROM codes c JOIN batches b ON b.id = c.batch_id WHERE ${w}`, args)!.n;
  const rows = q.all<any>(`SELECT c.*, b.memo, b.cost_usd, s.name strategy_name, s.config strategy_cfg, r.status r_status, r.error_msg r_error
    FROM codes c JOIN batches b ON b.id = c.batch_id JOIN strategies s ON s.id = c.strategy_id LEFT JOIN redemptions r ON r.id = c.redemption_id
    WHERE ${w} ORDER BY c.created_at DESC, c.rowid DESC LIMIT ? OFFSET ?`, [...args, f.size, (f.page - 1) * f.size]);
  return { total, list: rows.map(codeView) };
}
function codeView(r: any) {
  return {
    id: r.id, display: r.display, product: r.product, plan: r.plan, planLabel: fullPlanLabel(r.product, r.plan), mode: r.mode,
    status: r.status, upstreamStatus: r.upstream_status, account: r.account, batchId: r.batch_id, memo: r.memo,
    strategy: { id: r.strategy_id, name: r.strategy_name, mode: parse(r.strategy_cfg, {} as any).mode },
    cost: r.cost_usd, createdAt: r.created_at, redeemedAt: r.redeemed_at, expiresAt: r.expires_at,
    redemptionId: r.redemption_id, redemptionStatus: r.r_status, redemptionError: r.r_error, hasCode: !!r.code_enc,
  };
}
export function codeDetail(id: string) {
  const r = q.get<any>(`SELECT c.*, b.memo, b.cost_usd, b.params, s.name strategy_name, s.config strategy_cfg, r.status r_status, r.error_msg r_error
    FROM codes c JOIN batches b ON b.id = c.batch_id JOIN strategies s ON s.id = c.strategy_id LEFT JOIN redemptions r ON r.id = c.redemption_id WHERE c.id = ?`, [id]);
  if (!r) throw notFound('兑换码不存在');
  const redemptions = q.all<any>('SELECT id, status, account, error_msg, rule, attempts, created_at, completed_at FROM redemptions WHERE code_id = ? ORDER BY created_at DESC', [id]);
  const upstream = q.all<any>('SELECT id, status, created_at FROM upstream_codes WHERE code_id = ? ORDER BY created_at', [id]);
  return { ...codeView(r), params: parse(r.params, {}), redemptions, upstream };
}

export function codeStats() {
  const rows = q.all<{ product: string; status: string; n: number }>('SELECT product, status, COUNT(*) n FROM codes GROUP BY product, status');
  const out: Record<string, Record<string, number>> = { gpt: {}, x: {}, tg: {} };
  for (const r of rows) out[r.product][r.status] = r.n;
  return out;
}

/* ---------------- 导出 ---------------- */
export async function exportCodes(ids: string[]) {
  if (!ids.length || ids.length > 1000) throw bad('一次最多导出 1000 张');
  const rows = q.all<any>(`SELECT * FROM codes WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const out: { id: string; code: string | null; plan: string; product: string; status: string; note?: string }[] = [];
  for (const r of rows) {
    let code = decryptOpt(r.code_enc);
    let note: string | undefined;
    if (!code && r.mode === 'hosted' && r.product !== 'gpt' && r.upstream_id) {
      try { code = (await avan.socialExport(r.product, r.upstream_id)).code; q.run('UPDATE codes SET code_enc = ?, code_hash = ?, display = ? WHERE id = ?', [encrypt(code), lookupHash(code), displayCode(code), r.id]); }
      catch (e: any) { note = '卡台导出失败：' + e.message; }
    }
    if (!code) note ??= '卡台 GPT 码只在生成时返回一次，本地没有保存到完整码';
    out.push({ id: r.id, code, plan: r.plan, product: r.product, status: r.status, note });
  }
  return out;
}

/* ---------------- 撤销 ---------------- */
export async function revokeCodes(ids: string[]) {
  const results: { id: string; ok: boolean; msg: string }[] = [];
  for (const id of ids) {
    const r = q.get<any>('SELECT * FROM codes WHERE id = ?', [id]);
    if (!r) { results.push({ id, ok: false, msg: '不存在' }); continue; }
    if (r.status === 'revoked') { results.push({ id, ok: true, msg: '已是撤销状态' }); continue; }
    if (r.status === 'redeemed') { results.push({ id, ok: false, msg: '已兑换，不能撤销' }); continue; }
    if (pendingDirect(r.id)) { results.push({ id, ok: false, msg: '有一笔直充还没有结果，不能撤销' }); continue; }
    if (r.status === 'in_use') {
      const red = r.redemption_id && q.get<any>('SELECT status FROM redemptions WHERE id = ?', [r.redemption_id]);
      if (red && ['processing', 'funding', 'funded', 'paid_pending_delivery'].includes(red.status)) { results.push({ id, ok: false, msg: '正在付款，不能撤销' }); continue; }
    }
    try {
      if (r.mode === 'hosted' && r.product !== 'gpt' && r.upstream_id) await avan.socialRevoke(r.product, r.upstream_id, 'rv-' + r.id);
      if (r.mode === 'own') {
        // 已经临时生成的卡台 X/TG 码一起撤销（GPT 卡台码没有撤销接口，未兑换不产生费用）
        for (const u of q.all<any>("SELECT * FROM upstream_codes WHERE code_id = ? AND status IN ('issued','released')", [id])) {
          if (u.product !== 'gpt') await avan.socialRevoke(u.product, u.id, 'rv-' + u.id).catch(() => {});
          q.run("UPDATE upstream_codes SET status = 'revoked' WHERE id = ?", [u.id]);
        }
      }
      q.run("UPDATE codes SET status = 'revoked' WHERE id = ?", [id]);
      if (r.redemption_id) q.run("UPDATE redemptions SET status = 'cancelled', error_msg = '兑换码已被撤销', updated_at = ? WHERE id = ? AND status IN ('started','quoted','blocked','manual_review','requires_action')", [now(), r.redemption_id]);
      results.push({ id, ok: true, msg: r.mode === 'hosted' && r.product === 'gpt' ? '已在本系统停用；卡台 GPT 码没有撤销接口，在卡台官方兑换页仍可能被兑换' : '已撤销' });
    } catch (e) {
      results.push({ id, ok: false, msg: e instanceof AvanError ? `卡台拒绝：${e.message}` : String(e) });
    }
  }
  return results;
}

export const newIdemKey = () => 'gen-' + uuid();

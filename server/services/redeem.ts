/**
 * 兑换引擎
 *
 * 浏览器 ──► 我方 /api/public/redeem/* ──► 策略检查 ──► 卡台公开兑换接口
 *
 * 状态（redemptions.status）
 *   started          已输码，等待填写账号
 *   quoted           预检通过，等待用户确认
 *   blocked          被策略拦截（码仍可用）
 *   manual_review    等待管理员审核（价格保护 / 失败转人工）
 *   approved         管理员已通过，等待用户重新提交账号（Session 已过期时）
 *   funding / funded X/TG 第一阶段：准备付款 / 已准备好，等用户确认付款
 *   processing       已提交卡台，等待结果
 *   retrying         失败后按策略自动重试中
 *   requires_action  需要用户补交 Session 等
 *   paid_pending_delivery 已付款，等待官方交付
 *   completed        成功
 *   failed           失败（码已释放可重兑，或需联系卖家）
 *   expired          超时未完成
 *   cancelled        码被撤销
 */
import { q, tx, now, json, parse } from '../db.ts';
import { encrypt, decryptOpt, lookupHash, normalizeCode, hex, uuid } from '../crypto.ts';
import { avan, AvanError, type SocialKind, type SocialPublicData, type GptAutoTask, type GptAutoInput } from '../avan/client.ts';
import { normalizeGptPublic, type GptPublicView } from '../avan/normalize.ts';
import { HttpError, bad } from '../http.ts';
import { getStrategy, checkGates, checkAccount, checkPrice, type Strategy, type AccountInfo } from './strategy.ts';
import { getSetting } from './settings.ts';
import { gptSalePrice, gptPlans, fullPlanLabel } from './catalog.ts';
import { autoCard, deliveryOf, cdkRegionArg, type BatchParams } from './batches.ts';
import * as direct from './direct.ts';

const IN_FLIGHT = ['processing', 'funding', 'retrying', 'paid_pending_delivery'];
const OPEN = ['started', 'quoted', 'blocked', 'approved', 'funded', 'requires_action', ...IN_FLIGHT, 'manual_review'];
const STALE_MIN = 30;
/** 直充「需要处理」时的慢速查询间隔 */
const DIRECT_SLOW_POLL = Number(process.env.DIRECT_SLOW_POLL_MS) || 5 * 60e3;
/** 直充任务停在 requires_action 时也要继续查询（等卖家在卡台处理 / 买家补交 Session） */
const POLLABLE_SQL = `(status IN (${IN_FLIGHT.map(s => `'${s}'`).join(',')}) OR (status = 'requires_action' AND direct_task_id IS NOT NULL))`;
const pollable = (r: Red) => IN_FLIGHT.includes(r.status) || (r.status === 'requires_action' && !!r.direct_task_id);

/* ---------- Session 只存内存（不落库），供重试 / 审核通过后继续使用 ---------- */
const sessions = new Map<string, { s: string; exp: number }>();
const putSession = (rid: string, s: string, ttlMin = STALE_MIN) => sessions.set(rid, { s, exp: Date.now() + ttlMin * 60e3 });
const getSession = (rid: string) => { const e = sessions.get(rid); if (!e || e.exp < Date.now()) { sessions.delete(rid); return null; } return e.s; };
setInterval(() => { const t = Date.now(); for (const [k, v] of sessions) if (v.exp < t) sessions.delete(k); }, 60e3).unref();

/* ---------- 每条兑换的串行锁，防止重复点击并发提交 ---------- */
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(rid: string, fn: () => Promise<T>): Promise<T> {
  while (locks.has(rid)) await locks.get(rid)!.catch(() => {});
  const p = fn(); locks.set(rid, p);
  try { return await p; } finally { locks.delete(rid); }
}

interface Red {
  id: string; code_id: string; product: 'gpt' | 'x' | 'tg'; plan: string; strategy_id: string; status: string; stage: string | null;
  account: string | null; account_key: string | null; ip: string | null; browser_device: string | null; country: string | null;
  upstream_code_id: string | null; device: string; client_request_id: string | null;
  redemption_token_enc: string | null; preflight_token_enc: string | null; quote: string | null; cost_usd: string | null; rule: string | null;
  attempts: number; error_code: string | null; error_msg: string | null; order_id: string | null; card_last4: string | null;
  progress: string | null; invoice_urls: string | null; review: string | null; next_poll_at: string | null; created_at: string; updated_at: string; completed_at: string | null;
  direct_task_id: string | null; poll_started_at: string | null;
}
interface CodeRow { id: string; batch_id: string; product: 'gpt' | 'x' | 'tg'; plan: string; mode: 'own' | 'hosted'; strategy_id: string; code_enc: string | null; status: string; upstream_id: string | null; redemption_id: string | null; expires_at: string | null; created_at: string }

/** 卡台的金额是十进制字符串；按分换算，避免浮点误差累积 */
const DECIMAL = /^\d{1,9}(\.\d{1,6})?$/;
const toCents = (s: string) => Math.round(Number(s) * 100);
const getRed = async (id: string) => await q.get<Red>('SELECT * FROM redemptions WHERE id = ?', [id]);
const paramsOf = async (code: CodeRow) => parse<BatchParams>((await q.get<{ params: string }>('SELECT params FROM batches WHERE id = ?', [code.batch_id]))?.params, {});
/** GPT 自有码且批次交付方式是直充：不经过卡台 CDK，直接调用卡台自动直充 */
const isDirect = async (code: CodeRow) => code.product === 'gpt' && code.mode === 'own' && deliveryOf(await paramsOf(code)) === 'direct';
const UPSTREAM_SHORT = new Set(['error_code', 'order_id', 'card_last4', 'account']);
async function upd(id: string, f: Partial<Record<keyof Red, unknown>>) {
  const keys = Object.keys(f);
  if (!keys.length) return;
  // 卡台返回的短字段截断到列宽（PostgreSQL / MySQL 的短文本列是 VARCHAR(255)，超长会报错）
  const args: any[] = keys.map(k => { const v = (f as any)[k] ?? null; return UPSTREAM_SHORT.has(k) && typeof v === 'string' ? v.slice(0, 200) : v; });
  const sets = keys.map(k => `${k} = ?`);
  // 进入「处理中」类状态时记下起点，轮询退避按它算；已经在处理中的不重置（右边的 status 是更新前的值）
  if (typeof f.status === 'string' && IN_FLIGHT.includes(f.status)) {
    sets.push(`poll_started_at = CASE WHEN status IN (${IN_FLIGHT.map(() => '?').join(',')}) AND poll_started_at IS NOT NULL THEN poll_started_at ELSE ? END`);
    args.push(...IN_FLIGHT, now());
  }
  await q.run(`UPDATE redemptions SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...args, now(), id]);
}
const setCode = async (id: string, f: Record<string, unknown>) => {
  const keys = Object.keys(f);
  await q.run(`UPDATE codes SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => f[k] as any ?? null), id]);
};
async function attempt(ip: string, device: string, codeHash: string | null, ok: boolean, reason: string) {
  await q.run('INSERT INTO attempts(ip, device, code_hash, ok, reason, at) VALUES (?, ?, ?, ?, ?, ?)', [ip, device, codeHash, ok ? 1 : 0, reason, now()]);
}
const userErr = (msg: string, code = 'REDEEM_ERROR', extra?: Record<string, unknown>) => new HttpError(400, msg, code, extra);

/** 把卡台错误翻译成用户能看懂的话 */
function explain(e: unknown, fallback = '暂时无法处理，请稍后再试'): string {
  if (!(e instanceof AvanError)) return fallback;
  if (e.status === 429) return '当前兑换人数较多，请稍等一分钟再试。';
  if (e.uncertain) return '卡台暂时没有响应，请稍后刷新查看结果，不要重复兑换。';
  if (e.code === 'NOT_CONFIGURED') return '系统尚未配置完成，请联系卖家。';
  return e.message || fallback;
}

/* ==================================================================
   卡台码：托管码直接用；自有码在兑换时临时向卡台生成
   ================================================================== */
async function upstreamCodeFor(code: CodeRow, red: Red, forceNew = false): Promise<{ id: string; code: string }> {
  if (code.mode === 'hosted') {
    const c = decryptOpt(code.code_enc);
    if (!c) throw userErr('这个兑换码缺少卡台凭证，请联系卖家。');
    return { id: code.upstream_id || code.id, code: c };
  }
  if (!forceNew) {
    // 优先用这次兑换当前绑定的卡台码（已提交付款的也要用它查询进度）；失败 / 撤销的才换
    const cur = red.upstream_code_id && await q.get<any>("SELECT * FROM upstream_codes WHERE id = ? AND status NOT IN ('failed','revoked')", [red.upstream_code_id]);
    const reuse = cur || await q.get<any>("SELECT * FROM upstream_codes WHERE code_id = ? AND status IN ('issued','released') ORDER BY created_at DESC LIMIT 1", [code.id]);
    if (reuse) { await upd(red.id, { upstream_code_id: reuse.id }); return { id: reuse.id, code: decryptOpt(reuse.code_enc)! }; }
  }
  const batch = (await q.get<{ params: string }>('SELECT params FROM batches WHERE id = ?', [code.batch_id]))!;
  const params = parse<BatchParams>(batch.params, {});
  const n = (await q.get<{ n: number }>('SELECT COUNT(*) n FROM upstream_codes WHERE code_id = ?', [code.id]))!.n;
  const idem = `up-${code.id}-${n + 1}`;
  let id: string, full: string | null;
  if (code.product === 'gpt') {
    const r = await avan.gptGenerate({ plan: code.plan, quantity: 1, forceNewCard: !!params.forceNewCard, ...(await cdkRegionArg(params.country)) }, idem);
    id = r.items[0].cdkId; full = r.items[0].code;
  } else {
    if (!params.social) throw userErr('兑换码配置不完整，请联系卖家。');
    const r = await avan.socialGenerate(code.product, { plan: code.plan, quantity: 1, ...params.social, autoCard: autoCard() }, idem);
    id = r.list[0].id; full = r.list[0].code || null;
    if (!full) full = (await avan.socialExport(code.product, id)).code;
  }
  if (!full) throw userErr('卡台没有返回兑换凭证，请稍后再试。');
  await q.insertIgnore('INSERT INTO upstream_codes(id, code_id, product, plan, code_enc, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, code.id, code.product, code.plan, encrypt(full), 'issued', now()]);
  await upd(red.id, { upstream_code_id: id });
  return { id, code: full };
}
const markUpstream = async (id: string | null, status: string) => id && await q.run('UPDATE upstream_codes SET status = ? WHERE id = ?', [status, id]);

/* ==================================================================
   ① 输入兑换码
   ================================================================== */
export interface Ctx { ip: string; device: string; country: string | null; captchaToken?: string }

export async function start(rawCode: string, ctx: Ctx) {
  const page = getSetting('redeemPage');
  if (page.maintenance) throw userErr(page.maintenanceMsg || '系统维护中，请稍后再来。', 'MAINTENANCE');
  const codeStr = normalizeCode(rawCode);
  if (codeStr.length < 8 || codeStr.length > 64) throw userErr('兑换码格式不对，请检查是否完整。', 'INVALID_CODE');
  const h = lookupHash(codeStr);
  const code = await q.get<CodeRow>('SELECT * FROM codes WHERE code_hash = ?', [h]);
  if (!code) {
    await attempt(ctx.ip, ctx.device, h, false, 'invalid');
    const failed = (await q.get<{ n: number }>('SELECT COUNT(*) n FROM attempts WHERE ip = ? AND ok = 0 AND at > ?', [ctx.ip, new Date(Date.now() - 3600e3).toISOString()]))!.n;
    if (failed > 30) throw userErr('尝试次数过多，请一小时后再试。', 'RATE_LIMITED');
    throw userErr('兑换码无效，请检查是否输错（容易混淆的字符：0/O、1/I）。', 'INVALID_CODE');
  }
  if (!page.products[code.product]) throw userErr('这个产品暂停兑换，请稍后再来。', 'PRODUCT_CLOSED');
  if (code.status === 'revoked') { await attempt(ctx.ip, ctx.device, h, false, 'revoked'); throw userErr('这个兑换码已被卖家撤销，请联系卖家。', 'REVOKED'); }
  if (code.status === 'redeemed') {
    await attempt(ctx.ip, ctx.device, h, true, 'redeemed');
    throw userErr('这个兑换码已经使用过。如果是你本人兑换的，可以去「查询凭证」查看结果。', 'ALREADY_REDEEMED');
  }

  // 继续同一设备上未完成的兑换
  const cur = code.redemption_id ? await getRed(code.redemption_id) : undefined;
  // 被兑换门槛拦截的记录不恢复：每次输码都要重新检查门槛（例如时段到了就应该能兑）
  const gateBlocked = cur?.status === 'blocked' && cur.stage === 'gate';
  if (cur && OPEN.includes(cur.status) && !gateBlocked) {
    if (cur.browser_device === ctx.device) return view(cur);
    const stale = ['started', 'quoted', 'blocked'].includes(cur.status) && Date.now() - new Date(cur.updated_at).getTime() > STALE_MIN * 60e3;
    if (!stale && code.status === 'in_use') throw userErr('这个兑换码正在另一台设备上兑换。如果是你本人，请回到原来的设备继续。', 'IN_USE_ELSEWHERE');
    if (stale) await upd(cur.id, { status: 'expired' });
  }

  const s = await getStrategy(code.strategy_id);
  const g = await checkGates(s, { ip: ctx.ip, device: ctx.device, country: ctx.country, codeCreatedAt: code.created_at, codeExpiresAt: code.expires_at });
  if (!g.ok && g.action === 'captcha') {
    if (page.turnstileSecretEnc) {
      if (!ctx.captchaToken) throw userErr('请先完成人机验证。', 'CAPTCHA_REQUIRED', { siteKey: page.turnstileSiteKey });
      if (!(await verifyTurnstile(decryptOpt(page.turnstileSecretEnc)!, ctx.captchaToken, ctx.ip))) throw userErr('人机验证失败，请重试。', 'CAPTCHA_REQUIRED', { siteKey: page.turnstileSiteKey });
    } // 未配置 Turnstile 时只依赖 IP 频率限制
  } else if (!g.ok) {
    await attempt(ctx.ip, ctx.device, h, true, 'blocked');
    await newRedemption(code, s, ctx, cur, { status: 'blocked', stage: 'gate', rule: g.rule, error_msg: g.userMsg });
    throw userErr(g.userMsg!, 'BLOCKED');
  }
  await attempt(ctx.ip, ctx.device, h, true, 'ok');

  const red = await newRedemption(code, s, ctx, cur, { status: 'started', stage: 'code' });
  // 原子占码：只有码的状态还和开头读到的一样才占用。上面有 await（人机验证），两台设备同时输同一个码时只有一台能拿到
  // redemption_id 可能是 NULL：= NULL 永远不成立，要分开写（IS ? 只有 SQLite 支持）
  const claimed = (code.redemption_id == null
    ? await q.run("UPDATE codes SET status = 'in_use', redemption_id = ? WHERE id = ? AND status = ? AND redemption_id IS NULL", [red.id, code.id, code.status])
    : await q.run("UPDATE codes SET status = 'in_use', redemption_id = ? WHERE id = ? AND status = ? AND redemption_id = ?", [red.id, code.id, code.status, code.redemption_id])).changes;
  if (!claimed) {
    await q.run('DELETE FROM redemptions WHERE id = ?', [red.id]);
    throw userErr('这个兑换码正在另一台设备上兑换。如果是你本人，请回到原来的设备继续。', 'IN_USE_ELSEWHERE');
  }

  // 校验卡台侧状态（只读，不扣款）
  try {
    if (code.product === 'gpt') {
      // 直充不需要卡台码，输码阶段只在本地检查
      if (!await isDirect(code)) {
        const up = await upstreamCodeFor(code, red);
        const v = normalizeGptPublic(await avan.gptPublic('preview', { code: up.code }, red.device));
        await upd(red.id, { redemption_token_enc: v.redemptionToken ? encrypt(v.redemptionToken) : null });
      }
    } else {
      const up = await upstreamCodeFor(code, red);
      const d = await avan.socialPublic(code.product, 'preview', { code: up.code, deviceToken: red.device });
      const resumed = await applySocialStatus((await getRed(red.id))!, d, true);
      if (resumed) return view((await getRed(red.id))!);
    }
  } catch (e) {
    if (e instanceof AvanError && e.status === 409 && /CONSUMED|USED/i.test(e.code || e.message)) {
      await setCode(code.id, { status: 'redeemed', upstream_status: 'consumed' });
      await upd(red.id, { status: 'failed', error_msg: '这个兑换码已经被使用。' });
      throw userErr('这个兑换码已经使用过。', 'ALREADY_REDEEMED');
    }
    await setCode(code.id, { status: 'unused' });
    await upd(red.id, { status: 'failed', error_code: e instanceof AvanError ? e.code || String(e.status) : 'ERROR', error_msg: explain(e) });
    throw e instanceof HttpError ? e : userErr(explain(e), 'UPSTREAM');
  }
  return view((await getRed(red.id))!);
}

async function newRedemption(code: CodeRow, s: Strategy, ctx: Ctx, prev: Red | undefined, f: Partial<Red>): Promise<Red> {
  // X/TG 卡台码会永久绑定 deviceToken，同一张码必须沿用之前的设备标识
  const lastDev = prev?.device || (await q.get<{ device: string }>('SELECT device FROM redemptions WHERE code_id = ? ORDER BY created_at DESC LIMIT 1', [code.id]))?.device;
  const device = lastDev || (code.product === 'gpt' ? uuid() : hex(32));
  const id = 'r_' + hex(10);
  await q.run(`INSERT INTO redemptions(id, code_id, product, plan, strategy_id, status, stage, ip, browser_device, country, device, upstream_code_id, client_request_id, rule, error_msg, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, code.id, code.product, code.plan, s.id, f.status!, f.stage ?? null, ctx.ip, ctx.device, ctx.country, device, prev?.upstream_code_id ?? null, prev?.client_request_id ?? null, f.rule ?? null, f.error_msg ?? null, now(), now()]);
  if (f.status === 'blocked') await setCode(code.id, { redemption_id: id });
  return (await getRed(id))!;
}

/* ==================================================================
   ② 填写账号 / 接收方
   ================================================================== */
/** 从 ChatGPT session JSON 中提取账号标识（只用于计数和展示，不落库原文） */
export function parseGptSession(raw: string): { userId?: string; email?: string; masked: string } {
  let s: any;
  try { s = JSON.parse(raw); } catch { throw userErr('Session 内容不完整，请复制页面上的全部内容。', 'SESSION_INVALID'); }
  if (!s || typeof s !== 'object' || (!s.accessToken && !s.sessionToken && !s.user)) throw userErr('这看起来不是 ChatGPT 的 Session，请按步骤重新复制。', 'SESSION_INVALID');
  const email: string | undefined = s.user?.email || s.email;
  return { userId: s.user?.id, email, masked: email ? maskEmail(email) : '未知账号' };
}
export const maskEmail = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '***' + c);

export async function submitAccount(rid: string, device: string, p: { session?: string; recipient?: string }) {
  return locked(rid, async () => {
    const red = await mine(rid, device);
    const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
    const s = await getStrategy(red.strategy_id);
    const reAccountable = ['started', 'quoted', 'approved'].includes(red.status) || (red.status === 'blocked' && red.stage !== 'gate') || (red.status === 'failed' && code.status === 'unused');
    if (!reAccountable) throw userErr('当前状态不能修改账号。', 'BAD_STATE');
    if (code.status === 'revoked') throw userErr('这个兑换码已被卖家撤销。', 'REVOKED');
    // 码已被别的兑换占用（例如这次失败释放后，另一台设备又开始兑换）就不能再抢回来
    const claimed = (await q.run("UPDATE codes SET status = 'in_use', redemption_id = ? WHERE id = ? AND (status = 'unused' OR redemption_id = ?) AND status != 'revoked'", [red.id, code.id, red.id])).changes;
    if (!claimed) throw userErr('这个兑换码正在另一台设备上兑换。如果是你本人，请回到原来的设备继续。', 'IN_USE_ELSEWHERE');
    if (red.status === 'blocked' || red.status === 'failed') await archive(red);
    const approved = red.status === 'approved';
    return red.product === 'gpt' ? await gptAccount(red, code, s, p.session || '', approved) : await socialAccount(red, code, s, p.recipient || '', approved);
  });
}

async function gptAccount(red: Red, code: CodeRow, s: Strategy, session: string, approved: boolean) {
  const sess = parseGptSession(session.trim());
  const acc: AccountInfo = { key: lookupHash('gpt:' + (sess.userId || sess.email || '')), display: sess.masked, email: sess.email };
  if (!sess.userId && !sess.email) acc.key = null;

  // 账号次数先在本地判断，不浪费卡台预检
  const pre = await checkAccount(s, 'gpt', acc, red.id);
  if (!pre.ok) return block(red, code, 'account', pre.rule!, pre.userMsg!, acc);
  if (await isDirect(code)) return directAccount(red, code, s, session, acc, approved);

  let v: GptPublicView;
  try {
    const up = await upstreamCodeFor(code, red);
    const pv = normalizeGptPublic(await avan.gptPublic('preview', { code: up.code }, red.device));
    if (!pv.redemptionToken) throw userErr('兑换码校验失败，请稍后再试。');
    v = normalizeGptPublic(await avan.gptPublic('preflight', { redemptionToken: pv.redemptionToken, credential: { mode: 'session', session } }, red.device));
    if (!v.preflightToken) throw userErr('账号检查失败，请确认 Session 是否完整。', 'SESSION_INVALID');
    v.redemptionToken = pv.redemptionToken;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = e instanceof AvanError && e.status === 422 ? `账号检查没通过：${e.message}` : explain(e);
    await upd(red.id, { error_code: e instanceof AvanError ? e.code ?? String(e.status) : null, error_msg: msg });
    throw userErr(msg, 'PREFLIGHT_FAILED');
  }
  acc.currentPlan = v.currentPlan;
  if (v.email) acc.display = v.email;

  const full = await checkAccount(s, 'gpt', acc, red.id);
  if (!full.ok) return block(red, code, 'account', full.rule!, full.userMsg!, acc);

  const batch = (await q.get<{ cost_usd: string | null }>('SELECT cost_usd FROM batches WHERE id = ?', [code.batch_id]))!;
  const cur = await gptSalePrice(code.plan);
  const price = approved ? { ok: true } as const : checkPrice(s, batch.cost_usd ? Number(batch.cost_usd) : null, cur);
  putSession(red.id, session, price.ok ? STALE_MIN : 180);
  const common = {
    account: acc.display, account_key: acc.key, redemption_token_enc: encrypt(v.redemptionToken!), preflight_token_enc: encrypt(v.preflightToken!),
    quote: json({ ...v.quote, currentPlan: v.currentPlan, salePrice: cur, expiresAt: v.preflightExpiresAt || new Date(Date.now() + 10 * 60e3).toISOString() }),
    error_code: null, error_msg: null,
  };
  if (!price.ok && price.action === 'manual') {
    await upd(red.id, { ...common, status: 'manual_review', stage: 'price', review: 'pending', rule: price.rule, error_msg: price.userMsg });
    return view((await getRed(red.id))!);
  }
  if (!price.ok) return block(red, code, 'price', price.rule!, price.userMsg!, acc);
  await upd(red.id, { ...common, status: 'quoted', stage: 'quoted', rule: null });
  if (approved) return confirmGpt((await getRed(red.id))!, code);
  return view((await getRed(red.id))!);
}

/* ==================================================================
   GPT 直充：预检 → 资金护栏 → 卡台自动直充（选卡、注资、换卡重试都由卡台完成）
   ================================================================== */

async function directAccount(red: Red, code: CodeRow, s: Strategy, session: string, acc: AccountInfo, approved: boolean) {
  const params = await paramsOf(code);
  let pf, plans;
  try {
    // 目录直接取最新的：下单要原样回传 pricingVersion 和服务费，缓存里的旧版本会被卡台拒绝
    plans = await avan.gptPlans();
    const region = params.country ? plans.checkoutCountries?.find(r => r.country === params.country) : undefined;
    pf = await avan.gptPreflight({ session, paymentCountry: params.country || undefined, paymentCurrency: region?.currency });
  } catch (e) {
    const msg = e instanceof AvanError && e.status === 422 ? `账号检查没通过：${e.message}` : explain(e);
    await upd(red.id, { error_code: e instanceof AvanError ? e.code ?? String(e.status) : null, error_msg: msg });
    throw userErr(msg, 'PREFLIGHT_FAILED');
  }
  acc.currentPlan = pf.currentPlan;
  if (pf.email) acc.display = pf.email;
  const full = await checkAccount(s, 'gpt', acc, red.id);
  if (!full.ok) return block(red, code, 'account', full.rule!, full.userMsg!, acc);

  const plan = plans.plans?.find(p => p.key === code.plan);
  const usd = pf.quoteEstimatesUsd?.[code.plan];
  // 金额要原样回传给卡台，也决定额度预算：格式不对就拒绝，不能把异常值当成 0 继续付款
  const malformed = !Number.isInteger(plans.version) || plans.version < 1 || !DECIMAL.test(String(plan?.customerServiceFee ?? '')) || !DECIMAL.test(String(usd ?? ''));
  if (!plan?.enabled || malformed || !(Number(usd) > 0)) {
    if (plan?.enabled && usd && malformed) console.warn('[direct] 卡台报价数据格式异常', { version: plans.version, fee: plan?.customerServiceFee, usd });
    const msg = pf.quoteError ? `暂时拿不到官方报价：${pf.quoteError}` : '这个套餐暂时无法开通，请稍后再试。';
    await upd(red.id, { error_code: malformed && usd ? 'BAD_QUOTE' : 'NO_QUOTE', error_msg: msg });
    throw userErr(msg, 'PREFLIGHT_FAILED');
  }
  // 当前成本 = 官方金额的美元估算 + 服务费（按分计算），和批次生成时的成本快照比较（价格保护）
  const cur = (toCents(usd!) + toCents(plan.customerServiceFee)) / 100;
  const batch = (await q.get<{ cost_usd: string | null }>('SELECT cost_usd FROM batches WHERE id = ?', [code.batch_id]))!;
  // 批次成本快照不是直充口径（目录不是美元时退回了 CDK 售价）就不比较，避免两种口径互相比
  const base = params.costBasis === 'direct' && batch.cost_usd ? Number(batch.cost_usd) : null;
  const price = approved ? { ok: true } as const : checkPrice(s, base, cur);
  putSession(red.id, session, price.ok ? STALE_MIN : 180);
  const qt = pf.quotes?.[code.plan];
  const common = {
    account: acc.display, account_key: acc.key, redemption_token_enc: null, preflight_token_enc: null,
    quote: json({
      country: pf.paymentCountry, currency: pf.paymentCurrency, amountMinor: qt?.amountMinor, amountMajor: qt?.amountMajor, currentPlan: pf.currentPlan,
      usd, fee: plan.customerServiceFee, version: plans.version, salePrice: cur, expiresAt: pf.preflightExpiresAt || new Date(Date.now() + 10 * 60e3).toISOString(),
    }),
    error_code: null, error_msg: null,
  };
  if (!price.ok && price.action === 'manual') {
    await upd(red.id, { ...common, status: 'manual_review', stage: 'price', review: 'pending', rule: price.rule, error_msg: price.userMsg });
    return view((await getRed(red.id))!);
  }
  if (!price.ok) return block(red, code, 'price', price.rule!, price.userMsg!, acc);
  await upd(red.id, { ...common, status: 'quoted', stage: 'quoted', rule: null });
  if (approved) return confirmDirect((await getRed(red.id))!, code);
  return view((await getRed(red.id))!);
}

/** 被资金护栏拦下：转人工，码不消耗；Session 多留一段时间，方便卖家通过后直接继续 */
async function holdForGuard(red: Red, rule: string, userMsg = direct.HOLD_MSG) {
  const sess = getSession(red.id);
  if (sess) putSession(red.id, sess, 180);
  await upd(red.id, { status: 'manual_review', stage: 'guard', review: 'pending', rule: `资金护栏 · ${rule}`, error_msg: userMsg, next_poll_at: null });
}

async function confirmDirect(red: Red, code: CodeRow) {
  const qt = parse<any>(red.quote, {});
  if (qt.expiresAt && qt.expiresAt < now()) {
    await upd(red.id, { status: 'started', stage: 'code', error_msg: '报价已过期，请重新检查账号。' });
    throw userErr('报价已过期，请重新检查账号。', 'QUOTE_EXPIRED');
  }
  const session = getSession(red.id);
  if (!session) {
    await upd(red.id, { status: 'started', stage: 'code', error_msg: '登录信息已过期，请重新粘贴 Session。' });
    throw userErr('登录信息已过期，请重新粘贴 Session。', 'SESSION_EXPIRED');
  }
  const params = await paramsOf(code);
  // 名额复查、额度预留、改成「处理中」在同一个事务里：并发的确认请求不会穿插进来
  const r = await tx(async () => {
    if (await accountTaken(red, code)) return 'taken' as const;
    const n = (await q.get<{ n: number }>('SELECT COUNT(*) n FROM direct_spend WHERE redemption_id = ?', [red.id]))!.n;
    const idem = `ao-${red.id}-${n + 1}`;
    const g = await direct.reserve({ redemptionId: red.id, codeId: code.id, accountKey: red.account_key, idemKey: idem, plan: code.plan, estimateUsd: Number(qt.salePrice) || 0 });
    if (!g.ok) { await holdForGuard(red, g.rule, g.userMsg); return 'held' as const; }
    // 请求体里会变的部分在这里快照：结果未知时必须用同一个幂等键和完全相同的请求体重放
    const snap = { maxUsd: g.maxUsd, forceNewCard: !!params.forceNewCard, productCode: getSetting('payment').productCode || undefined };
    await upd(red.id, { client_request_id: idem, direct_task_id: null, quote: json({ ...qt, direct: snap }), status: 'processing', stage: 'submitting', next_poll_at: new Date(Date.now() + 5000).toISOString() });
    return 'go' as const;
  });
  if (r !== 'go') return view((await getRed(red.id))!);
  return submitDirect((await getRed(red.id))!, code, session);
}

function autoBody(red: Red, code: CodeRow, session: string): GptAutoInput {
  const qt = parse<any>(red.quote, {});
  return {
    credential: { mode: 'session', session }, plan: code.plan, paymentCountry: qt.country, paymentCurrency: qt.currency,
    expectedAmountUsd: String(qt.usd), expectedCustomerServiceFee: String(qt.fee), pricingVersion: Number(qt.version), maxTotalDebitUsd: qt.direct.maxUsd,
    forceNewCard: qt.direct.forceNewCard, ...(qt.direct.productCode && { productCode: qt.direct.productCode }),
  };
}

/**
 * 提交（或原样重放）一次自动直充。三种结果分开处理：
 *   - 卡台明确拒绝（4xx，带错误码）：没有受理，释放这次的额度预留
 *   - 结果未知（网络中断、超时、5xx、响应读不完 / 解析不了、本地异常）：保留预留和幂等键，之后用原键原样重放
 *   - 已受理（拿到任务 ID）：之后只查这个任务；本地后续处理出错也不会回到「重新下单」
 */
async function submitDirect(red: Red, code: CodeRow, session: string) {
  const idem = red.client_request_id!;
  let t: GptAutoTask | undefined;
  try {
    t = await avan.gptAutoOrder(autoBody(red, code, session), idem);
  } catch (e) {
    if (!(e instanceof AvanError) || e.uncertain) {
      if (!(e instanceof AvanError)) console.warn('[direct] 下单时本地异常，按结果未知处理', red.id, e instanceof Error ? e.message : e);
      await upd(red.id, { status: 'processing', stage: 'uncertain', next_poll_at: new Date(Date.now() + 5000).toISOString() });
      return view((await getRed(red.id))!);
    }
    await direct.settle(idem, 'cancelled', 0);
    const ec = e.code || '';
    if (/BALANCE_INSUFFICIENT|INSUFFICIENT_BALANCE/.test(ec)) {
      void direct.alertInsufficient(e.message);
      await holdForGuard(red, `卡台可用余额不足（${ec}）`);
      return view((await getRed(red.id))!);
    }
    if (/PRICE_CHANGED|PREFLIGHT_REQUIRED|QUOTE_(CHANGED|EXPIRED)/.test(ec)) {
      await upd(red.id, { status: 'started', stage: 'code', error_msg: '官方报价已更新，请重新检查账号。' });
      throw userErr('官方报价已更新，请重新检查账号。', 'QUOTE_EXPIRED');
    }
    await upd(red.id, { status: 'quoted', stage: 'quoted', next_poll_at: null, error_code: ec || String(e.status), error_msg: explain(e) });
    throw userErr(explain(e), 'REDEEM_FAILED');
  }
  // 成功状态但拿不到任务 ID：卡台可能已经受理，按结果未知处理
  if (!t || typeof t.id !== 'string' || !t.id) {
    console.warn('[direct] 下单响应缺少任务 ID，按结果未知处理', red.id);
    await upd(red.id, { status: 'processing', stage: 'uncertain', next_poll_at: new Date(Date.now() + 5000).toISOString() });
    return view((await getRed(red.id))!);
  }
  await direct.attachTask(idem, t.id);
  await upd(red.id, { direct_task_id: t.id, stage: 'submitted' });
  try { await applyDirect((await getRed(red.id))!, t); }
  catch (e) {
    // 已受理：后续处理失败只是晚点再查同一个任务，绝不重新下单
    console.warn('[direct] 已受理，处理任务状态时出错，稍后重新查询', red.id, e instanceof Error ? e.message : e);
    await upd(red.id, { next_poll_at: new Date(Date.now() + 5000).toISOString() });
  }
  return view((await getRed(red.id))!);
}

/** 自动直充任务状态 → 兑换状态 */
async function applyDirect(red: Red, t: GptAutoTask) {
  if (!Array.isArray(t.attempts)) t.attempts = []; // 卡台返回结构异常时不让后面崩掉
  const last = t.attempts[t.attempts.length - 1];
  const f: Partial<Red> = { progress: json(direct.taskProgress(t)), card_last4: last?.cardLastFour ?? red.card_last4, order_id: last?.orderId ?? red.order_id };
  const idem = red.client_request_id!;
  const order = f.order_id && ['completed', 'requires_action'].includes(t.status) ? await avan.gptOrder(f.order_id).then(r => r.order, () => null) : null;
  if (t.status === 'completed') {
    const qt = parse<any>(red.quote, {});
    // 汇总所有尝试的费用；明细还没结清时先按已知金额记、标记待核对，后台对账会补齐（期间额度按预算计）
    const c = await direct.taskCost(t, Number(qt.usd) || 0);
    await direct.settle(idem, 'spent', c.usd, { verified: c.verified, note: c.note ?? undefined });
    if (order?.invoiceUrls?.length) f.invoice_urls = json(order.invoiceUrls);
    // 自动取消续费取决于卡台 API Key 的设置：以订单实际返回为准，拿不到就是 null（完成页显示「待确认」，对账时补上）
    return complete(red, { ...f, cost_usd: (c.usd > 0 ? c.usd : Number(qt.salePrice) || 0).toFixed(4), quote: json({ ...qt, willRenew: c.willRenew }) });
  }
  if (t.status === 'failed') {
    // 失败也可能花了钱（开卡费等）：按费用明细核对；核对不了先按预算计入额度
    const c = await direct.taskCost(t, 0);
    await direct.settle(idem, 'released', c.usd, { verified: c.verified, note: c.note ?? undefined });
    // 错误码只记在后台（error_code），不给买家看
    await upd(red.id, { ...f, error_code: t.failureCode ?? null });
    return afterFailure((await getRed(red.id))!, '这次没有开通成功');
  }
  if (t.status === 'requires_action') {
    // 只有「补交 Session」用户自己能处理；其他情况（核对原付款等）需要卖家到卡台处理
    const needSession = order?.nextAction === 'submit_session';
    await upd(red.id, {
      // 继续慢速查询：卖家在卡台处理好、或买家补交 Session 后，这里能自动跟上
      ...f, status: 'requires_action', stage: needSession ? 'submit_session' : 'seller_action', next_poll_at: new Date(Date.now() + DIRECT_SLOW_POLL).toISOString(),
      error_msg: needSession ? order?.recoveryMessage || 'ChatGPT 登录状态已过期，请重新粘贴 Session 继续。' : '需要卖家处理，请联系卖家。兑换码不会作废。',
    });
    return;
  }
  await upd(red.id, { ...f, status: 'processing', stage: last?.status || t.status, next_poll_at: nextPoll(red) });
}

/** 轮询直充：有任务 ID 查任务；没有（下单时结果未知）就用原幂等键重放 */
async function pollDirect(red: Red, code: CodeRow) {
  if (red.direct_task_id) return applyDirect(red, await avan.gptAutoTask(red.direct_task_id));
  if (!red.client_request_id) return;
  const session = getSession(red.id);
  if (!session) {
    // 没有 Session 就无法原样重放；不能换键重下，交给卖家到卡台核对
    await upd(red.id, { status: 'requires_action', stage: 'seller_action', next_poll_at: null, error_msg: '开通结果需要卖家核对，请联系卖家。兑换码不会作废。', rule: `直充下单结果未知，幂等键 ${red.client_request_id}，请到卡台核对` });
    return;
  }
  await submitDirect(red, code, session);
}

async function socialAccount(red: Red, code: CodeRow, s: Strategy, recipientRaw: string, approved: boolean) {
  const recipient = recipientRaw.trim().replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{3,32}$/.test(recipient)) throw userErr('用户名格式不对，只能包含字母、数字和下划线。', 'BAD_RECIPIENT');
  const acc: AccountInfo = { key: lookupHash(`${red.product}:${recipient.toLowerCase()}`), display: '@' + recipient };
  // 卡台预检会把码绑定到接收方，所以账号规则必须在预检之前判断
  const chk = await checkAccount(s, red.product, acc, red.id);
  if (!chk.ok) return block(red, code, 'account', chk.rule!, chk.userMsg!, acc);

  const kind = red.product as SocialKind;
  let up = await upstreamCodeFor(code, red);
  // 已绑定到其他接收方：卡台允许时换新请求 ID 重绑；自有码不允许时换一张新的卡台码
  let crid = red.client_request_id && red.account === acc.display ? red.client_request_id : uuid();
  let d: SocialPublicData;
  try {
    d = await avan.socialPublic(kind, 'preflight', { code: up.code, deviceToken: red.device, clientRequestId: crid, recipient });
    if (d.recipient && d.recipient.toLowerCase() !== recipient.toLowerCase() && !d.canRetryPreflight) {
      if (code.mode !== 'own') throw userErr(`这个兑换码已经绑定到 @${d.recipient}，不能更换接收方。`, 'BOUND');
      await markUpstream(up.id, 'failed');
      await avan.socialRevoke(kind, up.id, 'rv-' + up.id).catch(() => {});
      up = await upstreamCodeFor(code, red, true);
      crid = uuid();
      d = await avan.socialPublic(kind, 'preflight', { code: up.code, deviceToken: red.device, clientRequestId: crid, recipient });
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw userErr(explain(e), 'PREFLIGHT_FAILED');
  }
  await upd(red.id, { account: acc.display, account_key: acc.key, client_request_id: crid, error_code: d.errorCode ?? null });
  if (d.status === 'ineligible') {
    return block(red, code, 'account', `卡台判定不符合资格：${d.message || d.errorCode}`, d.message || '这个账号暂时不能接收会员（可能已经是会员），请更换账号。', acc);
  }
  if (d.status === 'failed_precharge' || d.status === 'review_required') {
    await upd(red.id, { status: d.status === 'review_required' ? 'requires_action' : 'failed', stage: 'preflight', error_msg: d.message || '暂时无法为这个账号开通，请联系卖家。', rule: d.errorCode });
    if (d.status === 'failed_precharge') await setCode(code.id, { status: 'unused' });
    return view((await getRed(red.id))!);
  }
  if (d.status !== 'prepared') { await applySocialStatus((await getRed(red.id))!, d); return view((await getRed(red.id))!); }
  await upd(red.id, { status: 'quoted', stage: 'quoted', rule: null, error_msg: null, quote: json({ amountMinor: d.amountMinor, currency: d.currency, expiresAt: new Date(Date.now() + 30 * 60e3).toISOString() }) });
  if (approved) return confirmSocial((await getRed(red.id))!, code);
  return view((await getRed(red.id))!);
}

/** 用户换账号重试前，把这次被拦截 / 失败的结果另存一条，方便后台查看拦截历史 */
async function archive(red: Red) {
  const row: Record<string, any> = { ...(await getRed(red.id))!, id: 'r_' + hex(10), next_poll_at: null, redemption_token_enc: null, preflight_token_enc: null };
  const keys = Object.keys(row);
  await q.run(`INSERT INTO redemptions(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k] ?? null));
  await upd(red.id, { status: 'started', rule: null, error_msg: null, error_code: null, attempts: 1 });
}

async function block(red: Red, code: CodeRow, stage: string, rule: string, userMsg: string, acc?: AccountInfo) {
  await upd(red.id, { status: 'blocked', stage, rule, error_msg: userMsg, account: acc?.display ?? red.account, account_key: acc?.key ?? red.account_key });
  await setCode(code.id, { status: 'unused' });   // 被拦截不消耗兑换码
  return view((await getRed(red.id))!);
}

/* ==================================================================
   ③ 确认
   ================================================================== */
export async function confirm(rid: string, device: string) {
  return locked(rid, async () => {
    const red = await mine(rid, device);
    const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
    if (red.product === 'gpt') {
      if (red.status !== 'quoted') return view(red);
      return await isDirect(code) ? await confirmDirect(red, code) : await confirmGpt(red, code);
    }
    if (red.status === 'quoted' || red.status === 'funded') return confirmSocial(red, code);
    return view(red);
  });
}

/**
 * 付款前复查账号名额。预检阶段不占名额（同一账号可以用几张码各自完成预检），真正占名额的是这一步：
 * 复查和把状态改成「处理中」之间不能有 await，单进程里并发的确认请求就不会同时通过。
 * 返回拦截后的视图；名额还在返回 null
 */
/** 账号名额已经被别的兑换占了：拦下这一条（码不消耗），返回 true。调用方负责放在事务里 */
async function accountTaken(red: Red, code: CodeRow) {
  if (!red.account_key) return false;
  const v = await checkAccount(await getStrategy(red.strategy_id), red.product, { key: red.account_key, display: red.account || '', currentPlan: parse<any>(red.quote, {}).currentPlan }, red.id);
  if (v.ok) return false;
  await block(red, code, 'account', v.rule!, v.userMsg!);
  return true;
}
/** 复查名额并立即把状态改成 mark（同一个事务）：返回拦截后的视图；名额还在返回 null */
async function claimAccount(red: Red, code: CodeRow, mark: Partial<Record<keyof Red, unknown>>) {
  const taken = await tx(async () => {
    if (await accountTaken(red, code)) return true;
    await upd(red.id, mark);
    return false;
  });
  return taken ? view((await getRed(red.id))!) : null;
}

async function confirmGpt(red: Red, code: CodeRow) {
  const quote = parse<any>(red.quote, {});
  if (quote.expiresAt && quote.expiresAt < now()) {
    await upd(red.id, { status: 'started', stage: 'code', error_msg: '报价已过期，请重新检查账号。' });
    throw userErr('报价已过期，请重新检查账号。', 'QUOTE_EXPIRED');
  }
  const crid = red.client_request_id && red.status === 'processing' ? red.client_request_id : uuid();
  // 先进入「处理中」再调卡台：既占住账号名额，也让并发的确认看到它（复查和改状态在同一个事务里）
  const taken = await claimAccount(red, code, { client_request_id: crid, status: 'processing', stage: 'submitting', next_poll_at: new Date(Date.now() + 10_000).toISOString() });
  if (taken) return taken;
  try {
    const d = await avan.gptPublic('redeem', { redemptionToken: decryptOpt(red.redemption_token_enc), preflightToken: decryptOpt(red.preflight_token_enc), clientRequestId: crid }, red.device);
    await markUpstream(red.upstream_code_id, 'used');
    await upd(red.id, { status: 'processing', stage: 'submitted', next_poll_at: new Date(Date.now() + 2000).toISOString(), preflight_token_enc: null });
    await applyGpt((await getRed(red.id))!, normalizeGptPublic(d));
  } catch (e) {
    if (e instanceof AvanError && e.code === 'PREFLIGHT_REQUIRED') {
      await upd(red.id, { status: 'started', stage: 'code', error_msg: '报价已失效，请重新检查账号。' });
      throw userErr('报价已失效，请重新检查账号。', 'QUOTE_EXPIRED');
    }
    if (e instanceof AvanError && e.uncertain) {
      // 结果未知：保留 clientRequestId，转入轮询，绝不换标识重下
      await upd(red.id, { status: 'processing', stage: 'uncertain', next_poll_at: new Date(Date.now() + 5000).toISOString() });
      return view((await getRed(red.id))!);
    }
    // 卡台明确拒绝：没有提交，回到待确认
    await upd(red.id, { status: 'quoted', stage: 'quoted', next_poll_at: null, error_code: e instanceof AvanError ? e.code ?? String(e.status) : null, error_msg: explain(e) });
    throw userErr(explain(e), 'REDEEM_FAILED');
  }
  return view((await getRed(red.id))!);
}

async function confirmSocial(red: Red, code: CodeRow) {
  const q0 = parse<any>(red.quote, {});
  const firstStage = red.status === 'quoted';
  if (firstStage) {
    const taken = await claimAccount(red, code, { status: 'funding', stage: 'submitting', next_poll_at: new Date(Date.now() + 10_000).toISOString() });
    if (taken) return taken;
  }
  const up = await upstreamCodeFor(code, red);
  try {
    const d = await avan.socialPublic(red.product as SocialKind, 'redeem', { code: up.code, deviceToken: red.device, clientRequestId: red.client_request_id, expectedAmountMinor: q0.amountMinor, currency: q0.currency });
    if (red.status === 'quoted') await markUpstream(red.upstream_code_id, 'used');
    await applySocialStatus((await getRed(red.id))!, d);
  } catch (e) {
    if (e instanceof AvanError && /QUOTE_(CHANGED|EXPIRED)/.test(e.code || '')) {
      await upd(red.id, { status: 'started', stage: 'code', error_msg: '官方报价已更新，请重新检查账号。' });
      throw userErr('官方报价已更新，请重新检查账号。', 'QUOTE_EXPIRED');
    }
    if (e instanceof AvanError && e.uncertain) {
      await upd(red.id, { status: red.status === 'funded' ? 'processing' : 'funding', next_poll_at: new Date(Date.now() + 5000).toISOString() });
      return view((await getRed(red.id))!);
    }
    // 卡台明确拒绝：退回提交前的状态
    await upd(red.id, { status: firstStage ? 'quoted' : red.status, stage: firstStage ? 'quoted' : red.stage, next_poll_at: null });
    throw userErr(explain(e), 'REDEEM_FAILED');
  }
  return view((await getRed(red.id))!);
}

/* ==================================================================
   ④ 结果：轮询 / Webhook 推进
   ================================================================== */
async function applyGpt(red: Red, v: GptPublicView) {
  const f: Partial<Red> = { progress: v.progress.length ? json(v.progress) : red.progress, card_last4: v.cardLast4 ?? red.card_last4, order_id: v.orderId ?? red.order_id };
  if (v.invoiceUrls.length) f.invoice_urls = json(v.invoiceUrls);
  if (v.success) return complete(red, f);
  if (v.failed) return failGpt(red, f, v);
  if (v.orderStatus === 'requires_action' || v.nextAction === 'submit_session') {
    await upd(red.id, { ...f, status: 'requires_action', stage: v.nextAction || 'requires_action', error_msg: v.message || 'ChatGPT 登录状态已过期，请重新粘贴 Session 继续。', next_poll_at: null });
    return;
  }
  await upd(red.id, { ...f, status: red.status === 'retrying' ? 'retrying' : 'processing', stage: v.stage || v.orderStatus || red.stage, next_poll_at: nextPoll(red) });
}

/** X/TG 状态映射；返回 true 表示根据卡台状态恢复了流程 */
async function applySocialStatus(red: Red, d: SocialPublicData, fromPreview = false): Promise<boolean> {
  const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
  const base: Partial<Red> = { error_code: d.errorCode ?? null };
  if (d.invoiceUrls?.length) base.invoice_urls = json(d.invoiceUrls);
  if (d.recipient && !red.account) base.account = '@' + d.recipient;
  switch (d.status) {
    case 'unused': return false;
    case 'preparing': case 'prepared':
      if (fromPreview) return false;
      await upd(red.id, base); return false;
    case 'funding': await upd(red.id, { ...base, status: 'funding', stage: 'funding', next_poll_at: nextPoll(red) }); return true;
    case 'funded': await upd(red.id, { ...base, status: 'funded', stage: 'funded', next_poll_at: null }); return true;
    case 'paying': await upd(red.id, { ...base, status: 'processing', stage: 'paying', next_poll_at: nextPoll(red) }); return true;
    case 'paid_pending_delivery': await upd(red.id, { ...base, status: 'paid_pending_delivery', stage: 'delivery', next_poll_at: nextPoll(red, 30_000) }); return true;
    case 'completed': await complete(red, { ...base, quote: red.quote, progress: d.giftDays ? json([{ step: '赠送已到账', status: 'done', message: `${d.giftDays} 天` }]) : red.progress }); return true;
    case 'revoked':
      await setCode(code.id, { status: 'revoked' });
      await upd(red.id, { ...base, status: 'cancelled', error_msg: '这个兑换码已被卖家撤销。' }); return true;
    case 'review_required': case 'requires_action':
      await upd(red.id, { ...base, status: 'requires_action', stage: d.status, error_msg: d.message || '需要卖家处理，请联系卖家。', next_poll_at: nextPoll(red, 60_000) }); return true;
    case 'ineligible': case 'failed_precharge':
      await failSocial(red, base, d); return true;
  }
  return false;
}

/** 下次查询时间：刚提交时查得勤，越久越慢（2 分钟内按 min，10 分钟内 15 秒，之后 1 分钟） */
function nextPoll(red: Red, min = 3000) {
  const age = Date.now() - new Date(red.poll_started_at || red.created_at).getTime();
  const ms = age < 120e3 ? min : age < 600e3 ? Math.max(min, 15e3) : 60e3;
  return new Date(Date.now() + ms).toISOString();
}

async function complete(red: Red, f: Partial<Red>) {
  const batch = await q.get<{ cost_usd: string | null }>('SELECT b.cost_usd FROM codes c JOIN batches b ON b.id = c.batch_id WHERE c.id = ?', [red.code_id]);
  await tx(async () => {
    await upd(red.id, { ...f, status: 'completed', stage: 'completed', completed_at: now(), next_poll_at: null, error_msg: null, cost_usd: f.cost_usd ?? red.cost_usd ?? batch?.cost_usd ?? null });
    await setCode(red.code_id, { status: 'redeemed', redeemed_at: now(), account: red.account, redemption_id: red.id });
  });
  await markUpstream(red.upstream_code_id, 'used');
  sessions.delete(red.id);
}

async function failGpt(red: Red, f: Partial<Red>, v: GptPublicView) {
  const msg = v.message || '支付没有成功';
  await upd(red.id, { ...f, error_code: v.errorCode ?? v.orderStatus ?? null, error_msg: msg });
  await markUpstream(red.upstream_code_id, 'released');
  await afterFailure((await getRed(red.id))!, msg);
}
async function failSocial(red: Red, f: Partial<Red>, d: SocialPublicData) {
  const msg = d.message || (d.status === 'ineligible' ? '这个账号不符合开通条件' : '付款准备失败');
  await upd(red.id, { ...f, error_msg: msg });
  if (d.canRetryPreflight) await markUpstream(red.upstream_code_id, 'released'); else await markUpstream(red.upstream_code_id, 'failed');
  await afterFailure((await getRed(red.id))!, msg, d.canRetryPreflight === true);
}

/** 失败后按策略处理：自动重试 / 释放码让用户重兑 / 转人工 */
async function afterFailure(red: Red, msg: string, socialRetryable = true) {
  const s = await getStrategy(red.strategy_id);
  const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
  // 直充：卡台自动直充内部已经换卡重试过（最多 2 张卡），这里不再叠加，避免重复付开卡费
  const canAuto = code.mode === 'own' && s.failAct === 'retry' && red.attempts <= s.retryN && !await isDirect(code) &&
    (red.product === 'gpt' ? !!getSession(red.id) : socialRetryable);
  if (canAuto) {
    await upd(red.id, { status: 'retrying', stage: 'retry', attempts: red.attempts + 1, error_msg: `${msg}，正在自动重试（第 ${red.attempts} 次）` });
    setTimeout(() => retry(red.id).catch(e => console.error('[redeem] retry', red.id, e)), 1500);
    return;
  }
  if (s.failAct === 'manual') {
    await upd(red.id, { status: 'manual_review', stage: 'failed', review: 'pending', next_poll_at: null, error_msg: `${msg}。卖家会尽快处理，兑换码不会作废。` });
    return;
  }
  await upd(red.id, { status: 'failed', stage: 'failed', next_poll_at: null, error_msg: `${msg}。兑换码已释放，可以重新兑换。` });
  await setCode(code.id, { status: 'unused' });
  sessions.delete(red.id);
}

/** 自动重试 / 管理员手动重试：换一张卡台码（自有码）或重新预检 */
export async function retry(rid: string) {
  return locked(rid, async () => {
    const red = (await getRed(rid))!;
    const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
    const s = await getStrategy(red.strategy_id);
    try {
      if (red.product === 'gpt' && await isDirect(code)) {
        // 直充重试：重新预检再下单（新幂等键），同样要过资金护栏；价格已由管理员确认，不再做价格保护
        const session = getSession(rid);
        if (!session) throw new Error('Session 已过期');
        return await gptAccount((await getRed(rid))!, code, s, session, true);
      } else if (red.product === 'gpt') {
        const session = getSession(rid);
        if (!session) throw new Error('Session 已过期');
        const params = parse<BatchParams>((await q.get<{ params: string }>('SELECT params FROM batches WHERE id = ?', [code.batch_id]))!.params, {});
        // 每码独立支付的卡台码失败后不会再开第二张卡，必须换一张新码
        const up = await upstreamCodeFor(code, red, code.mode === 'own' && !!params.forceNewCard);
        const pv = normalizeGptPublic(await avan.gptPublic('preview', { code: up.code }, red.device));
        const pf = normalizeGptPublic(await avan.gptPublic('preflight', { redemptionToken: pv.redemptionToken, credential: { mode: 'session', session } }, red.device));
        await upd(rid, { redemption_token_enc: encrypt(pv.redemptionToken!), preflight_token_enc: encrypt(pf.preflightToken!), quote: json({ ...pf.quote, expiresAt: new Date(Date.now() + 10 * 60e3).toISOString() }), client_request_id: null, status: 'quoted' });
        await confirmGpt((await getRed(rid))!, code);
      } else {
        const up = await upstreamCodeFor(code, red);
        const crid = uuid();
        const d = await avan.socialPublic(red.product as SocialKind, 'preflight', { code: up.code, deviceToken: red.device, clientRequestId: crid, recipient: (red.account || '').replace(/^@/, '') });
        await upd(rid, { client_request_id: crid });
        if (d.status !== 'prepared') { await applySocialStatus((await getRed(rid))!, d); return view((await getRed(rid))!); }
        await upd(rid, { status: 'quoted', quote: json({ amountMinor: d.amountMinor, currency: d.currency, expiresAt: new Date(Date.now() + 30 * 60e3).toISOString() }) });
        await confirmSocial((await getRed(rid))!, code);  // 只做第一阶段，付款仍需用户确认
      }
    } catch (e) {
      await upd(rid, { status: s.failAct === 'manual' ? 'manual_review' : 'failed', review: s.failAct === 'manual' ? 'pending' : null, error_msg: `重试失败：${e instanceof Error ? e.message : e}。兑换码已释放，可以重新兑换。` });
      if (s.failAct !== 'manual') await setCode(code.id, { status: 'unused' });
    }
    return view((await getRed(rid))!);
  });
}

/** 查询一条兑换的最新卡台状态 */
export async function poll(rid: string) {
  return locked(rid, async () => {
    const red = await getRed(rid);
    if (!red || !pollable(red)) return;
    try {
      if (red.product === 'gpt') {
        const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
        if (await isDirect(code)) return await pollDirect(red, code);
        if (!red.redemption_token_enc) return;
        await applyGpt(red, normalizeGptPublic(await avan.gptPublic('result', { redemptionToken: decryptOpt(red.redemption_token_enc) }, red.device)));
      } else {
        const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
        const up = await upstreamCodeFor(code, red);
        await applySocialStatus(red, await avan.socialPublic(red.product as SocialKind, 'result', { code: up.code, deviceToken: red.device, clientRequestId: red.client_request_id }));
      }
    } catch (e) {
      await upd(rid, { next_poll_at: new Date(Date.now() + 20e3).toISOString() });
      if (!(e instanceof AvanError && e.uncertain)) console.warn('[redeem] poll', rid, e instanceof Error ? e.message : e);
    }
  });
}

export async function status(rid: string, device: string) {
  let red = await mine(rid, device);
  if (IN_FLIGHT.includes(red.status) && (!red.next_poll_at || red.next_poll_at <= now())) { await poll(rid); red = (await getRed(rid))!; }
  return view(red);
}

/** GPT 订单需要补交 Session */
export async function resubmitSession(rid: string, device: string, session: string) {
  return locked(rid, async () => {
    const red = await mine(rid, device);
    if (red.status !== 'requires_action' || red.product !== 'gpt' || !red.order_id || red.stage === 'seller_action') throw userErr('当前不需要补交。', 'BAD_STATE');
    parseGptSession(session);
    try { await avan.gptOrderSession(red.order_id, session); } catch (e) { throw userErr(explain(e), 'SESSION_FAILED'); }
    putSession(rid, session);
    await upd(rid, { status: 'processing', stage: 'session_resubmitted', error_msg: null, next_poll_at: new Date(Date.now() + 3000).toISOString() });
    return view((await getRed(rid))!);
  });
}

/** 后台循环：推进进行中的兑换、清理超时的兑换 */
export async function tick() {
  const due = await q.all<{ id: string }>(`SELECT id FROM redemptions WHERE ${POLLABLE_SQL} AND (next_poll_at IS NULL OR next_poll_at <= ?) ORDER BY next_poll_at LIMIT 20`, [now()]);
  await Promise.allSettled(due.map(r => poll(r.id)));
  const stale = new Date(Date.now() - STALE_MIN * 60e3).toISOString();
  for (const r of await q.all<Red>("SELECT * FROM redemptions WHERE status IN ('started','quoted') AND updated_at < ?", [stale])) {
    await upd(r.id, { status: 'expired', error_msg: '超过 30 分钟未完成，已自动结束。' });
    await q.run("UPDATE codes SET status = 'unused' WHERE id = ? AND status = 'in_use' AND redemption_id = ?", [r.code_id, r.id]);
  }
}

/** Webhook 收到 CDK / 订单事件后立即刷新相关兑换 */
export async function nudgeByUpstream(cdkId?: string, orderId?: string) {
  const rows = await q.all<{ id: string }>(`SELECT r.id FROM redemptions r LEFT JOIN codes c ON c.id = r.code_id
    WHERE (r.status IN (${IN_FLIGHT.map(() => '?').join(',')}) OR (r.status = 'requires_action' AND r.direct_task_id IS NOT NULL)) AND (r.upstream_code_id = ? OR c.upstream_id = ? OR r.order_id = ?)`, [...IN_FLIGHT, cdkId || '-', cdkId || '-', orderId || '-']);
  for (const r of rows) poll(r.id).catch(() => {});
  return rows.length;
}

/* ==================================================================
   管理员操作
   ================================================================== */
export async function adminApprove(rid: string) {
  const red = await getRed(rid);
  if (!red || red.status !== 'manual_review') throw bad('这条记录不在待审核状态');
  const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
  await upd(rid, { review: 'approved' });
  if (red.stage === 'failed') return retry(rid);
  if (red.product === 'gpt') {
    const session = getSession(rid);
    if (session) {
      await upd(rid, { status: 'approved' });
      return locked(rid, async () => gptAccount((await getRed(rid))!, code, await getStrategy(red.strategy_id), session, true));
    }
    await upd(rid, { status: 'approved', error_msg: '卖家已确认，请重新粘贴 Session 完成开通。' });
    return view((await getRed(rid))!);
  }
  await upd(rid, { status: 'approved' });
  return locked(rid, async () => socialAccount((await getRed(rid))!, code, await getStrategy(red.strategy_id), (red.account || '').replace(/^@/, ''), true));
}
export async function adminReject(rid: string, reason = '卖家拒绝了这次兑换') {
  const red = await getRed(rid);
  if (!red || !['manual_review', 'approved', 'requires_action'].includes(red.status)) throw bad('当前状态不能拒绝');
  if (await direct.pendingDirect(red.code_id)) throw bad(direct.PENDING_MSG);
  await upd(rid, { status: 'blocked', stage: 'review', review: 'rejected', rule: `管理员拒绝：${reason}`, error_msg: '暂时无法兑换，请稍后再试或联系卖家。兑换码仍然有效。' });
  await releaseIfCurrent(red);
  sessions.delete(rid);
}
export async function adminRetry(rid: string) {
  const red = await getRed(rid);
  if (!red || !['failed', 'manual_review'].includes(red.status)) throw bad('只有失败的记录可以重试');
  if (red.product === 'gpt' && !getSession(rid)) throw bad('用户的 Session 已过期（只在内存保留 30 分钟），无法代为重试；兑换码已释放，请让用户重新兑换');
  await setCode(red.code_id, { status: 'in_use', redemption_id: rid });
  await upd(rid, { attempts: red.attempts + 1, status: 'retrying' });
  return retry(rid);
}
export async function adminRelease(rid: string) {
  const red = await getRed(rid);
  if (!red || IN_FLIGHT.includes(red.status) || red.status === 'completed') throw bad('进行中或已完成的兑换不能释放');
  if (await direct.pendingDirect(red.code_id)) throw bad(direct.PENDING_MSG);
  await upd(rid, { status: 'failed', error_msg: '卖家已释放兑换码，可以重新兑换。', next_poll_at: null });
  await releaseIfCurrent(red);
}
/**
 * 直充人工核对：结果未知又没法自动重放（例如重启后 Session 没了），或卡台要求卖家处理时，
 * 卖家到卡台查清楚后在这里登记结果。兑换状态、兑换码、额度账本在同一个事务里一起改：
 *   completed 已开通：兑换完成、码记为已兑换，按填写的实际花费结算
 *   failed    没开通：兑换失败、码释放可重兑，按填写的实际花费（例如开卡费，没有就填 0）结算
 *   attach    找到了卡台任务 ID：关联上去，之后自动查询，不需要填金额
 * 「是否开通」和「花了多少钱」分开填：开卡费扣了但会员没开通的情况很常见，不能用金额推断结果
 */
export async function adminResolveDirect(rid: string, p: { outcome: 'completed' | 'failed' | 'attach'; actualUsd?: number; taskId?: string; note: string }) {
  return locked(rid, async () => {
    const red = await getRed(rid);
    if (!red) throw bad('记录不存在');
    const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
    if (!await isDirect(code)) throw bad('这条不是直充兑换');
    const open = await direct.reservedOf(rid);
    if (!open.length) throw bad('这条兑换没有待核对的直充');
    // 已经关联了任务、还在正常查询中的，不需要人工介入（等系统自己查到结果）
    if (red.status !== 'requires_action' && !(red.status === 'processing' && !red.direct_task_id)) throw bad('这条直充还在正常处理中，不需要人工核对');
    const note = p.note.trim().slice(0, 200);
    if (!note) throw bad('请写明核对依据（例如卡台订单号、查看到的状态）');
    const last = open[open.length - 1];

    if (p.outcome === 'attach') {
      const taskId = String(p.taskId || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw bad('任务 ID 格式不正确');
      // 先确认这个任务真的存在、属于当前 API Key，再关联
      try { await avan.gptAutoTask(taskId); } catch (e) { throw bad(`卡台查不到这个任务：${explain(e)}`); }
      await tx(async () => {
        await direct.attachTask(last.idem_key, taskId);
        await upd(rid, { direct_task_id: taskId, status: 'processing', stage: 'submitted', rule: `人工关联任务：${note}`, next_poll_at: now() });
      });
      setImmediate(() => poll(rid).catch(() => {}));
      return view((await getRed(rid))!);
    }

    const amt = Number(p.actualUsd);
    if (!(Number.isFinite(amt) && amt >= 0 && amt < 100000)) throw bad('请填写实际花费（USD），没有扣款填 0');
    const qt = parse<any>(red.quote, {});
    await tx(async () => {
      // 同一条兑换如果有多笔没结束的下单，金额记在最后一笔，其余记 0（都已人工确认）
      for (const r of open) await direct.settle(r.idem_key, p.outcome === 'completed' ? 'spent' : 'released', r === last ? amt : 0, { verified: true, note: `人工核对：${note}` });
      if (p.outcome === 'completed') {
        await complete(red, { cost_usd: amt.toFixed(4), rule: `人工核对：已开通。${note}`, quote: json({ ...qt, willRenew: qt.willRenew ?? null }) });
      } else {
        await upd(rid, { status: 'failed', stage: 'failed', next_poll_at: null, rule: `人工核对：没有开通。${note}`, error_msg: '这次没有开通成功。兑换码已释放，可以重新兑换。' });
        await releaseIfCurrent(red);
      }
    });
    return view((await getRed(rid))!);
  });
}

/** 只有当这条记录是兑换码当前的兑换时才释放码，避免历史记录影响进行中的兑换 */
async function releaseIfCurrent(red: Red) {
  await q.run("UPDATE codes SET status = 'unused' WHERE id = ? AND redemption_id = ? AND status IN ('in_use','unused')", [red.code_id, red.id]);
  sessions.delete(red.id);
}
export const hasSession = (rid: string) => !!getSession(rid);

/* ==================================================================
   视图
   ================================================================== */
async function mine(rid: string, device: string): Promise<Red> {
  const red = typeof rid === 'string' && /^r_[0-9a-f]{20}$/.test(rid) ? await getRed(rid) : undefined;
  if (!red || red.browser_device !== device) throw new HttpError(404, '找不到这次兑换，请重新输入兑换码。', 'NOT_FOUND');
  return red;
}

export async function view(red: Red) {
  const code = (await q.get<{ display: string; status: string; mode: string; params: string }>('SELECT c.display, c.status, c.mode, b.params FROM codes c JOIN batches b ON b.id = c.batch_id WHERE c.id = ?', [red.code_id]))!;
  const quote = parse<any>(red.quote, null);
  const needs =
    ['started', 'approved'].includes(red.status) || (red.status === 'blocked' && red.stage === 'account') || (red.status === 'failed' && code.status === 'unused' && red.stage !== 'code')
      ? (red.product === 'gpt' ? 'session' : 'recipient')
      : red.status === 'quoted' ? 'confirm'
      : red.status === 'funded' ? 'pay'
      : red.status === 'requires_action' && red.product === 'gpt' && red.order_id && red.stage !== 'seller_action' ? 'resubmit'
      : null;
  return {
    rid: red.id, product: red.product, plan: red.plan, planLabel: fullPlanLabel(red.product, red.plan), code: code.display,
    status: red.status, stage: red.stage, needs, account: red.account,
    quote: quote && { currency: quote.currency, amountMinor: quote.amountMinor, currentPlan: quote.currentPlan, expiresAt: quote.expiresAt },
    willRenew: quote?.willRenew ?? null, // 直充订单返回的自动续费状态；卡台 CDK 流程没有这个字段
    direct: red.product === 'gpt' && code.mode === 'own' && deliveryOf(parse<BatchParams>(code.params, {})) === 'direct',
    message: red.error_msg, codeReusable: code.status === 'unused',
    progress: parse<any[]>(red.progress, []), attempts: red.attempts,
    invoiceUrls: red.product === 'gpt' ? [] : parse<string[]>(red.invoice_urls, []), // GPT 的 Stripe 账单是卖家账号的，不给用户
    orderNo: red.id.slice(2, 14).toUpperCase(), createdAt: red.created_at, completedAt: red.completed_at,
  };
}

/** 凭证查询：必须是兑换时使用的同一浏览器 */
export async function receipt(rawCode: string, device: string) {
  const code = await q.get<{ id: string }>('SELECT id FROM codes WHERE code_hash = ?', [lookupHash(normalizeCode(rawCode))]);
  const red = code && await q.get<Red>("SELECT * FROM redemptions WHERE code_id = ? AND browser_device = ? AND status != 'blocked' ORDER BY created_at DESC LIMIT 1", [code.id, device]);
  if (!red) throw new HttpError(404, '没有在这台设备上找到这个兑换码的记录。请使用兑换时的设备和浏览器查询，或联系卖家。', 'NOT_FOUND');
  return view(red);
}

async function verifyTurnstile(secret: string, token: string, ip: string) {
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(8000) });
    return !!(await r.json() as any).success;
  } catch { return false; }
}

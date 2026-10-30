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
import { avan, AvanError, type SocialKind, type SocialPublicData } from '../avan/client.ts';
import { normalizeGptPublic, type GptPublicView } from '../avan/normalize.ts';
import { HttpError, bad } from '../http.ts';
import { getStrategy, checkGates, checkAccount, checkPrice, type Strategy, type AccountInfo } from './strategy.ts';
import { getSetting } from './settings.ts';
import { gptSalePrice, gptPlans, fullPlanLabel } from './catalog.ts';
import { autoCard, cdkRegionArg, type BatchParams } from './batches.ts';

const IN_FLIGHT = ['processing', 'funding', 'retrying', 'paid_pending_delivery'];
const OPEN = ['started', 'quoted', 'blocked', 'approved', 'funded', 'requires_action', ...IN_FLIGHT, 'manual_review'];
const STALE_MIN = 30;

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
  poll_started_at: string | null;
}
interface CodeRow { id: string; batch_id: string; product: 'gpt' | 'x' | 'tg'; plan: string; mode: 'own' | 'hosted'; strategy_id: string; code_enc: string | null; status: string; upstream_id: string | null; redemption_id: string | null; expires_at: string | null; created_at: string }

/** 卡台的金额是十进制字符串；按分换算，避免浮点误差累积 */
const DECIMAL = /^\d{1,9}(\.\d{1,6})?$/;
const toCents = (s: string) => Math.round(Number(s) * 100);
const getRed = async (id: string) => await q.get<Red>('SELECT * FROM redemptions WHERE id = ?', [id]);
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
  if (e.uncertain) return '服务暂时没有响应，请稍后刷新查看结果，不要重复兑换。';
  if (e.code === 'NOT_CONFIGURED') return '系统尚未配置完成，请联系客服。';
  // 服务端故障的原文是给运维看的，买家只看通用说明
  if (e.status >= 500) return fallback;
  return e.message || fallback;
}

/* ==================================================================
   卡台码：托管码直接用；自有码在兑换时临时向卡台生成
   ================================================================== */
async function upstreamCodeFor(code: CodeRow, red: Red, forceNew = false): Promise<{ id: string; code: string }> {
  if (code.mode === 'hosted') {
    const c = decryptOpt(code.code_enc);
    if (!c) throw userErr('这个兑换码暂时无法使用，请联系客服。');
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
    if (!params.social) throw userErr('这个兑换码暂时无法使用，请联系客服。');
    const r = await avan.socialGenerate(code.product, { plan: code.plan, quantity: 1, ...params.social, autoCard: autoCard() }, idem);
    id = r.list[0].id; full = r.list[0].code || null;
    if (!full) full = (await avan.socialExport(code.product, id)).code;
  }
  if (!full) throw userErr('兑换码校验没有完成，请稍后再试。');
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
  if (code.status === 'revoked') { await attempt(ctx.ip, ctx.device, h, false, 'revoked'); throw userErr('这个兑换码已作废，如有疑问请联系客服。', 'REVOKED'); }
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
      const up = await upstreamCodeFor(code, red);
      const v = normalizeGptPublic(await avan.gptPublic('preview', { code: up.code }, red.device));
      await upd(red.id, { redemption_token_enc: v.redemptionToken ? encrypt(v.redemptionToken) : null });
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
    if (code.status === 'revoked') throw userErr('这个兑换码已作废。', 'REVOKED');
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
  const pre = await checkAccount(s, 'gpt', acc, red.id, code.plan);
  if (!pre.ok) return block(red, code, 'account', pre.rule!, pre.userMsg!, acc);

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

  const full = await checkAccount(s, 'gpt', acc, red.id, code.plan);
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
    await upd(red.id, { status: d.status === 'review_required' ? 'requires_action' : 'failed', stage: 'preflight', error_msg: d.message || '暂时无法为这个账号开通，请联系客服。', rule: d.errorCode });
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
      return await confirmGpt(red, code);
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
  const v = await checkAccount(await getStrategy(red.strategy_id), red.product, { key: red.account_key, display: red.account || '', currentPlan: parse<any>(red.quote, {}).currentPlan }, red.id, red.plan);
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
    await upd(red.id, { status: 'started', stage: 'code', error_msg: '确认超时，请重新检查账号。' });
    throw userErr('确认超时，请重新检查账号。', 'QUOTE_EXPIRED');
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
      await upd(red.id, { status: 'started', stage: 'code', error_msg: '确认超时，请重新检查账号。' });
      throw userErr('确认超时，请重新检查账号。', 'QUOTE_EXPIRED');
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
      await upd(red.id, { status: 'started', stage: 'code', error_msg: '开通信息有变化，请重新检查账号。' });
      throw userErr('开通信息有变化，请重新检查账号。', 'QUOTE_EXPIRED');
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
      await upd(red.id, { ...base, status: 'cancelled', error_msg: '这个兑换码已作废。' }); return true;
    case 'review_required': case 'requires_action':
      await upd(red.id, { ...base, status: 'requires_action', stage: d.status, error_msg: d.message || '这次开通需要客服处理，请联系客服。', next_poll_at: nextPoll(red, 60_000) }); return true;
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
  const msg = v.message || '开通没有成功';
  await upd(red.id, { ...f, error_code: v.errorCode ?? v.orderStatus ?? null, error_msg: msg });
  await markUpstream(red.upstream_code_id, 'released');
  await afterFailure((await getRed(red.id))!, msg);
}
async function failSocial(red: Red, f: Partial<Red>, d: SocialPublicData) {
  const msg = d.message || (d.status === 'ineligible' ? '这个账号不符合开通条件' : '开通准备没有完成');
  await upd(red.id, { ...f, error_msg: msg });
  if (d.canRetryPreflight) await markUpstream(red.upstream_code_id, 'released'); else await markUpstream(red.upstream_code_id, 'failed');
  await afterFailure((await getRed(red.id))!, msg, d.canRetryPreflight === true);
}

/** 失败后按策略处理：自动重试 / 释放码让用户重兑 / 转人工 */
async function afterFailure(red: Red, msg: string, socialRetryable = true) {
  const s = await getStrategy(red.strategy_id);
  const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
  const canAuto = code.mode === 'own' && s.failAct === 'retry' && red.attempts <= s.retryN &&
    (red.product === 'gpt' ? !!getSession(red.id) : socialRetryable);
  if (canAuto) {
    await upd(red.id, { status: 'retrying', stage: 'retry', attempts: red.attempts + 1, error_msg: `${msg}，正在自动重试（第 ${red.attempts} 次）` });
    setTimeout(() => retry(red.id).catch(e => console.error('[redeem] retry', red.id, e)), 1500);
    return;
  }
  if (s.failAct === 'manual') {
    await upd(red.id, { status: 'manual_review', stage: 'failed', review: 'pending', next_poll_at: null, error_msg: `${msg}。客服会尽快处理，兑换码不会作废。` });
    return;
  }
  await upd(red.id, { status: 'failed', stage: 'failed', next_poll_at: null, error_msg: `${msg}。兑换码仍然有效，可以重新兑换。` });
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
      if (red.product === 'gpt') {
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
      await upd(rid, { status: s.failAct === 'manual' ? 'manual_review' : 'failed', review: s.failAct === 'manual' ? 'pending' : null, rule: `重试失败：${e instanceof Error ? e.message : e}`, error_msg: s.failAct === 'manual' ? '这次没有开通成功，客服会尽快处理，兑换码不会作废。' : '这次没有开通成功，兑换码仍然有效，可以重新兑换。' });
      if (s.failAct !== 'manual') await setCode(code.id, { status: 'unused' });
    }
    return view((await getRed(rid))!);
  });
}

/** 查询一条兑换的最新卡台状态 */
export async function poll(rid: string) {
  return locked(rid, async () => {
    const red = await getRed(rid);
    if (!red || !IN_FLIGHT.includes(red.status)) return;
    try {
      if (red.product === 'gpt') {
        const code = (await q.get<CodeRow>('SELECT * FROM codes WHERE id = ?', [red.code_id]))!;
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
    if (red.status !== 'requires_action' || red.product !== 'gpt' || !red.order_id) throw userErr('当前不需要补交。', 'BAD_STATE');
    parseGptSession(session);
    try { await avan.gptOrderSession(red.order_id, session); } catch (e) { throw userErr(explain(e), 'SESSION_FAILED'); }
    putSession(rid, session);
    await upd(rid, { status: 'processing', stage: 'session_resubmitted', error_msg: null, next_poll_at: new Date(Date.now() + 3000).toISOString() });
    return view((await getRed(rid))!);
  });
}

/** 后台循环：推进进行中的兑换、清理超时的兑换 */
export async function tick() {
  const due = await q.all<{ id: string }>(`SELECT id FROM redemptions WHERE status IN (${IN_FLIGHT.map(() => '?').join(',')}) AND (next_poll_at IS NULL OR next_poll_at <= ?) ORDER BY next_poll_at LIMIT 20`, [...IN_FLIGHT, now()]);
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
    WHERE r.status IN (${IN_FLIGHT.map(() => '?').join(',')}) AND (r.upstream_code_id = ? OR c.upstream_id = ? OR r.order_id = ?)`, [...IN_FLIGHT, cdkId || '-', cdkId || '-', orderId || '-']);
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
    await upd(rid, { status: 'approved', error_msg: '审核已通过，请重新粘贴 Session 完成开通。' });
    return view((await getRed(rid))!);
  }
  await upd(rid, { status: 'approved' });
  return locked(rid, async () => socialAccount((await getRed(rid))!, code, await getStrategy(red.strategy_id), (red.account || '').replace(/^@/, ''), true));
}
export async function adminReject(rid: string, reason = '卖家拒绝了这次兑换') {
  const red = await getRed(rid);
  if (!red || !['manual_review', 'approved', 'requires_action'].includes(red.status)) throw bad('当前状态不能拒绝');
  await upd(rid, { status: 'blocked', stage: 'review', review: 'rejected', rule: `管理员拒绝：${reason}`, error_msg: '暂时无法兑换，请稍后再试或联系客服。兑换码仍然有效。' });
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
  await upd(rid, { status: 'failed', error_msg: '兑换码已恢复可用，可以重新兑换。', next_poll_at: null });
  await releaseIfCurrent(red);
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
  const code = (await q.get<{ display: string; status: string }>('SELECT display, status FROM codes WHERE id = ?', [red.code_id]))!;
  const quote = parse<any>(red.quote, null);
  const needs =
    ['started', 'approved'].includes(red.status) || (red.status === 'blocked' && red.stage === 'account') || (red.status === 'failed' && code.status === 'unused' && red.stage !== 'code')
      ? (red.product === 'gpt' ? 'session' : 'recipient')
      : red.status === 'quoted' ? 'confirm'
      : red.status === 'funded' ? 'pay'
      : red.status === 'requires_action' && red.product === 'gpt' && red.order_id ? 'resubmit'
      : null;
  return {
    rid: red.id, product: red.product, plan: red.plan, planLabel: fullPlanLabel(red.product, red.plan), code: code.display,
    status: red.status, stage: red.stage, needs, account: red.account,
    quote: quote && { currency: quote.currency, amountMinor: quote.amountMinor, currentPlan: quote.currentPlan, expiresAt: quote.expiresAt },
    willRenew: quote?.willRenew ?? null,
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
  if (!red) throw new HttpError(404, '没有在这台设备上找到这个兑换码的记录。请使用兑换时的设备和浏览器查询，或联系客服。', 'NOT_FOUND');
  return view(red);
}

async function verifyTurnstile(secret: string, token: string, ip: string) {
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(8000) });
    return !!(await r.json() as any).success;
  } catch { return false; }
}

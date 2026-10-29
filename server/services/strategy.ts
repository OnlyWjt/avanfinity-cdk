/**
 * 兑换策略
 * 执行层：
 *   own      我方后端前置检查（可随时修改）
 *   gen      生成码时写入卡台（costCap、payMode），之后该批次不变
 *   platform 卡台强制（报价有效期、资格判定等），我们只能加严
 */
import { q, now, json, parse } from '../db.ts';
import { config } from '../config.ts';
import { bad, HttpError } from '../http.ts';
import { hex } from '../crypto.ts';
import { GPT_DIRECT_PLAN_KEYS } from './catalog.ts';

export interface StrategyConfig {
  desc: string;
  prod: ('gpt' | 'x' | 'tg')[];
  mode: 'own' | 'hosted';
  prefix: string;
  ipH: number;          // 同一 IP 每小时最多尝试
  devD: number;         // 同一设备每天最多兑换成功
  captcha: number;      // 同一 IP 输错几次后要求人机验证
  expire: number;       // 码有效期（天），0 不过期
  timeOn: boolean; from: string; to: string;
  geo: string;          // 拦截国家，逗号分隔
  accN: number; accDays: number;
  freeOnly: boolean;
  mailAllow: string; mailBlock: string;
  priceTol: number;     // 售价上涨超过 %
  priceAct: 'block' | 'manual' | 'pass';
  costCap: number;      // X/TG 单码成本上限（USD），生成时写入
  failAct: 'retry' | 'release' | 'manual';
  retryN: number;
  payMode: 'shared' | 'own';  // GPT 每码独立支付（forceNewCard）
  delivery: 'cdk' | 'direct'; // GPT 交付方式：卡台 CDK | 直充（只限自有码），生成时写入批次
  country: string;            // GPT 结账地区（国家代码），空 = 卡台默认；生成时写入批次
}
export interface Strategy extends StrategyConfig { id: string; name: string; on: boolean; prio: number; isDefault: boolean; hits?: number }

const DEFAULT_CFG: StrategyConfig = {
  desc: '所有未指定策略的兑换码', prod: ['gpt', 'x', 'tg'], mode: 'own', prefix: 'CDK',
  ipH: 20, devD: 5, captcha: 3, expire: 0, timeOn: false, from: '09:00', to: '23:00', geo: '',
  accN: 1, accDays: 30, freeOnly: false, mailAllow: '', mailBlock: 'tempmail.com, 10minutemail.com, guerrillamail.com',
  priceTol: 10, priceAct: 'manual', costCap: 30, failAct: 'release', retryN: 1, payMode: 'shared', delivery: 'cdk', country: '',
};

const row2s = (r: any): Strategy => ({ ...DEFAULT_CFG, ...parse(r.config, {}), id: r.id, name: r.name, on: !!r.enabled, prio: r.priority, isDefault: !!r.is_default });

export function listStrategies(): Strategy[] {
  const since = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const hits = Object.fromEntries(q.all<{ s: string; n: number }>("SELECT strategy_id s, COUNT(*) n FROM redemptions WHERE status = 'blocked' AND created_at >= ? GROUP BY strategy_id", [since]).map(r => [r.s, r.n]));
  return q.all('SELECT * FROM strategies ORDER BY priority, created_at').map(r => ({ ...row2s(r), hits: hits[r.id] || 0 }));
}
export function getStrategy(id: string): Strategy {
  const r = q.get('SELECT * FROM strategies WHERE id = ?', [id]);
  if (!r) throw new HttpError(404, '策略不存在');
  return row2s(r);
}
export function defaultStrategy(): Strategy {
  return row2s(q.get('SELECT * FROM strategies WHERE is_default = 1')!);
}

function validate(s: Partial<Strategy>, id?: string): StrategyConfig & { name: string; on: boolean; prio: number } {
  const c = { ...DEFAULT_CFG, ...s } as any;
  const name = String(s.name || '').trim();
  if (!name || name.length > 40) throw bad('策略名称 1–40 字');
  c.prod = (Array.isArray(c.prod) ? c.prod : []).filter((p: string) => ['gpt', 'x', 'tg'].includes(p));
  if (!c.prod.length) throw bad('至少选择一个适用产品');
  if (!['own', 'hosted'].includes(c.mode)) throw bad('兑换码模式不正确');
  c.prefix = String(c.prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.mode === 'own') {
    if (c.prefix.length < 2 || c.prefix.length > 6) throw bad('自有码前缀需要 2–6 位字母或数字');
    if (/^(AVF|XCDK|TGCD)$/.test(c.prefix)) throw bad('前缀不能与卡台码前缀相同');
    const dup = q.get<{ name: string }>("SELECT name FROM strategies WHERE id != ? AND json_extract(config, '$.mode') = 'own' AND json_extract(config, '$.prefix') = ?", [id || '', c.prefix]);
    if (dup) throw bad(`前缀 ${c.prefix} 已被策略「${dup.name}」使用`);
  }
  const nums: [keyof StrategyConfig, number, number][] = [['ipH', 1, 10000], ['devD', 1, 10000], ['captcha', 1, 1000], ['expire', 0, 3650], ['accN', 1, 10000], ['accDays', 1, 3650], ['priceTol', 0, 1000], ['costCap', 0.01, 10000], ['retryN', 0, 5]];
  for (const [k, min, max] of nums) { const v = Number(c[k]); if (!Number.isFinite(v) || v < min || v > max) throw bad(`${k} 超出范围 ${min}–${max}`); c[k] = v; }
  for (const k of ['from', 'to']) if (!/^([01]\d|2[0-4]):[0-5]\d$/.test(c[k])) throw bad('时段格式应为 HH:MM');
  if (!['block', 'manual', 'pass'].includes(c.priceAct)) throw bad('价格保护动作不正确');
  if (!['retry', 'release', 'manual'].includes(c.failAct)) throw bad('失败处理方式不正确');
  if (!['shared', 'own'].includes(c.payMode)) throw bad('支付方式不正确');
  if (!['cdk', 'direct'].includes(c.delivery)) throw bad('GPT 交付方式不正确');
  if (c.delivery === 'direct' && c.mode !== 'own') throw bad('直充只能用于自有码策略（托管码本身就是卡台 CDK）');
  c.country = String(c.country || '').trim().toUpperCase();
  if (c.country && !/^[A-Z]{2}$/.test(c.country)) throw bad('结账地区应为 2 位国家代码，如 US');
  c.timeOn = !!c.timeOn; c.freeOnly = !!c.freeOnly;
  for (const k of ['desc', 'geo', 'mailAllow', 'mailBlock']) c[k] = String(c[k] || '').slice(0, 500);
  return { ...c, name, on: s.on !== false, prio: Number.isInteger(Number(s.prio)) ? Number(s.prio) : 10 };
}
const cfgOnly = (c: any): StrategyConfig => Object.fromEntries(Object.keys(DEFAULT_CFG).map(k => [k, c[k]])) as any;

export function saveStrategy(s: Partial<Strategy> & { id?: string }): Strategy {
  const existing = s.id ? q.get<any>('SELECT * FROM strategies WHERE id = ?', [s.id]) : null;
  const v = validate(s, s.id);
  if (existing) {
    const old = row2s(existing);
    // 已有码的策略不能切换模式：自有码和卡台码的兑换路径完全不同
    if (old.mode !== v.mode && q.get('SELECT 1 FROM codes WHERE strategy_id = ? LIMIT 1', [s.id!])) throw bad('这条策略已经生成过兑换码，不能切换码模式；请复制一份新策略');
    if (old.mode === 'own' && old.prefix !== v.prefix && q.get('SELECT 1 FROM codes WHERE strategy_id = ? LIMIT 1', [s.id!])) throw bad('这条策略已经生成过兑换码，不能修改前缀');
    if (existing.is_default && !v.on) throw bad('默认策略不能停用');
    // 改成直充前检查商城商品：直充不支持的套餐绑在这条策略上，买家付款后会一直发不出货
    if (v.mode === 'own' && v.delivery === 'direct') {
      const bad1 = q.all<{ title: string }>(`SELECT title FROM shop_products WHERE strategy_id = ? AND product = 'gpt' AND plan NOT IN (${GPT_DIRECT_PLAN_KEYS.map(() => '?').join(',')})`, [s.id!, ...GPT_DIRECT_PLAN_KEYS]);
      if (bad1.length) throw bad(`商品「${bad1.map(p => p.title).join('」「')}」用的套餐不支持直充，请先给它们换一条策略`);
      // 未完成的订单在下单时快照了这条策略：商品改绑别的策略也没用，它们发货时仍按这条策略生成码
      const ph = GPT_DIRECT_PLAN_KEYS.map(() => '?').join(',');
      const open = q.all<{ no: string }>(`SELECT no FROM orders WHERE snap_strategy = ? AND snap_product = 'gpt' AND snap_plan NOT IN (${ph}) AND status IN ('pending','paid') LIMIT 5`, [s.id!, ...GPT_DIRECT_PLAN_KEYS]);
      if (open.length) throw bad(`还有未完成的订单（${open.map(o => o.no).join('、')}）按这条策略发货，套餐不支持直充；请等它们发货或关闭后再改`);
    }
    q.run('UPDATE strategies SET name = ?, enabled = ?, priority = ?, config = ?, updated_at = ? WHERE id = ?', [v.name, v.on ? 1 : 0, v.prio, json(cfgOnly(v)), now(), s.id!]);
    return getStrategy(s.id!);
  }
  const id = 's_' + hex(6);
  q.run('INSERT INTO strategies(id, name, enabled, priority, is_default, config, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)', [id, v.name, v.on ? 1 : 0, v.prio, json(cfgOnly(v)), now(), now()]);
  return getStrategy(id);
}
export function deleteStrategy(id: string) {
  const s = getStrategy(id);
  if (s.isDefault) throw bad('默认策略不能删除');
  if (q.get('SELECT 1 FROM codes WHERE strategy_id = ? LIMIT 1', [id])) throw bad('这条策略下已有兑换码，不能删除，可以改为停用');
  q.run('DELETE FROM strategies WHERE id = ?', [id]);
}
export function ensureDefaultStrategy() {
  if (q.get('SELECT 1 FROM strategies WHERE is_default = 1')) return;
  q.run('INSERT INTO strategies(id, name, enabled, priority, is_default, config, created_at, updated_at) VALUES (?, ?, 1, 99, 1, ?, ?, ?)', ['s_default', '默认策略', json(DEFAULT_CFG), now(), now()]);
}

/* ==================================================================
   规则评估
   ================================================================== */
export interface Verdict { ok: boolean; action?: 'block' | 'manual' | 'captcha'; rule?: string; userMsg?: string; checks: { name: string; ok: boolean | 'warn'; detail: string }[] }

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
export function hhmmNow(tz = config.timezone, d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(/^24/, '00');
}
export function inWindow(t: string, from: string, to: string) {
  const end = to === '24:00' ? '23:60' : to;
  return from <= end ? t >= from && t < end : t >= from || t < end; // 支持跨零点，如 22:00–06:00
}
const list = (s: string) => s.split(/[,，\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);

/** ① 兑换门槛：输码时检查（还没调用卡台） */
export function checkGates(s: Strategy, ctx: { ip: string; device: string; country: string | null; codeCreatedAt: string; codeExpiresAt: string | null }): Verdict {
  const checks: Verdict['checks'] = [];
  const fail = (rule: string, userMsg: string, action: Verdict['action'] = 'block'): Verdict => ({ ok: false, action, rule, userMsg, checks });

  const ipCount = q.get<{ n: number }>('SELECT COUNT(*) n FROM attempts WHERE ip = ? AND at > ?', [ctx.ip, ago(3600e3)])!.n;
  checks.push({ name: 'IP 频率', ok: ipCount < s.ipH, detail: `本小时 ${ipCount} / ${s.ipH} 次` });
  if (ipCount >= s.ipH) return fail(`IP ${ctx.ip} 本小时尝试 ${ipCount} 次（上限 ${s.ipH}）`, '尝试次数过多，请一小时后再试。');

  const devCount = q.get<{ n: number }>("SELECT COUNT(*) n FROM redemptions WHERE browser_device = ? AND status = 'completed' AND created_at > ?", [ctx.device, ago(86400e3)])!.n;
  checks.push({ name: '设备次数', ok: devCount < s.devD, detail: `今日已兑 ${devCount} / ${s.devD} 次` });
  if (devCount >= s.devD) return fail(`设备今日已兑换 ${devCount} 次（上限 ${s.devD}）`, '这台设备今天的兑换次数已达上限，请明天再来。');

  const expAt = ctx.codeExpiresAt || (s.expire ? new Date(new Date(ctx.codeCreatedAt).getTime() + s.expire * 86400e3).toISOString() : null);
  checks.push({ name: '有效期', ok: !expAt || expAt > now(), detail: expAt ? `至 ${expAt.slice(0, 10)}` : '不过期' });
  if (expAt && expAt <= now()) return fail('兑换码已过期', '这个兑换码已过期，请联系卖家。');

  if (s.timeOn) {
    const t = hhmmNow(), okT = inWindow(t, s.from, s.to);
    checks.push({ name: '兑换时段', ok: okT, detail: `${s.from}–${s.to}，当前 ${t}` });
    if (!okT) return fail(`不在兑换时段 ${s.from}–${s.to}（当前 ${t}）`, `当前不在兑换时间（${s.from}–${s.to}），请稍后再来。`);
  }
  const geo = list(s.geo);
  if (geo.length) {
    const hit = !!ctx.country && geo.includes(ctx.country.toLowerCase());
    checks.push({ name: '地区', ok: !hit, detail: ctx.country || '未知（未接入 Cloudflare）' });
    if (hit) return fail(`访问地区 ${ctx.country} 被拦截`, '你所在的地区暂不支持兑换。');
  }
  const failed = q.get<{ n: number }>('SELECT COUNT(*) n FROM attempts WHERE ip = ? AND ok = 0 AND at > ?', [ctx.ip, ago(3600e3)])!.n;
  const needCaptcha = failed >= s.captcha;
  checks.push({ name: '人机验证', ok: needCaptcha ? 'warn' : true, detail: `本小时输错 ${failed} 次 / 阈值 ${s.captcha}` });
  if (needCaptcha) return { ok: false, action: 'captcha', rule: '需要人机验证', userMsg: '请先完成人机验证。', checks };
  return { ok: true, checks };
}

export interface AccountInfo { key: string | null; display: string; email?: string; currentPlan?: string }

/** ② 账号规则：预检后检查 */
export function checkAccount(s: Strategy, product: string, acc: AccountInfo, excludeRedemption?: string): Verdict {
  const checks: Verdict['checks'] = [];
  const fail = (rule: string, userMsg: string): Verdict => ({ ok: false, action: 'block', rule, userMsg, checks });
  if (acc.key) {
    const used = q.get<{ n: number }>(
      "SELECT COUNT(DISTINCT code_id) n FROM redemptions WHERE account_key = ? AND strategy_id = ? AND product = ? AND status IN ('completed','processing','funding','funded','retrying','paid_pending_delivery','manual_review','requires_action') AND created_at > ? AND id != ?",
      [acc.key, s.id, product, ago(s.accDays * 86400e3), excludeRedemption || ''])!.n;
    checks.push({ name: '账号兑换次数', ok: used < s.accN, detail: `${s.accDays} 天内已兑 ${used} / ${s.accN} 次` });
    if (used >= s.accN) return fail(`账号 ${acc.display} ${s.accDays} 天内已兑换 ${used} 次（上限 ${s.accN}）`, `这个账号已经兑换过（每个账号限 ${s.accN} 次）。请更换其他账号，兑换码仍然有效。`);
  }
  if (product === 'gpt' && s.freeOnly) {
    const plan = (acc.currentPlan || '').toLowerCase();
    const free = !plan || plan === 'free';
    checks.push({ name: '只允许 Free', ok: free, detail: `当前 ${acc.currentPlan || '未知'}` });
    if (!free) return fail(`账号当前为 ${acc.currentPlan}，策略只允许 Free 账号`, `这个账号当前已是 ${acc.currentPlan} 会员，不能兑换。请使用未订阅的账号。`);
  }
  const domain = (acc.email || acc.display).split('@')[1]?.toLowerCase();
  if (product === 'gpt' && domain) {
    const allow = list(s.mailAllow), block = list(s.mailBlock);
    const okD = (!allow.length || allow.includes(domain)) && !block.includes(domain);
    checks.push({ name: '邮箱域名', ok: okD, detail: domain });
    if (!okD) return fail(`邮箱域名 ${domain} 不允许`, '这个邮箱类型暂不支持兑换，请使用常用邮箱注册的账号。');
  }
  return { ok: true, checks };
}

/** ③ 价格保护：当前成本比生成时高出多少 */
export function checkPrice(s: Strategy, baseCost: number | null, curCost: number | null): Verdict {
  if (baseCost == null || curCost == null || baseCost <= 0) return { ok: true, checks: [{ name: '价格保护', ok: true, detail: '无参考价，跳过' }] };
  const over = ((curCost - baseCost) / baseCost) * 100;
  const hit = over > s.priceTol;
  const detail = `当前 $${curCost.toFixed(2)}，生成时 $${baseCost.toFixed(2)}，高出 ${over.toFixed(1)}% / 阈值 ${s.priceTol}%`;
  if (!hit || s.priceAct === 'pass') return { ok: true, checks: [{ name: '价格保护', ok: hit ? 'warn' : true, detail }] };
  return {
    ok: false, action: s.priceAct === 'manual' ? 'manual' : 'block', rule: `价格保护：${detail}`,
    userMsg: s.priceAct === 'manual' ? '当前官方价格有波动，需要卖家确认后为你开通。' : '当前官方价格波动较大，暂时无法兑换，请稍后再试。兑换码仍然有效。',
    checks: [{ name: '价格保护', ok: s.priceAct === 'manual' ? 'warn' : false, detail }],
  };
}

/** 总览 / 成功率分析 / 售价与利润 */
import { q } from '../db.ts';
import { config } from '../config.ts';
import { getSetting } from './settings.ts';
import { fullPlanLabel, gptOffers, socialPlans, planKeys } from './catalog.ts';
import { listStrategies } from './strategy.ts';

/** 业务时区的今天 0 点（ISO） */
export function startOfDay(daysAgo = 0) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const d = fmt.format(new Date(Date.now() - daysAgo * 86400e3));
  const offset = tzOffset();
  return new Date(new Date(`${d}T00:00:00Z`).getTime() - offset).toISOString();
}
function tzOffset() {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return local.getTime() - utc.getTime();
}
const FAILED = "('failed','expired')";

function profitOf(rows: { product: string; plan: string; cost_usd: string | null }[]) {
  const retail = getSetting('retail'), fx = getSetting('fx').usdCny;
  let sales = 0, cost = 0, priced = 0;
  for (const r of rows) {
    const p = retail[`${r.product}.${r.plan}`];
    const c = Number(r.cost_usd || 0) * fx;
    cost += c;
    if (p) { sales += p; priced++; }
  }
  return { sales, cost, profit: sales - cost, margin: sales ? (sales - cost) / sales : null, priced, count: rows.length };
}

export function overview() {
  const today = startOfDay();
  const done = q.all<any>("SELECT product, plan, cost_usd FROM redemptions WHERE status = 'completed' AND completed_at >= ?", [today]);
  const daily = Array.from({ length: 10 }, (_, i) => {
    const from = startOfDay(9 - i), to = i === 9 ? new Date(Date.now() + 1000).toISOString() : startOfDay(8 - i);
    return profitOf(q.all<any>("SELECT product, plan, cost_usd FROM redemptions WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?", [from, to])).profit;
  });
  const month = startOfDay(29);
  const issued = q.get<{ n: number }>('SELECT COUNT(*) n FROM codes WHERE created_at >= ?', [month])!.n;
  const issuedPrev = q.get<{ n: number }>('SELECT COUNT(*) n FROM codes WHERE created_at >= ? AND created_at < ?', [startOfDay(59), month])!.n;
  const issuedDaily = Array.from({ length: 7 }, (_, i) => q.get<{ n: number }>('SELECT COUNT(*) n FROM codes WHERE created_at >= ? AND created_at < ?', [startOfDay(6 - i), i === 6 ? new Date(Date.now() + 1000).toISOString() : startOfDay(5 - i)])!.n);
  const r30 = q.get<any>(`SELECT SUM(status='completed') ok, SUM(status IN ${FAILED}) bad, SUM(status IN ('processing','funding','funded','retrying','paid_pending_delivery')) run FROM redemptions WHERE created_at >= ?`, [month])!;
  const blocked = q.all<{ stage: string; n: number }>("SELECT stage, COUNT(*) n FROM redemptions WHERE status = 'blocked' AND created_at >= ? GROUP BY stage", [today]);
  const unused = Object.fromEntries(q.all<any>("SELECT product, COUNT(*) n FROM codes WHERE status = 'unused' GROUP BY product").map(r => [r.product, r.n]));
  const todayBy = Object.fromEntries(q.all<any>("SELECT product, COUNT(*) n FROM redemptions WHERE status = 'completed' AND completed_at >= ? GROUP BY product", [today]).map(r => [r.product, r.n]));
  // 和兑换记录「需处理」页签、侧边栏角标同一个口径
  const attention = q.all<any>("SELECT status, stage, COUNT(*) n FROM redemptions WHERE status IN ('manual_review','requires_action','approved') GROUP BY status, stage");
  const strategies = listStrategies().map(s => {
    const r = q.get<any>("SELECT SUM(status='blocked') blocked, SUM(status='completed') ok, SUM(status='manual_review') review FROM redemptions WHERE strategy_id = ? AND created_at >= ?", [s.id, today])!;
    return { id: s.id, name: s.name, on: s.on, blocked: r.blocked || 0, ok: r.ok || 0, review: r.review || 0 };
  });
  const retried = q.get<{ n: number }>("SELECT COUNT(*) n FROM redemptions WHERE status = 'completed' AND attempts > 1 AND completed_at >= ?", [today])!.n;
  return {
    today: { redeemed: done.length, ...profitOf(done), dailyProfit: daily },
    issued: { month: issued, prev: issuedPrev, daily: issuedDaily },
    success30: { ok: r30.ok || 0, failed: r30.bad || 0, running: r30.run || 0 },
    blockedToday: { total: blocked.reduce((a, b) => a + b.n, 0), byStage: Object.fromEntries(blocked.map(b => [b.stage || 'other', b.n])) },
    unused, todayBy, attention, strategies, retried,
  };
}

export function insights(days: number) {
  const from = startOfDay(days - 1);
  const series = Array.from({ length: Math.min(days, 30) }, (_, i) => {
    const n = Math.min(days, 30), a = startOfDay(n - 1 - i), b = i === n - 1 ? new Date(Date.now() + 1000).toISOString() : startOfDay(n - 2 - i);
    const r = q.get<any>(`SELECT SUM(status='completed') ok, SUM(status IN ${FAILED}) bad FROM redemptions WHERE created_at >= ? AND created_at < ?`, [a, b])!;
    return { day: a.slice(5, 10), ok: r.ok || 0, bad: r.bad || 0 };
  });
  const tot = q.get<any>(`SELECT COUNT(*) n, SUM(status='completed') ok, SUM(status IN ${FAILED}) bad, SUM(status='blocked') blocked FROM redemptions WHERE created_at >= ?`, [from])!;
  const byPlan = q.all<any>(`SELECT product, plan, SUM(status='completed') ok, SUM(status IN ${FAILED}) bad FROM redemptions WHERE created_at >= ? GROUP BY product, plan`, [from])
    .map(r => ({ label: fullPlanLabel(r.product, r.plan), ok: r.ok, bad: r.bad, rate: r.ok + r.bad ? Math.round((r.ok / (r.ok + r.bad)) * 100) : null }));
  const byStrategy = q.all<any>(`SELECT s.name, SUM(r.status='completed') ok, SUM(r.status IN ${FAILED}) bad, SUM(r.status='blocked') blocked, COUNT(*) n FROM redemptions r JOIN strategies s ON s.id = r.strategy_id WHERE r.created_at >= ? GROUP BY s.id`, [from])
    .map(r => ({ name: r.name, rate: r.ok + r.bad ? Math.round((r.ok / (r.ok + r.bad)) * 100) : null, blockRate: r.n ? Math.round((r.blocked / r.n) * 100) : 0 }));
  const reasons = q.all<any>(`SELECT COALESCE(error_code, 'unknown') code, MAX(error_msg) msg, COUNT(*) n FROM redemptions WHERE status IN ${FAILED} AND created_at >= ? GROUP BY COALESCE(error_code, 'unknown') ORDER BY n DESC LIMIT 8`, [from]);
  const blockReasons = q.all<any>("SELECT stage, COUNT(*) n FROM redemptions WHERE status = 'blocked' AND created_at >= ? GROUP BY stage ORDER BY n DESC", [from]);
  return { totals: { n: tot.n, ok: tot.ok || 0, failed: tot.bad || 0, blocked: tot.blocked || 0 }, series, byPlan, byStrategy, reasons, blockReasons };
}

export async function pricing() {
  const retail = getSetting('retail'), fx = getSetting('fx').usdCny, defaults = getSetting('socialDefaults');
  const [offers, xp, tp] = await Promise.all([gptOffers(), socialPlans('x'), socialPlans('tg')]);
  const unused = Object.fromEntries(q.all<any>("SELECT product || '.' || plan k, COUNT(*) n FROM codes WHERE status = 'unused' GROUP BY product, plan").map(r => [r.k, r.n]));
  const sold30 = Object.fromEntries(q.all<any>("SELECT product || '.' || plan k, COUNT(*) n, AVG(CAST(cost_usd AS REAL)) avg FROM redemptions WHERE status = 'completed' AND completed_at >= ? GROUP BY product, plan", [startOfDay(29)]).map(r => [r.k, r]));
  const gpt = planKeys('gpt').map(k => {
    const o = offers.val?.find(x => x.plan === k);
    return { key: k, label: fullPlanLabel('gpt', k), status: o?.pricingStatus ?? null, enabled: !!o?.enabled, cost: o?.salePrice ? Number(o.salePrice) : null, stock: o?.stock ?? null, unused: unused[`gpt.${k}`] || 0, retail: retail[`gpt.${k}`] ?? null, sold30: sold30[`gpt.${k}`]?.n || 0 };
  });
  const social = (kind: 'x' | 'tg', r: typeof xp) => planKeys(kind).map(k => {
    const p = r.val?.plans.find(x => x.key === k), d = defaults[`${kind}.${k}`];
    const avg = sold30[`${kind}.${k}`]?.avg;
    return { key: k, label: fullPlanLabel(kind, k), enabled: p?.enabled ?? null, serviceFee: p ? Number(p.serviceFee) : null, pricingVersion: p?.pricingVersion ?? null,
      defaults: d, costRef: avg ?? (d ? Number(d.fundingAmountUsd) + (p ? Number(p.serviceFee) : 0) : null), unused: unused[`${kind}.${k}`] || 0, retail: retail[`${kind}.${k}`] ?? null, sold30: sold30[`${kind}.${k}`]?.n || 0 };
  });
  return { fx, gpt, x: social('x', xp), tg: social('tg', tp), errors: [offers.error, xp.error, tp.error].filter(Boolean), stale: !!(offers.stale || xp.stale || tp.stale) };
}

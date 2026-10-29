import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from './config.ts';
import { q, now } from './db.ts';

export type Role = 'admin' | 'operator' | 'support';
export interface SessionUser { id: number; email: string; name: string; role: Role; totpEnabled: boolean }
export type AppEnv = { Variables: { user: SessionUser; sid: string } };

export class HttpError extends Error {
  status: number; code?: string; extra?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
    super(message); this.status = status; this.code = code; this.extra = extra;
  }
}
export const bad = (msg: string, code = 'BAD_REQUEST') => new HttpError(400, msg, code);
export const notFound = (msg = '找不到') => new HttpError(404, msg, 'NOT_FOUND');
export const forbidden = (msg = '没有权限执行此操作') => new HttpError(403, msg, 'FORBIDDEN');

export function clientIp(c: Context): string {
  if (config.trustProxy) {
    // 只信任一种来源，客户端自己伪造的另一种头不起作用
    // 截断到 IPv6 的最大长度：配置不对时这个头可能被伪造成任意内容，而它会写进数据库
    if (config.proxyMode === 'cf') { const cf = c.req.header('cf-connecting-ip'); if (cf) return cf.trim().slice(0, 45); }
    else { const xff = c.req.header('x-forwarded-for'); if (xff) return (xff.split(',').map(s => s.trim()).filter(Boolean).pop() || 'unknown').slice(0, 45); }
  }
  try { return getConnInfo(c).remote.address || 'unknown'; } catch { return 'unknown'; }
}
/** 访问者国家代码（需部署在 Cloudflare 后面，或由反向代理注入） */
export function clientCountry(c: Context): string | null {
  if (!config.trustProxy) return null;
  const v = config.proxyMode === 'cf' ? c.req.header('cf-ipcountry') : c.req.header('x-country-code');
  return v && /^[A-Z]{2}$/i.test(v) ? v.toUpperCase() : null;
}

const RANK: Record<Role, number> = { support: 1, operator: 2, admin: 3 };
/** 至少需要某个角色：support(只读) < operator(运营) < admin(管理员) */
export const requireRole = (min: Role): MiddlewareHandler<AppEnv> => async (c, next) => {
  const u = c.get('user');
  if (!u) throw new HttpError(401, '请先登录', 'AUTH_REQUIRED');
  if (RANK[u.role] < RANK[min]) throw forbidden();
  await next();
};

export async function audit(c: Context<AppEnv> | null, action: string, target = '', detail: unknown = '') {
  const u = c?.get('user');
  await q.run('INSERT INTO audit(user_id, user_name, action, target, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    u?.id ?? null, u?.name ?? 'system', action, target, typeof detail === 'string' ? detail : JSON.stringify(detail), c ? clientIp(c) : null, now(),
  ]);
}

export async function body<T = any>(c: Context): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw bad('请求体必须是 JSON'); }
}

/* ---------- 简单内存限流（登录等） ---------- */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const t = Date.now(), b = buckets.get(key);
  if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowMs }); return true; }
  b.n++; return b.n <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60_000).unref();

/* ---------- 校验小工具 ---------- */
export const str = (v: unknown, name: string, { min = 0, max = 2000, opt = false } = {}): string => {
  if (v === undefined || v === null || v === '') { if (opt) return ''; throw bad(`缺少 ${name}`); }
  if (typeof v !== 'string') throw bad(`${name} 必须是字符串`);
  const s = v.trim(); if (s.length < min || s.length > max) throw bad(`${name} 长度不正确`);
  return s;
};
export const int = (v: unknown, name: string, min: number, max: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw bad(`${name} 必须是 ${min}–${max} 的整数`);
  return n;
};
export const oneOf = <T extends string>(v: unknown, name: string, opts: readonly T[]): T => {
  if (!opts.includes(v as T)) throw bad(`${name} 不正确`); return v as T;
};

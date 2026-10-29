/**
 * PostgreSQL 驱动（pg）
 *   - ? 占位符换成 $1…
 *   - BIGINT / NUMERIC 结果转成 JS number（金额都是「分」，在安全整数范围内）
 *   - PostgreSQL 会把没加引号的列别名转成小写：按 SQL 里出现的驼峰标识符还原（例如 createdAt）
 */
import type { Driver, Conn, Param, Result } from './driver.ts';
import { numberPlaceholders, redactUrl, QUERY_TIMEOUT, LOCK_PING_MS } from './driver.ts';

const CAMEL = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g;
const aliasCache = new Map<string, Map<string, string>>();
function camelMap(sql: string) {
  let m = aliasCache.get(sql);
  if (!m) {
    m = new Map();
    for (const id of sql.match(CAMEL) || []) m.set(id.toLowerCase(), id);
    if (aliasCache.size > 2000) aliasCache.clear();
    aliasCache.set(sql, m);
  }
  return m;
}
function restore(sql: string, rows: any[]) {
  const m = camelMap(sql);
  if (!m.size || !rows.length) return rows;
  const keys = Object.keys(rows[0]).filter(k => m.has(k));
  if (!keys.length) return rows;
  for (const r of rows) for (const k of keys) { r[m.get(k)!] = r[k]; delete r[k]; }
  return rows;
}

/** 迁移等长时间的语句：不限时（pg 的 query_timeout 填 0 会退回默认值，所以给一个足够大的数） */
const NO_TIMEOUT = 2 ** 31 - 1;

export async function pgDriver(url: string): Promise<Driver> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, v => Number(v));     // int8 / bigint：COUNT、SUM、自增 id
  pg.types.setTypeParser(1700, v => Number(v));   // numeric：SUM(bigint)、CAST AS DECIMAL
  // 超时：服务端 statement_timeout 取消慢查询（连接还能用）；客户端 query_timeout 兜底网络卡死（连接作废）；
  // 事务里空闲太久（进程卡住）由服务端回滚并断开，释放行锁
  const pool = new pg.Pool({
    connectionString: url, max: Number(process.env.DB_POOL_SIZE) || 10,
    connectionTimeoutMillis: 10_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000,
    statement_timeout: QUERY_TIMEOUT, query_timeout: QUERY_TIMEOUT + 5_000, idle_in_transaction_session_timeout: QUERY_TIMEOUT * 2,
  });
  pool.on('error', e => console.error('[db] PostgreSQL 连接错误', e.message));
  const exec = async (c: { query: (...a: any[]) => Promise<any> }, sql: string, params: Param[]): Promise<Result> => {
    const r = await c.query(numberPlaceholders(sql), params as any[]);
    const rows = restore(sql, r.rows || []);
    return { rows, changes: r.rowCount ?? 0, insertId: rows[0] && 'id' in rows[0] && /^\s*INSERT/i.test(sql) ? Number(rows[0].id) : null };
  };
  // 数据库返回的 SQL 错误（DatabaseError）不影响连接；超时、断线之后连接状态不可知，作废
  const fatal = (e: unknown) => !(e instanceof pg.DatabaseError);
  const acquire = async (): Promise<Conn> => {
    const c = await pool.connect();
    let broken: Error | null = null;
    const guard = async <T>(f: () => Promise<T>) => {
      if (broken) throw broken;
      try { return await f(); } catch (e) { if (fatal(e)) broken = e as Error; throw e; }
    };
    return {
      query: (sql, params) => guard(() => exec(c, sql, params)),
      // 在事务里（迁移）：SET LOCAL 只对这个事务生效
      script: sql => guard(async () => { await c.query('SET LOCAL statement_timeout = 0'); await c.query({ text: sql, query_timeout: NO_TIMEOUT } as any); }),   // pg 支持单条查询的 query_timeout，类型定义里没写
      release: () => c.release(broken ?? undefined),
    };
  };
  await pool.query('SELECT 1');

  let lockClient: InstanceType<typeof pg.Client> | null = null, closing = false;
  return {
    dialect: 'pg', begin: 'BEGIN', describe: `PostgreSQL ${redactUrl(url)}`,
    // pool.query 出错时会自己丢弃那个连接
    query: (sql, params) => exec(pool, sql, params),
    acquire,
    execScript: async sql => { const c = await acquire(); try { await c.script(sql); } finally { c.release(); } },
    async lock(onLost) {
      const c = new pg.Client({ connectionString: url, keepAlive: true, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
      await c.connect();
      // advisory lock 按库区分；这条连接断开（包括进程退出）时自动释放
      const ok = (await c.query("SELECT pg_try_advisory_lock(hashtext('avanfinity-cdk')) AS ok")).rows[0].ok;
      if (!ok) { await c.end(); return false; }
      // 进程卡死 / 网络断开时：会话空闲超过 3 次保活就由数据库断开、释放锁（PostgreSQL 14+）
      await c.query(`SET idle_session_timeout = ${LOCK_PING_MS * 3}`).catch(() => {});
      let lost = false;
      const lose = (e: Error) => { if (closing || lost) return; lost = true; clearInterval(timer); c.end().catch(() => {}); onLost(e); };
      const timer = setInterval(() => { c.query('SELECT 1').catch(lose); }, LOCK_PING_MS);
      timer.unref();
      c.on('error', lose);
      c.on('end', () => lose(new Error('连接已关闭')));
      lockClient = c;
      return true;
    },
    close: async () => { closing = true; await lockClient?.end().catch(() => {}); await pool.end(); },
  };
}

/**
 * MySQL 驱动（mysql2）。要求 MySQL 8.0+（或 MariaDB 10.6+），库字符集 utf8mb4
 *   - DECIMAL / BIGINT 结果转成 JS number
 *   - 用 query（客户端转义）而不是 execute：LIMIT ? 之类的数字参数在服务端预处理时会报错
 */
import type { Driver, Conn, Param, Result } from './driver.ts';
import { splitStatements, redactUrl, QUERY_TIMEOUT, LOCK_PING_MS } from './driver.ts';

/** 8.0.19 起支持行别名；MariaDB 的版本号是 10.x / 11.x，要单独排除 */
function supportsRowAlias(version: string) {
  if (/mariadb/i.test(version)) return false;
  const [a, b, c] = version.split(/[.-]/).map(Number);
  return a > 8 || (a === 8 && (b > 0 || c >= 19));
}

export async function mysqlDriver(url: string): Promise<Driver> {
  const mysql = (await import('mysql2/promise')).default;
  const pool = mysql.createPool({
    uri: url, connectionLimit: Number(process.env.DB_POOL_SIZE) || 10, charset: 'utf8mb4',
    decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: false, dateStrings: true,
    // 时间都以 ISO 字符串存 VARCHAR，不依赖连接时区
  });
  const exec = async (c: { query: (...a: any[]) => Promise<any> }, sql: string, params: Param[], timeout: number | undefined = QUERY_TIMEOUT): Promise<Result> => {
    const [r] = await c.query({ sql, timeout }, params as any[]);
    if (Array.isArray(r)) return { rows: r as any[], changes: 0, insertId: null };
    return { rows: [], changes: (r as any).affectedRows ?? 0, insertId: (r as any).insertId ? Number((r as any).insertId) : null };
  };
  // 每个新连接：双引号按标识符处理（和 SQLite / PostgreSQL 一致）、严格模式。
  // 同一连接上的语句按顺序执行，所以这条一定在业务查询之前生效
  pool.on('connection', (c: any) => { c.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION,ANSI_QUOTES,ONLY_FULL_GROUP_BY', time_zone = '+00:00'"); });
  const version = String((await pool.query('SELECT VERSION() v') as any)[0][0].v);
  // 数据库返回的 SQL 错误（有 sqlState）不影响连接；超时之后那条查询还在连接上跑，断线更不用说，连接作废
  const fatal = (e: any) => e?.fatal || !e?.sqlState;
  const acquire = async (): Promise<Conn> => {
    const c = await pool.getConnection();
    let broken: Error | null = null;
    const guard = async <T>(f: () => Promise<T>) => {
      if (broken) throw broken;
      try { return await f(); } catch (e) { if (fatal(e)) broken = e as Error; throw e; }
    };
    return {
      query: (sql, params) => guard(() => exec(c, sql, params)),
      script: sql => guard(async () => { for (const st of splitStatements(sql)) await exec(c, st, [], undefined); }),
      // 作废的连接直接断开（服务端会回滚它上面没提交的事务），不还回连接池
      release: () => { if (broken) c.destroy(); else c.release(); },
    };
  };
  // 不在事务里的查询也要独占一个连接：超时后才能把那个连接作废，不会还回池里给下一个请求
  const once = async <T>(f: (c: Conn) => Promise<T>) => { const c = await acquire(); try { return await f(c); } finally { c.release(); } };

  let lockConn: any = null, closing = false;
  return {
    dialect: 'mysql', begin: 'START TRANSACTION', describe: `MySQL ${version} ${redactUrl(url)}`, rowAlias: supportsRowAlias(version),
    query: (sql, params) => once(c => c.query(sql, params)),
    acquire,
    execScript: sql => once(c => c.script(sql)),
    async lock(onLost) {
      const c = await mysql.createConnection({ uri: url, connectTimeout: 10_000, enableKeepAlive: true });
      // GET_LOCK 是整个 MySQL 服务器范围的，名字里带上库名；这条连接断开（包括进程退出）时自动释放
      const [[r]] = await c.query({ sql: "SELECT GET_LOCK(CONCAT('cdk:', SHA1(DATABASE())), 0) ok", timeout: 10_000 }) as any;
      if (Number(r.ok) !== 1) { await c.end(); return false; }
      // 进程卡死 / 网络断开时：连接空闲超过 3 次保活就由数据库断开、释放锁
      await c.query(`SET SESSION wait_timeout = ${Math.ceil(LOCK_PING_MS * 3 / 1000)}`);
      let lost = false;
      const lose = (e: Error) => { if (closing || lost) return; lost = true; clearInterval(timer); c.destroy(); onLost(e); };
      const timer = setInterval(() => { c.query({ sql: 'SELECT 1', timeout: 10_000 }).catch(lose); }, LOCK_PING_MS);
      timer.unref();
      c.on('error', lose);
      c.on('end', () => lose(new Error('连接已关闭')));
      lockConn = c;
      return true;
    },
    close: async () => { closing = true; await lockConn?.end().catch(() => {}); await pool.end(); },
  };
}

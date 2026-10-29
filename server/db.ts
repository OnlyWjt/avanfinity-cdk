/**
 * 数据库访问层：SQLite（默认）/ PostgreSQL / MySQL，由 DATABASE_URL 决定
 *
 * 业务代码只用这里导出的 q / tx，SQL 用 ? 占位符，按三种数据库都支持的写法写（见 docs/database.md）。
 *
 * 事务 tx(fn)：
 *   - fn 里的所有查询（包括 await 之后、调用的其他函数里的）都走同一个连接：用 AsyncLocalStorage 传递
 *   - 可以嵌套：外层已在事务里时用 SAVEPOINT，内层失败只回滚自己
 *   - 事务在进程内按顺序执行（互斥）。资金相关的「先检查、再写入」（额度预留、余额扣减等）依赖这一点，
 *     所以系统只能跑一个进程；fn 里不要调用外部接口（卡台、支付平台），只做数据库操作
 *   - SQLite 只有一个连接：事务期间，事务外的查询会等事务结束再执行，不会被卷进事务里
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { config } from './config.ts';
import type { Driver, Conn, Param, Dialect } from './db/driver.ts';
import { SQLITE_MIGRATIONS, BASE_VERSION, LATER_MIGRATIONS, baseSchema } from './db/schema.ts';

let driver: Driver | null = null;
export let dialect: Dialect = 'sqlite';

const drv = () => { if (!driver) throw new Error('数据库还没有初始化（initDb）'); return driver; };

/* ---------------- 连接 ---------------- */
/** DATABASE_URL：postgres://user:pass@host:5432/db | mysql://user:pass@host:3306/db | sqlite:/path/cdk.db；留空用 DATA_DIR/cdk.db */
export function databaseUrl() {
  return process.env.DATABASE_URL || `sqlite:${process.env.DB_FILE || resolve(config.dataDir, 'cdk.db')}`;
}
/**
 * exclusive：应用服务用，拿到实例锁才继续（PostgreSQL / MySQL；同一个库只允许一个实例）。
 * 命令行工具（建管理员、备份、搬库）不拿锁，可以在服务运行时使用
 */
export async function initDb(opts: { exclusive?: boolean } = {}) {
  if (driver) return;
  const url = databaseUrl();
  const connect = async (): Promise<Driver> => {
    if (/^postgres(ql)?:\/\//i.test(url)) return (await import('./db/pg.ts')).pgDriver(url);
    if (/^(mysql|mariadb):\/\//i.test(url)) return (await import('./db/mysql.ts')).mysqlDriver(url.replace(/^mariadb:/i, 'mysql:'));
    if (/^(sqlite|file):/i.test(url)) return (await import('./db/sqlite.ts')).sqliteDriver(url.replace(/^(sqlite|file):(\/\/)?/i, ''));
    throw new Error(`DATABASE_URL 不认识：${url.split(':')[0]}（支持 postgres://、mysql://、sqlite:）`);
  };
  // 数据库服务器可能比应用晚启动（docker compose 一起拉起时）：连不上就重试，最多约 1 分钟
  const tries = Number(process.env.DB_CONNECT_RETRIES ?? 30);
  for (let i = 0; ; i++) {
    try { driver = await connect(); break; }
    catch (e: any) {
      if (/不认识/.test(e?.message) || i >= tries || /^(sqlite|file):/i.test(url)) throw e;
      if (i === 0 || i % 5 === 4) console.warn(`[db] 连接数据库失败，2 秒后重试（${i + 1}/${tries}）：${e?.message || e}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  dialect = driver.dialect;
  console.log(`[db] ${driver.describe}`);
  if (opts.exclusive && driver.lock) await lockInstance(driver);
  await migrate();
}

/**
 * 进程内的事务互斥、限流、兑换锁都要求只有一个实例：两个实例连同一个库会重复扣款、重复跑后台任务。
 * 旧实例可能正在退出（滚动重启），所以拿不到锁时等一会儿再放弃
 */
async function lockInstance(d: Driver) {
  const waitS = Number(process.env.DB_LOCK_WAIT_S ?? 120);
  const onLost = async (e: Error) => {
    console.error(`[db] 实例锁的连接断开了（${e.message}），重新获取…`);
    // 数据库重启这类情况锁已经释放，能立刻拿回来；拿不回来说明另一个实例拿到了，退出，交给 Docker / systemd 重启
    try { if (await d.lock!(onLost)) { console.log('[db] 已重新获取实例锁'); return; } } catch { /* 下面退出 */ }
    console.error('[db] 没能重新获取实例锁，为了不和其他实例同时运行，现在退出');
    process.exit(1);
  };
  for (const start = Date.now(); ;) {
    if (await d.lock!(onLost)) return;
    if (Date.now() - start >= waitS * 1000) {
      throw new Error(`已经有另一个应用实例在使用这个数据库（等了 ${waitS} 秒）。系统只能运行一个实例：先停掉另一个再启动`);
    }
    console.warn('[db] 另一个应用实例正在使用这个数据库，等待它退出…');
    await new Promise(r => setTimeout(r, 5000));
  }
}
/** 关闭数据库：先等排队中的事务都结束 */
export async function closeDb() {
  if (!driver) return;
  await tail;
  await driver.close(); driver = null;
}

/* ---------------- 事务 ---------------- */
/**
 * Root：一个顶层事务（独占一个连接）。pending 是还没完成的数据库操作数：
 * 事务函数返回时还有没完成的，说明有调用漏了 await，它会在提交之后才执行，事务就只写了一半
 * Frame：一层事务（顶层或某个保存点）。同一层里的嵌套事务排队执行：保存点是栈结构，交错执行会互相释放；
 * 每一层有自己的队列，嵌套多层也不会等自己的上层
 */
interface Root { conn: Conn; done: boolean; pending: number; seq: number }
/** 事务结束后连接已经还回连接池（可能正被别的请求使用）：迟到的操作直接报错，不能再往这个连接上发语句 */
const rq = (root: Root, sql: string, params: Param[] = []) => {
  if (root.done) return Promise.reject(new Error('事务已经结束，这个数据库操作没有执行（调用处漏了 await）'));
  return root.conn.query(sql, params);
};
interface Frame { root: Root; chain: Promise<unknown> }
const als = new AsyncLocalStorage<Frame>();
let tail: Promise<void> = Promise.resolve();
let active: Promise<void> | null = null;
let activeSince = 0;
/** 当前事务已经执行了多久（毫秒，没有事务时为 0）。事务排队执行，一个卡住会挡住所有写入：给健康检查用 */
export const txBusyMs = () => (active ? Date.now() - activeSince : 0);
/**
 * 当前所在的事务层。事务已经结束（回滚或提交）但还在它的调用链上的操作是漏了 await 的迟到操作：
 * 不能改成在事务外单独执行（那样已回滚事务的一部分写入会单独生效），直接报错。
 * 注意：事务函数里不要用 setTimeout / setImmediate 安排数据库操作，回调会继承事务上下文
 */
const current = () => {
  const f = als.getStore();
  if (f?.root.done) throw new Error('事务已经结束，这个数据库操作没有执行（调用处漏了 await）');
  return f;
};
export const inTx = () => !!current();

export async function tx<T>(fn: () => Promise<T> | T): Promise<T> {
  const f = current();
  if (!f) return top(fn);
  f.root.pending++;
  try {
    const run = f.chain.then(() => savepoint(f.root, fn));
    f.chain = run.catch(() => {});
    return await run;
  } finally { f.root.pending--; }
}

async function savepoint<T>(root: Root, fn: () => Promise<T> | T): Promise<T> {
  const sp = `sp${++root.seq}`;
  await rq(root, `SAVEPOINT ${sp}`);
  try {
    const r = await als.run({ root, chain: Promise.resolve() }, fn);
    await rq(root, `RELEASE SAVEPOINT ${sp}`);
    return r;
  } catch (e) {
    // 回滚到保存点失败（例如数据库已经因为这个错误把整个事务回滚了）时，抛出原来的错误，外层事务会整体回滚
    try { await rq(root, `ROLLBACK TO SAVEPOINT ${sp}`); await rq(root, `RELEASE SAVEPOINT ${sp}`); }
    catch (e2) { if (process.env.DB_DEBUG) console.warn('[db] 回滚保存点失败', (e2 as Error).message); }
    throw e;
  }
}

async function top<T>(fn: () => Promise<T> | T): Promise<T> {
  // 进程内互斥：排队，前一个事务结束才开始
  let release!: () => void;
  const mine = new Promise<void>(r => (release = r));
  const prev = tail; tail = prev.then(() => mine);
  await prev;
  active = mine; activeSince = Date.now();
  let conn: Conn;
  try { conn = await drv().acquire(); } catch (e) { active = null; release(); throw e; }
  const root: Root = { conn, done: false, pending: 0, seq: 0 };
  try {
    await conn.query(drv().begin, []);
    const r = await als.run({ root, chain: Promise.resolve() }, fn);
    if (root.pending > 0) throw new Error(`事务里有 ${root.pending} 个数据库操作没有 await（会在提交后才执行），已回滚`);
    // 先标记结束再发 COMMIT / ROLLBACK：之后迟到的操作不会再排到这个连接上（否则会在事务外单独生效）
    root.done = true;
    await conn.query('COMMIT', []);
    return r;
  } catch (e) {
    root.done = true;
    await conn.query('ROLLBACK', []).catch(() => {});
    throw e;
  } finally {
    root.done = true;
    conn.release();
    if (active === mine) active = null;
    release();
  }
}

/* ---------------- 查询 ---------------- */
type Params = unknown[] | string | number | null | undefined;
const norm = (p?: Params): Param[] =>
  (p === undefined ? [] : Array.isArray(p) ? p : [p]).map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param)));

async function exec(sql: string, params: Param[]) {
  const f = current();
  if (f) { f.root.pending++; try { return await rq(f.root, sql, params); } finally { f.root.pending--; } }
  if (dialect === 'sqlite') while (active) await active;   // 单连接：等正在进行的事务结束
  return drv().query(sql, params);
}

const quoteCols = (cols: string[]) => cols.map(c => `"${c}"`).join(', ');

export const q = {
  async get<T = any>(sql: string, p?: Params): Promise<T | undefined> { return (await exec(sql, norm(p))).rows[0] as T | undefined; },
  async all<T = any>(sql: string, p?: Params): Promise<T[]> { return (await exec(sql, norm(p))).rows as T[]; },
  /** 返回影响的行数：条件更新（WHERE status = …）靠它判断有没有抢到 */
  async run(sql: string, p?: Params): Promise<{ changes: number }> { return { changes: (await exec(sql, norm(p))).changes }; },
  /** 插入自增主键（列名 id）的表，返回新行 id */
  async insert(sql: string, p?: Params): Promise<number> {
    const r = await exec(dialect === 'pg' ? `${sql} RETURNING id` : sql, norm(p));
    if (r.insertId == null) throw new Error('插入后没有拿到 id');
    return r.insertId;
  },
  /** 唯一键冲突时不插入，返回插入的行数（0 = 已存在） */
  async insertIgnore(sql: string, p?: Params): Promise<number> {
    // MySQL 不用 INSERT IGNORE：它会把外键不存在、字段为空、超长截断也变成警告，看起来就像「已存在」。
    // 改成普通 INSERT，只把唯一键冲突（1062）当作已存在；MySQL 里失败的语句只回滚自己，不影响所在事务
    if (dialect === 'mysql') {
      try { await exec(sql, norm(p)); return 1; }
      catch (e: any) { if (e?.errno === 1062) return 0; throw e; }
    }
    const s = dialect === 'pg' ? `${sql} ON CONFLICT DO NOTHING` : sql.replace(/^\s*INSERT\s+INTO/i, 'INSERT OR IGNORE INTO');
    return (await exec(s, norm(p))).changes > 0 ? 1 : 0;
  },
  /** 按唯一键插入或更新 */
  async upsert(table: string, row: Record<string, unknown>, keys: string[], update: string[]) {
    const cols = Object.keys(row);
    const head = `INSERT INTO ${table} (${quoteCols(cols)}) VALUES (${cols.map(() => '?').join(', ')})${sql.insertedAlias()}`;
    const set = update.map(c => `"${c}" = ${sql.inserted(c)}`).join(', ');
    await exec(dialect === 'mysql' ? `${head} ON DUPLICATE KEY UPDATE ${set}` : `${head} ON CONFLICT (${quoteCols(keys)}) DO UPDATE SET ${set}`,
      norm(cols.map(c => row[c]) as unknown[]));
  },
};

/**
 * 三种数据库写法不同的 SQL 片段（返回 SQL 文本，参数仍然用 ?）。只在函数里调用（要等 initDb 之后才知道是哪种数据库）
 */
export const sql = {
  /** JSON 文本列里取一个字段（文本） */
  json: (col: string, key: string) => dialect === 'pg' ? `(${col}::json ->> '${key}')` : dialect === 'mysql' ? `JSON_UNQUOTE(JSON_EXTRACT(${col}, '$.${key}'))` : `json_extract(${col}, '$.${key}')`,
  /** 两个数中较大的那个（SQLite 的 MAX(a, b) 在别的数据库是聚合函数） */
  greatest: (a: string, b: string) => dialect === 'sqlite' ? `MAX(${a}, ${b})` : `GREATEST(${a}, ${b})`,
  /** 十进制字符串列转成数字参与计算（金额 USD 存的是字符串） */
  num: (expr: string) => `CAST(${expr} AS DECIMAL(20,6))`,
  /** 转成文本（MySQL 只认 CHAR） */
  text: (expr: string) => dialect === 'mysql' ? `CAST(${expr} AS CHAR)` : `CAST(${expr} AS TEXT)`,
  /**
   * 插入或更新时引用「这次要插入的值」：接在 VALUES (...) 后面写 insertedAlias()，更新部分用 inserted('列名')。
   * MySQL 8.0.19+ 用行别名（VALUES() 写法已废弃）；更早的 MySQL 和 MariaDB 不支持行别名，仍用 VALUES()
   */
  insertedAlias: () => (dialect === 'mysql' && driver?.rowAlias ? ' AS ins' : ''),
  inserted: (col: string) => dialect !== 'mysql' ? `excluded."${col}"` : driver?.rowAlias ? `ins."${col}"` : `VALUES("${col}")`,
};

export const now = () => new Date().toISOString();
export const json = (v: unknown) => JSON.stringify(v ?? null);
export const parse = <T = any>(s: string | null | undefined, def: T): T => { try { return s ? JSON.parse(s) : def; } catch { return def; } };

/* ---------------- 迁移 ---------------- */
async function script(sql: string) { const f = current(); if (f) await f.root.conn.script(sql); else await drv().execScript(sql); }

async function migrate() {
  await script('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, at VARCHAR(40) NOT NULL)');
  let cur = Number((await q.get<{ v: number | null }>('SELECT MAX(version) v FROM _migrations'))?.v ?? 0);
  // MySQL 的 DDL 会隐式提交，放进事务也没用；SQLite / PostgreSQL 的 DDL 可以回滚
  const step = async (version: number, sql: string) => {
    const body = async () => { await script(sql); await q.run('INSERT INTO _migrations (version, at) VALUES (?, ?)', [version, now()]); };
    if (dialect === 'mysql') await body(); else await tx(body);
    console.log(`[db] migration ${version} applied`);
  };
  if (dialect === 'sqlite') {
    for (let v = cur; v < SQLITE_MIGRATIONS.length; v++) await step(v + 1, SQLITE_MIGRATIONS[v]);
    cur = Math.max(cur, SQLITE_MIGRATIONS.length);
  } else if (cur === 0) {
    await step(BASE_VERSION, baseSchema(dialect));
    cur = BASE_VERSION;
  } else if (cur < BASE_VERSION) throw new Error(`数据库版本 ${cur} 不完整（新建库应直接是第 ${BASE_VERSION} 版），请检查 _migrations 表`);
  for (let v = cur; v < BASE_VERSION + LATER_MIGRATIONS.length; v++) await step(v + 1, LATER_MIGRATIONS[v - BASE_VERSION][dialect]);
}

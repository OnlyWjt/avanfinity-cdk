/** 数据库驱动接口：SQLite / PostgreSQL / MySQL 都实现它，业务代码只通过 server/db.ts 使用 */
export type Dialect = 'sqlite' | 'pg' | 'mysql';
export type Param = string | number | bigint | null | Uint8Array;

export interface Result { rows: any[]; changes: number; insertId: number | null }

/** 一个数据库连接：事务期间独占，用完 release */
export interface Conn {
  query(sql: string, params: Param[]): Promise<Result>;
  /** 执行多条 DDL（迁移用，不受查询超时限制） */
  script(sql: string): Promise<void>;
  /** 还回连接池；出过超时 / 断线的连接直接丢弃，不再给别人用 */
  release(): void;
}

export interface Driver {
  dialect: Dialect;
  /** 不在事务里的查询：用连接池里的任意连接 */
  query(sql: string, params: Param[]): Promise<Result>;
  /** 拿一个独占连接（事务用） */
  acquire(): Promise<Conn>;
  /** 不在事务里执行多条 DDL */
  execScript(sql: string): Promise<void>;
  /** 开始事务的语句 */
  begin: string;
  close(): Promise<void>;
  /** 用于日志，不含密码 */
  describe: string;
  /** MySQL 8.0.19+ 支持 INSERT … AS 别名 ON DUPLICATE KEY UPDATE（更早的版本和 MariaDB 只能用 VALUES()） */
  rowAlias?: boolean;
  /**
   * 实例锁（PostgreSQL / MySQL）：用一条单独的连接持有数据库锁，同一个库只允许一个应用实例。
   * 拿不到返回 false；拿到后连接断开（锁随之释放）时调用 onLost
   */
  lock?(onLost: (e: Error) => void): Promise<boolean>;
}

/** 查询超时（毫秒）：一条查询卡住时报错并丢弃连接，不让它一直占着事务队列 */
export const QUERY_TIMEOUT = Number(process.env.DB_QUERY_TIMEOUT_MS) || 30_000;
/** 实例锁连接的保活间隔；数据库在 3 倍这么久没收到保活时断开会话、释放锁（进程异常退出时用） */
export const LOCK_PING_MS = 30_000;

/** 把 SQL 按分号拆成单条（跳过引号和注释里的分号），给不支持一次执行多条语句的驱动用 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '', i = 0, quote: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 把 ? 占位符换成 $1、$2…（PostgreSQL），跳过引号里的问号 */
export function numberPlaceholders(sql: string): string {
  let n = 0, quote: string | null = null, out = '';
  for (const ch of sql) {
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? '$' + ++n : ch;
  }
  return out;
}

/** 脱敏的连接串，用于日志 */
export const redactUrl = (u: string) => u.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');

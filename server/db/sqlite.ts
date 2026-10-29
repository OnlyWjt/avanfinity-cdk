/**
 * SQLite 驱动（Node 内置 node:sqlite，同步 API 包成异步接口）。
 * 只有一个连接：事务期间其他查询必须等事务结束（由 server/db.ts 的事务锁保证），否则会被卷进事务里
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Driver, Conn, Param, Result } from './driver.ts';

const READS = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i;

export function sqliteDriver(file: string): Driver {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const run = (sql: string, params: Param[]): Result => {
    const st = db.prepare(sql);
    if (READS.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: st.all(...(params as any[])), changes: 0, insertId: null };
    const r = st.run(...(params as any[]));
    return { rows: [], changes: Number(r.changes), insertId: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) };
  };
  const conn: Conn = { query: async (sql, params) => run(sql, params), script: async sql => { db.exec(sql); }, release() { /* 单连接，无需释放 */ } };
  return {
    dialect: 'sqlite', begin: 'BEGIN IMMEDIATE', describe: `SQLite ${file}`,
    query: async (sql, params) => run(sql, params),
    acquire: async () => conn,
    execScript: conn.script,
    close: async () => { db.close(); },
  };
}

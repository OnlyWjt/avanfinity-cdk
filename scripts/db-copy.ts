/**
 * 把数据从一个数据库完整复制到另一个（例如 SQLite → PostgreSQL / MySQL）
 *
 *   FROM_DATABASE_URL=sqlite:data/cdk.db TO_DATABASE_URL=postgres://cdk:密码@localhost:5432/cdk node --no-warnings scripts/db-copy.ts
 *
 * - 先停掉服务再复制（复制期间不能有新数据写进源库）
 * - 目标库必须是空的：程序会先在目标库建好表结构，有数据就拒绝执行
 * - 两边要用同一个 MASTER_KEY（数据里的兑换码、密钥是用它加密的，复制不会重新加密）
 * - 复制完会逐表核对行数；之后把 .env 的 DATABASE_URL 改成目标库再启动
 */
import { initDb, closeDb, q, dialect } from '../server/db.ts';

const FROM = process.env.FROM_DATABASE_URL, TO = process.env.TO_DATABASE_URL;
if (!FROM || !TO) { console.error('用法：FROM_DATABASE_URL=… TO_DATABASE_URL=… node --no-warnings scripts/db-copy.ts'); process.exit(1); }
if (FROM === TO) { console.error('源库和目标库相同'); process.exit(1); }

/** 按外键依赖排好的顺序：被引用的表在前 */
const TABLES = [
  'users', 'sessions', 'audit', 'settings', 'strategies', 'batches', 'codes', 'upstream_codes', 'redemptions', 'attempts', 'webhook_events', 'transactions',
  'shop_categories', 'shop_products', 'customers', 'customer_sessions', 'agent_levels', 'agents', 'agent_prices', 'coupons', 'coupon_uses', 'orders', 'order_codes',
  'payments', 'ledger', 'withdrawals', 'mail_log', 'direct_spend',
];
/** 有自增 id 的表（PostgreSQL 复制后要把序列调到最大 id 之后） */
const AUTO_ID = ['users', 'audit', 'attempts', 'shop_categories', 'customers', 'agent_levels', 'coupons', 'coupon_uses', 'ledger', 'withdrawals', 'mail_log', 'direct_spend'];

// 两边都拿实例锁（PostgreSQL / MySQL）：应用还连着源库或目标库时直接拒绝，不等待
process.env.DB_LOCK_WAIT_S = '0';
const open = (url: string) => {
  process.env.DATABASE_URL = url;
  return initDb({ exclusive: true }).catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
};

// 1. 读出源库全部数据（同一时间只能连一个库：db.ts 是单例）
await open(FROM);
const ver = (await q.get<{ v: number }>('SELECT MAX(version) v FROM _migrations'))?.v;
const data: Record<string, any[]> = {};
for (const t of TABLES) data[t] = await q.all(`SELECT * FROM ${t}`);
console.log(`源库（${dialect}，结构版本 ${ver}）：` + TABLES.map(t => `${t} ${data[t].length}`).join('，'));
await closeDb();

// 2. 写入目标库
await open(TO);   // 建好表结构
const dver = (await q.get<{ v: number }>('SELECT MAX(version) v FROM _migrations'))?.v;
if (dver !== ver) { console.error(`✗ 结构版本不一致：源库 ${ver}，目标库 ${dver}。请先用同一个版本的程序启动一次源库，让它升级到最新`); process.exit(1); }
for (const t of TABLES) {
  const n = (await q.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`))!.n;
  if (n && !(t === 'strategies' || t === 'agent_levels')) { console.error(`✗ 目标库的 ${t} 已经有 ${n} 行数据，只能复制到空库`); process.exit(1); }
}
const { tx } = await import('../server/db.ts');
// 整个复制在一个事务里（同一个连接）：失败就全部回滚，目标库保持为空
await tx(async () => {
  // 目标库建表时不会自动插数据，但保险起见清掉默认策略 / 默认代理等级，用源库的数据
  await q.run('DELETE FROM agent_levels'); await q.run('DELETE FROM strategies');
  for (const t of TABLES) {
    const rows = data[t];
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const head = `INSERT INTO ${t} (${cols.map(c => `"${c}"`).join(', ')}) VALUES `;
    // 分批插入，避免单条语句太长
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await q.run(head + chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', '), chunk.flatMap(r => cols.map(c => r[c])));
    }
  }
  if (dialect === 'pg') for (const t of AUTO_ID) await q.run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1), (SELECT COUNT(*) > 0 FROM ${t}))`);
});

// 3. 核对
let bad = 0;
for (const t of TABLES) {
  const n = (await q.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`))!.n;
  if (n !== data[t].length) { console.error(`✗ ${t}：源 ${data[t].length} 行，目标 ${n} 行`); bad++; }
}
await closeDb();
if (bad) process.exit(1);
console.log(`✓ 已复制到目标库（${dialect}），每张表行数一致。把 .env 的 DATABASE_URL 改成目标库后启动服务`);

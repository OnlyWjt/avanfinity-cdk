# 数据库开发说明

系统支持 SQLite（默认）、PostgreSQL、MySQL，由 `DATABASE_URL` 选择。业务代码只用 `server/db.ts` 导出的接口，同一份 SQL 在三种数据库上运行。部署和备份见 [deploy.md](deploy.md)。

## 结构

```
server/db.ts           对外接口：initDb / q / tx / sql 片段 / 迁移
server/db/driver.ts    驱动接口、占位符转换
server/db/sqlite.ts    node:sqlite（单连接）
server/db/pg.ts        pg（连接池）
server/db/mysql.ts     mysql2（连接池）
server/db/schema.ts    表结构与迁移
```

## 查询接口（全部是异步的）

```ts
import { q, tx, sql, dialect } from '../db.ts';

const row  = await q.get<T>('SELECT … WHERE id = ?', [id]);   // 第一行或 undefined
const rows = await q.all<T>('SELECT …', [a, b]);
const { changes } = await q.run('UPDATE … WHERE id = ? AND status = ?', [id, 'pending']);
const id   = await q.insert('INSERT INTO coupons(…) VALUES (?, ?)', [...]);       // 自增主键表，返回新 id
const n    = await q.insertIgnore('INSERT INTO order_codes(…) VALUES (?, ?)', [...]); // 唯一键冲突时不插入，返回 0 / 1
await q.upsert('settings', { key, value, updated_at }, ['key'], ['value', 'updated_at']); // 按唯一键插入或更新
```

- 占位符一律用 `?`（PostgreSQL 驱动会自动换成 `$1…`）
- `run` 返回的 `changes` 是「条件更新抢没抢到」的依据，例如 `UPDATE orders SET status='paid' WHERE no=? AND status='pending'`
- 布尔值存 `INTEGER 0/1`，金额存整数「分」（USD 的十进制字符串除外），时间存 ISO 字符串（`now()`）

## 事务

```ts
await tx(async () => {
  if (!(await q.run("UPDATE … WHERE … AND status = 'paid'", [...])).changes) return false;
  await customers.credit(...);   // 里面的 tx 会变成 SAVEPOINT
  return true;
});
```

- `fn` 里的所有数据库操作（包括调用的其他函数里的）都在同一个事务、同一个连接上，靠 AsyncLocalStorage 传递，不用手动传连接
- **所有数据库调用都要 `await`**。事务结束时还有没完成的操作会报错并整体回滚；事务结束后才执行的操作会直接报错，不会悄悄在事务外生效
- 事务在进程内**排队执行**（互斥）：资金相关的「先检查、再写入」（额度预留、余额扣减、优惠券占用、账号名额）依赖这一点。所以系统只能跑一个进程（PostgreSQL / MySQL 上启动时会拿数据库锁，第二个实例起不来）
- **互斥只管事务和事务之间**。PostgreSQL / MySQL 上，事务外的单条写入不会等事务结束，可以插在事务的「检查」和「写入」之间（SQLite 只有一个连接，事务外的语句会等，所以本地用 SQLite 测不出来）。因此：
  - 参与「先检查、再写入」的数据，**所有写入都要放进 `tx`**（例如优惠券占用、余额扣减都在下单 / 退款的事务里）
  - 或者写成带条件的单条语句，靠 `changes` 判断抢没抢到：`UPDATE customers SET balance = balance - ? WHERE id = ? AND balance >= ?`
  - 不要在事务外 `SELECT` 检查、再在事务外 `UPDATE`
- 每条查询有超时（`DB_QUERY_TIMEOUT_MS`，默认 30 秒）：超时报错，事务回滚，那个连接作废。事务是排队的，一个卡住会挡住所有写入，所以事务要短；`/healthz` 在事务超过 60 秒时返回 503，超过 5 分钟进程退出重启
- 事务里不要调用外部接口（卡台、支付平台、邮件），也不要用 `setTimeout` / `setImmediate` 安排数据库操作（回调会继承事务上下文，事务结束后执行就会报错）
- 嵌套的 `tx` 用 SAVEPOINT：内层失败只回滚自己；外层失败全部回滚
- SQLite 只有一个连接：事务进行时，事务外的查询会等它结束

## 写 SQL 要注意的

三种数据库都支持的写法才能用。下面这些已经在代码里统一处理过，新写的 SQL 照着做：

| 不要写（只有 SQLite 支持） | 改成 |
|---|---|
| `SUM(status = 'x')` | `SUM(CASE WHEN status = 'x' THEN 1 ELSE 0 END)` |
| `MAX(a, b)`（两个参数） | `${sql.greatest('a', 'b')}` |
| `json_extract(col, '$.k')` | `${sql.json('col', 'k')}` |
| `CAST(x AS REAL)` | `${sql.num('x')}`（`DECIMAL(20,6)`） |
| `CAST(x AS TEXT)` | `${sql.text('x')}` |
| `a \|\| b`（拼接字符串） | `CONCAT(a, b)` |
| `INSERT OR IGNORE` / `ON CONFLICT … DO UPDATE` | `q.insertIgnore(...)` / `q.upsert(...)`；要在更新里写表达式（例如 `COALESCE`）时手写，用 `${sql.insertedAlias()}` 和 `${sql.inserted('列')}`，见 `webhook.ts` 的 `saveTx` |
| MySQL 的 `INSERT IGNORE` | `q.insertIgnore(...)`（它只忽略唯一键冲突；`INSERT IGNORE` 会把外键错误、超长截断也悄悄忽略） |
| `ORDER BY rowid` | 显式的排序列（例如 `codes.seq`） |
| `col IS ?`（参数可能为 NULL） | 分开写 `IS NULL` 和 `= ?` 两种 |
| `julianday()`、`date()`、`strftime()` | 在程序里算时间，SQL 里只比较 ISO 字符串 |
| 依赖 `COLLATE NOCASE` / `LIKE` 不区分大小写 | 写入前统一大小写（邮箱、店铺地址小写，券码大写）；模糊搜索用 `LOWER(col) LIKE LOWER(?)` |
| `LIMIT ?` 放在子查询里 | 只在最外层用 `LIMIT ? OFFSET ?` |

其他：

- 列名 `key` 等关键字用双引号：`"key"`（MySQL 连接开启了 `ANSI_QUOTES`，双引号是标识符）
- 列别名用驼峰时（`created_at createdAt`），PostgreSQL 驱动会自动还原大小写，不用加引号
- `COUNT(*)`、`SUM()` 的结果驱动会转成 JS number
- 文本列：短的（会建索引、做比较）在 PG / MySQL 里是 `VARCHAR(255)`；长的（JSON、加密内容）是 `TEXT` / `LONGTEXT`。新列按这个区分
- 写进短文本列的值要在程序里限制长度（用户输入用 `str(..., { max })`，卡台返回的、请求头里的用 `.slice()`）：SQLite 不限长度，PG / MySQL 超长会报错

## 改表结构（迁移）

`server/db/schema.ts`：

- **SQLite**：`SQLITE_MIGRATIONS` 是逐版本的迁移，只追加、不修改
- **PostgreSQL / MySQL**：新库直接用 `baseSchema()` 建成最新结构（等于 SQLite 全部迁移之后），版本号记为 `BASE_VERSION`
- 以后改结构：在 `LATER_MIGRATIONS` 末尾加一项，三种数据库各写一份 SQL：

  ```ts
  export const LATER_MIGRATIONS: Record<Dialect, string>[] = [
    /* 10 */ {
      sqlite: `ALTER TABLE orders ADD COLUMN memo TEXT;`,
      pg:     `ALTER TABLE orders ADD COLUMN memo TEXT;`,
      mysql:  `ALTER TABLE orders ADD COLUMN memo LONGTEXT;`,
    },
  ];
  ```

  不要再往 `SQLITE_MIGRATIONS` 里加（否则 PG / MySQL 那边对不上）。
- 数据状态不满足时不能升级的（例如删表前表里还有没处理完的数据），在 `MIGRATION_CHECKS` 里按版本号写检查：抛错会让启动失败，数据库不变（第 9 版的检查就是一个例子）
- 迁移在启动时自动执行。SQLite / PostgreSQL 的迁移在事务里，失败会回滚；MySQL 的 DDL 会自动提交，迁移失败可能停在一半，所以 MySQL 上升级前一定要备份

## 测试

```bash
npm test                                                        # SQLite
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/cdk_test npm test
TEST_DATABASE_URL=mysql://user:pass@localhost:3306/cdk_test npm test
```

测试开始前会**清空** `TEST_DATABASE_URL` 指向的库，所以库名必须包含 `test`，否则拒绝执行。

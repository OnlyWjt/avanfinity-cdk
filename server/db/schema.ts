/**
 * 数据库结构
 *
 * SQLite：沿用原来的逐版本迁移（SQLITE_MIGRATIONS，只追加不修改）
 * PostgreSQL / MySQL：新库直接建成和 SQLite 最后一版一致的结构（baseSchema），之后的变更写进 LATER_MIGRATIONS
 *
 * 加新迁移：在 LATER_MIGRATIONS 末尾追加一项，三种数据库各写一份 SQL（写法相同就填同一段）。
 * 不要修改已经发布的迁移。
 */
import type { Dialect } from "./driver.ts";

export const SQLITE_MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','operator','support')),
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    last_login_ip TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                 -- token 的 sha256
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage TEXT NOT NULL DEFAULT 'full',  -- 'totp' = 密码已过、待两步验证
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT, ua TEXT
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    user_id INTEGER, user_name TEXT,
    action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX audit_at ON audit(at);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE strategies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 10,
    is_default INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    product TEXT NOT NULL CHECK (product IN ('gpt','x','tg')),
    plan TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('own','hosted')),
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    params TEXT NOT NULL,                -- 生成参数快照（成本上限、币种、强制新卡等）
    cost_usd TEXT,                       -- 生成时的单码参考成本
    memo TEXT,
    idem_key TEXT NOT NULL,
    created_by INTEGER, created_at TEXT NOT NULL
  );

  CREATE TABLE codes (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batches(id),
    product TEXT NOT NULL, plan TEXT NOT NULL, mode TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    code_enc TEXT,                       -- 完整码（加密）；托管 GPT 码过了恢复窗口后可能为空
    code_hash TEXT UNIQUE,
    display TEXT NOT NULL,               -- 列表展示用前缀，如 TB-7K2Q-••••
    status TEXT NOT NULL DEFAULT 'unused',  -- unused | in_use | redeemed | revoked
    upstream_id TEXT,                    -- 托管码：卡台 CDK id
    upstream_status TEXT,
    account TEXT,                        -- 兑换账号（脱敏）
    redemption_id TEXT,                  -- 当前 / 最终兑换记录
    expires_at TEXT,
    created_at TEXT NOT NULL, redeemed_at TEXT
  );
  CREATE INDEX codes_batch ON codes(batch_id);
  CREATE INDEX codes_status ON codes(product, status);
  CREATE INDEX codes_upstream ON codes(upstream_id);

  -- 自有码模式下，兑换时向卡台临时生成的码（每次尝试一张）
  CREATE TABLE upstream_codes (
    id TEXT PRIMARY KEY,                 -- 卡台 CDK id
    code_id TEXT NOT NULL REFERENCES codes(id),
    product TEXT NOT NULL, plan TEXT NOT NULL,
    code_enc TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'issued',  -- issued | used | released | failed | revoked
    created_at TEXT NOT NULL
  );
  CREATE INDEX upstream_codes_code ON upstream_codes(code_id);

  CREATE TABLE redemptions (
    id TEXT PRIMARY KEY,
    code_id TEXT NOT NULL REFERENCES codes(id),
    product TEXT NOT NULL, plan TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    account TEXT,                        -- 展示用（脱敏）
    account_key TEXT,                    -- 账号唯一键哈希，用于「同一账号限兑」
    ip TEXT, browser_device TEXT, country TEXT,
    upstream_code_id TEXT,
    device TEXT NOT NULL,                -- 发给卡台的设备 UUID / deviceToken
    client_request_id TEXT,
    redemption_token_enc TEXT,
    preflight_token_enc TEXT,
    quote TEXT,                          -- 报价快照
    cost_usd TEXT,
    rule TEXT,                           -- 命中的策略规则
    attempts INTEGER NOT NULL DEFAULT 1,
    error_code TEXT, error_msg TEXT,
    order_id TEXT, card_last4 TEXT,
    progress TEXT,                       -- 公开进度时间线
    invoice_urls TEXT,
    review TEXT,                         -- 人工审核：pending | approved | rejected
    next_poll_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
  );
  CREATE INDEX red_code ON redemptions(code_id);
  CREATE INDEX red_status ON redemptions(status);
  CREATE INDEX red_created ON redemptions(created_at);
  CREATE INDEX red_account ON redemptions(account_key, strategy_id);

  CREATE TABLE attempts (
    id INTEGER PRIMARY KEY,
    ip TEXT, device TEXT, code_hash TEXT,
    ok INTEGER NOT NULL, reason TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX attempts_ip ON attempts(ip, at);
  CREATE INDEX attempts_dev ON attempts(device, at);

  CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX wh_received ON webhook_events(received_at);

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    auth_time TEXT,
    card_last4 TEXT,
    redemption_id TEXT,
    data TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );
  CREATE INDEX tx_time ON transactions(auth_time);
  `,
  /* 2 商城：商品、订单、支付、买家、优惠券、代理。金额单位：分（USDT 为 1e-6） */ `
  CREATE TABLE shop_products (
    id TEXT PRIMARY KEY,
    product TEXT NOT NULL, plan TEXT NOT NULL,
    title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', badge TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL,              -- 零售价
    agent_price INTEGER NOT NULL,        -- 代理基础进货价
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    stock_limit INTEGER,                 -- 可售上限，NULL 不限
    sold INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0,
    max_per_order INTEGER NOT NULL DEFAULT 10,
    enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    reset_hash TEXT, reset_expires TEXT,
    created_at TEXT NOT NULL, last_login_at TEXT
  );
  CREATE TABLE customer_sessions (
    id TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );

  CREATE TABLE agent_levels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    wholesale_pct INTEGER NOT NULL DEFAULT 100,  -- 进货价 = 代理基础价 × wholesale_pct%
    commission_pct REAL NOT NULL DEFAULT 0,       -- 推广佣金 = 实付 × commission_pct%
    is_default INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE agents (
    customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    shop_name TEXT NOT NULL, notice TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '',
    level_id INTEGER REFERENCES agent_levels(id),
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | active | disabled | rejected
    earnings INTEGER NOT NULL DEFAULT 0,         -- 可提现
    frozen INTEGER NOT NULL DEFAULT 0,           -- 冻结中
    total_earned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, approved_at TEXT
  );
  CREATE TABLE agent_prices (
    agent_id INTEGER NOT NULL REFERENCES agents(customer_id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
    price INTEGER NOT NULL,
    PRIMARY KEY (agent_id, product_id)
  );

  CREATE TABLE coupons (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (type IN ('amount','percent')),
    value INTEGER NOT NULL,                      -- amount：分；percent：折扣百分比（如 15 = 减 15%）
    min_amount INTEGER NOT NULL DEFAULT 0,
    max_discount INTEGER,                        -- 折扣券封顶，分
    product_ids TEXT,                            -- JSON 数组，NULL 表示全部商品
    max_uses INTEGER, used INTEGER NOT NULL DEFAULT 0,
    per_user INTEGER NOT NULL DEFAULT 1,
    starts_at TEXT, ends_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE coupon_uses (
    id INTEGER PRIMARY KEY,
    coupon_id INTEGER NOT NULL REFERENCES coupons(id),
    order_no TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'held',         -- held（下单占用）| used（已付款）| released（关单释放）
    created_at TEXT NOT NULL
  );

  CREATE TABLE orders (
    no TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('buy','wholesale','topup')),
    source TEXT NOT NULL DEFAULT 'site',         -- site | store | ref | wholesale | topup
    customer_id INTEGER REFERENCES customers(id),
    agent_id INTEGER REFERENCES agents(customer_id),
    email TEXT NOT NULL COLLATE NOCASE,
    contact TEXT NOT NULL DEFAULT '',
    query_hash TEXT,                             -- 免注册订单的查询密码
    view_token TEXT NOT NULL,                    -- 订单页链接凭证
    product_id TEXT REFERENCES shop_products(id),
    title TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
    coupon_id INTEGER REFERENCES coupons(id),
    cost INTEGER NOT NULL DEFAULT 0,             -- 发货时的成本快照（分）
    agent_profit INTEGER NOT NULL DEFAULT 0, commission INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | paid | delivered | closed | refunded
    pay_method TEXT, payment_id TEXT,
    deliver_error TEXT, deliver_attempts INTEGER NOT NULL DEFAULT 0, next_deliver_at TEXT,
    ip TEXT, device TEXT,
    mail_status TEXT, refund_note TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    paid_at TEXT, delivered_at TEXT, closed_at TEXT, refunded_at TEXT
  );
  CREATE INDEX orders_status ON orders(status, created_at);
  CREATE INDEX orders_email ON orders(email);
  CREATE INDEX orders_customer ON orders(customer_id);
  CREATE INDEX orders_agent ON orders(agent_id, created_at);
  CREATE TABLE order_codes (
    order_no TEXT NOT NULL REFERENCES orders(no),
    code_id TEXT NOT NULL REFERENCES codes(id),
    PRIMARY KEY (order_no, code_id)
  );

  CREATE TABLE payments (
    id TEXT PRIMARY KEY,                         -- 发给支付平台的商户订单号
    order_no TEXT NOT NULL REFERENCES orders(no),
    method TEXT NOT NULL,                        -- epay | usdt | alipay | wechat | balance
    sub TEXT,                                    -- 易支付子类型 alipay / wxpay / qqpay 等
    amount INTEGER NOT NULL,                     -- 分
    crypto_amount INTEGER,                       -- USDT × 1e6（唯一尾数）
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | paid | closed
    trade_no TEXT UNIQUE,                        -- 平台流水号 / 交易哈希
    pay_url TEXT, qr TEXT,
    raw TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, paid_at TEXT
  );
  CREATE INDEX payments_order ON payments(order_no);
  CREATE INDEX payments_pending ON payments(status, method);

  -- 客户余额 / 代理收益流水
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL CHECK (owner IN ('customer','agent')),
    owner_id INTEGER NOT NULL,
    type TEXT NOT NULL,                          -- topup | spend | refund | profit | commission | unfreeze | withdraw | withdraw_reject | reverse | adjust
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    ref TEXT, note TEXT,
    unfreeze_at TEXT,                            -- 代理收益：冻结到期时间
    settled INTEGER NOT NULL DEFAULT 1,          -- 代理收益：0 冻结中，1 已解冻
    created_at TEXT NOT NULL
  );
  CREATE INDEX ledger_owner ON ledger(owner, owner_id, created_at);
  CREATE INDEX ledger_frozen ON ledger(settled, unfreeze_at);

  CREATE TABLE withdrawals (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(customer_id),
    amount INTEGER NOT NULL,
    method TEXT NOT NULL, account_enc TEXT NOT NULL, account_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | paid | rejected
    note TEXT,
    created_at TEXT NOT NULL, processed_at TEXT, processed_by TEXT
  );

  CREATE TABLE mail_log (
    id INTEGER PRIMARY KEY,
    to_addr TEXT NOT NULL, subject TEXT NOT NULL, ref TEXT,
    status TEXT NOT NULL, error TEXT,
    created_at TEXT NOT NULL
  );
  `,
  /* 3 */ `
  -- 下单时快照套餐和策略；邮件重试次数
  ALTER TABLE orders ADD COLUMN snap_product TEXT;
  ALTER TABLE orders ADD COLUMN snap_plan TEXT;
  ALTER TABLE orders ADD COLUMN snap_strategy TEXT;
  ALTER TABLE orders ADD COLUMN mail_attempts INTEGER NOT NULL DEFAULT 0;
  UPDATE orders SET snap_product = (SELECT product FROM shop_products p WHERE p.id = orders.product_id), snap_plan = (SELECT plan FROM shop_products p WHERE p.id = orders.product_id),
    snap_strategy = (SELECT strategy_id FROM shop_products p WHERE p.id = orders.product_id) WHERE product_id IS NOT NULL;
  -- 幂等键唯一：多进程同时发货也只会生成一批
  UPDATE batches SET idem_key = idem_key || '#' || id WHERE rowid NOT IN (SELECT MIN(rowid) FROM batches GROUP BY idem_key);
  CREATE UNIQUE INDEX batches_idem_key ON batches(idem_key);
  CREATE INDEX payments_method_status ON payments(method, status, expires_at);
  `,
  /* 4 */ `
  -- 商品分类：两级（一级分类 → 二级分类），商品挂在任意一级上
  CREATE TABLE shop_categories (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES shop_categories(id),
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  ALTER TABLE shop_products ADD COLUMN category_id INTEGER REFERENCES shop_categories(id);
  `,
  /* 5 */ `
  -- 兑换页旧的默认说明里提到「绑卡」，换成新文案（自己改过的不动）
  UPDATE settings SET value = replace(value, '整个过程你不需要付款，也不需要绑卡。', '整个过程不需要你付款，也不需要提供任何支付信息。') WHERE key = 'redeemPage';
  `,
  /* 6 GPT 直充：卡台自动直充任务 + 资金护栏额度账本（金额为 USD 十进制字符串） */ `
  ALTER TABLE redemptions ADD COLUMN direct_task_id TEXT;
  CREATE TABLE direct_spend (
    id INTEGER PRIMARY KEY,
    redemption_id TEXT NOT NULL,
    code_id TEXT NOT NULL,                        -- 每张码的直充次数上限按它算
    account_key TEXT,                             -- 熔断要求失败涉及多个不同账号
    idem_key TEXT NOT NULL UNIQUE,                -- 发给卡台的幂等键，一次下单一条
    task_id TEXT,
    plan TEXT NOT NULL,
    reserved_usd TEXT NOT NULL,                   -- 下单时预留（= 单笔上限）
    actual_usd TEXT,                              -- 结束后实际花费
    status TEXT NOT NULL DEFAULT 'reserved',      -- reserved（进行中 / 结果未知）| spent 成功 | released 失败 | cancelled 卡台没受理
    created_at TEXT NOT NULL, settled_at TEXT
  );
  CREATE INDEX direct_spend_day ON direct_spend(created_at);
  CREATE INDEX direct_spend_red ON direct_spend(redemption_id);
  CREATE INDEX direct_spend_code ON direct_spend(code_id);
  CREATE INDEX red_direct_task ON redemptions(direct_task_id);
  `,
  /* 7 */ `
  -- 进入「处理中」的时间：轮询退避按它算（updated_at 每次查询都会变，不能用）
  ALTER TABLE redemptions ADD COLUMN poll_started_at TEXT;
  -- 直充费用是否已按卡台费用明细核对：0 = 还没核对（按预算计入额度，后台继续对账），1 = 已核对
  ALTER TABLE direct_spend ADD COLUMN cost_verified INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE direct_spend ADD COLUMN cost_note TEXT;
  -- 重新设置两步验证时，新密钥先放在这里，确认后才替换现用的
  ALTER TABLE users ADD COLUMN totp_pending_enc TEXT;
  `,
  /* 8 */ `
  -- 码在批次里的顺序。原来按 SQLite 隐含的 rowid 排序，PostgreSQL / MySQL 没有 rowid，改成显式的列
  ALTER TABLE codes ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
  UPDATE codes SET seq = rowid;
  `,
];

/** PostgreSQL / MySQL 新库对应的版本号（等于 SQLite 迁移的数量） */
export const BASE_VERSION = SQLITE_MIGRATIONS.length;

/** 第 BASE_VERSION 版之后的迁移：每项三种数据库各一份 */
/**
 * 迁移前检查（按版本号）：数据状态不允许升级时抛错，启动失败、数据库不变。
 * get 是普通查询（迁移前的结构）
 */
export const MIGRATION_CHECKS: Record<number, (get: (sql: string) => Promise<any>) => Promise<void>> = {
  // 还有没出结果的直充（钱可能已经付出去了）就删掉账本，之后没法核对：先用旧版本处理完再升级
  9: async get => {
    // 表已经不在：MySQL 上这次迁移上回做到一半（DDL 不能回滚），接着做完即可
    const n = Number((await get("SELECT COUNT(*) n FROM direct_spend WHERE status = 'reserved'").catch(() => null))?.n || 0);
    if (n) throw new Error(`还有 ${n} 笔 GPT 直充没有结果。新版本去掉了直充，升级会删除直充账本：请先用旧版本在「兑换记录」里等它们结束或人工核对，再升级`);
  },
};

export const LATER_MIGRATIONS: Record<Dialect, string>[] = [
  /* 9 去掉 GPT 直充（统一走卡台 CDK）：额度账本、兑换记录上的直充任务 ID、资金护栏设置 */
  {
    sqlite: `
      DROP INDEX IF EXISTS red_direct_task;
      ALTER TABLE redemptions DROP COLUMN direct_task_id;
      DROP TABLE IF EXISTS direct_spend;
      DELETE FROM settings WHERE "key" = 'directGuard';`,
    pg: `
      DROP INDEX IF EXISTS red_direct_task;
      ALTER TABLE redemptions DROP COLUMN IF EXISTS direct_task_id;
      DROP TABLE IF EXISTS direct_spend;
      DELETE FROM settings WHERE "key" = 'directGuard';`,
    // MySQL 的 DDL 不能回滚：每一步都写成可以重复执行的，迁移中途失败后重启能接着做完
    mysql: `
      DROP TABLE IF EXISTS direct_spend;
      DELETE FROM settings WHERE "key" = 'directGuard';
      SET @drop_direct = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE redemptions DROP COLUMN direct_task_id', 'DO 0') FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'redemptions' AND COLUMN_NAME = 'direct_task_id');
      PREPARE drop_direct FROM @drop_direct;
      EXECUTE drop_direct;
      DEALLOCATE PREPARE drop_direct;`,
  },
];

/**
 * PostgreSQL / MySQL 的完整结构（等价于 SQLite 全部迁移）。
 * 文本都按「短字符串（可建索引）/ 长文本」区分：MySQL 的 TEXT 不能建索引、不能有默认值。
 * 邮箱、店铺地址、券码由程序统一转成小写 / 大写后再存和查，不依赖数据库的大小写规则
 */
export function baseSchema(d: "pg" | "mysql"): string {
  const t: Record<string, string> = d === "pg"
    ? { AUTO: "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY", S: "VARCHAR(255)", T: "TEXT", REAL: "DOUBLE PRECISION", E: "" }
    : { AUTO: "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY", S: "VARCHAR(255)", T: "LONGTEXT", REAL: "DOUBLE", E: " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin" };
  const sql = SCHEMA.replace(/\{(AUTO|S|T|REAL|E)\}/g, (_, k) => t[k]);
  return d === "mysql" ? tableLevelForeignKeys(sql) : sql;
}

/** MySQL 会静默忽略写在列后面的 REFERENCES（不建外键），改成表级 FOREIGN KEY 约束 */
function tableLevelForeignKeys(sql: string) {
  return sql.replace(/CREATE TABLE (\w+) \(([\s\S]*?)\n\)( ENGINE[^;]*)?;/g, (_m, table: string, body: string, engine = "") => {
    const fks: string[] = [];
    const lines = body.split("\n").map(line =>
      line.replace(/^(\s*)(\w+)(.*?) REFERENCES (\w+)\((\w+)\)( ON DELETE CASCADE)?(,?)$/, (_l, ind, col, rest, rt, rc, cascade = "", comma) => {
        fks.push(`  FOREIGN KEY (${col}) REFERENCES ${rt}(${rc})${cascade}`);
        return `${ind}${col}${rest}${comma}`;
      }));
    const cols = lines.join("\n").replace(/,\s*$/, "");
    return `CREATE TABLE ${table} (${cols}${fks.length ? ",\n" + fks.join(",\n") : ""}\n)${engine};`;
  });
}

/* {S} 短字符串（可建索引）  {T} 长文本  {AUTO} 自增主键  {REAL} 浮点  {E} MySQL 表选项 */
const SCHEMA = `
CREATE TABLE users (
  id {AUTO},
  email {S} NOT NULL UNIQUE,
  name {S} NOT NULL,
  role {S} NOT NULL CHECK (role IN ('admin','operator','support')),
  password_hash {S} NOT NULL,
  totp_secret_enc {S},
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at {S} NOT NULL,
  last_login_at {S},
  last_login_ip {S},
  totp_pending_enc {S}
){E};
CREATE TABLE sessions (
  id {S} PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage {S} NOT NULL DEFAULT 'full',
  created_at {S} NOT NULL,
  expires_at {S} NOT NULL,
  ip {S}, ua {T}
){E};
CREATE TABLE audit (
  id {AUTO},
  user_id BIGINT, user_name {S},
  action {S} NOT NULL, target {T}, detail {T}, ip {S},
  at {S} NOT NULL
){E};
CREATE INDEX audit_at ON audit(at);
CREATE TABLE settings ("key" {S} PRIMARY KEY, value {T} NOT NULL, updated_at {S} NOT NULL){E};
CREATE TABLE strategies (
  id {S} PRIMARY KEY,
  name {S} NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 10,
  is_default INTEGER NOT NULL DEFAULT 0,
  config {T} NOT NULL,
  created_at {S} NOT NULL, updated_at {S} NOT NULL
){E};
CREATE TABLE batches (
  id {S} PRIMARY KEY,
  product {S} NOT NULL CHECK (product IN ('gpt','x','tg')),
  plan {S} NOT NULL,
  quantity INTEGER NOT NULL,
  mode {S} NOT NULL CHECK (mode IN ('own','hosted')),
  strategy_id {S} NOT NULL REFERENCES strategies(id),
  params {T} NOT NULL,
  cost_usd {S},
  memo {S},
  idem_key {S} NOT NULL UNIQUE,
  created_by BIGINT, created_at {S} NOT NULL
){E};
CREATE TABLE codes (
  id {S} PRIMARY KEY,
  batch_id {S} NOT NULL REFERENCES batches(id),
  product {S} NOT NULL, plan {S} NOT NULL, mode {S} NOT NULL,
  strategy_id {S} NOT NULL,
  code_enc {T},
  code_hash {S} UNIQUE,
  display {S} NOT NULL,
  status {S} NOT NULL DEFAULT 'unused',
  upstream_id {S},
  upstream_status {S},
  account {S},
  redemption_id {S},
  expires_at {S},
  created_at {S} NOT NULL, redeemed_at {S},
  seq INTEGER NOT NULL DEFAULT 0
){E};
CREATE INDEX codes_batch ON codes(batch_id);
CREATE INDEX codes_status ON codes(product, status);
CREATE INDEX codes_upstream ON codes(upstream_id);
CREATE TABLE upstream_codes (
  id {S} PRIMARY KEY,
  code_id {S} NOT NULL REFERENCES codes(id),
  product {S} NOT NULL, plan {S} NOT NULL,
  code_enc {T} NOT NULL,
  status {S} NOT NULL DEFAULT 'issued',
  created_at {S} NOT NULL
){E};
CREATE INDEX upstream_codes_code ON upstream_codes(code_id);
CREATE TABLE redemptions (
  id {S} PRIMARY KEY,
  code_id {S} NOT NULL REFERENCES codes(id),
  product {S} NOT NULL, plan {S} NOT NULL,
  strategy_id {S} NOT NULL,
  status {S} NOT NULL,
  stage {S},
  account {S},
  account_key {S},
  ip {S}, browser_device {S}, country {S},
  upstream_code_id {S},
  device {S} NOT NULL,
  client_request_id {S},
  redemption_token_enc {T},
  preflight_token_enc {T},
  quote {T},
  cost_usd {S},
  rule {T},
  attempts INTEGER NOT NULL DEFAULT 1,
  error_code {S}, error_msg {T},
  order_id {S}, card_last4 {S},
  progress {T},
  invoice_urls {T},
  review {S},
  next_poll_at {S},
  created_at {S} NOT NULL, updated_at {S} NOT NULL, completed_at {S},
  direct_task_id {S},
  poll_started_at {S}
){E};
CREATE INDEX red_code ON redemptions(code_id);
CREATE INDEX red_status ON redemptions(status);
CREATE INDEX red_created ON redemptions(created_at);
CREATE INDEX red_account ON redemptions(account_key, strategy_id);
CREATE INDEX red_direct_task ON redemptions(direct_task_id);
CREATE TABLE attempts (
  id {AUTO},
  ip {S}, device {S}, code_hash {S},
  ok INTEGER NOT NULL, reason {S},
  at {S} NOT NULL
){E};
CREATE INDEX attempts_ip ON attempts(ip, at);
CREATE INDEX attempts_dev ON attempts(device, at);
CREATE TABLE webhook_events (
  id {S} PRIMARY KEY,
  type {S} NOT NULL,
  payload {T} NOT NULL,
  received_at {S} NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  error {T}
){E};
CREATE INDEX wh_received ON webhook_events(received_at);
CREATE TABLE transactions (
  id BIGINT PRIMARY KEY,
  auth_time {S},
  card_last4 {S},
  redemption_id {S},
  data {T} NOT NULL,
  synced_at {S} NOT NULL
){E};
CREATE INDEX tx_time ON transactions(auth_time);
CREATE TABLE shop_categories (
  id {AUTO},
  parent_id BIGINT REFERENCES shop_categories(id),
  name {S} NOT NULL,
  icon {S} NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at {S} NOT NULL
){E};
CREATE TABLE shop_products (
  id {S} PRIMARY KEY,
  product {S} NOT NULL, plan {S} NOT NULL,
  title {S} NOT NULL, subtitle {S} NOT NULL DEFAULT '', description VARCHAR(2000) NOT NULL DEFAULT '', badge {S} NOT NULL DEFAULT '',
  price BIGINT NOT NULL,
  agent_price BIGINT NOT NULL,
  strategy_id {S} NOT NULL REFERENCES strategies(id),
  stock_limit INTEGER,
  sold INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0,
  max_per_order INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at {S} NOT NULL, updated_at {S} NOT NULL,
  category_id BIGINT REFERENCES shop_categories(id)
){E};
CREATE TABLE customers (
  id {AUTO},
  email {S} NOT NULL UNIQUE,
  name {S} NOT NULL DEFAULT '',
  password_hash {S} NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  reset_hash {S}, reset_expires {S},
  created_at {S} NOT NULL, last_login_at {S}
){E};
CREATE TABLE customer_sessions (
  id {S} PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at {S} NOT NULL, expires_at {S} NOT NULL
){E};
CREATE TABLE agent_levels (
  id {AUTO},
  name {S} NOT NULL,
  wholesale_pct INTEGER NOT NULL DEFAULT 100,
  commission_pct {REAL} NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
){E};
CREATE TABLE agents (
  customer_id BIGINT PRIMARY KEY REFERENCES customers(id),
  slug {S} NOT NULL UNIQUE,
  shop_name {S} NOT NULL, notice VARCHAR(500) NOT NULL DEFAULT '', contact {S} NOT NULL DEFAULT '',
  level_id BIGINT REFERENCES agent_levels(id),
  status {S} NOT NULL DEFAULT 'pending',
  earnings BIGINT NOT NULL DEFAULT 0,
  frozen BIGINT NOT NULL DEFAULT 0,
  total_earned BIGINT NOT NULL DEFAULT 0,
  created_at {S} NOT NULL, approved_at {S}
){E};
CREATE TABLE agent_prices (
  agent_id BIGINT NOT NULL REFERENCES agents(customer_id) ON DELETE CASCADE,
  product_id {S} NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  price BIGINT NOT NULL,
  PRIMARY KEY (agent_id, product_id)
){E};
CREATE TABLE coupons (
  id {AUTO},
  code {S} NOT NULL UNIQUE,
  name {S} NOT NULL DEFAULT '',
  type {S} NOT NULL CHECK (type IN ('amount','percent')),
  value BIGINT NOT NULL,
  min_amount BIGINT NOT NULL DEFAULT 0,
  max_discount BIGINT,
  product_ids {T},
  max_uses INTEGER, used INTEGER NOT NULL DEFAULT 0,
  per_user INTEGER NOT NULL DEFAULT 1,
  starts_at {S}, ends_at {S},
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at {S} NOT NULL
){E};
CREATE TABLE coupon_uses (
  id {AUTO},
  coupon_id BIGINT NOT NULL REFERENCES coupons(id),
  order_no {S} NOT NULL UNIQUE,
  email {S} NOT NULL,
  status {S} NOT NULL DEFAULT 'held',
  created_at {S} NOT NULL
){E};
CREATE TABLE orders (
  no {S} PRIMARY KEY,
  kind {S} NOT NULL CHECK (kind IN ('buy','wholesale','topup')),
  source {S} NOT NULL DEFAULT 'site',
  customer_id BIGINT REFERENCES customers(id),
  agent_id BIGINT REFERENCES agents(customer_id),
  email {S} NOT NULL,
  contact {S} NOT NULL DEFAULT '',
  query_hash {S},
  view_token {S} NOT NULL,
  product_id {S} REFERENCES shop_products(id),
  title {S} NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price BIGINT NOT NULL, subtotal BIGINT NOT NULL, discount BIGINT NOT NULL DEFAULT 0, total BIGINT NOT NULL,
  coupon_id BIGINT REFERENCES coupons(id),
  cost BIGINT NOT NULL DEFAULT 0,
  agent_profit BIGINT NOT NULL DEFAULT 0, commission BIGINT NOT NULL DEFAULT 0,
  status {S} NOT NULL DEFAULT 'pending',
  pay_method {S}, payment_id {S},
  deliver_error {T}, deliver_attempts INTEGER NOT NULL DEFAULT 0, next_deliver_at {S},
  ip {S}, device {S},
  mail_status {T}, refund_note {T},
  created_at {S} NOT NULL, expires_at {S} NOT NULL,
  paid_at {S}, delivered_at {S}, closed_at {S}, refunded_at {S},
  snap_product {S}, snap_plan {S}, snap_strategy {S},
  mail_attempts INTEGER NOT NULL DEFAULT 0
){E};
CREATE INDEX orders_status ON orders(status, created_at);
CREATE INDEX orders_email ON orders(email);
CREATE INDEX orders_customer ON orders(customer_id);
CREATE INDEX orders_agent ON orders(agent_id, created_at);
CREATE TABLE order_codes (
  order_no {S} NOT NULL REFERENCES orders(no),
  code_id {S} NOT NULL REFERENCES codes(id),
  PRIMARY KEY (order_no, code_id)
){E};
CREATE TABLE payments (
  id {S} PRIMARY KEY,
  order_no {S} NOT NULL REFERENCES orders(no),
  method {S} NOT NULL,
  sub {S},
  amount BIGINT NOT NULL,
  crypto_amount BIGINT,
  status {S} NOT NULL DEFAULT 'pending',
  trade_no {S} UNIQUE,
  pay_url {T}, qr {T},
  raw {T},
  created_at {S} NOT NULL, expires_at {S} NOT NULL, paid_at {S}
){E};
CREATE INDEX payments_order ON payments(order_no);
CREATE INDEX payments_pending ON payments(status, method);
CREATE INDEX payments_method_status ON payments(method, status, expires_at);
CREATE TABLE ledger (
  id {AUTO},
  owner {S} NOT NULL CHECK (owner IN ('customer','agent')),
  owner_id BIGINT NOT NULL,
  type {S} NOT NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  ref {S}, note {T},
  unfreeze_at {S},
  settled INTEGER NOT NULL DEFAULT 1,
  created_at {S} NOT NULL
){E};
CREATE INDEX ledger_owner ON ledger(owner, owner_id, created_at);
CREATE INDEX ledger_frozen ON ledger(settled, unfreeze_at);
CREATE TABLE withdrawals (
  id {AUTO},
  agent_id BIGINT NOT NULL REFERENCES agents(customer_id),
  amount BIGINT NOT NULL,
  method {S} NOT NULL, account_enc {T} NOT NULL, account_name {S} NOT NULL DEFAULT '',
  status {S} NOT NULL DEFAULT 'pending',
  note {T},
  created_at {S} NOT NULL, processed_at {S}, processed_by {S}
){E};
CREATE TABLE mail_log (
  id {AUTO},
  to_addr {S} NOT NULL, subject {T} NOT NULL, ref {S},
  status {S} NOT NULL, error {T},
  created_at {S} NOT NULL
){E};
CREATE TABLE direct_spend (
  id {AUTO},
  redemption_id {S} NOT NULL,
  code_id {S} NOT NULL,
  account_key {S},
  idem_key {S} NOT NULL UNIQUE,
  task_id {S},
  plan {S} NOT NULL,
  reserved_usd {S} NOT NULL,
  actual_usd {S},
  status {S} NOT NULL DEFAULT 'reserved',
  created_at {S} NOT NULL, settled_at {S},
  cost_verified INTEGER NOT NULL DEFAULT 0,
  cost_note {T}
){E};
CREATE INDEX direct_spend_day ON direct_spend(created_at);
CREATE INDEX direct_spend_red ON direct_spend(redemption_id);
CREATE INDEX direct_spend_code ON direct_spend(code_id);
`;

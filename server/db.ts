import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { resolve } from 'node:path';
import { config } from './config.ts';

export const db = new DatabaseSync(process.env.DB_FILE || resolve(config.dataDir, 'cdk.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

type Params = Record<string, SQLInputValue> | SQLInputValue[];
const norm = (p?: Params): any[] => (p === undefined ? [] : Array.isArray(p) ? p : [p]);

export const q = {
  get<T = any>(sql: string, p?: Params): T | undefined { return db.prepare(sql).get(...norm(p)) as T | undefined; },
  all<T = any>(sql: string, p?: Params): T[] { return db.prepare(sql).all(...norm(p)) as T[]; },
  run(sql: string, p?: Params) { return db.prepare(sql).run(...norm(p)); },
};

/** 事务（只接受同步函数）。可以嵌套：外层已在事务里时用 SAVEPOINT，内层失败只回滚自己 */
let depth = 0;
export function tx<T>(fn: () => T): T {
  const sp = depth ? `sp${depth}` : null;
  db.exec(sp ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    depth--; db.exec(sp ? `RELEASE ${sp}` : 'COMMIT');
    return r;
  } catch (e) {
    depth--; db.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
    throw e;
  }
}

export const now = () => new Date().toISOString();
export const json = (v: unknown) => JSON.stringify(v ?? null);
export const parse = <T = any>(s: string | null | undefined, def: T): T => { try { return s ? JSON.parse(s) : def; } catch { return def; } };

/* ------------------------------------------------------------------
   迁移：按版本号顺序执行，只追加不修改
   ------------------------------------------------------------------ */
const MIGRATIONS: string[] = [
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
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, at TEXT NOT NULL)');
  const cur = (q.get<{ v: number }>('SELECT MAX(version) v FROM _migrations')?.v) ?? 0;
  MIGRATIONS.slice(cur).forEach((sql, i) => {
    tx(() => { db.exec(sql); q.run('INSERT INTO _migrations VALUES (?, ?)', [cur + i + 1, now()]); });
    console.log(`[db] migration ${cur + i + 1} applied`);
  });
}
migrate();

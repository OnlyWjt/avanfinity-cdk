/**
 * 数据库在线备份（SQLite）：用 VACUUM INTO 生成一致的快照，服务运行中也可以执行
 * （WAL 模式下直接复制 data/ 目录可能拿到损坏的库）
 * PostgreSQL / MySQL 请用数据库自带的工具备份（pg_dump / mysqldump），见 docs/deploy.md
 *
 *   npm run backup                       备份到 backups/，保留最近 14 份
 *   BACKUP_DIR=/mnt/bak BACKUP_KEEP=30 npm run backup
 *
 * 注意：备份里的兑换码、密钥是用 MASTER_KEY 加密的。MASTER_KEY 要单独保管，不要和备份放在一起
 * crontab 示例（每天 4 点）：0 4 * * * cd /srv/cdk && npm run backup >> backups/backup.log 2>&1
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../server/config.ts';
import { databaseUrl } from '../server/db.ts';

const url = databaseUrl();
if (!/^(sqlite|file):/i.test(url)) {
  const pg = /^postgres/i.test(url);
  console.error(`[backup] 当前用的是 ${pg ? 'PostgreSQL' : 'MySQL'}，请用 ${pg ? 'pg_dump' : 'mysqldump'} 备份，例如：
  ${pg
    ? 'docker compose exec -T postgres pg_dump -U cdk -Fc cdk > cdk-$(date +%F).dump'
    : 'docker compose exec -T mysql mysqldump -u cdk -p --single-transaction cdk > cdk-$(date +%F).sql'}
详见 docs/deploy.md`);
  process.exit(2);
}
const src = url.replace(/^(sqlite|file):(\/\/)?/i, '');
const dir = resolve(ROOT, process.env.BACKUP_DIR || 'backups');
const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const out = resolve(dir, `cdk-${stamp}.db`);
const db = new DatabaseSync(src, { readOnly: true });
db.exec('PRAGMA busy_timeout = 10000');
db.prepare('VACUUM INTO ?').run(out);
db.close();

// 校验快照能打开且完整
const chk = new DatabaseSync(out, { readOnly: true });
const ok = (chk.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
chk.close();
if (ok !== 'ok') { console.error(`[backup] ✗ ${out} 完整性检查失败：${ok}`); process.exit(1); }
console.log(`[backup] ✓ ${out}（${(statSync(out).size / 1024).toFixed(0)} KB）`);

// 只保留最近 keep 份
const old = readdirSync(dir).filter(f => /^cdk-\d{8}-\d{6}\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) { rmSync(resolve(dir, f)); console.log(`[backup] 删除旧备份 ${f}`); }

/**
 * 一键测试：在独立端口、全新数据库上启动模拟卡台和系统，依次跑
 *   1) scripts/e2e.ts       主流程
 *   2) scripts/e2e-full.ts  安全 / 权限 / 校验 / 审核 / 通知
 *   3) scripts/e2e-shop.ts  商城：支付 / 发货 / 优惠券 / 账户 / 代理 / 退款
 *   4) scripts/e2e-cdk.ts   GPT 点数（Credits）/ 结账地区
 *   5) scripts/ui-check.ts  浏览器（需要本机 Chrome，可用 SKIP_UI=1 跳过）
 *   npm test（先跑类型检查）
 * 每次使用随机空闲端口和独立的数据目录，可以同时跑多份；全部通过后删除数据目录，失败时保留现场并打印路径
 * （KEEP_TEST_DATA=1 总是保留，TEST_DATA_DIR 指定目录）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';

/** 让系统分配一个当前空闲的端口 */
const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
const APP = Number(process.env.TEST_APP_PORT) || await freePort(), MOCK = Number(process.env.TEST_MOCK_PORT) || await freePort();
const DATA = process.env.TEST_DATA_DIR || `data-test/run-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${process.pid}`;
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
console.log(`测试端口 ${APP} / 模拟卡台 ${MOCK}，数据目录 ${DATA}`);

/**
 * 在 PostgreSQL / MySQL 上测试：TEST_DATABASE_URL=postgres://…/cdk_test npm test
 * 开始前清空这个库（库名必须含 test，防止误清生产库）
 */
const DB_URL = process.env.TEST_DATABASE_URL || '';
if (DB_URL) {
  const name = decodeURIComponent(new URL(DB_URL).pathname.slice(1));
  if (!/test/i.test(name)) { console.error(`✗ TEST_DATABASE_URL 的库名「${name}」不含 test，为防止误清数据，拒绝执行`); process.exit(1); }
  if (/^postgres/i.test(DB_URL)) {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: DB_URL }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
  } else {
    const mysql = (await import('mysql2/promise')).default;
    const c = await mysql.createConnection({ uri: DB_URL.replace(/^mariadb:/i, 'mysql:') });
    const [rows] = await c.query('SELECT table_name t FROM information_schema.tables WHERE table_schema = DATABASE()') as any;
    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const r of rows) await c.query(`DROP TABLE \`${r.t ?? r.T ?? r.TABLE_NAME}\``);
    await c.query('SET FOREIGN_KEY_CHECKS = 1'); await c.end();
  }
  console.log(`数据库：${DB_URL.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@')}（已清空）`);
}
const env = { ...process.env, MAIL_OUTBOX: `${DATA}/mail`, E2E_BASE: `http://localhost:${APP}`, MOCK_BASE: `http://localhost:${MOCK}`, SHOTS_DIR: `${DATA}/shots` };
const procs: ChildProcess[] = [];
const start = (file: string, extra: Record<string, string>) => {
  const p = spawn(process.execPath, ['--no-warnings', file], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout!.on('data', d => log += d); p.stderr!.on('data', d => log += d);
  (p as any).log = () => log;
  procs.push(p); return p;
};
const stopAll = () => procs.forEach(p => p.kill());
process.on('exit', stopAll);

start('server/mock/avan-mock.ts', { MOCK_PORT: String(MOCK), MOCK_PUBLIC_URL: `http://localhost:${MOCK}`, MOCK_SPEED: '4', MOCK_WEBHOOK_URL: `http://localhost:${APP}/api/webhooks/avanfinity` });
const app = start('server/main.ts', { PORT: String(APP), DATA_DIR: DATA, ...(DB_URL && { DATABASE_URL: DB_URL }), PUBLIC_URL: `http://localhost:${APP}`, TELEGRAM_API_BASE: `http://localhost:${MOCK}`, NOTIFY_SCAN_MS: '2000', TRUST_PROXY: '1', SHOP_TICK_MS: '1000', SHOP_QUERY_AFTER_MS: '1500', USDT_SCAN_MS: '1000' });

for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://localhost:${APP}/api/public/config`)).ok && (await fetch(`http://localhost:${MOCK}/mock/telegram`)).ok) break; } catch { /* 还没启动 */ }
  await new Promise(r => setTimeout(r, 200));
}

const run = (file: string) => new Promise<number>(res => {
  console.log(`\n━━━━━━━━ ${file} ━━━━━━━━`);
  const p = spawn(process.execPath, ['--no-warnings', file], { env, stdio: 'inherit' });
  p.on('exit', code => res(code ?? 1));
});
const results: [string, number][] = [];
for (const f of ['scripts/e2e.ts', 'scripts/e2e-full.ts', 'scripts/e2e-shop.ts', 'scripts/e2e-cdk.ts', ...(process.env.SKIP_UI ? [] : ['scripts/ui-check.ts'])]) results.push([f, await run(f)]);

const errs = (app as any).log().split('\n').filter((l: string) => /\[error\]|Unhandled|TypeError|ReferenceError/.test(l));
console.log('\n━━━━━━━━ 结果 ━━━━━━━━');
for (const [f, c] of results) console.log(`${c === 0 ? '✓' : '✗'} ${f}`);
console.log(errs.length ? `✗ 服务端日志里有 ${errs.length} 条错误：\n${errs.slice(0, 10).join('\n')}` : '✓ 服务端日志没有错误');
if (process.env.SHOW_LOG) console.log('\n━━━━━━━━ 服务端日志 ━━━━━━━━\n' + (app as any).log().split('\n').slice(-80).join('\n'));
stopAll();
const passed = results.every(([, c]) => c === 0) && !errs.length;
// 等子进程退出、释放数据库文件后再清理
await new Promise(r => setTimeout(r, 500));
if (passed && !process.env.KEEP_TEST_DATA && !process.env.TEST_DATA_DIR) rmSync(DATA, { recursive: true, force: true });
else console.log(`测试数据保留在 ${DATA}`);
process.exit(passed ? 0 : 1);

/**
 * 一键测试：在独立端口、全新数据库上启动模拟卡台和系统，依次跑
 *   1) scripts/e2e.ts       主流程
 *   2) scripts/e2e-full.ts  安全 / 权限 / 校验 / 审核 / 通知
 *   3) scripts/e2e-shop.ts  商城：支付 / 发货 / 优惠券 / 账户 / 代理 / 退款
 *   4) scripts/ui-check.ts  浏览器（需要本机 Chrome，可用 SKIP_UI=1 跳过）
 *   npm test
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

const APP = 18080, MOCK = 18090, DATA = 'data-test';
rmSync(DATA, { recursive: true, force: true });
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
const app = start('server/main.ts', { PORT: String(APP), DATA_DIR: DATA, PUBLIC_URL: `http://localhost:${APP}`, TELEGRAM_API_BASE: `http://localhost:${MOCK}`, NOTIFY_SCAN_MS: '2000', TRUST_PROXY: '1', SHOP_TICK_MS: '1000', SHOP_QUERY_AFTER_MS: '1500', USDT_SCAN_MS: '1000' });

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
for (const f of ['scripts/e2e.ts', 'scripts/e2e-full.ts', 'scripts/e2e-shop.ts', ...(process.env.SKIP_UI ? [] : ['scripts/ui-check.ts'])]) results.push([f, await run(f)]);

const errs = (app as any).log().split('\n').filter((l: string) => /\[error\]|Unhandled|TypeError|ReferenceError/.test(l));
console.log('\n━━━━━━━━ 结果 ━━━━━━━━');
for (const [f, c] of results) console.log(`${c === 0 ? '✓' : '✗'} ${f}`);
console.log(errs.length ? `✗ 服务端日志里有 ${errs.length} 条错误：\n${errs.slice(0, 10).join('\n')}` : '✓ 服务端日志没有错误');
if (process.env.SHOW_LOG) console.log('\n━━━━━━━━ 服务端日志 ━━━━━━━━\n' + (app as any).log().split('\n').slice(-80).join('\n'));
stopAll();
process.exit(results.every(([, c]) => c === 0) && !errs.length ? 0 : 1);

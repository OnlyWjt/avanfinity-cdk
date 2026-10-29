import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 读取项目根目录的 .env（不覆盖已有环境变量） */
function loadDotEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, k, raw] = m;
    if (process.env[k] === undefined) process.env[k] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv();

const env = (k: string, def = '') => process.env[k] ?? def;

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  /** 对外访问地址，用于生成 Webhook 接收 URL 等 */
  publicUrl: env('PUBLIC_URL', 'http://localhost:8080').replace(/\/$/, ''),
  dataDir: resolve(ROOT, env('DATA_DIR', 'data')),
  /** 32 字节主密钥（hex），用于加密兑换码、卡台密钥等。丢失后已加密数据无法解密 */
  masterKey: env('MASTER_KEY'),
  /** 部署在反向代理 / Cloudflare 后面时设为 1，从 X-Forwarded-For / CF-Connecting-IP 取真实 IP */
  // 反向代理：1 / xff = Nginx 等（取 X-Forwarded-For 最右边一跳，即代理看到的真实来源）；cf = Cloudflare（只认 CF-Connecting-IP）
  trustProxy: ['1', 'xff', 'cf'].includes(env('TRUST_PROXY', '0')),
  proxyMode: env('TRUST_PROXY', '0') === 'cf' ? 'cf' : 'xff',
  /** 卡台站点根地址，如 https://avanfinity.example.com；v1 接口在 /api/v1，公开兑换接口在 /api/public */
  avanBase: env('AVAN_BASE_URL', '').replace(/\/$/, ''),
  /** 业务时区：兑换时段等规则按这个时区判断 */
  timezone: env('TZ_BUSINESS', 'Asia/Shanghai'),
  cookieSecure: env('COOKIE_SECURE', '0') === '1',
};

if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });

/** PUBLIC_URL 是否是外网能访问的 https 地址（支付平台回调、邮件链接都依赖它） */
export const publicUrlOk = () => config.publicUrl.startsWith('https://') && !['localhost', '127.0.0.1', '0.0.0.0'].some(h => config.publicUrl.includes(h));

if (!/^[0-9a-f]{64}$/i.test(config.masterKey)) {
  const keyFile = resolve(config.dataDir, '.master_key');
  // 生产环境必须显式设置：主密钥和数据库放在同一个目录，备份数据目录就等于把密钥一起交出去，加密形同虚设
  if (process.env.NODE_ENV === 'production' || publicUrlOk()) {
    console.error(`[config] 生产环境必须在 .env 里设置 MASTER_KEY（64 位十六进制），并和数据目录分开备份。`
      + (existsSync(keyFile) ? `\n[config] 检测到旧的 ${keyFile}：把里面的内容填到 .env 的 MASTER_KEY，然后把这个文件移出数据目录。` : '')
      + `\n[config] 生成新密钥：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
    process.exit(1);
  }
  // 开发环境下自动生成并持久化
  if (existsSync(keyFile)) config.masterKey = readFileSync(keyFile, 'utf8').trim();
  else {
    const { randomBytes } = await import('node:crypto');
    const { writeFileSync } = await import('node:fs');
    config.masterKey = randomBytes(32).toString('hex');
    writeFileSync(keyFile, config.masterKey, { mode: 0o600 });
    console.warn(`[config] 未设置 MASTER_KEY，已生成并保存到 ${keyFile}。生产环境请在 .env 中显式配置并妥善备份。`);
  }
}

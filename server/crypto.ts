import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

const KEY = Buffer.from(config.masterKey, 'hex');
const ENC_KEY = createHmac('sha256', KEY).update('enc:v1').digest();
const LOOKUP_KEY = createHmac('sha256', KEY).update('lookup:v1').digest();

/** AES-256-GCM 加密，输出 v1.<iv>.<tag>.<ciphertext>（base64url） */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function decrypt(blob: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1') throw new Error('unknown cipher version');
  const d = createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
export const encryptOpt = (s: string | null | undefined) => (s ? encrypt(s) : null);
export const decryptOpt = (s: string | null | undefined) => (s ? decrypt(s) : null);

/** 兑换码的确定性查找哈希（不可逆），用于按码查询而不存明文 */
export function lookupHash(code: string): string {
  return createHmac('sha256', LOOKUP_KEY).update(normalizeCode(code)).digest('hex');
}
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

/* ---------- 密码 ---------- */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = scryptSync(pw, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 });
  const expect = Buffer.from(hash, 'base64url');
  return expect.length === h.length && timingSafeEqual(expect, h);
}
/** 异步版：在线程池里算哈希，不阻塞事件循环（一次请求要校验多条时用） */
export async function verifyPasswordAsync(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = await new Promise<Buffer>((res, rej) => scrypt(pw, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
  const expect = Buffer.from(hash, 'base64url');
  return expect.length === h.length && timingSafeEqual(expect, h);
}

/* ---------- TOTP（RFC 6238，SHA-1，30 秒，6 位） ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(): string {
  return Array.from(randomBytes(20), b => B32[b & 31]).join('');
}
function b32decode(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function verifyTotp(secret: string, code: string): boolean {
  const c = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some(d => safeEqual(totpAt(secret, c + d), code.trim()));
}
export function totpUri(secret: string, account: string, issuer = 'CDK Console') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}

/* ---------- 其他 ---------- */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hex = (bytes = 32) => randomBytes(bytes).toString('hex');
export const uuid = () => randomUUID();
export const sha256 = (s: string) => createHmac('sha256', 'x').update(s).digest('hex');

/** 自有兑换码：PREFIX-XXXX-XXXX-XXXX，去掉易混字符（0/O/1/I），60 bit 熵 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function ownCode(prefix: string): string {
  const g = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(32)]).join('');
  return `${prefix}-${g()}-${g()}-${g()}`;
}

/** Webhook 签名：HMAC-SHA256(secret, timestamp + '.' + rawBody) */
export function webhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

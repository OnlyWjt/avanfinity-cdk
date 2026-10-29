import { createHash } from 'node:crypto';
import { q, now } from '../db.ts';
import { hashPassword, verifyPassword, verifyTotp, newTotpSecret, encrypt, decrypt, token } from '../crypto.ts';
import { HttpError, type Role, type SessionUser } from '../http.ts';

const SESSION_HOURS = 12;
const TOTP_STAGE_MIN = 5;
const sidHash = (t: string) => createHash('sha256').update(t).digest('hex');

interface UserRow { id: number; email: string; name: string; role: Role; password_hash: string; totp_secret_enc: string | null; totp_enabled: number; disabled: number }
const toUser = (u: UserRow): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, totpEnabled: !!u.totp_enabled });

export function userCount() { return q.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n; }

export function createUser(p: { email: string; name: string; role: Role; password: string }) {
  if (p.password.length < 8) throw new HttpError(400, '密码至少 8 位');
  if (q.get('SELECT 1 FROM users WHERE email = ?', [p.email])) throw new HttpError(409, '这个邮箱已存在');
  const r = q.run('INSERT INTO users(email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [p.email, p.name, p.role, hashPassword(p.password), now()]);
  return Number(r.lastInsertRowid);
}

function newSession(userId: number, stage: 'full' | 'totp', ip: string, ua: string) {
  const t = token();
  const exp = new Date(Date.now() + (stage === 'full' ? SESSION_HOURS * 3600e3 : TOTP_STAGE_MIN * 60e3)).toISOString();
  q.run('INSERT INTO sessions(id, user_id, stage, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)', [sidHash(t), userId, stage, now(), exp, ip, ua.slice(0, 200)]);
  return t;
}

/** 第一步：邮箱 + 密码。开启 TOTP 的账号返回 stage=totp 的临时会话 */
export function login(email: string, password: string, ip: string, ua: string) {
  const u = q.get<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
  // 账号不存在时也做一次哈希，避免通过耗时区分
  const ok = u ? verifyPassword(password, u.password_hash) : (verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
  if (!u || !ok) throw new HttpError(401, '邮箱或密码不正确', 'BAD_CREDENTIALS');
  if (u.disabled) throw new HttpError(403, '账号已停用', 'DISABLED');
  if (u.totp_enabled) return { token: newSession(u.id, 'totp', ip, ua), needTotp: true };
  q.run('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?', [now(), ip, u.id]);
  return { token: newSession(u.id, 'full', ip, ua), needTotp: false, user: toUser(u) };
}

/** 第二步：TOTP。成功后作废临时会话，签发正式会话 */
export function loginTotp(tmpToken: string, code: string, ip: string, ua: string) {
  const s = q.get<{ user_id: number; stage: string; expires_at: string }>('SELECT * FROM sessions WHERE id = ?', [sidHash(tmpToken)]);
  if (!s || s.stage !== 'totp' || s.expires_at < now()) throw new HttpError(401, '登录已过期，请重新输入密码', 'AUTH_REQUIRED');
  const u = q.get<UserRow>('SELECT * FROM users WHERE id = ?', [s.user_id])!;
  if (!u.totp_secret_enc || !verifyTotp(decrypt(u.totp_secret_enc), code)) throw new HttpError(401, '验证码不正确', 'BAD_TOTP');
  q.run('DELETE FROM sessions WHERE id = ?', [sidHash(tmpToken)]);
  q.run('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?', [now(), ip, u.id]);
  return { token: newSession(u.id, 'full', ip, ua), user: toUser(u) };
}

export function sessionUser(t: string | undefined): { user: SessionUser; sid: string } | null {
  if (!t) return null;
  const row = q.get<UserRow & { stage: string; expires_at: string; sid: string }>(
    'SELECT u.*, s.stage, s.expires_at, s.id sid FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', [sidHash(t)]);
  if (!row || row.stage !== 'full' || row.expires_at < now() || row.disabled) return null;
  return { user: toUser(row), sid: row.sid };
}
export function logout(t: string | undefined) { if (t) q.run('DELETE FROM sessions WHERE id = ?', [sidHash(t)]); }

export function changePassword(userId: number, oldPw: string, newPw: string) {
  const u = q.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId])!;
  if (!verifyPassword(oldPw, u.password_hash)) throw new HttpError(400, '原密码不正确');
  if (newPw.length < 8) throw new HttpError(400, '新密码至少 8 位');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPw), userId]);
  q.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

/** 开启 TOTP：先生成密钥（未生效），用户输入一次正确验证码后才启用 */
export function totpSetup(userId: number) {
  const secret = newTotpSecret();
  q.run('UPDATE users SET totp_secret_enc = ?, totp_enabled = 0 WHERE id = ?', [encrypt(secret), userId]);
  return secret;
}
export function totpEnable(userId: number, code: string) {
  const u = q.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId])!;
  if (!u.totp_secret_enc || !verifyTotp(decrypt(u.totp_secret_enc), code)) throw new HttpError(400, '验证码不正确');
  q.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', [userId]);
}
export function totpDisable(userId: number, code: string) {
  const u = q.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId])!;
  if (u.totp_enabled && (!u.totp_secret_enc || !verifyTotp(decrypt(u.totp_secret_enc), code))) throw new HttpError(400, '验证码不正确');
  q.run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE id = ?', [userId]);
}

setInterval(() => q.run('DELETE FROM sessions WHERE expires_at < ?', [now()]), 3600e3).unref();

/**
 * 命令行创建管理员（忘记密码、或者不方便打开网页初始化时用）
 *   npm run admin:create -- 邮箱 密码 [名称]
 *   docker compose exec app npm run admin:create -- 邮箱 密码
 * 邮箱已存在时重置它的密码，并让它的登录会话全部失效
 * 使用和服务相同的 .env / DATABASE_URL
 */
import { initDb, closeDb, q } from '../server/db.ts';
import { createUser } from '../server/services/auth.ts';
import { hashPassword } from '../server/crypto.ts';

const [email, password, name = '管理员'] = process.argv.slice(2);
if (!email || !password) { console.error('用法：npm run admin:create -- 邮箱 密码 [名称]'); process.exit(1); }
if (password.length < 8) { console.error('密码至少 8 位'); process.exit(1); }

await initDb();
const mail = email.trim().toLowerCase();
const u = await q.get<{ id: number }>('SELECT id FROM users WHERE email = ?', [mail]);
if (u) {
  await q.run("UPDATE users SET password_hash = ?, role = 'admin', disabled = 0 WHERE id = ?", [hashPassword(password), u.id]);
  await q.run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
  console.log(`已重置 ${mail} 的密码（并设为管理员），原来的登录已失效`);
} else {
  await createUser({ email: mail, name, role: 'admin', password });
  console.log(`已创建管理员 ${mail}`);
}
await closeDb();

/** 邮件：SMTP 发送；设置环境变量 MAIL_OUTBOX=目录 时改为写入文件（测试用） */
import nodemailer from 'nodemailer';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { q, now } from '../db.ts';
import { getSetting } from './settings.ts';
import { decryptOpt } from '../crypto.ts';
import { config } from '../config.ts';

export interface Mail { to: string; subject: string; html: string; text: string; ref?: string }

function transport() {
  const m = getSetting('mail');
  return nodemailer.createTransport({ host: m.host, port: m.port, secure: m.secure, auth: m.user ? { user: m.user, pass: decryptOpt(m.passEnc) || '' } : undefined, connectionTimeout: 15_000, socketTimeout: 20_000 });
}
export const mailConfigured = () => !!process.env.MAIL_OUTBOX || (() => { const m = getSetting('mail'); return m.enabled && !!m.host && !!m.from; })();

export async function sendMail(mail: Mail) {
  const m = getSetting('mail');
  try {
    if (process.env.MAIL_OUTBOX) {
      mkdirSync(process.env.MAIL_OUTBOX, { recursive: true });
      appendFileSync(resolve(process.env.MAIL_OUTBOX, 'outbox.jsonl'), JSON.stringify({ ...mail, at: now() }) + '\n');
    } else {
      if (!mailConfigured()) throw new Error('还没有配置 SMTP');
      await transport().sendMail({ from: m.fromName ? `"${m.fromName.replace(/"/g, '')}" <${m.from}>` : m.from, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
    }
    q.run('INSERT INTO mail_log(to_addr, subject, ref, status, created_at) VALUES (?, ?, ?, ?, ?)', [mail.to, mail.subject, mail.ref ?? null, 'sent', now()]);
    return true;
  } catch (e: any) {
    q.run('INSERT INTO mail_log(to_addr, subject, ref, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)', [mail.to, mail.subject, mail.ref ?? null, 'failed', String(e?.message || e).slice(0, 300), now()]);
    throw e;
  }
}

const h = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** 统一的邮件外框，颜色取主题主色 */
export function layout(title: string, bodyHtml: string) {
  const t = getSetting('theme');
  return `<!doctype html><html><body style="margin:0;background:#f3f4fa;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#16173a">
  <div style="max-width:560px;margin:0 auto;padding:28px 16px">
    <div style="font-weight:800;font-size:17px;margin-bottom:16px"><span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:8px;background:${t.a1};color:#fff;margin-right:8px">${h(t.logo)}</span>${h(t.name)}</div>
    <div style="background:#fff;border-radius:14px;padding:24px;border:1px solid #e6e7f2">
      <h1 style="font-size:19px;margin:0 0 14px">${h(title)}</h1>${bodyHtml}
    </div>
    <p style="font-size:12px;color:#8a8fb0;margin-top:14px">这封邮件由系统自动发送，请勿直接回复。</p>
  </div></body></html>`;
}
export function button(href: string, label: string) {
  const t = getSetting('theme');
  return `<a href="${h(href)}" style="display:inline-block;background:${t.a1};color:#fff;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600;margin-top:6px">${h(label)}</a>`;
}
export const esc = h;
export const siteUrl = (path: string) => config.publicUrl + path;

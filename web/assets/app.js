/* ============================================================
   CDK Console · 共享脚本（后台与兑换页共用）
   - api()：请求后端，401 自动跳转登录
   - Theme：主题来自服务端，本地缓存避免闪烁
   - 组件：toast / modal / drawer / confirmBox / run
   - 后台外壳：侧边栏 / 顶栏 / ⌘K 搜索
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = '$') => n == null || n === '' || isNaN(n) ? '—' : cur + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cny = n => money(n, '¥');
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
const qs = k => new URLSearchParams(location.search).get(k);
const fmtTime = iso => { if (!iso) return '—'; const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const ago = iso => { if (!iso) return '—'; const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? '刚刚' : s < 3600 ? `${s / 60 | 0} 分钟前` : s < 86400 ? `${s / 3600 | 0} 小时前` : fmtTime(iso); };
const IS_ADMIN = location.pathname.startsWith('/admin/');

/* ---------------- 接口 ---------------- */
class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
/* 首屏缓存（只在后台页面）：切换页面时，打开后 1 秒内的 GET 先用本标签页上次的结果立即渲染，
   避免「先画空壳、几十毫秒后数据到了再填满」的闪动；同时后台取最新数据，有变化就调用页面的 load() 无感刷新。
   页面没有全局 load() 时不用缓存；任何写操作都会清空缓存，保证操作后看到的是最新数据。 */
const SWR = { t0: performance.now(), key: 'swr:', pending: null };
const swrOn = (method, path) => IS_ADMIN && method === 'GET' && !path.startsWith('/api/auth/') && typeof window.load === 'function';
function swrRevalidate(path, cachedText) {
  api('GET', path, undefined, true).then(d => {
    if (JSON.stringify(d) === cachedText) return;
    clearTimeout(SWR.pending);
    SWR.pending = setTimeout(() => { try { window.load(); } catch { /* 页面自己处理 */ } }, 30);
  }).catch(() => {});
}
async function api(method, path, body, fresh = false) {
  if (!fresh && swrOn(method, path) && performance.now() - SWR.t0 < 1000) {
    const text = sessionStorage.getItem(SWR.key + path);
    if (text) { swrRevalidate(path, text); return JSON.parse(text); }
  }
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw new ApiError('网络连接失败，请检查网络后重试', 0); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && IS_ADMIN && !location.pathname.startsWith('/admin/login')) { location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname + location.search); throw new ApiError('请先登录', 401); }
  if (!res.ok) throw new ApiError(data.error || `请求失败（${res.status}）`, res.status, data);
  if (IS_ADMIN && method !== 'GET') Object.keys(sessionStorage).filter(k => k.startsWith(SWR.key)).forEach(k => sessionStorage.removeItem(k));
  else if (IS_ADMIN && method === 'GET' && !path.startsWith('/api/auth/')) { try { const t = JSON.stringify(data); if (t.length < 300_000) sessionStorage.setItem(SWR.key + path, t); } catch { /* 存满了就不缓存 */ } }
  return data;
}
const GET = p => api('GET', p), POST = (p, b = {}) => api('POST', p, b), PUT = (p, b) => api('PUT', p, b), DEL = p => api('DELETE', p), PATCH = (p, b) => api('PATCH', p, b);

/** 按钮 loading → 执行 → 出错 toast */
async function run(btn, text, fn) {
  const o = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="pulse"></span> ${text}`; }
  try { return await fn(); }
  catch (e) { toast(e.message || String(e), 'bad'); throw e; }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = o; } }
}
const quiet = p => p.catch(() => {});

/* ---------------- 主题 ---------------- */
const PRESETS = {
  // 默认：票根。墨蓝主色 + 票面蓝 + 印泥红，纸面卡片，得意黑标题
  stub:     { label: '票根', mode: 'light', a1: '#15233f', a2: '#3d6e9e', a3: '#d3382b', bg: 'paper', font: 'stub', card: 'paper', btn: 'solid', shape: 'round', r: 14, blur: 0, glow: 0 },
  // 深色
  aurora:   { label: '极光', mode: 'dark', a1: '#8b7cff', a2: '#4fd8ff', a3: '#ff7ac6', bg: 'aurora', font: 'modern', card: 'glass', btn: 'gradient', shape: 'round', r: 18, blur: 24, glow: 60 },
  nebula:   { label: '星云', mode: 'dark', a1: '#b06bff', a2: '#ff6bcb', a3: '#5b8cff', bg: 'mesh', font: 'modern', card: 'glass', btn: 'glow', shape: 'pill', r: 22, blur: 28, glow: 80 },
  ocean:    { label: '深海', mode: 'dark', a1: '#3a7bff', a2: '#36d1ff', a3: '#7c5cff', bg: 'aurora', font: 'modern', card: 'glass', btn: 'gradient', shape: 'round', r: 16, blur: 22, glow: 55 },
  forest:   { label: '森林', mode: 'dark', a1: '#2fd38a', a2: '#3ec7c2', a3: '#c6f432', bg: 'dots', font: 'rounded', card: 'solid', btn: 'gradient', shape: 'round', r: 16, blur: 14, glow: 45 },
  sunset:   { label: '落日', mode: 'dark', a1: '#ff7a59', a2: '#ffb547', a3: '#ff4fa3', bg: 'mesh', font: 'rounded', card: 'glass', btn: 'gradient', shape: 'pill', r: 20, blur: 24, glow: 70 },
  midnight: { label: '午夜', mode: 'dark', a1: '#6d8bff', a2: '#a5b8ff', a3: '#5ee6ff', bg: 'grid', font: 'modern', card: 'outline', btn: 'solid', shape: 'round', r: 12, blur: 16, glow: 40 },
  cyber:    { label: '赛博', mode: 'dark', a1: '#ff2bd6', a2: '#21e6ff', a3: '#7a5cff', bg: 'grid', font: 'tech', card: 'outline', btn: 'glow', shape: 'square', r: 6, blur: 10, glow: 75 },
  obsidian: { label: '曜石', mode: 'dark', a1: '#d7dbe8', a2: '#8e95ad', a3: '#f2f4fa', bg: 'plain', font: 'modern', card: 'solid', btn: 'solid', shape: 'round', r: 14, blur: 0, glow: 15 },
  gilded:   { label: '鎏金', mode: 'dark', a1: '#e2b866', a2: '#f6dca0', a3: '#b8863b', bg: 'plain', font: 'serif', card: 'neo', btn: 'gradient', shape: 'square', r: 8, blur: 0, glow: 35 },
  // 浅色
  sakura:   { label: '樱花', mode: 'light', a1: '#ec5f9a', a2: '#9b7bff', a3: '#ffa36c', bg: 'aurora', font: 'rounded', card: 'glass', btn: 'gradient', shape: 'pill', r: 22, blur: 24, glow: 60 },
  porcelain:{ label: '青花', mode: 'light', a1: '#2347c5', a2: '#4f7bff', a3: '#1aa6c9', bg: 'plain', font: 'serif', card: 'outline', btn: 'solid', shape: 'square', r: 6, blur: 0, glow: 20 },
  mint:     { label: '薄荷', mode: 'light', a1: '#10b394', a2: '#4cc9f0', a3: '#a3e635', bg: 'dots', font: 'rounded', card: 'solid', btn: 'solid', shape: 'pill', r: 20, blur: 12, glow: 40 },
  lavender: { label: '薰衣草', mode: 'light', a1: '#7c5cff', a2: '#c08bff', a3: '#ff8fd1', bg: 'mesh', font: 'modern', card: 'glass', btn: 'gradient', shape: 'round', r: 18, blur: 26, glow: 65 },
  citrus:   { label: '柑橘', mode: 'light', a1: '#f26b1d', a2: '#ffb020', a3: '#e8475f', bg: 'grid', font: 'rounded', card: 'neo', btn: 'gradient', shape: 'pill', r: 18, blur: 10, glow: 45 },
  glacier:  { label: '冰川', mode: 'light', a1: '#2b8cff', a2: '#38d6e0', a3: '#7a8cff', bg: 'aurora', font: 'modern', card: 'glass', btn: 'glow', shape: 'round', r: 16, blur: 30, glow: 55 },
  mono:     { label: '素白', mode: 'light', a1: '#2c2f4a', a2: '#5b6bff', a3: '#22c3a6', bg: 'plain', font: 'modern', card: 'solid', btn: 'solid', shape: 'round', r: 12, blur: 0, glow: 10 },
};
const THEME_DEFAULT = { preset: 'stub', mode: 'light', a1: '#15233f', a2: '#3d6e9e', a3: '#d3382b', r: 14, blur: 0, glow: 0, name: 'CDK Console', logo: 'C', slogan: '一码开通你的会员',
  bg: 'paper', font: 'stub', card: 'paper', btn: 'solid', shape: 'round', motion: true, logoImg: '', tagline: '', customCss: '' };
/* 后台主题页用 iframe 预览前台页面时（?preview=1）：只认父页面发来的主题，不写本地缓存、不受个人深浅色影响 */
const PREVIEW = window.parent !== window && new URLSearchParams(location.search).get('preview') === '1';
let PREVIEW_THEME = null;
const Theme = {
  cached() { try { return { ...THEME_DEFAULT, ...JSON.parse(localStorage.getItem('cdk-theme') || '{}') }; } catch { return { ...THEME_DEFAULT }; } },
  lum(hex) { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; },
  /** 主色很深（比如票根的墨蓝）时，深色模式下提亮，否则按钮会消失在背景里（boot.js 里有同样的逻辑） */
  ui(hex, mode) {
    if (mode !== 'dark' || Theme.lum(hex) >= .06) return hex;
    const n = parseInt(hex.slice(1), 16);
    return '#' + [n >> 16, n >> 8 & 255, n & 255].map(v => Math.round(v + (255 - v) * .86).toString(16).padStart(2, '0')).join('');
  },
  apply(t = Theme.cached(), persist = false) {
    if (PREVIEW) { if (PREVIEW_THEME) t = PREVIEW_THEME; persist = false; }
    t = { ...THEME_DEFAULT, ...t };
    if (persist) { try { localStorage.setItem('cdk-theme', JSON.stringify(t)); } catch { /* 存满了不影响显示 */ } }
    const root = document.documentElement, s = root.style;
    const local = PREVIEW ? null : localStorage.getItem('cdk-mode');
    const mode = local || t.mode;
    root.dataset.mode = mode === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
    const a1 = Theme.ui(t.a1, root.dataset.mode);
    s.setProperty('--a1', a1); s.setProperty('--a2', t.a2); s.setProperty('--a3', t.a3);
    s.setProperty('--r', t.r + 'px'); s.setProperty('--blur', t.blur + 'px'); s.setProperty('--glow', t.glow / 100);
    s.setProperty('--on-a', Theme.lum(a1) > .45 ? '#111228' : '#fff');
    Object.assign(root.dataset, { bg: t.bg, font: t.font, card: t.card, btn: t.btn, shape: t.shape, motion: t.motion ? 'on' : 'off' });
    $$('[data-bind=name]').forEach(e => e.textContent = t.name || 'CDK Console');
    $$('[data-bind=logo]').forEach(e => { e.classList.toggle('img', !!t.logoImg); e.innerHTML = t.logoImg ? `<img src="${esc(t.logoImg)}" alt="">` : esc(t.logo || 'C'); });
    $$('[data-bind=slogan]').forEach(e => e.textContent = t.slogan || '');
    $$('[data-bind=tagline]').forEach(e => { if (t.tagline) e.textContent = t.tagline; });
    $$('[data-bind=mode-icon]').forEach(e => e.textContent = root.dataset.mode === 'dark' ? '☾' : '☀');
    document.title = document.title.replace(/CDK Console$/, t.name || 'CDK Console');
    Theme.icon(t);
    let css = document.getElementById('theme-css');
    if (!css) { css = document.createElement('style'); css.id = 'theme-css'; document.head.appendChild(css); }
    if (css.textContent !== (t.customCss || '')) css.textContent = t.customCss || '';
  },
  /** 网站图标：有 Logo 图片用图片，否则用主色渐变 + Logo 字符生成 */
  icon(t) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    const href = t.logoImg || 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.a1}"/><stop offset="1" stop-color="${t.a2}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="32" y="43" font-size="30" font-family="system-ui,sans-serif" font-weight="800" text-anchor="middle" fill="${Theme.lum(t.a1) > .45 ? '#111228' : '#fff'}">${esc((t.logo || 'C').slice(0, 2))}</text></svg>`);
    if (link.href !== href) link.href = href;
  },
  /** 个人深浅色偏好只存本地，不影响全站主题 */
  toggleMode() { localStorage.setItem('cdk-mode', document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark'); Theme.apply(); },
};
if (PREVIEW) window.addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'cdk-theme') { PREVIEW_THEME = e.data.theme; Theme.apply(); } });
Theme.apply();

/* ---------------- 组件 ---------------- */
function toast(text, kind = 'ok') {
  let el = $('#__toast');
  if (!el) { el = document.createElement('div'); el.id = '__toast'; el.className = 'toast glass solid'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
  const ic = { ok: '<span class="c-ok">✓</span>', bad: '<span class="c-bad">✕</span>', warn: '<span class="c-warn">⚠</span>', info: '<span class="c-run">ⓘ</span>' }[kind] || '';
  el.innerHTML = ic + esc(text); el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), kind === 'bad' ? 4000 : 2200);
}
function copy(text, label = '已复制') { navigator.clipboard?.writeText(text).then(() => toast(label), () => toast('复制失败，请手动选择复制', 'warn')); }
/**
 * 兑换页 / 凭证页的顶栏：和商城页保持一致
 *   商城开着：品牌显示商城名称，导航「商城 · 兑换 · 查订单 · 我的」
 *   商城关着：品牌显示主题名称，导航「兑换 · 兑换结果」
 */
function pubNav(cfg, on) {
  const el = document.querySelector('header.pub-top'); if (!el) return;
  const shop = cfg?.shop?.enabled, st = sessionStorage.getItem('shop-store');
  let me = null; try { me = JSON.parse(sessionStorage.getItem('shop-cfg:' + (st || '')) || 'null')?.me; } catch { /* 没缓存 */ }
  const name = shop ? cfg.shop.title : (cfg?.theme?.name || Theme.cached().name);
  const a = (href, label, key) => `<a href="${href}" class="${on === key ? 'on' : ''}">${label}</a>`;
  el.innerHTML = `<a class="brand" href="${shop ? (st ? '/s/' + st : '/shop/') : '/redeem'}" style="padding:0"><div class="logo" data-bind="logo"></div><span>${esc(name || '')}</span></a>
    <nav>${shop ? a(st ? '/s/' + st : '/shop/', '商城', 'shop') : ''}${a('/redeem', '兑换', 'redeem')}${shop ? a('/shop/query.html', '查订单', 'query') + a('/account/', me ? '我的' : '登录', 'account') : a('/receipt.html', '兑换结果', 'receipt')}
      <button class="btn ghost sm" onclick="Theme.toggleMode()" aria-label="切换深浅色"><span data-bind="mode-icon">☾</span></button></nav>`;
  Theme.apply();
}
/** 时间范围下拉的值 → { from, to }（按浏览器本地日期）。'' 全部，'0' 今天，'1' 昨天，'7' / '30' 近 N 天 */
const rangeOf = v => {
  if (v === '' || v == null) return {};
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const day = 86400e3;
  if (v === '0') return { from: d0.toISOString() };
  if (v === '1') return { from: new Date(d0 - day).toISOString(), to: d0.toISOString() };
  return { from: new Date(d0 - (Number(v) - 1) * day).toISOString() };
};
const RANGE_OPTS = '<option value="">全部时间</option><option value="0">今天</option><option value="1">昨天</option><option value="7">近 7 天</option><option value="30">近 30 天</option>';
/** CSV 单元格：含逗号 / 引号 / 换行时加引号转义 */
const csvCell = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function download(name, body, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: type + ';charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

/* ---------------- 弹窗 / 抽屉 ----------------
   全站统一一个弹层组件：
   dialog({ title, sub, tone, body, size, actions, closable, onClose })
     tone     标题前的状态图标：'ok' | 'warn' | 'bad' | 'info'
     size     'sm' | 'md' | 'lg'
     actions  底部按钮 [{ label, kind: 'primary' | 'danger' | 'ghost', id, onClick(d) }]
              没有 onClick 的按钮只关闭；onClick 返回 false 保持打开；抛出错误时显示在弹窗里
   sheet({ ...同上 })  右侧抽屉（手机上从底部弹出）
   返回 { el, body, close, error(msg), busy(on) } */
const Layers = (() => {
  const stack = [];
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  document.addEventListener('keydown', e => {
    const top = stack[stack.length - 1]; if (!top) return;
    if (e.key === 'Escape' && !$('.dd-pop')) { e.preventDefault(); top.closable && top.close(); }
    else if (e.key === 'Tab') {
      const f = $$(FOCUSABLE, top.panel).filter(x => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!top.panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    } else if (e.key === 'Enter' && top.primary && !e.isComposing && !['TEXTAREA', 'BUTTON', 'A'].includes(document.activeElement?.tagName) && top.panel.contains(document.activeElement)) {
      e.preventDefault(); top.primary.click();
    }
  });
  return {
    push(l) { stack.push(l); document.documentElement.classList.add('layer-open'); l.mask.style.zIndex = 80 + stack.length * 10; l.panel.style.zIndex = 81 + stack.length * 10; },
    pop(l) { const i = stack.indexOf(l); if (i >= 0) stack.splice(i, 1); if (!stack.length) document.documentElement.classList.remove('layer-open'); },
    FOCUSABLE,
  };
})();
const TONE_IC = { ok: '✓', warn: '!', bad: '✕', info: 'i' };

function layer(kind, o) {
  const { title = '', sub = '', tone = null, icon = '', body = '', size = 'md', actions = [], closable = true, onClose } = o;
  const prevFocus = document.activeElement;
  const mask = document.createElement('div'); mask.className = 'mask';
  const panel = document.createElement(kind === 'sheet' ? 'aside' : 'div');
  panel.className = kind === 'sheet' ? 'sheet glass solid' : `dlg glass solid dlg-${size}`;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); if (title) panel.setAttribute('aria-label', title.replace(/<[^>]+>/g, ''));
  const ic = icon || (tone ? `<div class="dlg-ic ${tone}">${TONE_IC[tone]}</div>` : '');
  panel.innerHTML = `
    ${o.header !== false && (title || closable) ? `<header class="dlg-h">${ic}<div class="dlg-t">${title ? `<h2>${title}</h2>` : ''}${sub ? `<p>${sub}</p>` : ''}</div>${closable ? '<button class="iconbtn dlg-x" data-close aria-label="关闭">×</button>' : ''}</header>` : ''}
    <div class="dlg-b">${body}</div>
    <div class="dlg-err hidden"></div>
    ${actions.length ? `<footer class="dlg-f">${actions.map((a, i) => `<button class="btn ${a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger solidbg' : a.kind === 'ghost' ? 'ghost' : ''}" data-act="${i}" ${a.id ? `id="${a.id}"` : ''} ${a.disabled ? 'disabled' : ''}>${a.label}</button>`).join('')}</footer>` : ''}`;
  document.body.append(mask, panel);
  let closed = false;
  const d = {
    el: panel, body: $('.dlg-b', panel), mask, panel, closable,
    primary: null,
    close() {
      if (closed) return; closed = true;
      mask.classList.remove('show'); panel.classList.remove('show');
      Layers.pop(d);
      setTimeout(() => { mask.remove(); panel.remove(); }, kind === 'sheet' ? 280 : 180);
      onClose && onClose();
      if (prevFocus && prevFocus.isConnected) prevFocus.focus?.({ preventScroll: true });
    },
    error(msg) { const e = $('.dlg-err', panel); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); },
    busy(on, btn) { $$('[data-act]', panel).forEach(b => b.disabled = on); if (btn) btn.classList.toggle('loading', on); },
  };
  Layers.push(d);
  $$('[data-close]', panel).forEach(b => b.onclick = () => d.close());
  mask.addEventListener('mousedown', e => { if (e.target === mask && closable) d.close(); });
  $$('[data-act]', panel).forEach(b => {
    const a = actions[+b.dataset.act];
    if (a.kind === 'primary' || a.kind === 'danger') d.primary ??= b;
    b.onclick = async () => {
      if (!a.onClick) return d.close();
      d.error('');
      const label = b.innerHTML;
      d.busy(true, b); b.innerHTML = `<span class="spin"></span>${a.busyLabel || label}`;
      try { const r = await a.onClick(d); if (r !== false) d.close(); }
      catch (e) { d.error(e?.message || String(e)); }
      finally { if (!closed) { d.busy(false, b); b.innerHTML = label; } }
    };
  });
  requestAnimationFrame(() => {
    mask.classList.add('show'); panel.classList.add('show');
    // 触屏设备不自动聚焦输入框（会弹出键盘挡住表单），只把焦点放到弹层本身
    if (matchMedia('(pointer: coarse)').matches) { panel.tabIndex = -1; panel.focus({ preventScroll: true }); return; }
    const auto = $('[autofocus]', panel) || $$('input:not([type=checkbox]):not([disabled]),textarea', d.body).find(x => x.offsetParent !== null) || d.primary || $('.dlg-x', panel);
    auto?.focus({ preventScroll: true });
  });
  return d;
}
const dialog = o => layer('dialog', o);
const sheet = o => { $$('.sheet.show [data-close]').forEach(b => b.click()); return layer('sheet', o); };

/** 二次确认，返回 Promise：确认 → true（有 input 时返回输入内容），取消 → false */
function confirmBox({ title, body = '', ok = '确认', danger = false, typeToConfirm = null, input = null, tone }) {
  return new Promise(res => {
    let done = false;
    const d = dialog({
      title, tone: tone ?? (danger ? 'bad' : null), size: 'sm',
      body: `${body ? `<div class="dlg-text">${body}</div>` : ''}
        ${typeToConfirm ? `<div class="f mt12"><div class="flabel">请输入 <span class="mono">${esc(typeToConfirm)}</span> 以确认</div><input class="field" id="__ttc" autocomplete="off"></div>` : ''}
        ${input ? `<div class="f mt12"><div class="flabel">${input}</div><input class="field" id="__in" autocomplete="off"></div>` : ''}`,
      actions: [{ label: '取消' }, { label: ok, kind: danger ? 'danger' : 'primary', id: '__ok', disabled: !!typeToConfirm, onClick: () => { done = true; res(input ? ($('#__in', d.el).value || '') : true); } }],
      onClose: () => !done && res(false),
    });
    if (typeToConfirm) $('#__ttc', d.el).oninput = e => $('#__ok', d.el).disabled = e.target.value !== typeToConfirm;
  });
}
/** 展示一组兑换码：逐个复制 / 复制全部 / 下载 CSV、TXT */
function codesDialog({ title, sub = '', tone = 'ok', note = '', noteTone = 'warn', items, csv, doneLabel = '完成', onDone }) {
  const ok = items.filter(x => x.code);
  const d = dialog({
    title, sub, tone, size: 'md',
    body: `${note ? `<div class="note ${noteTone} mb12">${note}</div>` : ''}
      <div class="codes">${items.map(x => x.code ? `<div>${esc(x.code)}<button class="link" data-c="${esc(x.code)}">复制</button></div>` : `<div class="faint">${esc(x.id || '')}<span class="xs">${esc(x.note || '')}</span></div>`).join('') || '<div class="faint">没有可导出的码</div>'}</div>`,
    actions: [
      { label: '复制全部', onClick: () => { copy(ok.map(x => x.code).join('\n'), `已复制 ${ok.length} 个兑换码`); return false; } },
      ...(csv ? [{ label: '下载 CSV', onClick: () => { download(csv.name + '.csv', csv.header + '\n' + csv.rows.join('\n'), 'text/csv'); return false; } },
        { label: '下载 TXT', onClick: () => { download(csv.name + '.txt', ok.map(x => x.code).join('\n')); return false; } }] : []),
      { label: doneLabel, kind: 'primary', onClick: () => onDone && onDone() },
    ],
  });
  $$('[data-c]', d.el).forEach(b => b.onclick = () => { copy(b.dataset.c); b.textContent = '已复制'; });
  return d;
}
/** 没有权限时把弹层里的表单变成只读（只能看，不能改） */
function lockForm(d, role = 'admin') {
  if (can(role)) return false;
  $$('input,select,textarea,.sw,.seg button,.opt,.stepper button', d.body).forEach(x => { x.disabled = true; });
  d.body.insertAdjacentHTML('afterbegin', `<div class="note mb12">只读：${ROLE_CN[role === 'admin' ? 'admin' : 'operator']}才能修改</div>`);
  return true;
}
/** 只有一个「知道了」按钮的提示 */
const alertBox = ({ title, body = '', tone = 'info', ok = '知道了' }) => dialog({ title, tone, size: 'sm', body: `<div class="dlg-text">${body}</div>`, actions: [{ label: ok, kind: 'primary', onClick: () => {} }] });
function segInit(root, onChange) {
  $$('button', root).forEach(b => b.onclick = () => { $$('button', root).forEach(x => x.classList.toggle('on', x === b)); onChange && onChange(b.dataset.v, b); });
}
function segSet(root, v) { $$('button', root).forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
function swInit(el, onChange) { el.onclick = () => { el.classList.toggle('on'); el.setAttribute('aria-pressed', el.classList.contains('on')); onChange && onChange(el.classList.contains('on')); }; }
function countdown(el, seconds, onEnd) {
  let s = Math.max(0, Math.floor(seconds)); const tick = () => { if (!el.isConnected) return clearInterval(t); el.textContent = `${String(s / 60 | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; if (s-- <= 0) { clearInterval(t); onEnd && onEnd(); } };
  const t = setInterval(tick, 1000); tick(); return () => clearInterval(t);
}
function pager(el, total, page, size, onPage) {
  const pages = Math.max(1, Math.ceil(total / size));
  const nums = [...new Set([1, page - 1, page, page + 1, pages].filter(n => n >= 1 && n <= pages))].sort((a, b) => a - b);
  el.innerHTML = `<span>共 ${total} 条</span><div class="pgs">${page > 1 ? '<button data-p="' + (page - 1) + '">‹</button>' : ''}${nums.map(n => `<button data-p="${n}" class="${n === page ? 'on' : ''}">${n}</button>`).join('')}${page < pages ? '<button data-p="' + (page + 1) + '">›</button>' : ''}</div>`;
  $$('[data-p]', el).forEach(b => b.onclick = () => onPage(+b.dataset.p));
}

/* ---------------- 下拉框 ----------------
   自动把所有 <select class="field"> 换成玻璃风格的下拉菜单。
   原生 select 保留在页面里（隐藏），值和 change 事件照常工作，页面脚本不用改。 */
const Dropdown = (() => {
  let open = null;   // { sel, btn, pop, idx }
  const opts = sel => [...sel.options].map((o, i) => ({ i, value: o.value, label: o.textContent, disabled: o.disabled }));
  function label(sel) {
    const o = sel.options[sel.selectedIndex];
    return o ? o.textContent : '';
  }
  function sync(sel) {
    const btn = sel.__dd; if (!btn) return;
    btn.querySelector('.dd-label').textContent = label(sel) || '请选择';
    btn.classList.toggle('placeholder', !sel.value);
    btn.disabled = sel.disabled;
    if (open?.sel === sel) renderPop();
  }
  function enhance(sel) {
    if (sel.__dd || sel.multiple || sel.dataset.native !== undefined) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd ' + [...sel.classList].filter(c => c !== 'field').join(' ');
    btn.style.cssText = sel.style.cssText;
    btn.innerHTML = '<span class="dd-label"></span><svg class="dd-caret" viewBox="0 0 12 12" width="12" height="12"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    // 读屏：沿用原 select 的标签（<label for> / aria-label / 所在表单项的标题）
    const lbl = sel.getAttribute('aria-label') || (sel.id && document.querySelector(`label[for="${sel.id}"]`)?.textContent) || sel.closest('.f')?.querySelector('label,.flabel')?.textContent || sel.options[0]?.textContent || '';
    if (lbl) btn.setAttribute('aria-label', lbl.trim());
    sel.__dd = btn;
    sel.classList.add('dd-native');
    sel.after(btn);
    btn.addEventListener('click', e => { e.preventDefault(); open?.sel === sel ? close() : show(sel); });
    btn.addEventListener('keydown', e => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && !open) { e.preventDefault(); show(sel); }
      else if (open?.sel === sel) key(e);
    });
    // 选项被脚本重写 / 值被修改时同步
    new MutationObserver(() => sync(sel)).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
    sel.addEventListener('change', () => sync(sel));
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(sel, 'value', { get() { return d.get.call(this); }, set(v) { d.set.call(this, v); sync(sel); }, configurable: true });
    sync(sel);
  }
  function show(sel) {
    close();
    const pop = document.createElement('div');
    pop.className = 'dd-pop glass solid';
    pop.setAttribute('role', 'listbox');
    document.body.appendChild(pop);
    open = { sel, btn: sel.__dd, pop, idx: Math.max(0, sel.selectedIndex) };
    open.btn.classList.add('open'); open.btn.setAttribute('aria-expanded', 'true');
    pop.id = 'dd-pop'; open.btn.setAttribute('aria-controls', 'dd-pop');
    renderPop(); place();
    requestAnimationFrame(() => pop.classList.add('show'));
  }
  function renderPop() {
    const { sel, pop } = open;
    const list = opts(sel);
    pop.innerHTML = list.map(o => `<div class="dd-opt ${o.i === sel.selectedIndex ? 'sel' : ''} ${o.i === open.idx ? 'act' : ''} ${o.disabled ? 'dis' : ''}" data-i="${o.i}" role="option" aria-selected="${o.i === sel.selectedIndex}"><span>${esc(o.label)}</span><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 6.2 5 8.6 9.6 3.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`).join('') || '<div class="dd-empty">没有选项</div>';
    pop.querySelectorAll('.dd-opt').forEach(el => {
      el.onmousedown = e => e.preventDefault();
      el.onclick = () => pick(+el.dataset.i);
      el.onmouseenter = () => { open.idx = +el.dataset.i; pop.querySelectorAll('.act').forEach(x => x.classList.remove('act')); el.classList.add('act'); };
    });
    pop.querySelector('.act')?.scrollIntoView({ block: 'nearest' });
  }
  function place() {
    const { btn, pop } = open, r = btn.getBoundingClientRect();
    pop.style.minWidth = r.width + 'px';
    const h = Math.min(pop.scrollHeight, 320), below = innerHeight - r.bottom - 8;
    const up = below < h && r.top > below;
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + 'px';
    pop.style.top = (up ? r.top - h - 6 : r.bottom + 6) + 'px';
    pop.style.maxHeight = (up ? Math.min(320, r.top - 14) : Math.min(320, below)) + 'px';
    pop.classList.toggle('up', up);
  }
  function pick(i) {
    const { sel, btn } = open;
    if (sel.options[i]?.disabled) return;
    const changed = sel.selectedIndex !== i;
    sel.selectedIndex = i;
    close(); btn.focus();
    sync(sel);
    if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  function key(e) {
    const list = opts(open.sel).filter(o => !o.disabled);
    const pos = list.findIndex(o => o.i === open.idx);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = list[(pos + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]; if (n) { open.idx = n.i; renderPop(); } }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(open.idx); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); const b = open.btn; close(); b.focus(); }
    else if (e.key.length === 1) { const n = list.find(o => o.label.toLowerCase().startsWith(e.key.toLowerCase())); if (n) { open.idx = n.i; renderPop(); } }
  }
  function close() {
    if (!open) return;
    open.btn.setAttribute('aria-expanded', 'false');
    const { pop, btn } = open; open = null;
    btn.classList.remove('open'); pop.classList.remove('show');
    setTimeout(() => pop.remove(), 150);
  }
  function scan(root = document) { root.querySelectorAll?.('select.field').forEach(enhance); }
  document.addEventListener('mousedown', e => { if (open && !open.pop.contains(e.target) && !open.btn.contains(e.target)) close(); });
  addEventListener('resize', close);
  document.addEventListener('scroll', e => { if (open && !open.pop.contains(e.target)) close(); }, true);
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches?.('select.field')) enhance(n); else scan(n); } })
    .observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => scan());
  return { scan, close };
})();

/* ---------------- 状态字典 ---------------- */
const ST = {
  // 兑换码
  unused: ['idle', '○ 未使用'], in_use: ['run', '<i></i>兑换中'], redeemed: ['ok', '✓ 已兑换'], revoked: ['idle', '⊘ 已撤销'],
  // 兑换记录
  started: ['idle', '◔ 已输码'], quoted: ['acc', '◎ 待确认'], blocked: ['bad', '⛔ 策略拦截'], manual_review: ['warn', '⚑ 待审核'], approved: ['acc', '✓ 已通过'],
  funding: ['run', '<i></i>准备付款'], funded: ['acc', '◉ 待用户付款'], processing: ['run', '<i></i>处理中'], retrying: ['run', '<i></i>自动重试'],
  requires_action: ['warn', '! 需处理'], paid_pending_delivery: ['warn', '◷ 已付待交付'], completed: ['ok', '✓ 已完成'],
  failed: ['bad', '✕ 失败'], expired: ['idle', '◷ 已超时'], cancelled: ['idle', '⊘ 已取消'],
  // 流水
  APPROVED: ['ok', '✓ 成功'], DECLINED: ['bad', '✕ 拒付'], REVERSED: ['idle', '↺ 撤销'], SETTLED: ['ok', '✓ 已结算'], COMPLETE: ['ok', '✓ 完成'], PENDING: ['run', '<i></i>处理中'],
};
const badge = s => { const [k, t] = ST[s] || ['idle', esc(s)]; return `<span class="badge ${k}">${t}</span>`; };
const PIC = { gpt: '<span class="pic gpt">G</span>', x: '<span class="pic x">𝕏</span>', tg: '<span class="pic tg">✈</span>' };
const PICXS = { gpt: '<span class="pic xs gpt">G</span>', x: '<span class="pic xs x">𝕏</span>', tg: '<span class="pic xs tg">✈</span>' };
const PNAME = { gpt: 'ChatGPT', x: 'X Premium', tg: 'Telegram' };
const LAYER = {
  own: '<span class="badge ok" title="在我们自己的后端执行，完全可控">我方控制</span>',
  gen: '<span class="badge acc" title="生成兑换码时写入卡台，之后这批码不能再改">生成时写入</span>',
  platform: '<span class="badge idle" title="卡台强制执行，无法覆盖">卡台强制</span>',
};

/* ---------------- 后台外壳 ---------------- */
let ME = null;
const NAV = [
  { h: null, items: [['index', '◉', '总览']] },
  { h: 'CDK', items: [['cdks', '✦', 'CDK 管理'], ['generate', '＋', '生成 CDK', null, 'operator'], ['orders', '⇄', '兑换记录', 'attn'], ['strategy', '⛉', '兑换策略'], ['pricing', '▤', '售价与利润']] },
  { h: '商城', items: [['products', '▦', '商品'], ['shop-orders', '¥', '商城订单', 'shop'], ['coupons', '✂', '优惠券'], ['agents', '⚇', '代理分销', 'agent'], ['customers', '☺', '客户']] },
  { h: '数据', items: [['insights', '◔', '成功率分析'], ['transactions', '≡', '支付流水']] },
  { h: '系统', items: [['webhooks', '⌁', 'Webhook'], ['settings', '⚙', '设置'], ['theme', '◐', '主题与品牌']] },
  { h: '前台', items: [['/', '↗', '用户兑换页'], ['/receipt.html', '↗', '凭证查询'], ['/shop/', '↗', '商城前台']] },
];
const ROLE_CN = { admin: '管理员', operator: '运营', support: '客服（只读）' };
const can = role => ({ support: 1, operator: 2, admin: 3 })[ME?.role] >= ({ support: 1, operator: 2, admin: 3 })[role];

const ssGet = k => { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } };
const ssSet = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式 */ } };

/** 同步构建外壳：在浏览器画第一帧之前完成，避免切换页面时布局跳动 */
function buildShell() {
  const page = document.body.dataset.page, content = $("#page");
  if (!content) return false;
  const t = Theme.cached(), nav0 = ssGet("cdk-nav") || {};
  ME = ssGet("cdk-me");
  const nav = NAV.map(g => `${g.h ? `<div class="nav-h">${g.h}</div>` : ""}${g.items.map(([k, ic, label, ct, role]) => {
    const ext = k.startsWith("/");
    const n = ct && nav0[ct];
    return `<a href="${ext ? k : k + ".html"}" class="${k === page ? "on" : ""} ${role && ME && !can(role) ? "hidden" : ""}" ${role ? `data-role="${role}"` : ""} ${ext ? 'target="_blank"' : ""}><span class="ic">${ic}</span>${label}${ct ? `<span class="ct ${n ? "" : "hidden"}" id="nav-${ct}">${n || ""}</span>` : ""}</a>`;
  }).join("")}`).join("");
  const shell = document.createElement("div");
  shell.className = "app";
  shell.innerHTML = `
    <aside class="side glass">
      <a class="brand" href="index.html"><div class="logo" data-bind="logo">${esc(t.logo)}</div><span data-bind="name">${esc(t.name)}</span></a>
      <nav class="nav">${nav}</nav>
      <div class="conn" id="conn">${nav0.conn || '<span class="dot" style="background:var(--faint);box-shadow:none"></span>检查卡台连接…'}</div>
    </aside>
    <main class="main">
      <div class="top">
        <div class="row-flex" style="gap:12px"><button class="btn menu-btn" id="menuBtn" aria-label="打开菜单">☰</button><div><div class="crumb">${content.dataset.crumb || ""}</div><h1 id="title">${content.dataset.title || ""}</h1></div></div>
        <div class="acts">
          <button class="search" id="openCmdk" type="button">⌕ 搜索码、订单、客户<kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd></button>
          <button class="btn search-btn" id="openCmdk2" aria-label="搜索">⌕</button>
          <a class="btn" href="theme.html" title="主题">◐</a>
          <button class="btn" id="modeBtn" title="切换深浅色（仅自己）"><span data-bind="mode-icon">☾</span></button>
          <button class="avatar" id="avatarBtn" title="账户" aria-label="账户">${ME ? esc(ME.name.slice(0, 2).toUpperCase()) : "··"}</button>
        </div>
      </div>
      <div id="pageSlot"></div>
    </main>`;
  content.parentNode.insertBefore(shell, content);
  $("#pageSlot").appendChild(content);
  $("#modeBtn").onclick = Theme.toggleMode;
  $("#openCmdk").onclick = openCmdk; $("#openCmdk2").onclick = openCmdk;
  // 窄屏：侧边栏变成抽屉
  const mask = document.createElement('div'); mask.className = 'nav-mask'; document.body.appendChild(mask);
  const navOpen = on => document.documentElement.classList.toggle('nav-open', on);
  $("#menuBtn").onclick = () => navOpen(true); mask.onclick = () => navOpen(false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') navOpen(false); });
  $("#avatarBtn").onclick = () => ME && accountModal();
  Theme.apply();
  applyRoles();
  return true;
}
function applyRoles() { if (ME) $$("[data-role]").forEach(el => el.classList.toggle("hidden", !can(el.dataset.role))); }

/** 异步刷新当前用户和主题；有缓存时页面已经用缓存先渲染了 */
async function loadShell() {
  const cached = ME;
  const [me, theme] = await Promise.all([GET("/api/auth/me"), GET("/api/admin/theme").catch(() => null)]);
  if (cached && cached.id !== me.user.id) { ssSet("cdk-me", me.user); location.reload(); return; }
  ME = me.user; ssSet("cdk-me", ME);
  if (theme) Theme.apply(theme, true);
  $("#avatarBtn").textContent = ME.name.slice(0, 2).toUpperCase();
  applyRoles();
  if (!cached) document.dispatchEvent(new CustomEvent("me", { detail: ME }));
  refreshNav();
}
async function refreshNav() {
  try {
    const F = p => api('GET', p, undefined, true);  // 外壳状态不走首屏缓存，避免把旧数字存回去
    const r = await F("/api/admin/redemptions?f=attention&size=1");
    const el = $("#nav-attn"); if (el) { el.textContent = r.counts.attention; el.classList.toggle("hidden", !r.counts.attention); }
    const [w, so, ag] = await Promise.all([F("/api/admin/webhooks").catch(() => null), F("/api/admin/shop/orders?size=1").catch(() => null), F("/api/admin/shop/agents?status=pending").catch(() => null)]);
    const pend = ag ? ag.total + (await F("/api/admin/shop/withdrawals?status=pending").catch(() => ({ list: [] }))).list.length : 0;
    for (const [id, n] of [["shop", so?.attention || 0], ["agent", pend]]) { const e = $("#nav-" + id); if (e) { e.textContent = n; e.classList.toggle("hidden", !n); } }
    const last = w?.stats.lastAt;
    const conn = `<span class="dot" style="${w?.secretSet ? "" : "background:var(--warn);box-shadow:0 0 8px var(--warn)"}"></span>${w?.secretSet ? "已配置卡台" : "Webhook 未配置"}<p>最近事件 ${last ? ago(last) : "无"} · 24h 失败 ${w?.stats.failed24h ?? 0}</p>`;
    $("#conn").innerHTML = conn;
    ssSet("cdk-nav", { attn: r.counts.attention, conn, shop: so?.attention || 0, agent: pend });
  } catch { /* 外壳状态失败不影响页面 */ }
}
function accountModal() {
  dialog({
    title: esc(ME.name), sub: esc(ME.email), size: 'sm',
    icon: `<div class="avatar" style="width:40px;height:40px;cursor:default">${esc(ME.name.slice(0, 2).toUpperCase())}</div>`,
    body: `<div class="kv"><div><span>角色</span><b>${ROLE_CN[ME.role]}</b></div><div><span>两步验证</span><b>${ME.totpEnabled ? '<span class="c-ok">已开启</span>' : '<span class="c-warn">未开启</span>'}</b></div></div>`,
    actions: [
      { label: '安全设置', onClick: () => { location.href = 'settings.html?tab=security'; } },
      { label: '退出登录', kind: 'danger', onClick: async () => { await POST('/api/auth/logout'); sessionStorage.clear(); location.href = '/admin/login.html'; return false; } },
    ],
  });
}
function openCmdk() {
  const nav = NAV.flatMap(g => g.items.map(([k, ic, l]) => ({ ic, l, sub: '页面', href: k.startsWith('/') ? k : k + '.html' })));
  const m = dialog({ size: 'lg', header: false, body: `<input id="__q" placeholder="输入兑换码、记录号、订单号、邮箱、策略名或页面名…" autocomplete="off"><div class="res" id="__res"></div>` });
  m.el.classList.add('cmdk');
  let items = nav, t;
  const render = () => {
    $('#__res', m.el).innerHTML = items.slice(0, 14).map((i, n) => `<a href="${i.href}" class="${n ? '' : 'on'}"><span class="tag">${i.ic}</span>${esc(i.l)}<small>${esc(i.sub)}</small></a>`).join('') || '<div class="empty">没有找到</div>';
  };
  const search = async v => {
    const local = nav.filter(i => !v || i.l.includes(v));
    if (!v) { items = local; return render(); }
    try {
      const r = await GET('/api/admin/search?q=' + encodeURIComponent(v));
      const IC = { code: '✦', redemption: '⇄', strategy: '⛉', order: '¥', customer: '☺' };
      const HREF = { code: x => `cdks.html?p=${x.product}&id=${x.id}`, redemption: x => `orders.html?id=${x.id}`, strategy: x => `strategy.html?id=${x.id}`, order: x => `shop-orders.html?no=${x.id}`, customer: x => `customers.html?q=${encodeURIComponent(x.label)}` };
      items = [...r.list.map(x => ({ ic: IC[x.kind], l: x.label, sub: x.sub, href: HREF[x.kind](x) })), ...local];
    } catch { items = local; }
    render();
  };
  render();
  const inp = $('#__q', m.el); inp.focus();
  inp.oninput = () => { clearTimeout(t); t = setTimeout(() => search(inp.value.trim()), 200); };
  inp.onkeydown = e => { if (e.key === 'Enter') { const a = $('#__res a', m.el); a && (location.href = a.href); } };
}
if (IS_ADMIN && !location.pathname.startsWith('/admin/login')) {
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); } });
  // app.js 放在 #page 之后加载，这里 DOM 已经就绪，立即同步构建外壳
  buildShell();
  loadShell().catch(e => e.status !== 401 && toast(e.message, 'bad'));
}
/* 全站通用交互
   - [data-copy]：点击复制（不用内联 onclick，避免把用户输入拼进 JS 里造成 XSS）
   - 可点击的表格行（tr.click）可以用 Tab 聚焦、回车打开
   - 开关（.sw）补上 aria-pressed */
document.addEventListener('click', e => { const b = e.target.closest?.('[data-copy]'); if (b) { e.preventDefault(); e.stopPropagation(); copy(b.dataset.copy, b.dataset.msg || '已复制'); } }, true);
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('tr.click')) { e.preventDefault(); e.target.click(); } });
/** 给 .tbl.stack 的每个单元格写上对应表头，手机上显示成卡片时当小标题 */
const stackLabels = root => (root.matches?.('table.tbl.stack') ? [root] : [...(root.querySelectorAll?.('table.tbl.stack') || [])]).forEach(t => { const hs = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim()); t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => { if (!td.hasAttribute('data-label')) td.setAttribute('data-label', hs[i] || ''); })); });
const a11y = root => {
  stackLabels(root.closest?.('table') || root); root.querySelectorAll?.('tr.click:not([tabindex])').forEach(tr => tr.tabIndex = 0); root.querySelectorAll?.('.sw:not([aria-pressed])').forEach(s => { s.setAttribute('aria-pressed', s.classList.contains('on')); s.type = 'button'; }); };
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && a11y(n.parentNode || n)))).observe(document.documentElement, { childList: true, subtree: true });
a11y(document);
// 页面外壳和下拉框都已就绪，显示内容
Dropdown.scan();
document.documentElement.classList.remove('booting');
/** 页面脚本初始化：有缓存的用户信息时，等页面脚本全部执行完立即开始，不必等 /me 接口 */
const ready = fn => {
  if (ME) document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', () => fn(ME), { once: true }) : setTimeout(() => fn(ME));
  else document.addEventListener('me', () => fn(ME), { once: true });
};

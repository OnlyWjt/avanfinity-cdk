/* ============================================================
   CDK Console · 共享脚本
   - 主题（localStorage: cdk-theme）
   - 后台外壳：侧边栏 / 顶栏 / ⌘K
   - 组件：toast / modal / drawer / confirm
   - 演示数据 MOCK
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (n, cur = '$') => n == null ? '—' : cur + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rnd4 = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0]).join('');
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- 主题 ---------------- */
const PRESETS = {
  aurora: { label: '极光', mode: 'dark', a1: '#8b7cff', a2: '#4fd8ff', a3: '#ff7ac6' },
  sunset: { label: '落日', mode: 'dark', a1: '#ff7a59', a2: '#ffb547', a3: '#ff4fa3' },
  forest: { label: '森林', mode: 'dark', a1: '#2fd38a', a2: '#3ec7c2', a3: '#c6f432' },
  ocean:  { label: '深海', mode: 'dark', a1: '#3a7bff', a2: '#36d1ff', a3: '#7c5cff' },
  sakura: { label: '樱花', mode: 'light', a1: '#ec5f9a', a2: '#9b7bff', a3: '#ffa36c' },
  mono:   { label: '素白', mode: 'light', a1: '#2c2f4a', a2: '#5b6bff', a3: '#22c3a6' },
};
const THEME_DEFAULT = { preset: 'aurora', mode: 'dark', a1: '#8b7cff', a2: '#4fd8ff', a3: '#ff7ac6', r: 18, blur: 24, glow: 60, name: 'CDK Console', logo: 'C', slogan: '一码开通你的会员' };
const Theme = {
  get() { try { return Object.assign({}, THEME_DEFAULT, JSON.parse(localStorage.getItem('cdk-theme') || '{}')); } catch { return { ...THEME_DEFAULT }; } },
  save(t) { localStorage.setItem('cdk-theme', JSON.stringify(t)); },
  lum(hex) { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; },
  apply(t = Theme.get()) {
    const s = document.documentElement.style;
    ['a1', 'a2', 'a3'].forEach(k => s.setProperty('--' + k, t[k]));
    s.setProperty('--r', t.r + 'px'); s.setProperty('--blur', t.blur + 'px'); s.setProperty('--glow', t.glow / 100);
    s.setProperty('--on-a', Theme.lum(t.a1) > .45 ? '#111228' : '#fff');
    const m = t.mode === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t.mode;
    document.documentElement.dataset.mode = m;
    $$('[data-bind=name]').forEach(e => e.textContent = t.name || 'CDK Console');
    $$('[data-bind=logo]').forEach(e => e.textContent = t.logo || 'C');
    $$('[data-bind=slogan]').forEach(e => e.textContent = t.slogan || '');
    $$('[data-bind=mode-icon]').forEach(e => e.textContent = m === 'dark' ? '☾' : '☀');
    document.dispatchEvent(new CustomEvent('theme', { detail: t }));
  },
  toggleMode() { const t = Theme.get(); t.mode = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark'; Theme.save(t); Theme.apply(t); },
};
Theme.apply();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => Theme.get().mode === 'auto' && Theme.apply());

/* ---------------- 组件 ---------------- */
function toast(text, kind = 'ok') {
  let el = $('#__toast');
  if (!el) { el = document.createElement('div'); el.id = '__toast'; el.className = 'toast glass solid'; document.body.appendChild(el); }
  const ic = { ok: '<span class="c-ok">✓</span>', bad: '<span class="c-bad">✕</span>', warn: '<span class="c-warn">⚠</span>', info: '<span class="c-run">ⓘ</span>' }[kind] || '';
  el.innerHTML = ic + esc(text); el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}
function copy(text, label = '已复制') { navigator.clipboard?.writeText(text).catch(() => {}); toast(label); }

/** 打开弹窗。返回 { el, close } */
function modal(html, { wide = false, onClose } = {}) {
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `<div class="modal glass solid ${wide ? 'wide' : ''}">${html}</div>`;
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('show'));
  const close = () => { mask.classList.remove('show'); setTimeout(() => mask.remove(), 200); onClose && onClose(); document.removeEventListener('keydown', onKey); };
  const onKey = e => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  mask.addEventListener('mousedown', e => e.target === mask && close());
  $$('[data-close]', mask).forEach(b => b.onclick = close);
  return { el: $('.modal', mask), close };
}
/** 打开抽屉。返回 { el, close } */
function drawer(html, { onClose } = {}) {
  $$('.__drawer').forEach(d => d.__close && d.__close());
  const mask = document.createElement('div'); mask.className = 'mask';
  const d = document.createElement('aside'); d.className = 'drawer glass solid __drawer'; d.innerHTML = html;
  document.body.append(mask, d);
  requestAnimationFrame(() => { mask.classList.add('show'); d.classList.add('show'); });
  const close = () => { mask.classList.remove('show'); d.classList.remove('show'); setTimeout(() => { mask.remove(); d.remove(); }, 300); onClose && onClose(); document.removeEventListener('keydown', onKey); };
  const onKey = e => e.key === 'Escape' && !$('.mask.show .modal') && close();
  document.addEventListener('keydown', onKey);
  d.__close = close; mask.onclick = close;
  $$('[data-close]', d).forEach(b => b.onclick = close);
  return { el: d, close };
}
/** 二次确认 */
function confirmBox({ title, body = '', ok = '确认', danger = false, typeToConfirm = null }) {
  return new Promise(res => {
    const m = modal(`
      <h2>${title}</h2><div class="sub">${body}</div>
      ${typeToConfirm ? `<div class="flabel">请输入 <span class="mono">${typeToConfirm}</span> 以确认</div><input class="field" id="__ttc" autocomplete="off">` : ''}
      <div class="foot"><button class="btn" data-close>取消</button><button class="btn ${danger ? 'danger solidbg' : 'primary'}" id="__ok" ${typeToConfirm ? 'disabled' : ''}>${ok}</button></div>`,
      { onClose: () => res(false) });
    if (typeToConfirm) $('#__ttc', m.el).oninput = e => $('#__ok', m.el).disabled = e.target.value !== typeToConfirm;
    $('#__ok', m.el).onclick = () => { res(true); m.close(); };
  });
}
/** 按钮 loading → 回调 */
function busy(btn, text, ms, fn) {
  const o = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="pulse"></span> ${text}`;
  setTimeout(() => { btn.disabled = false; btn.innerHTML = o; fn && fn(); }, ms);
}
function segInit(root, onChange) {
  $$('button', root).forEach(b => b.onclick = () => { $$('button', root).forEach(x => x.classList.toggle('on', x === b)); onChange && onChange(b.dataset.v, b); });
}
function swInit(el, onChange) { el.onclick = () => { el.classList.toggle('on'); onChange && onChange(el.classList.contains('on')); }; }
function countdown(el, seconds, onEnd) {
  let s = seconds; const tick = () => { el.textContent = `${String(s / 60 | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; if (s-- <= 0) { clearInterval(t); onEnd && onEnd(); } };
  tick(); const t = setInterval(tick, 1000); return () => clearInterval(t);
}
function qs(k) { return new URLSearchParams(location.search).get(k); }

/* ---------------- 状态字典 ---------------- */
const ST = {
  // CDK
  unused: ['idle', '○ 未使用'], reserved: ['run', '◔ 兑换中'], consumed: ['ok', '✓ 已兑换'], released: ['idle', '↺ 已释放'],
  frozen: ['warn', '❄ 已冻结'], disabled: ['bad', '⊘ 已停用'],
  preparing: ['run', '<i></i>准备中'], prepared: ['acc', '◎ 已报价'], funding: ['run', '<i></i>注资中'], funded: ['acc', '◉ 已注资'],
  paying: ['run', '<i></i>付款中'], review_required: ['warn', '⚑ 需审核'], completed: ['ok', '✓ 已完成'], failed_precharge: ['bad', '✕ 预扣失败'],
  ineligible: ['bad', '✕ 不符合资格'], revoked: ['idle', '⊘ 已撤销'], paid_pending_delivery: ['warn', '◷ 已付待交付'], requires_action: ['warn', '! 需处理'],
  // 策略
  blocked: ['bad', '⛔ 策略拦截'], manual_review: ['warn', '⚑ 待人工审核'],
  // 订单
  ready: ['idle', '○ 待处理'], queued: ['idle', '◷ 排队中'], running: ['run', '<i></i>执行中'], awaiting_card: ['run', '<i></i>处理中'],
  funding_pending: ['run', '<i></i>注资中'], pending: ['run', '<i></i>处理中'], cancel_requested: ['warn', '◷ 取消中'],
  declined: ['bad', '✕ 被拒付'], failed: ['bad', '✕ 失败'], cancelled: ['idle', '⊘ 已取消'], processing: ['run', '<i></i>处理中'],
  // 充值
  confirmed: ['ok', '✓ 已到账'], expired: ['idle', '◷ 已过期'],
  // 卡
  ACTIVE: ['ok', '● 正常'], FROZEN: ['warn', '❄ 已冻结'], CLOSED: ['idle', '⊘ 已注销'], PENDING: ['run', '<i></i>处理中'],
  // 操作
  SUCCEEDED: ['ok', '✓ 成功'], FAILED: ['bad', '✕ 失败'], RECONCILE_REQUIRED: ['warn', '⚑ 待对账'],
  // 交易
  APPROVED: ['ok', '✓ 成功'], DECLINED: ['bad', '✕ 拒付'], REVERSED: ['idle', '↺ 撤销'], SETTLED: ['ok', '✓ 已结算'],
  // webhook
  delivered: ['ok', '✓ 200'], retrying: ['warn', '↻ 重试中'], dead: ['bad', '✕ 放弃'],
};
const badge = s => { const [k, t] = ST[s] || ['idle', s]; return `<span class="badge ${k}">${t}</span>`; };
const PIC = { gpt: '<span class="pic gpt">G</span>', x: '<span class="pic x">𝕏</span>', tg: '<span class="pic tg">✈</span>' };
const PICXS = { gpt: '<span class="pic xs gpt">G</span>', x: '<span class="pic xs x">𝕏</span>', tg: '<span class="pic xs tg">✈</span>' };
const PNAME = { gpt: 'ChatGPT', x: 'X Premium', tg: 'Telegram' };

/* ---------------- 演示数据 ---------------- */
const MOCK = {
  gptPlans: [
    { key: 'go', label: 'ChatGPT Go', sale: 4.90, stock: 96, status: 'READY', fee: 0.30 },
    { key: 'plus', label: 'ChatGPT Plus', sale: 19.80, stock: 412, status: 'READY', fee: 0.80 },
    { key: 'pro_5x', label: 'ChatGPT Pro 5x', sale: 99.00, stock: 38, status: 'READY', fee: 2.00 },
    { key: 'pro_20x', label: 'ChatGPT Pro 20x', sale: 199.00, stock: 12, status: 'READY', fee: 3.00 },
    { key: 'pro_25x', label: 'ChatGPT Pro 25x', sale: null, stock: 0, status: 'WAITING_QUOTE', fee: 3.50 },
  ],
  xPlans: [
    { key: 'premium_3m', label: 'Premium 3 个月', tier: 'premium', months: 3, fee: 1.00, est: 24.10, enabled: true },
    { key: 'premium_6m', label: 'Premium 6 个月', tier: 'premium', months: 6, fee: 1.20, est: 46.30, enabled: true },
    { key: 'premium_12m', label: 'Premium 12 个月', tier: 'premium', months: 12, fee: 1.50, est: 84.00, enabled: true },
    { key: 'premium_plus_3m', label: 'Premium+ 3 个月', tier: 'premium_plus', months: 3, fee: 1.50, est: 62.00, enabled: true },
    { key: 'premium_plus_6m', label: 'Premium+ 6 个月', tier: 'premium_plus', months: 6, fee: 2.00, est: 118.00, enabled: true },
    { key: 'premium_plus_12m', label: 'Premium+ 12 个月', tier: 'premium_plus', months: 12, fee: 2.50, est: 229.00, enabled: false },
  ],
  tgPlans: [
    { key: 'premium_3m', label: 'Premium 3 个月', months: 3, fee: 0.60, est: 11.99, enabled: true },
    { key: 'premium_6m', label: 'Premium 6 个月', months: 6, fee: 0.80, est: 15.99, enabled: true },
    { key: 'premium_12m', label: 'Premium 12 个月', months: 12, fee: 1.00, est: 28.99, enabled: true },
  ],
  gptCdks: [
    { id: 'cdk_8f21', prefix: 'GPTD-7K2Q', strat: 's_taobao', plan: 'plus', fnc: true, status: 'consumed', inv: 'consumed', sale: 19.80, batch: 'B-1025-0142', who: 'm***@gmail.com', at: '10-25 14:20', created: '10-25 09:12' },
    { id: 'cdk_8f22', prefix: 'GPTD-Z3RE', strat: 's_taobao', plan: 'pro_20x', fnc: true, status: 'released', inv: 'released', sale: 199.00, batch: 'B-1025-0142', who: 'z***@qq.com', at: '10-25 13:51', created: '10-25 09:12', fail: '支付被拒（do_not_honor），已自动重试 2 次' },
    { id: 'cdk_8f23', prefix: 'GPTD-L0C1', strat: 's_taobao', plan: 'plus', fnc: false, status: 'unused', inv: 'unused', sale: 19.80, batch: 'B-1025-0142', who: '—', at: '—', created: '10-25 09:12' },
    { id: 'cdk_8f24', prefix: 'GPTD-A88W', strat: 's_default', plan: 'go', fnc: false, status: 'consumed', inv: 'consumed', sale: 4.90, batch: 'B-1024-0139', who: 'l***@outlook.com', at: '10-25 09:40', created: '10-24 18:02' },
    { id: 'cdk_8f25', prefix: 'GPTD-P7MN', strat: 's_default', plan: 'plus', fnc: false, status: 'reserved', inv: 'reserved', sale: 19.80, batch: 'B-1024-0139', who: 'k***@gmail.com', at: '10-25 14:22', created: '10-24 18:02' },
    { id: 'cdk_8f26', prefix: 'GPTD-W2XY', strat: 's_default', plan: 'pro_5x', fnc: false, status: 'frozen', inv: 'frozen', sale: 99.00, batch: 'B-1024-0139', who: '—', at: '—', created: '10-24 18:02' },
    { id: 'cdk_8f27', prefix: 'GPTD-H6TT', strat: 's_default', plan: 'plus', fnc: false, status: 'unused', inv: 'unused', sale: 19.80, batch: 'B-1023-0131', who: '—', at: '—', created: '10-23 11:30' },
    { id: 'cdk_8f28', prefix: 'GPTD-QQ9R', strat: 's_default', plan: 'go', fnc: false, status: 'disabled', inv: 'disabled', sale: 4.90, batch: 'B-1023-0131', who: '—', at: '—', created: '10-23 11:30' },
  ],
  xCdks: [
    { id: 'xc_1a', prefix: 'XCDK-M91A', strat: 's_default', plan: 'premium_plus_12m', status: 'paying', maxDebit: 240.00, maxOfficial: 2850000, cur: 'BDT', funding: 232.00, total: 236.50, who: '@elonfan', at: '10-25 14:16', created: '10-24 20:00' },
    { id: 'xc_1b', prefix: 'XCDK-Q2NV', strat: 's_default', plan: 'premium_3m', status: 'revoked', maxDebit: 30.00, maxOfficial: 290000, cur: 'BDT', funding: 26.00, total: 27.40, who: '—', at: '—', created: '10-24 20:00' },
    { id: 'xc_1c', prefix: 'XCDK-R8BB', strat: 's_default', plan: 'premium_6m', status: 'unused', maxDebit: 52.00, maxOfficial: 560000, cur: 'BDT', funding: 48.00, total: 49.90, who: '—', at: '—', created: '10-24 20:00' },
    { id: 'xc_1d', prefix: 'XCDK-5TLM', strat: 's_default', plan: 'premium_12m', status: 'completed', maxDebit: 90.00, maxOfficial: 1010000, cur: 'BDT', funding: 86.00, total: 87.50, who: '@devmia', at: '10-25 08:02', created: '10-23 10:00' },
    { id: 'xc_1e', prefix: 'XCDK-9KDW', strat: 's_default', plan: 'premium_3m', status: 'funded', maxDebit: 30.00, maxOfficial: 290000, cur: 'BDT', funding: 26.00, total: 27.40, who: '@koala_x', at: '10-25 14:10', created: '10-23 10:00' },
    { id: 'xc_1f', prefix: 'XCDK-UU3P', strat: 's_default', plan: 'premium_6m', status: 'review_required', maxDebit: 52.00, maxOfficial: 560000, cur: 'BDT', funding: 48.00, total: 49.90, who: '@fresh_acc', at: '10-25 12:30', created: '10-23 10:00' },
  ],
  tgCdks: [
    { id: 'tc_2a', prefix: 'TGCD-HH4T', strat: 's_default', plan: 'premium_12m', status: 'completed', maxDebit: 32.00, maxOfficial: 2899, cur: 'USD', funding: 30.00, total: 30.60, who: '@neko_dev', at: '10-25 11:08', created: '10-22 09:00', giftDays: 365 },
    { id: 'tc_2b', prefix: 'TGCD-P0LX', strat: 's_default', plan: 'premium_6m', status: 'unused', maxDebit: 18.00, maxOfficial: 1599, cur: 'USD', funding: 17.00, total: 17.40, who: '—', at: '—', created: '10-22 09:00' },
    { id: 'tc_2c', prefix: 'TGCD-7YQE', strat: 's_default', plan: 'premium_3m', status: 'paid_pending_delivery', maxDebit: 14.00, maxOfficial: 1199, cur: 'USD', funding: 13.00, total: 13.30, who: '@sleepycat', at: '10-25 13:40', created: '10-22 09:00' },
    { id: 'tc_2d', prefix: 'TGCD-B4ZC', strat: 's_default', plan: 'premium_3m', status: 'ineligible', maxDebit: 14.00, maxOfficial: 1199, cur: 'USD', funding: 13.00, total: 13.30, who: '@already_prem', at: '10-25 10:12', created: '10-22 09:00' },
  ],
  orders: [
    { id: 'rq_0931', type: 'gpt', src: 'cdk', ref: 'GPTD-L0C1', plan: 'ChatGPT Plus', who: 'm***@gmail.com', amount: 0, fee: 0, status: 'blocked', next: 'none', at: '10-25 14:25', strat: 's_taobao', rule: '账号 m***@gmail.com 365 天内已兑换 1 次（上限 1）' },
    { id: 'rq_0930', type: 'gpt', src: 'cdk', ref: 'GPTD-H6TT', plan: 'ChatGPT Plus', who: 'q***@gmail.com', amount: 19.80, fee: 0.80, status: 'manual_review', next: 'approve', at: '10-25 14:24', strat: 's_default', rule: '实时报价 $22.10 高于售价 $19.80 超过 10%' },
    { id: 'go_7c1e', type: 'gpt', src: 'cdk', ref: 'GPTD-7K2Q', plan: 'ChatGPT Plus', who: 'm***@gmail.com', amount: 19.80, fee: 0.80, status: 'completed', next: 'none', at: '10-25 14:20', willRenew: false },
    { id: 'xo_44a0', type: 'x', src: 'cdk', ref: 'XCDK-M91A', plan: 'X Premium+ 12 个月', who: '@elonfan', amount: 229.00, fee: 2.50, status: 'processing', next: 'wait', at: '10-25 14:16' },
    { id: 'go_7c1d', type: 'gpt', src: 'cdk', ref: 'GPTD-P7MN', plan: 'ChatGPT Plus', who: 'k***@gmail.com', amount: 19.80, fee: 0.80, status: 'running', next: 'wait', at: '10-25 14:22' },
    { id: 'go_7c1a', type: 'gpt', src: 'cdk', ref: 'GPTD-Z3RE', plan: 'ChatGPT Pro 20x', who: 'z***@qq.com', amount: 199.00, fee: 3.00, status: 'declined', next: 'released', at: '10-25 13:51', reason: '支付被拒：do_not_honor', strat: 's_taobao', retried: 2 },
    { id: 'tgo_19', type: 'tg', src: 'cdk', ref: 'TGCD-7YQE', plan: 'Telegram 3 个月', who: '@sleepycat', amount: 11.99, fee: 0.60, status: 'paid_pending_delivery', next: 'wait', at: '10-25 13:40' },
    { id: 'go_7c19', type: 'gpt', src: 'cdk', ref: 'GPTD-K8VN', plan: 'ChatGPT Pro 5x', who: 'a***@corp.io', amount: 99.00, fee: 2.00, status: 'requires_action', next: 'submit_session', at: '10-25 12:58' },
    { id: 'xo_449f', type: 'x', src: 'cdk', ref: 'XCDK-UU3P', plan: 'X Premium 6 个月', who: '@fresh_acc', amount: 46.30, fee: 1.20, status: 'review_required', next: 'contact_support', at: '10-25 12:30' },
    { id: 'tgo_18', type: 'tg', src: 'cdk', ref: 'TGCD-HH4T', plan: 'Telegram 12 个月', who: '@neko_dev', amount: 28.99, fee: 1.00, status: 'completed', next: 'none', at: '10-25 11:08' },
    { id: 'go_7c10', type: 'gpt', src: 'cdk', ref: 'GPTD-A88W', plan: 'ChatGPT Go', who: 'l***@outlook.com', amount: 4.90, fee: 0.30, status: 'completed', next: 'none', at: '10-25 09:40', willRenew: false },
  ],
  _blocked: 0,
  txs: [
    { id: 551203, ref: 'GPTD-7K2Q', order: 'go_7c1e', type: 'AUTH', status: 'APPROVED', amt: 20.00, cur: 'USD', merchant: 'OPENAI *CHATGPT SUBSCR', country: 'US', at: '10-25 14:20' },
    { id: 551199, ref: 'XCDK-M91A', order: 'xo_44a0', type: 'AUTH', status: 'APPROVED', amt: 229.00, cur: 'USD', merchant: 'X CORP. PAID FEATURES', country: 'US', at: '10-25 14:16', merchantAmt: '27,830.00 BDT' },
    { id: 551188, ref: 'GPTD-Z3RE', order: 'go_7c1a', type: 'AUTH', status: 'DECLINED', amt: 200.00, cur: 'USD', merchant: 'OPENAI *CHATGPT SUBSCR', country: 'US', at: '10-25 13:51', reason: 'do_not_honor' },
    { id: 551170, ref: 'TGCD-7YQE', order: 'tgo_19', type: 'AUTH', status: 'APPROVED', amt: 11.99, cur: 'USD', merchant: 'TELEGRAM PREMIUM', country: 'AE', at: '10-25 13:40' },
    { id: 551152, ref: 'GPTD-K8VN', order: 'go_7c19', type: 'REVERSAL', status: 'REVERSED', amt: 1.00, cur: 'USD', merchant: 'OPENAI *VERIFY', country: 'US', at: '10-25 12:58' },
    { id: 551140, ref: 'TGCD-HH4T', order: 'tgo_18', type: 'SETTLEMENT', status: 'SETTLED', amt: 28.99, cur: 'USD', merchant: 'TELEGRAM PREMIUM', country: 'AE', at: '10-25 11:08' },
    { id: 551121, ref: 'GPTD-P7MN', order: 'go_7c1d', type: 'AUTH', status: 'APPROVED', amt: 20.00, cur: 'USD', merchant: 'OPENAI *CHATGPT SUBSCR', country: 'US', at: '10-25 10:30' },
    { id: 551090, ref: 'GPTD-W2XY', order: 'go_7c0f', type: 'AUTH', status: 'DECLINED', amt: 20.00, cur: 'USD', merchant: 'OPENAI *CHATGPT SUBSCR', country: 'US', at: '10-24 19:12', reason: 'insufficient_funds' },
  ],
  webhookEvents: {
    '支付流水': ['card.transaction.updated'],
    'OpenAI 直充': ['openai.direct.updated', 'openai.direct.progress', 'openai.direct.completed', 'openai.direct.failed', 'openai.direct.cancelled'],
    'OpenAI CDK': ['openai.cdk.updated', 'openai.cdk.released', 'openai.cdk.reserved', 'openai.cdk.consumed', 'openai.cdk.frozen', 'openai.cdk.unfrozen', 'openai.cdk.disabled'],
    '测试': ['webhook.test'],
  },
  deliveries: [
    { id: 'evt_9a01', type: 'openai.cdk.consumed', status: 'delivered', code: 200, ms: 84, at: '14:20:31', tries: 1 },
    { id: 'evt_9a00', type: 'openai.cdk.reserved', status: 'delivered', code: 200, ms: 72, at: '14:20:31', tries: 1 },
    { id: 'evt_99ff', type: 'openai.direct.progress', status: 'delivered', code: 200, ms: 91, at: '14:15:02', tries: 1 },
    { id: 'evt_99fa', type: 'openai.direct.failed', status: 'retrying', code: 502, ms: 3012, at: '13:51:40', tries: 3 },
    { id: 'evt_99f2', type: 'openai.cdk.released', status: 'delivered', code: 200, ms: 66, at: '13:51:40', tries: 1 },
    { id: 'evt_99e0', type: 'openai.direct.completed', status: 'delivered', code: 200, ms: 120, at: '09:02:11', tries: 1 },
    { id: 'evt_99c1', type: 'card.transaction.updated', status: 'dead', code: 500, ms: 88, at: '昨天 19:12', tries: 8 },
  ],
};

// CDK 系统只处理兑换订单
MOCK.orders = MOCK.orders.filter(o => o.src === 'cdk');

/* ---------------- 兑换策略 ---------------- */
// layer: own = 我方系统前置控制；gen = 生成时写入卡台（快照，之后不可改）；platform = 卡台强制
const STRAT_DEFAULT = [
  { id: 's_default', name: '默认策略', on: true, prio: 3, prod: ['gpt', 'x', 'tg'], desc: '所有未指定策略的兑换码', hits: 4,
    ipH: 20, devD: 5, captcha: 3, expire: 0, timeOn: false, from: '09:00', to: '23:00', geo: '', black: '',
    accN: 1, accDays: 30, freeOnly: false, mailAllow: '', mailBlock: 'tempmail.com, 10minutemail.com',
    priceTol: 10, priceAct: 'manual', costCap: 30, failAct: 'release', retryN: 1, payMode: 'shared', mode: 'hosted', prefix: '' },
  { id: 's_taobao', name: '淘宝渠道 · 严格', on: true, prio: 1, prod: ['gpt'], desc: '防倒卖、防盗号', hits: 23,
    ipH: 5, devD: 2, captcha: 1, expire: 30, timeOn: true, from: '08:00', to: '24:00', geo: '', black: '',
    accN: 1, accDays: 365, freeOnly: true, mailAllow: '', mailBlock: 'tempmail.com, 10minutemail.com, guerrillamail.com',
    priceTol: 5, priceAct: 'block', costCap: 25, failAct: 'retry', retryN: 2, payMode: 'own', mode: 'own', prefix: 'TB' },
  { id: 's_vip', name: 'VIP 客户 · 宽松', on: true, prio: 2, prod: ['gpt', 'x', 'tg'], desc: '老客户，不限次数，失败自动重试', hits: 0,
    ipH: 60, devD: 30, captcha: 10, expire: 0, timeOn: false, from: '00:00', to: '24:00', geo: '', black: '',
    accN: 10, accDays: 30, freeOnly: false, mailAllow: '', mailBlock: '',
    priceTol: 30, priceAct: 'pass', costCap: 260, failAct: 'retry', retryN: 3, payMode: 'own', mode: 'own', prefix: 'VIP' },
];
const Strat = {
  all() { try { return JSON.parse(localStorage.getItem('cdk-strategies')) || structuredClone(STRAT_DEFAULT); } catch { return structuredClone(STRAT_DEFAULT); } },
  save(l) { localStorage.setItem('cdk-strategies', JSON.stringify(l)); },
  get(id) { return Strat.all().find(s => s.id === id); },
};
const LAYER = {
  own: '<span class="badge ok" title="在我们自己的后端执行，完全可控">我方控制</span>',
  gen: '<span class="badge acc" title="生成兑换码时写入卡台，之后这批码不能再改">生成时写入</span>',
  platform: '<span class="badge idle" title="卡台强制执行，无法覆盖">卡台强制</span>',
};

/* ---------------- 后台外壳 ---------------- */
const NAV = [
  { h: null, items: [['index', '◉', '总览']] },
  { h: 'CDK', items: [['cdks', '✦', 'CDK 管理'], ['generate', '＋', '生成 CDK'], ['orders', '⇄', '兑换记录', 3], ['strategy', '⛉', '兑换策略'], ['pricing', '▤', '售价与利润']] },
  { h: '数据', items: [['insights', '◔', '成功率分析'], ['transactions', '≡', '支付流水']] },
  { h: '系统', items: [['webhooks', '⌁', 'Webhook'], ['settings', '⚙', '设置'], ['theme', '◐', '主题与品牌']] },
  { h: '前台', items: [['redeem', '↗', '用户兑换页'], ['receipt', '↗', '凭证查询']] },
];
function mountShell() {
  const page = document.body.dataset.page;
  const content = $('#page');
  if (!content) return;
  const t = Theme.get();
  const nav = NAV.map(g => `${g.h ? `<div class="nav-h">${g.h}</div>` : ''}${g.items.map(([k, ic, label, ct]) =>
    `<a href="${k}.html" class="${k === page ? 'on' : ''}" ${['redeem', 'receipt'].includes(k) ? 'target="_blank"' : ''}><span class="ic">${ic}</span>${label}${ct ? `<span class="ct">${ct}</span>` : ''}</a>`).join('')}`).join('');
  const shell = document.createElement('div');
  shell.className = 'app';
  shell.innerHTML = `
    <aside class="side glass">
      <a class="brand" href="index.html"><div class="logo" data-bind="logo">${esc(t.logo)}</div><span data-bind="name">${esc(t.name)}</span></a>
      <nav class="nav">${nav}</nav>
      <div class="conn"><span class="dot"></span>卡台已连接<p>延迟 86ms · Webhook 正常 · v2026-09-30</p></div>
    </aside>
    <main class="main">
      <div class="top">
        <div><div class="crumb" id="crumb"></div><h1 id="title"></h1></div>
        <div class="acts">
          <div class="search" id="openCmdk">⌕ 搜索兑换码、记录、策略<kbd>⌘K</kbd></div>
          <a class="btn" href="theme.html" title="主题">◐</a>
          <button class="btn" id="modeBtn" title="切换深浅色"><span data-bind="mode-icon">☾</span></button>
          <div class="avatar" id="avatarBtn" title="账户">MC</div>
        </div>
      </div>
      <div id="pageSlot"></div>
    </main>`;
  content.parentNode.insertBefore(shell, content);
  $('#pageSlot').appendChild(content);
  $('#title').innerHTML = content.dataset.title || '';
  $('#crumb').innerHTML = content.dataset.crumb || '';
  $('#modeBtn').onclick = Theme.toggleMode;
  $('#openCmdk').onclick = openCmdk;
  $('#avatarBtn').onclick = () => {
    const m = modal(`<h2>账户 <button class="iconbtn" data-close>×</button></h2>
      <div class="kv mt12"><div><span>登录账号</span><b>admin@yourshop.com</b></div><div><span>角色</span><b>超级管理员</b></div><div><span>当前 API Key</span><b class="mono">key_main</b></div><div><span>上次登录</span><b>10-25 08:41 · 203.0.113.8</b></div></div>
      <div class="foot"><a class="btn" href="settings.html">账户设置</a><a class="btn danger" href="login.html">退出登录</a></div>`);
  };
  Theme.apply();
}
function openCmdk() {
  const items = [
    ...NAV.flatMap(g => g.items.map(([k, ic, l]) => ({ ic, l, sub: '页面', href: k + '.html' }))),
    ...MOCK.gptCdks.map(c => ({ ic: 'G', l: c.prefix + '-••••', sub: 'ChatGPT CDK · ' + c.plan, href: 'cdks.html?p=gpt&q=' + c.prefix })),
    ...MOCK.xCdks.map(c => ({ ic: '𝕏', l: c.prefix + '-••••', sub: 'X CDK · ' + c.plan, href: 'cdks.html?p=x&q=' + c.prefix })),
    ...MOCK.tgCdks.map(c => ({ ic: '✈', l: c.prefix + '-••••', sub: 'TG CDK · ' + c.plan, href: 'cdks.html?p=tg&q=' + c.prefix })),
    ...MOCK.orders.map(o => ({ ic: '⇄', l: o.id + ' · ' + o.who, sub: '兑换记录 · ' + o.plan, href: 'orders.html?id=' + o.id })),
    ...Strat.all().map(s => ({ ic: '⛉', l: s.name, sub: '兑换策略', href: 'strategy.html?id=' + s.id })),
  ];
  const m = modal(`<div class="cmdk"><input id="__q" placeholder="输入兑换码前缀、订单号、卡号后四位、页面名…"><div class="res" id="__res"></div></div>`);
  m.el.classList.add('cmdk'); m.el.style.padding = 0;
  const render = q => {
    const r = items.filter(i => !q || (i.l + i.sub).toLowerCase().includes(q.toLowerCase())).slice(0, 12);
    $('#__res', m.el).innerHTML = r.map((i, n) => `<a href="${i.href}" class="${n ? '' : 'on'}"><span class="tag">${i.ic}</span>${esc(i.l)}<small>${esc(i.sub)}</small></a>`).join('') || '<div class="empty">没有找到</div>';
  };
  render(''); const inp = $('#__q', m.el); inp.focus(); inp.oninput = () => render(inp.value);
  inp.onkeydown = e => { if (e.key === 'Enter') { const a = $('#__res a', m.el); a && (location.href = a.href); } };
}
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); } });
document.addEventListener('DOMContentLoaded', mountShell);

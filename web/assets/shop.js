/* 商城前台公共：顶栏、买家登录状态、分站 / 推广归因、最近订单、支付方式选择
   页面结构：<header class="pub-top" id="shopTop" data-on="shop|query|account|agent"></header> */
const yuan = c => (Number(c) < 0 ? '-¥' : '¥') + (Math.abs(Number(c || 0)) / 100).toFixed(2);
const yuanN = c => (Number(c || 0) / 100).toFixed(2);
const DEVICE = localStorage.getItem('cdk-device') || (() => { const d = uuid(); localStorage.setItem('cdk-device', d); return d; })();

/* 分站：/s/{slug} 进入后，本次浏览的订单页、查询页都保持分站品牌 */
const STORE = (() => {
  const m = location.pathname.match(/^\/s\/([a-z0-9-]+)/);
  if (m) { sessionStorage.setItem('shop-store', m[1]); return m[1]; }
  if (['/', '/shop/', '/shop/index.html'].includes(location.pathname)) { sessionStorage.removeItem('shop-store'); return ''; }
  return sessionStorage.getItem('shop-store') || '';
})();
const storeHome = () => (STORE && !CFG?.storeMissing ? `/s/${STORE}` : '/shop/');
/* 推广链接：?ref={slug}，在本机保留 refDays 天 */
(() => { const r = qs('ref'); if (r && /^[a-z0-9-]{3,24}$/.test(r)) localStorage.setItem('shop-ref', JSON.stringify({ slug: r, at: Date.now() })); })();
const refSlug = days => { try { const r = JSON.parse(localStorage.getItem('shop-ref') || 'null'); return r && Date.now() - r.at < (days || 30) * 86400e3 ? r.slug : ''; } catch { return ''; } };

/* 本机最近订单（免注册买家找回订单用） */
const Recent = {
  list() { try { return JSON.parse(localStorage.getItem('shop-orders') || '[]'); } catch { return []; } },
  add(o) { const l = Recent.list().filter(x => x.no !== o.no); l.unshift({ ...o, at: Date.now() }); localStorage.setItem('shop-orders', JSON.stringify(l.slice(0, 20))); },
};
const orderUrl = (no, t) => `/shop/order.html?no=${encodeURIComponent(no)}${t ? '&t=' + encodeURIComponent(t) : ''}`;

/* 配置 + 登录状态：先用本标签页缓存渲染顶栏，接口返回后再刷新 */
let CFG = ssGet('shop-cfg:' + STORE) || null, MEC = CFG ? CFG.me : null;
const cfgReady = GET('/api/shop/config' + (STORE ? '?store=' + STORE : '')).then(c => {
  CFG = c; MEC = c.me; ssSet('shop-cfg:' + STORE, c);
  if (c.storeMissing) sessionStorage.removeItem('shop-store');  // 店铺不存在 / 已停用：不要把买家困在这个店铺里
  Theme.apply(c.theme, true); shopTop(); return c;
});
function shopTop() {
  const el = $('#shopTop'); if (!el) return;
  const on = el.dataset.on, t = Theme.cached();
  const name = CFG?.store ? CFG.store.name : (CFG?.shop.title || t.name);
  el.innerHTML = `<a class="brand" href="${storeHome()}" style="padding:0"><div class="logo" data-bind="logo">${esc(t.logo)}</div><span>${esc(name || '')}</span></a>
    <nav><a class="${on === 'shop' ? 'on' : ''}" href="${storeHome()}">商城</a><a href="/redeem">兑换</a><a class="${on === 'query' ? 'on' : ''}" href="/shop/query.html">查订单</a>
      <a class="${on === 'account' || on === 'agent' ? 'on' : ''}" href="/account/">${MEC ? '我的' : '登录'}</a>
      <button class="btn ghost sm" onclick="Theme.toggleMode()" aria-label="切换深浅色"><span data-bind="mode-icon">☾</span></button></nav>`;
  Theme.apply();
}
shopTop();

/* 支付方式 */
const PM_IC = { alipay: '支', wxpay: '微', wechat: '微', usdt: '₮', qqpay: 'Q', bank: '银', balance: '¥', manual: '人' };
const PM_NAME = { epay: '在线支付', alipay: '支付宝', wechat: '微信支付', usdt: 'USDT', balance: '余额', manual: '人工确认' };
const pmIcon = k => `<span class="pm-ic pm-${esc(k)}">${PM_IC[k] || '¥'}</span>`;
const pmLabel = (method, sub) => { const m = (CFG?.payMethods || []).find(x => x.method === method && (x.sub || '') === (sub || '')); return m ? m.label : PM_NAME[method] || method; };
/**
 * 渲染支付方式选择，返回 pick() => { method, sub }
 *   balance  可用余额（分），null 表示不显示余额支付
 *   total    应付金额（分）：余额不够时余额选项置灰并提示差多少，默认选第一个可用渠道
 *   current  当前已选的 { method, sub }（换支付方式时预选）
 *   pick.setTotal(n) 金额变化（改数量 / 用券）后刷新
 */
function payPicker(el, { balance = null, exclude = [], total = null, current = null } = {}) {
  const list = [...(balance != null ? [{ method: 'balance', label: '余额支付', icon: 'balance' }] : []), ...(CFG?.payMethods || [])].filter(m => !exclude.includes(m.method));
  if (!list.length) { el.innerHTML = '<div class="note warn">暂时没有可用的支付方式，请联系客服</div>'; const none = () => null; none.setTotal = () => {}; return none; }
  let cur = -1;
  const short = m => m.method === 'balance' && total != null && balance < total;
  const draw = () => {
    if (cur < 0 || short(list[cur])) {
      const want = current ? list.findIndex(m => m.method === current.method && (m.sub || '') === (current.sub || '')) : -1;
      cur = want >= 0 && !short(list[want]) ? want : list.findIndex(m => !short(m));
    }
    el.innerHTML = `<div class="choice ${list.length > 1 ? 'c2' : ''}" role="radiogroup" aria-label="支付方式">${list.map((m, i) => {
      const note = m.method === 'balance' ? (short(m) ? `余额 ${yuan(balance)}，还差 ${yuan(total - balance)}` : `可用 ${yuan(balance)}`) : m.note;
      return `<button type="button" class="opt pm ${i === cur ? 'on' : ''}" role="radio" aria-checked="${i === cur}" data-i="${i}" ${short(m) ? 'disabled' : ''}>${pmIcon(m.icon)}<span><b>${esc(m.label)}</b>${note ? `<small>${esc(note)}</small>` : ''}</span></button>`;
    }).join('')}</div>`;
    $$('[data-i]', el).forEach(b => b.onclick = () => { cur = +b.dataset.i; draw(); el.dispatchEvent(new Event('change')); });
  };
  draw();
  const pick = () => (cur >= 0 ? { method: list[cur].method, sub: list[cur].sub } : null);
  pick.setTotal = n => { total = n; draw(); };
  return pick;
}
/** 按钮显示忙碌状态执行 fn（不弹 toast，错误交给调用方显示在表单里） */
async function busy(btn, text, fn) {
  const o = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${text}`;
  try { return await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = o; } }
}
/** 客服联系方式（分站优先用代理的） */
const contactText = () => CFG?.store?.contact || CFG?.redeem?.contact || '';
const contactLine = () => (contactText() ? `<p class="xs faint mt12" style="text-align:center">遇到问题？联系客服：${esc(contactText())}</p>` : '');
/** 列表加载失败：401 去登录，其他显示可重试的错误 */
function loadFail(el, e, retry) {
  if (e?.status === 401) { location.href = '/account/?next=' + encodeURIComponent(location.pathname + location.search); return; }
  el.innerHTML = `<div class="empty"><div class="ic">!</div>${esc(e?.message || '加载失败')}<br><button class="link mt8" type="button">重试</button></div>`;
  $('button', el).onclick = retry;
}
/** 当前可用的支付方式名称（只含已开启且配置完整的渠道，同名去重） */
const payNames = () => [...new Set((CFG?.payMethods || []).map(m => m.label))];
/** 下单 / 换支付方式后：跳转收银台，或去订单页显示二维码 */
function afterPay(no, token, pay) {
  if (pay?.type === 'redirect' && pay.url) { location.href = pay.url; return; }
  location.href = orderUrl(no, token);
}
const ORDER_ST = {
  pending: ['warn', '待付款'], paid: ['run', '<i></i>发货中'], delivered: ['ok', '✓ 已完成'], closed: ['idle', '已关闭'], refunded: ['idle', '↺ 已退款'],
};
const oBadge = s => { const [k, t] = ORDER_ST[s] || ['idle', esc(s)]; return `<span class="badge ${k}">${t}</span>`; };

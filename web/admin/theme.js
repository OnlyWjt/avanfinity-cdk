/* 主题与品牌：所有改动实时预览（后台本身 + 右侧嵌入的真实商城 / 兑换页），保存后全站生效 */
let T = null, saved = '';
const isSaved = () => JSON.stringify(T) === saved;

/* ---------- 各维度的选项 ---------- */
const FONT_STACK = {
  // 内层用单引号：这些值会写进 style="..." 属性里
  modern: "system-ui,'PingFang SC','Microsoft YaHei',sans-serif",
  rounded: "'SF Pro Rounded','HarmonyOS Sans SC','PingFang SC','Microsoft YaHei UI',ui-rounded,sans-serif",
  serif: "'Noto Serif SC','Source Han Serif SC','Songti SC','STSong','SimSun',Georgia,serif",
  tech: "'SF Mono','JetBrains Mono',Menlo,Consolas,monospace",
};
const DIMS = {
  bg: [['aurora', '极光', '柔和的三色光晕'], ['mesh', '流光', '大块色彩缓慢漂移'], ['grid', '网格', '科技感细网格'], ['dots', '点阵', '细密的点状纹理'], ['plain', '纯色', '干净，只留顶部一点光']],
  card: [['glass', '玻璃', '半透明磨砂'], ['solid', '实色', '不透明，更清晰'], ['outline', '描边', '轻盈的线框'], ['neo', '浮雕', '柔和的立体阴影']],
  font: [['modern', '现代'], ['rounded', '圆润'], ['serif', '宋体'], ['tech', '科技']],
  btn: [['gradient', '渐变'], ['solid', '纯色'], ['glow', '霓虹']],
  shape: [['round', '圆角'], ['pill', '胶囊'], ['square', '直角']],
};
const BASE = { dark: '#0b0c1d', light: '#f3f4fa' };
/** 预设缩略图：用这套主题自己的背景、卡片、字体和按钮画一个小场景 */
function scene(p) {
  const base = BASE[p.mode], dark = p.mode === 'dark';
  const glow = (c, x, y, a = 60) => `radial-gradient(circle at ${x}% ${y}%,${c}${Math.round(a * 2.2).toString(16).padStart(2, '0')},transparent ${a}%)`;
  const line = dark ? 'rgba(255,255,255,.08)' : 'rgba(20,24,60,.08)';
  const bgs = {
    aurora: [glow(p.a1, 15, 10), glow(p.a2, 95, 35, 55), glow(p.a3, 50, 120, 55)],
    mesh: [glow(p.a1, 20, 20, 70), glow(p.a2, 85, 25, 65), glow(p.a3, 55, 95, 70)],
    grid: [glow(p.a1, 20, 0, 55), `linear-gradient(${line} 1px,transparent 1px) 0 0/12px 12px`, `linear-gradient(90deg,${line} 1px,transparent 1px) 0 0/12px 12px`],
    dots: [glow(p.a1, 25, 5, 50), `radial-gradient(${dark ? 'rgba(255,255,255,.18)' : 'rgba(20,24,60,.18)'} 1px,transparent 1.4px) 0 0/8px 8px`],
    plain: [glow(p.a1, 50, -30, 60)],
  }[p.bg];
  const cardBg = { glass: dark ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.62)', solid: dark ? '#17182e' : '#ffffff', outline: 'transparent', neo: dark ? 'linear-gradient(160deg,#1d1e36,#121329)' : base }[p.card];
  const cardBd = p.card === 'outline' ? p.a1 + '99' : p.card === 'neo' ? 'transparent' : (dark ? 'rgba(255,255,255,.12)' : 'rgba(20,24,60,.08)');
  const cardSh = p.card === 'neo' ? (dark ? '0 6px 12px -6px #000' : '4px 4px 10px rgba(40,44,110,.15),-4px -4px 10px #fff') : 'none';
  const rad = Math.round(p.r * .45);
  const btnR = p.shape === 'pill' ? 99 : p.shape === 'square' ? 2 : Math.max(3, Math.round(p.r * .3));
  const btnBg = p.btn === 'solid' ? p.a1 : `linear-gradient(135deg,${p.a1},${p.a2})`;
  const btnSh = p.btn === 'glow' ? `0 0 10px ${p.a1}` : 'none';
  return `<div class="scene" style="background:${bgs.join(',')},${base}"></div>
    <div class="chip" style="background:${cardBg};border-color:${cardBd};box-shadow:${cardSh};border-radius:${rad}px;font-family:${FONT_STACK[p.font]};color:${dark ? '#eef0ff' : '#16173a'}">Aa</div>
    <div class="bar" style="background:${btnBg};border-radius:${btnR}px;box-shadow:${btnSh}"></div>`;
}
$('#presets').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<button class="pre" data-k="${k}" type="button" aria-label="${p.label}主题">${scene(p)}<div class="nm">${p.label}<small>${p.mode === 'dark' ? '深色' : '浅色'}</small></div></button>`).join('');
$$('[data-dim]').forEach(box => {
  const dim = box.dataset.dim;
  box.innerHTML = DIMS[dim].map(([v, label, tip]) => `<button type="button" class="chipopt" data-v="${v}" ${tip ? `title="${tip}"` : ''}>${dim === 'font' ? `<span class="f-sample" style="font-family:${FONT_STACK[v]}">会员 Aa</span>` : ''}${label}</button>`).join('');
  $$('button', box).forEach(b => b.onclick = () => { T[dim] = b.dataset.v; T.preset = 'custom'; sync(); });
});

/* ---------- 预览：嵌入真实页面，通过 postMessage 推送当前主题 ---------- */
const PV = { tab: 'shop', dev: 'desk' };
const frame = $('#pvFrame'), stage = $('#prevBox');
function layoutFrame() {
  const w = PV.dev === 'phone' ? 390 : 1280;
  const sc = stage.clientWidth / w;
  frame.style.width = w + 'px'; frame.style.height = stage.clientHeight / sc + 'px'; frame.style.transform = `scale(${sc})`;
}
function loadFrame() {
  const comp = PV.tab === 'comp';
  stage.classList.toggle('hidden', comp); $('#compBox').classList.toggle('show', comp);
  stage.classList.toggle('phone', PV.dev === 'phone');
  if (comp) return;
  const src = PV.tab === 'shop' ? '/shop/?preview=1' : '/redeem?preview=1';
  if (frame.dataset.src !== src) { frame.dataset.src = src; frame.src = src; }
  layoutFrame();
}
let pushT;
const push = () => { clearTimeout(pushT); pushT = setTimeout(() => { try { frame.contentWindow?.postMessage({ type: 'cdk-theme', theme: T }, location.origin); } catch { /* 还没加载完 */ } }, 40); };
frame.addEventListener('load', () => { push(); setTimeout(push, 400); });
new ResizeObserver(layoutFrame).observe(stage);
segInit($('#pvTab'), v => { PV.tab = v; loadFrame(); });
segInit($('#pvDev'), v => { PV.dev = v; loadFrame(); setTimeout(layoutFrame, 50); });

function sync() {
  // 后台按你自己的深浅色偏好显示；预览区按「买家看到的深浅色」显示
  Theme.apply({ ...T, mode: saved ? JSON.parse(saved).mode : T.mode });
  const m = T.mode === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : T.mode;
  stage.dataset.mode = m; $('#compBox').dataset.mode = m;
  $('#compMode').textContent = `买家看到：${{ dark: '深色', light: '浅色', auto: '跟随系统' }[T.mode]}`;
  $$('.pre').forEach(p => p.classList.toggle('on', p.dataset.k === T.preset));
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === T.mode));
  $$('[data-dim]').forEach(box => $$('button', box).forEach(b => b.classList.toggle('on', b.dataset.v === T[box.dataset.dim])));
  $('#tMotion').classList.toggle('on', !!T.motion);
  ['a1', 'a2', 'a3'].forEach(k => { $(`[data-c=${k}]`).value = T[k]; $(`[data-cv=${k}]`).textContent = T[k]; });
  $('#tR').value = T.r; $('#vR').textContent = T.r + 'px'; $('#tB').value = T.blur; $('#vB').textContent = T.blur + 'px'; $('#tG').value = T.glow; $('#vG').textContent = T.glow + '%';
  [['tName', 'name'], ['tLogo', 'logo'], ['tSlogan', 'slogan'], ['tTagline', 'tagline'], ['tCss', 'customCss']].forEach(([id, k]) => { const el = $('#' + id); if (document.activeElement !== el) el.value = T[k] || ''; });
  $('#logoClear').classList.toggle('hidden', !T.logoImg);
  $('#dirty').innerHTML = isSaved() ? '<span class="faint">已是最新，修改后会实时预览</span>' : '<span class="c-warn">● 有未发布的修改，离开页面会还原</span>';
  push();
}
ready(async () => {
  T = { ...THEME_DEFAULT, ...(await GET('/api/admin/theme')) }; saved = JSON.stringify(T);
  if (!can('admin')) { $$('#form input, #form button, #form select, #form textarea').forEach(e => e.disabled = true); }
  sync(); loadFrame();
  if (!can('admin')) $('#dirty').textContent = '只有管理员可以修改主题';
});

/* ---------- 交互 ---------- */
$$('.pre').forEach(b => b.onclick = () => { const { label, ...p } = PRESETS[b.dataset.k]; Object.assign(T, p, { preset: b.dataset.k }); sync(); });
$$('#modeSeg button').forEach(b => b.onclick = () => { T.mode = b.dataset.v; sync(); });
$$('[data-c]').forEach(i => i.oninput = () => { T[i.dataset.c] = i.value; T.preset = 'custom'; sync(); });
$('#tR').oninput = e => { T.r = +e.target.value; T.preset = 'custom'; sync(); };
$('#tB').oninput = e => { T.blur = +e.target.value; T.preset = 'custom'; sync(); };
$('#tG').oninput = e => { T.glow = +e.target.value; T.preset = 'custom'; sync(); };
$('#tMotion').onclick = () => { T.motion = !T.motion; sync(); };
[['tName', 'name'], ['tLogo', 'logo'], ['tSlogan', 'slogan'], ['tTagline', 'tagline'], ['tCss', 'customCss']].forEach(([id, k]) => $('#' + id).oninput = e => { T[k] = e.target.value; sync(); });

/* Logo 图片：SVG 原样保存；位图缩放到 128px 以内转 PNG */
$('#logoFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  if (f.type === 'image/svg+xml') {
    if (url.length > 190_000) return toast('SVG 太大，请压缩到 140KB 以内', 'bad');
    T.logoImg = url;
  } else {
    const img = new Image(); img.src = url; await img.decode().catch(() => null);
    if (!img.naturalWidth) return toast('图片读取失败，请换一张', 'bad');
    const k = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    T.logoImg = c.toDataURL('image/png');
  }
  sync(); toast('Logo 已更新，可以点「从 Logo 取色」生成配色');
};
$('#logoClear').onclick = () => { T.logoImg = ''; sync(); };
/* 从 Logo 取色：取最饱和、最多的两个色相作为主色和辅色，点缀色在主色基础上偏移色相 */
$('#fromLogo').onclick = async () => {
  if (!T.logoImg) return toast('先上传 Logo 图片', 'info');
  const img = new Image(); img.src = T.logoImg; await img.decode().catch(() => null);
  const c = document.createElement('canvas'); c.width = c.height = 40;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, 40, 40);
  const px = x.getImageData(0, 0, 40, 40).data, buckets = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue;
    const [h, s, l] = hsl(px[i], px[i + 1], px[i + 2]);
    if (s < .25 || l < .12 || l > .92) continue;
    const bk = buckets[Math.floor(h / 15) % 24], w = s * (1 - Math.abs(l - .55));
    bk.w += w; bk.r += px[i] * w; bk.g += px[i + 1] * w; bk.b += px[i + 2] * w;
  }
  const top = buckets.map((b, i) => ({ ...b, i })).filter(b => b.w > 0).sort((a, b) => b.w - a.w);
  if (!top.length) return toast('Logo 里没有明显的颜色，请手动选色', 'warn');
  const hex = b => '#' + [b.r, b.g, b.b].map(v => Math.round(v / b.w).toString(16).padStart(2, '0')).join('');
  const second = top.find(b => Math.min(Math.abs(b.i - top[0].i), 24 - Math.abs(b.i - top[0].i)) >= 3);
  T.a1 = hex(top[0]);
  const [h1, s1, l1] = hsl(...[1, 3, 5].map(j => parseInt(T.a1.slice(j, j + 2), 16)));
  T.a2 = second ? hex(second) : fromHsl((h1 + 35) % 360, s1, Math.min(.7, l1 + .1));
  T.a3 = fromHsl((h1 + 300) % 360, Math.max(.6, s1), .65);
  T.preset = 'custom'; sync(); toast('已按 Logo 生成配色');
};
function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function fromHsl(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
}

$('#save').onclick = e => run(e.currentTarget, '发布中…', async () => { T = { ...THEME_DEFAULT, ...(await PUT('/api/admin/theme', T)) }; saved = JSON.stringify(T); Theme.apply(T, true); sync(); toast('主题已发布，商城、兑换页和后台已生效'); });
$('#reset').onclick = async () => { if (await confirmBox({ title: '恢复默认主题？', body: '会还原所有外观、颜色和品牌设置（发布前不会生效）。', ok: '恢复默认' })) { T = { ...THEME_DEFAULT }; sync(); } };
$('#exp').onclick = () => { const { logoImg, ...rest } = T; copy(JSON.stringify(rest, null, 2), '主题已复制（不含 Logo 图片）'); };
$('#imp').onclick = () => {
  const m = dialog({
    title: '导入主题', sub: '粘贴「导出主题」得到的内容，导入后检查预览再发布。',
    body: `<textarea class="field css-area" id="j" placeholder='{"a1":"#8b7cff",...}'></textarea>`,
    actions: [{ label: '取消' }, { label: '导入', kind: 'primary', onClick: () => {
      let v; try { v = JSON.parse($('#j', m.el).value); } catch { throw new Error('内容不是有效的主题 JSON'); }
      T = { ...THEME_DEFAULT, ...v, logoImg: v.logoImg ?? T.logoImg }; sync(); toast('已导入，检查预览后点「保存并发布」');
    } }],
  });
};
$$('#compBox .sw').forEach(sw => swInit(sw));
segInit($('#compBox .seg'));
window.addEventListener('beforeunload', () => { if (T && !isSaved()) Theme.apply(JSON.parse(saved), true); });

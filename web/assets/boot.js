/* 首帧之前执行（放在 <head> 里同步加载）：
   按本地缓存的主题设置颜色、背景、字体、卡片风格和深浅色，避免切换页面时先闪一帧默认主题 */
(function () {
  var d = document.documentElement, s = d.style, t = {};
  try { t = JSON.parse(localStorage.getItem('cdk-theme') || '{}'); } catch (e) {}
  var preview = window.parent !== window && /[?&]preview=1/.test(location.search);
  var mode = (!preview && localStorage.getItem('cdk-mode')) || t.mode || 'light';
  if (mode === 'auto') mode = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  d.dataset.mode = mode;
  var lum = function (hex) { var n = parseInt(hex.slice(1), 16); var c = [n >> 16, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  // 主色很深（比如票根的墨蓝）时，深色模式下提亮，否则按钮会消失在背景里（和 app.js 的 Theme.ui 一致）
  var a1 = t.a1 || '#15233f';
  if (mode === 'dark' && lum(a1) < .06) { var n = parseInt(a1.slice(1), 16); a1 = '#' + [n >> 16, n >> 8 & 255, n & 255].map(function (v) { return Math.round(v + (255 - v) * .86).toString(16).padStart(2, '0'); }).join(''); }
  s.setProperty('--a1', a1); s.setProperty('--a2', t.a2 || '#3d6e9e'); s.setProperty('--a3', t.a3 || '#d3382b');
  s.setProperty('--r', (t.r != null ? t.r : 14) + 'px'); s.setProperty('--blur', (t.blur != null ? t.blur : 0) + 'px'); s.setProperty('--glow', (t.glow != null ? t.glow : 0) / 100);
  s.setProperty('--on-a', lum(a1) > .45 ? '#111228' : '#fff');
  d.dataset.bg = t.bg || 'paper'; d.dataset.font = t.font || 'stub'; d.dataset.card = t.card || 'paper';
  d.dataset.btn = t.btn || 'solid'; d.dataset.shape = t.shape || 'round'; d.dataset.motion = t.motion === false ? 'off' : 'on';
  if (t.customCss) { var st = document.createElement('style'); st.id = 'theme-css'; st.textContent = t.customCss; document.head.appendChild(st); }
  d.classList.add('booting');
  // 兜底：脚本异常时也不能一直隐藏
  setTimeout(function () { d.classList.remove('booting'); }, 1500);
})();

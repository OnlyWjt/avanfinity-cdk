/* 首帧之前执行（放在 <head> 里同步加载）：
   按本地缓存的主题设置颜色、背景、字体、卡片风格和深浅色，避免切换页面时先闪一帧默认主题 */
(function () {
  var d = document.documentElement, s = d.style, t = {};
  try { t = JSON.parse(localStorage.getItem('cdk-theme') || '{}'); } catch (e) {}
  var preview = window.parent !== window && /[?&]preview=1/.test(location.search);
  var a1 = t.a1 || '#8b7cff';
  s.setProperty('--a1', a1); s.setProperty('--a2', t.a2 || '#4fd8ff'); s.setProperty('--a3', t.a3 || '#ff7ac6');
  s.setProperty('--r', (t.r != null ? t.r : 18) + 'px'); s.setProperty('--blur', (t.blur != null ? t.blur : 24) + 'px'); s.setProperty('--glow', (t.glow != null ? t.glow : 60) / 100);
  var n = parseInt(a1.slice(1), 16), lum = [n >> 16, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
  s.setProperty('--on-a', .2126 * lum[0] + .7152 * lum[1] + .0722 * lum[2] > .45 ? '#111228' : '#fff');
  d.dataset.bg = t.bg || 'aurora'; d.dataset.font = t.font || 'modern'; d.dataset.card = t.card || 'glass';
  d.dataset.btn = t.btn || 'gradient'; d.dataset.shape = t.shape || 'round'; d.dataset.motion = t.motion === false ? 'off' : 'on';
  var mode = (!preview && localStorage.getItem('cdk-mode')) || t.mode || 'dark';
  if (mode === 'auto') mode = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  d.dataset.mode = mode;
  if (t.customCss) { var st = document.createElement('style'); st.id = 'theme-css'; st.textContent = t.customCss; document.head.appendChild(st); }
  d.classList.add('booting');
  // 兜底：脚本异常时也不能一直隐藏
  setTimeout(function () { d.classList.remove('booting'); }, 1500);
})();

/* 兑换策略页 */
$('#page').innerHTML = $('#page').innerHTML.replaceAll('${LAYER_OWN}', LAYER.own).replaceAll('${LAYER_GEN}', LAYER.gen).replaceAll('${LAYER_PLAT}', LAYER.platform);
let list = [], cur = null, dirty = false, readOnly = true;
const BLANK = { name: '新策略', desc: '', on: false, prio: 10, prod: ['gpt', 'x', 'tg'], mode: 'own', prefix: '', ipH: 20, devD: 5, captcha: 3, expire: 0, timeOn: false, from: '09:00', to: '23:00', geo: '', accN: 1, accDays: 30, freeOnly: false, mailAllow: '', mailBlock: 'tempmail.com, 10minutemail.com', priceTol: 10, priceAct: 'manual', costCap: 30, failAct: 'release', retryN: 1, payMode: 'shared' };

ready(async () => {
  readOnly = !can('admin');
  await reload(qs('id'));
});
/** 首屏缓存刷新：没有未保存的修改时才重新加载 */
function load() { if (!dirty) return reload(); }
async function reload(selectId) {
  list = (await GET('/api/admin/strategies')).list;
  cur = structuredClone(list.find(s => s.id === (selectId || cur?.id)) || list[0]);
  dirty = false; render();
}
function renderList() {
  $('#slist').innerHTML = list.map(s => `<div class="it ${s.id === cur?.id ? 'on' : ''}" data-id="${s.id}">
    <div class="between"><b>${esc(s.name)}</b>${s.on ? '<span class="badge ok">启用</span>' : '<span class="badge idle">停用</span>'}</div>
    <div class="xs faint mt8">${s.isDefault ? '默认 · ' : ''}${s.mode === 'own' ? '自有码' : '托管码'}${s.mode === 'own' && s.prefix ? ` · 前缀 <span class="mono">${esc(s.prefix)}-</span>` : ''} · 优先级 ${s.prio} · 今日拦截 ${s.hits || 0}</div>
    <div class="row-flex mt8">${s.prod.map(p => PICXS[p]).join('')}</div></div>`).join('') + (cur && !cur.id ? `<div class="it on"><b>${esc(cur.name)}</b><div class="xs c-warn mt8">未保存</div></div>` : '');
  $$('#slist .it[data-id]').forEach(el => el.onclick = async () => {
    if (dirty && !await confirmBox({ title: '放弃未保存的修改？', ok: '放弃' })) return;
    cur = structuredClone(list.find(s => s.id === el.dataset.id)); dirty = false; render();
  });
}
const v = k => esc(cur[k]);
const num = (k, unit) => `<div class="inputgrp"><input data-k="${k}" data-num value="${v(k)}"><span>${unit}</span></div>`;
const sw = k => `<button class="sw ${cur[k] ? 'on' : ''}" data-sw="${k}"></button>`;
const rule = (title, desc, layer, ctl) => `<div class="rule"><div class="t"><b>${title} ${LAYER[layer]}</b><p>${desc}</p></div><div class="ctl">${ctl}</div></div>`;
const sel = (k, opts) => `<select class="field" data-k="${k}">${opts.map(([val, l]) => `<option value="${val}" ${cur[k] === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

function renderEditor() {
  const s = cur, own = s.mode === 'own';
  $('#editor').innerHTML = `
    ${readOnly ? '<div class="note mb12">ⓘ 只有管理员可以修改策略，你现在是只读查看。</div>' : ''}
    <div class="between mb16">
      <div style="flex:1"><input class="field" data-k="name" value="${v('name')}" maxlength="40" style="font-size:17px;font-weight:700;background:none;border-color:transparent;padding-left:0"><input class="field sm" data-k="desc" value="${v('desc')}" placeholder="一句话说明这条策略用在哪" style="width:100%;background:none;border-color:transparent;padding-left:0;color:var(--muted)"></div>
      <div class="row-flex"><span class="sm muted">启用</span>${sw('on')}</div>
    </div>
    <div class="grp"><h4>① 适用范围 <small>决定哪些兑换码走这条策略</small></h4>
      ${rule('兑换码模式', '自有码：买家拿到的是本系统的码，规则不可绕过（推荐）。托管码：直接发卡台码，买家可能绕到卡台兑换。已生成过码的策略不能切换。', 'own',
        `<div class="seg full" id="modeSeg"><button data-v="own" class="${own ? 'on' : ''}">自有码</button><button data-v="hosted" class="${own ? '' : 'on'}">托管码</button></div>`)}
      ${own ? rule('码前缀', '2–6 位字母或数字，例如 TB → TB-7K2Q-F9WM-3TXA', 'own', `<div class="inputgrp"><input data-k="prefix" value="${v('prefix')}" maxlength="6" style="text-transform:uppercase"><span>-XXXX</span></div>`) : ''}
      ${rule('适用产品', '', 'own', `<div class="row-flex">${['gpt', 'x', 'tg'].map(p => `<label class="row-flex sm" style="margin-left:8px"><input type="checkbox" data-prod="${p}" ${s.prod.includes(p) ? 'checked' : ''}>${{ gpt: 'GPT', x: 'X', tg: 'TG' }[p]}</label>`).join('')}</div>`)}
      ${rule('优先级', '数字越小越靠前（只影响列表顺序）', 'own', num('prio', '级'))}
    </div>
    <div class="grp"><h4>② 兑换门槛 <small>用户输码时检查，还没调用卡台</small></h4>
      ${rule('同一 IP 每小时最多尝试', '包括输错的码；超出后暂时拒绝', 'own', num('ipH', '次'))}
      ${rule('同一设备每天最多兑换成功', '按浏览器设备 ID 计数', 'own', num('devD', '次'))}
      ${rule('输错几次后要求人机验证', '需要在「设置 → 兑换页」配置 Cloudflare Turnstile，否则只按 IP 频率限制', 'own', num('captcha', '次'))}
      ${rule('兑换码有效期', '从生成开始计算，0 表示不过期；只影响之后生成的码', 'own', num('expire', '天'))}
      ${rule('限定兑换时段', `只在 ${v('from')}–${v('to')} 之间允许兑换（服务器业务时区）`, 'own', `<div class="row-flex">${s.timeOn ? `<input class="field sm mono" data-k="from" value="${v('from')}" style="width:70px">–<input class="field sm mono" data-k="to" value="${v('to')}" style="width:70px">` : ''}${sw('timeOn')}</div>`)}
      ${rule('拦截地区', '国家代码，逗号分隔，如 CN, RU。需要部署在 Cloudflare 后面才能识别地区', 'own', `<input class="field" data-k="geo" value="${v('geo')}" placeholder="不限制">`)}
    </div>
    <div class="grp"><h4>③ 账号规则 <small>X/TG 在卡台预检前检查，GPT 在预检后检查</small></h4>
      ${rule('同一账号最多兑换', `在 ${v('accDays')} 天内，同一个账号（ChatGPT 按账号 ID、X/TG 按用户名）在本策略下最多兑换几次`, 'own', `<div class="row-flex" style="width:100%"><div class="inputgrp"><input data-k="accN" data-num value="${v('accN')}"><span>次</span></div><div class="inputgrp"><input data-k="accDays" data-num value="${v('accDays')}"><span>天</span></div></div>`)}
      ${rule('只允许 Free 账号兑换（GPT）', '已经是付费会员的账号会被拒绝，避免叠加或被盗号兑换', 'own', sw('freeOnly'))}
      ${rule('邮箱域名黑名单（GPT）', '临时邮箱、一次性邮箱', 'own', `<input class="field" data-k="mailBlock" value="${v('mailBlock')}" placeholder="tempmail.com, …">`)}
      ${rule('邮箱域名白名单（GPT）', '填写后只允许这些域名，留空不限制', 'own', `<input class="field" data-k="mailAllow" value="${v('mailAllow')}" placeholder="不限制">`)}
      ${rule('账号资格', '账号能否开通由卡台判断（例如已是 Premium 的 X 账号）', 'platform', '<span class="xs faint">不可修改</span>')}
    </div>
    <div class="grp"><h4>④ 价格保护 <small>防止报价上涨导致亏本</small></h4>
      ${rule('成本比生成时高出', 'GPT：兑换时卡台售价比生成这批码时高出多少就触发', 'own', num('priceTol', '%'))}
      ${rule('触发后', '', 'own', sel('priceAct', [['block', '拦截，提示稍后再试'], ['manual', '转人工审核'], ['pass', '放行，只记录']]))}
      ${rule('单码成本上限（X/TG）', '生成时写进卡台的资金上限；超过直接失败，不会多扣', 'gen', `<div class="inputgrp"><input data-k="costCap" data-num value="${v('costCap')}"><span>USD</span></div>`)}
      ${rule('报价有效期', 'GPT 约 10 分钟，X / TG 30 分钟', 'platform', '<span class="xs faint">不可修改</span>')}
    </div>
    <div class="grp"><h4>⑤ 失败处理</h4>
      ${rule('支付失败后', own ? '自有码可以由后端自动换一张新的卡台码重试（GPT 需要用户 Session 仍在 30 分钟内）' : '托管码失败后卡台释放这张码，只能让用户自己重新兑换', own ? 'own' : 'platform',
        sel('failAct', own ? [['retry', '自动重试'], ['release', '释放码，让用户重兑'], ['manual', '转人工处理']] : [['release', '释放码，让用户重兑'], ['manual', '转人工处理']]))}
      ${own && s.failAct === 'retry' ? rule('最多自动重试', '超过次数后释放码', 'own', num('retryN', '次')) : ''}
      ${rule('每码独立支付（GPT）', '每次兑换使用独立的付款通道，失败不复用，更稳但每码多一笔通道费', 'gen', `<div class="seg full" id="payMode"><button data-v="shared" class="${s.payMode === 'shared' ? 'on' : ''}">共享</button><button data-v="own" class="${s.payMode === 'own' ? 'on' : ''}">独立</button></div>`)}
    </div>
    <div class="between mt16"><span class="xs ${dirty ? 'c-warn' : 'faint'}" id="dirtyTip">${dirty ? '● 有未保存的修改' : '「生成时写入」的规则只影响之后生成的码'}</span>
      <div class="row-flex" data-role="admin">${s.id && !s.isDefault ? '<button class="btn danger" id="del">删除</button>' : ''}${s.id ? '<button class="btn" id="dup">复制一份</button>' : ''}<button class="btn primary" id="save">${s.id ? '保存' : '创建'}</button></div></div>`;
  if (readOnly) { $$('#editor input, #editor select, #editor .sw, #editor .seg button').forEach(e => e.disabled = true); $$('#editor [data-role]').forEach(e => e.classList.add('hidden')); return; }
  const mark = () => { dirty = true; $('#dirtyTip').className = 'xs c-warn'; $('#dirtyTip').textContent = '● 有未保存的修改'; };
  $$('#editor [data-k]').forEach(i => i.oninput = i.onchange = () => {
    const k = i.dataset.k; cur[k] = i.dataset.num !== undefined ? Number(i.value) : k === 'prefix' ? i.value.toUpperCase() : i.value;
    mark(); if (i.tagName === 'SELECT') renderEditor();
  });
  $$('#editor [data-sw]').forEach(b => b.onclick = () => { cur[b.dataset.sw] = !cur[b.dataset.sw]; dirty = true; renderEditor(); });
  $$('#editor [data-prod]').forEach(c => c.onchange = () => { cur.prod = $$('#editor [data-prod]').filter(x => x.checked).map(x => x.dataset.prod); mark(); });
  $$('#modeSeg button').forEach(b => b.onclick = () => { cur.mode = b.dataset.v; if (cur.mode === 'hosted' && cur.failAct === 'retry') cur.failAct = 'release'; dirty = true; renderEditor(); });
  $$('#payMode button').forEach(b => b.onclick = () => { cur.payMode = b.dataset.v; dirty = true; renderEditor(); });
  $('#save').onclick = e => run(e.currentTarget, '保存中…', async () => {
    const r = cur.id ? await PUT('/api/admin/strategies/' + cur.id, cur) : await POST('/api/admin/strategies', cur);
    toast('策略已保存'); await reload(r.id);
  });
  const dup = $('#dup'); if (dup) dup.onclick = () => { cur = { ...structuredClone(cur), id: undefined, isDefault: false, name: cur.name + ' 副本', on: false, prefix: '' }; dirty = true; render(); };
  const del = $('#del'); if (del) del.onclick = async () => {
    if (!await confirmBox({ title: `删除「${esc(cur.name)}」？`, body: '只有还没生成过兑换码的策略可以删除。', ok: '删除', danger: true })) return;
    try { await DEL('/api/admin/strategies/' + cur.id); toast('已删除'); cur = null; await reload(); } catch (e) { toast(e.message, 'bad'); }
  };
}
function render() { renderList(); renderEditor(); }
$('#add').onclick = () => { cur = structuredClone(BLANK); dirty = true; render(); };
$('#toggleMx').onclick = () => { const h = $('#mx').classList.toggle('hidden'); $('#toggleMx').textContent = h ? '展开对照表 ▾' : '收起 ▴'; };
$('#runTest').onclick = e => run(e.currentTarget, '检查中…', async () => {
  const r = await POST('/api/admin/strategies/test', { code: $('#tCode').value || 'X', account: $('#tAcc').value, currentPlan: $('#tPlan').value, price: $('#tQuote').value });
  const cls = { true: 'row-ok', false: 'row-bad', warn: 'row-warn' };
  $('#tRes').innerHTML = `<div class="kv">${r.checks.map(c => `<div><span>${esc(c.name)}</span><b class="${cls[c.ok]} sm">${c.ok === true ? '✓' : c.ok === false ? '✕' : '⚑'} ${esc(c.detail)}</b></div>`).join('')}</div>
    <div class="note ${r.result === 'block' ? 'bad' : r.result === 'manual' ? 'warn' : 'ok'} mt8">${r.result === 'block' ? '⛔ 会被拦截：' + esc(r.rule) : r.result === 'manual' ? '⚑ 会转人工审核' : '✓ 通过，会提交到卡台兑换'}</div>
    <div class="xs faint mt8">只读模拟，不会写入任何记录。IP / 设备按测试值计算。</div>`;
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

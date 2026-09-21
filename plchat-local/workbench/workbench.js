/* Independent single-page client for the existing local host. No NX calls on load. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { settings: null, review: null, online: false, busy: false, remoteBusy: false,
    settingsBusy: false, dirty: false, drafts: new Map(), logs: [], toolsSeen: new Set(),
    job: null, jobPolling: false, polling: false, lastReview: '', lastStage: '', lastProgressError: false,
    history: [], pendingPlanButton: null, imageOneShot: true, imageMaxSide: 1600 };
  const JOB_KEY = 'dc-workbench-job-v1';
  const stages = { thinking: '模型正在组织回答', streaming: '正在接收回答', tool: '正在查询工具',
    authoring: '正在生成建模计划', validating: '正在检查脚本', retry: '正在修正计划',
    ping: '正在检查实时桥', running: 'NX 正在执行', done: '处理结束', failed: '处理失败' };
  const statusNames = { pending: '待执行', done: '已完成', failed: '失败', running: '执行中',
    undone: '已撤销', skipped: '已跳过', blocked: '已阻止', unknown: '状态未知' };
  const operationNames = { journal: '脚本', create_block: '创建长方体', screenshot: '截图', status: '检查状态', noop: '人工操作' };
  const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const text = (id, value) => { $(id).textContent = value == null ? '' : String(value); };
  const node = (tag, cls, value) => { const el = document.createElement(tag); if (cls) el.className = cls; if (value != null) el.textContent = value; return el; };
  let toastTimer;
  function toast(message) { text('toast', message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
  function log(category, message, error = false) {
    const record = { time: clock(), category, message: String(message), error };
    state.logs.push(record); if (state.logs.length > 200) state.logs.shift();
    $('log-empty')?.remove();
    const row = node('div', 'log-row' + (error ? ' error' : ''));
    row.append(node('time', '', record.time), node('span', 'log-category', category), node('span', 'log-description', record.message));
    $('log-content').append(row); if ($('log-content').children.length > 200) $('log-content').firstElementChild.remove();
    $('log-content').scrollTop = $('log-content').scrollHeight;
    text('log-count', state.logs.length + ' 条');
  }
  async function api(path, body, timeout = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('宿主返回 HTTP ' + response.status);
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求等待超时。后台任务可能仍在进行，请刷新状态核对后再操作。');
      if (error instanceof TypeError) throw new Error('无法连接本地宿主，请检查服务后刷新状态。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function requireOK(result) {
    if (!result || result.ok === false) throw new Error(result?.error?.message || result?.error || result?.stderr || '操作失败，请查看宿主日志。');
    return result;
  }
  function feedback(id, message, error = false) { text(id, message); $(id).className = 'field-feedback ' + (error ? 'error-text' : 'success-text'); }
  function syncControls() {
    const locked = state.busy || state.remoteBusy || state.settingsBusy || !!state.job;
    document.querySelectorAll('[data-mutation]').forEach(el => { el.disabled = locked || !state.online || !state.settings; });
    document.querySelectorAll('.chat-plan-button').forEach(el => { el.disabled = locked || !state.online || el.dataset.added === 'true'; });
    const runnable = state.review?.hasPlan && state.review.steps?.some(s => s.operation === 'journal');
    document.querySelectorAll('[data-run]').forEach(el => { el.disabled = locked || !state.online || !runnable; });
    $('clear-plan').disabled = locked || !state.online || !state.review?.hasPlan;
    $('export-plan').disabled = !state.review?.hasPlan;
    $('new-chat').disabled = locked;
    $('pick-image').disabled = locked;
    $('check-environment').disabled = locked || !state.online || !state.settings || state.settingsBusy;
    $('test-connection').disabled = locked || !state.online || !state.settings || state.settingsBusy;
    $('save-settings').disabled = locked || !state.online || !state.settings || state.settingsBusy;
    for (const id of ['provider', 'model', 'base-url', 'api-key', 'clear-key', 'system-prompt', 'nx-root', 'skill-root', 'workspace-path']) {
      $(id).disabled = state.settingsBusy || !state.settings || (id === 'api-key' && $('clear-key').checked);
    }
    $('activity-strip').hidden = !locked;
    text('chat-status', locked ? '处理中' : state.online ? '就绪' : '未连接');
  }
  function setBusy(on, label) {
    state.busy = on;
    if (on) { state.toolsSeen.clear(); state.lastStage = ''; text('activity-text', label); text('activity-time', '0 s'); }
    syncControls();
  }
  function connected(on) {
    const changed = state.online !== on;
    state.online = on;
    ['host-dot', 'footer-dot'].forEach(id => { $(id).className = 'status-dot ' + (on ? 'online' : 'error'); });
    text('host-label', on ? '本地宿主已连接' : '本地宿主未连接');
    text('host-state', on ? '已连接' : '离线'); text('footer-status', on ? '宿主就绪' : '连接中断');
    $('connection-warning').hidden = on;
    if (changed) log('连接', on ? '本地宿主连接正常。NX 会话需单独检查。' : '连接中断，请检查宿主后刷新。', !on);
    syncControls();
  }
  function snapshotDraft() {
    if (!state.settings) return;
    state.drafts.set($('provider').value, { model: $('model').value, baseUrl: $('base-url').value,
      apiKey: $('api-key').value, clearKey: $('clear-key').checked });
  }
  function selectProvider() {
    const id = $('provider').value;
    const provider = state.settings.providers.find(p => p.id === id) || {};
    const draft = state.drafts.get(id) || provider;
    $('model').value = draft.model || ''; $('base-url').value = draft.baseUrl || '';
    $('api-key').value = draft.apiKey || ''; $('clear-key').checked = !!draft.clearKey;
    $('api-key').disabled = !!draft.clearKey;
    text('key-status', provider.hasKey ? '已存密钥' : '未设置');
    $('model-options').replaceChildren(...(provider.models || []).map(value => { const option = node('option'); option.value = value; return option; }));
  }
  /** 顶部版本徽标 + NX 环境空态 —— 全部来自宿主按结构特征扫出来的结果(nxdetect.js),
   *  所以 2606 / 2506 / 2406 / 2306 都显示本机真实版本,不再写死。 */
  function applyDetectedNx(nx) {
    const active = nx && nx.detected && nx.detected.active;
    const badge = $('edition');
    if (!active) {
      text('edition', 'NX / 未检测到');
      badge.title = '没有在本机找到带 NXBIN 的 Siemens Designcenter / NX 安装';
      text('nx-status', '未检测到 Designcenter / NX 安装');
      $('nx-dot').className = 'status-dot error';
      return;
    }
    const cap = active.hasCopilot ? '含内置 Copilot' : '未检出 Copilot';
    const markers = ((active.copilot && active.copilot.markers) || []).join(' / ') || '(无)';
    const libs = (active.copilot && (active.copilot.libs || []).length) || 0;
    text('edition', 'NX / ' + active.release + (active.hasCopilot ? '' : ' · 无 Copilot'));
    badge.title = [
      active.product || 'Siemens ' + active.release,
      '安装目录: ' + active.root,
      '识别依据: ' + markers,
      active.copilot && active.copilot.page ? '页面: ' + active.copilot.page : '未找到 PLChat.html',
      'AI 库: ' + (libs ? libs + ' 个' : '无')
    ].join('\n');
    if (!nx.nxRoot) $('nx-root').placeholder = active.root;
    if (active.hasCopilot) {
      text('nx-status', '已识别 ' + active.release + '（' + cap + '）');
      $('nx-dot').className = 'status-dot online';
    } else {
      text('nx-status', '检测到的 ' + active.release + ' 里没有内置 Copilot');
      $('nx-dot').className = 'status-dot error';
      feedback('environment-feedback', '该安装未检出 UGII/copilot 页面或 NXBIN/libcopilot* 库，原版页面无法从它重建。', true);
    }
  }
  async function loadSettings(force = false) {
    const result = requireOK(await api('/api/settings'));
    state.settings = result;
    // 默认「一发即摘」:图只跟一条消息走。宿主没给这个字段时也当开(老宿主兼容)。
    state.imageOneShot = !(result.image && result.image.oneShot === false);
    if (result.image && result.image.maxSide) state.imageMaxSide = result.image.maxSide;
    fillBudget(result.tool || {});
    text('active-model', result.active.label + ' · ' + result.active.model);
    text('model-chip', result.active.model || '未设置模型'); $('model-chip').title = result.active.label;
    text('footer-workspace', result.nx.nxWorkspace || '工作区未配置'); $('footer-workspace').title = result.nx.nxWorkspace || '';
    applyDetectedNx(result.nx);
    if (!state.dirty || force) {
      state.drafts.clear();
      $('provider').replaceChildren(...result.providers.map(p => { const option = node('option', '', p.label); option.value = p.id; return option; }));
      $('provider').value = result.activeProvider;
      ['provider', 'model', 'base-url', 'api-key', 'clear-key', 'system-prompt', 'nx-root', 'skill-root', 'workspace-path'].forEach(id => { $(id).disabled = false; });
      selectProvider();
      $('system-prompt').value = result.systemPrompt || '';
      $('nx-root').value = result.nx.nxRoot || ''; $('skill-root').value = result.nx.nxSkillRoot || '';
      $('workspace-path').value = result.nx.nxWorkspace || '';
      state.dirty = false; text('settings-dirty', '已保存配置');
    }
    syncControls();
  }
  function dirty() { state.dirty = true; text('settings-dirty', '有未保存修改'); snapshotDraft(); }

  /* ---- 状态栏上方的「工具额度」 ----
   * 放在这里而不是塞进连接配置:它是每次提问前最可能想调的一格(问复杂图纸就调大、
   * 想快就调小),埋进设置面板要点三层。改动只 POST tool/image 两个块,不会碰供应商。 */
  function fillBudget(tool) {
    const rounds = Number(tool.maxToolRounds);
    const calls = Number(tool.maxToolCalls);
    const timeout = Number(tool.toolTimeoutMs);
    $('budget-rounds').value = Number.isFinite(rounds) && rounds > 0 ? rounds : '';
    $('budget-calls').value = Number.isFinite(calls) && calls > 0 ? calls : '';
    $('budget-timeout').value = Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout / 1000) : '';
    $('budget-one-shot').checked = state.imageOneShot !== false;
    budgetDirty(false);
  }
  function budgetDirty(on) {
    $('budget-save').disabled = !on || !state.online;
    if (!on) feedback('budget-feedback', '');
  }
  async function saveBudget() {
    const payload = {
      tool: {
        maxToolRounds: Number($('budget-rounds').value) || 8,
        maxToolCalls: Number($('budget-calls').value) || 14,
        toolTimeoutMs: Math.round((Number($('budget-timeout').value) || 60) * 1000)
      },
      image: { oneShot: $('budget-one-shot').checked, maxSide: state.imageMaxSide }
    };
    feedback('budget-feedback', '正在应用…');
    try {
      requireOK(await api('/api/settings', payload, 15000));
      state.imageOneShot = payload.image.oneShot;
      if (state.imageOneShot && state.image) clearImage();
      feedback('budget-feedback', '已应用：最多 ' + payload.tool.maxToolRounds + ' 轮 / '
        + payload.tool.maxToolCalls + ' 次调用 / 单次 ' + Math.round(payload.tool.toolTimeoutMs / 1000) + ' 秒'
        + (state.imageOneShot ? '；图一发即摘' : '；图会留下'));
      log('额度', '工具额度已更新：最多 ' + payload.tool.maxToolRounds + ' 轮 / ' + payload.tool.maxToolCalls
        + ' 次调用 / 单次超时 ' + Math.round(payload.tool.toolTimeoutMs / 1000) + ' 秒'
        + '；图' + (state.imageOneShot ? '一发即摘' : '发后保留'));
      budgetDirty(false);
      await loadSettings();
    } catch (e) { feedback('budget-feedback', e.message, true); log('额度', e.message, true); }
  }
  function budgetInput() { budgetDirty(true); feedback('budget-feedback', '改完点「应用」生效。'); }
  function providerPayload() {
    return { id: $('provider').value, model: $('model').value.trim(), baseUrl: $('base-url').value.trim(),
      apiKey: $('clear-key').checked ? null : $('api-key').value };
  }
  async function saveSettings(event) {
    event.preventDefault(); if ($('save-settings').disabled) return;
    state.settingsBusy = true; syncControls(); feedback('settings-feedback', '正在保存…');
    try {
      requireOK(await api('/api/settings', { activeProvider: $('provider').value, provider: providerPayload(),
        systemPrompt: $('system-prompt').value, nx: { nxRoot: $('nx-root').value, nxSkillRoot: $('skill-root').value, nxWorkspace: $('workspace-path').value } }));
      await loadSettings(true); feedback('settings-feedback', '已保存并启用。后续请求使用此模型。');
      text('nx-status', '配置已更新，请重新检查环境'); $('nx-dot').className = 'status-dot';
      log('配置', '已保存并启用 ' + state.settings.active.label + ' / ' + state.settings.active.model);
      try { await refreshReview(); } catch (error) { log('队列', '配置已保存，刷新复核队列失败：' + error.message, true); }
    } catch (e) { feedback('settings-feedback', e.message, true); }
    finally { state.settingsBusy = false; syncControls(); }
  }
  async function testConnection() {
    if ($('test-connection').disabled || !$('model').reportValidity() || !$('base-url').reportValidity()) return;
    if ($('clear-key').checked) { feedback('settings-feedback', '请先保存清除密钥的修改，再测试连接。', true); return; }
    state.settingsBusy = true; syncControls(); feedback('settings-feedback', '正在测试所选模型…');
    try {
      const result = requireOK(await api('/api/settings/test', { provider: providerPayload(), useThis: true }, 120000));
      feedback('settings-feedback', '连接正常 · ' + result.ms + ' ms' + (result.reply ? ' · ' + result.reply : ''));
      log('模型', '连接测试成功：' + result.model + '（' + result.ms + ' ms）');
    } catch (e) { feedback('settings-feedback', e.message, true); log('模型', '连接测试失败：' + e.message, true); }
    finally { state.settingsBusy = false; syncControls(); }
  }
  async function checkEnvironment() {
    if ($('check-environment').disabled) return;
    setBusy(true, '正在检查 NX 环境'); feedback('environment-feedback', '正在读取安装与进程信息…');
    try {
      const result = requireOK(await api('/api/tool', { name: 'nx_status', args: {} }, 90000));
      const data = result.data || {}; const installs = data.detectedInstallations || [];
      const running = data.runningNxGuiProcesses || [];
      text('nx-status', running.length ? '检测到 NX 进程，实时桥未验证' : installs.length ? '已找到 NX 安装，未检测到运行进程' : '未发现 NX 安装');
      $('nx-dot').className = 'status-dot ' + (running.length ? 'online' : '');
      feedback('environment-feedback', ['发现 ' + installs.length + ' 个安装、' + running.length + ' 个运行进程。',
        ...installs.map(i => i.root), ...(data.problems || []).map(p => typeof p === 'string' ? p : JSON.stringify(p))].join('\n'), !installs.length);
      log('环境', $('nx-status').textContent);
    } catch (e) { feedback('environment-feedback', e.message, true); text('nx-status', '环境检查失败'); log('环境', e.message, true); }
    finally { setBusy(false); }
  }
  function renderReview(data) {
    state.review = data;
    const signature = JSON.stringify(data);
    if (signature === state.lastReview) { syncControls(); return; }
    const oldPlan = state.lastReview ? $('plan-name').textContent : '';
    state.lastReview = signature;
    text('plan-name', data.plan?.planId || '暂无计划'); text('step-count', (data.steps || []).length + ' 步');
    $('plan-empty').hidden = !!data.hasPlan; $('plan-prompt').hidden = !data.plan?.prompt;
    text('plan-prompt', data.plan?.prompt || ''); $('workspace-warning').hidden = !data.workspaceMismatch;
    $('step-list').replaceChildren(...(data.steps || []).map((step, index) => {
      const item = node('li', 'step'); const content = node('div', 'step-content');
      content.append(node('div', 'step-name', step.name));
      const tags = node('div', 'step-tags');
      const status = Object.hasOwn(statusNames, step.status) ? step.status : 'unknown';
      tags.append(node('span', 'step-tag ' + status, statusNames[status]),
        node('span', 'step-tag ' + (step.gate === 'auto' ? '' : 'manual'), step.gate === 'auto' ? '自动步骤' : '人工确认'),
        node('span', 'step-tag', operationNames[step.operation] || step.operation));
      content.append(tags);
      if (step.note) content.append(node('p', 'step-detail', step.note));
      if (step.message) content.append(node('p', 'step-detail' + (status === 'failed' || status === 'unknown' ? ' error-text' : ''), step.message));
      item.append(node('span', 'step-number', String(index + 1).padStart(2, '0')), content); return item;
    }));
    if (oldPlan && oldPlan !== (data.plan?.planId || '暂无计划')) $('run-result').hidden = true;
    syncControls();
  }
  async function refreshReview() { renderReview(requireOK(await api('/api/review'))); }

  // Reconstruct only presentation tags; generated HTML never brings scripts, styles, or handlers.
  function safeAnswer(html) {
    const parsed = new DOMParser().parseFromString(String(html), 'text/html');
    const allowed = new Set(['P','BR','B','STRONG','EM','I','UL','OL','LI','PRE','CODE','BLOCKQUOTE','H2','H3','H4','TABLE','THEAD','TBODY','TR','TH','TD','HR','DETAILS','SUMMARY','SPAN','DIV','A']);
    const blocked = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','SVG','MATH','IMG','LINK','META','TEMPLATE']);
    function copy(src, dest) {
      for (const child of src.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { dest.append(document.createTextNode(child.textContent)); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE || blocked.has(child.tagName)) continue;
        if (!allowed.has(child.tagName)) { copy(child, dest); continue; }
        const clean = document.createElement(child.tagName.toLowerCase());
        if (child.tagName === 'A') {
          try { const link = new URL(child.getAttribute('href'), location.origin);
            if (['https:', 'http:'].includes(link.protocol)) { clean.href = link.href; clean.target = '_blank'; clean.rel = 'noopener noreferrer'; }
          } catch (_) { /* Invalid links remain readable text. */ }
        }
        copy(child, clean); dest.append(clean);
      }
    }
    const fragment = document.createDocumentFragment(); copy(parsed.body, fragment); return fragment;
  }
  function message(role, value, html = false, meta = '') {
    $('welcome').hidden = true;
    const article = node('article', 'message ' + role); const content = node('div', 'message-main');
    const heading = node('div', 'message-byline'); heading.append(node('span', '', role === 'user' ? '你' : 'Copilot'), node('time', '', clock()));
    const body = node('div', 'message-body'); if (html) body.append(safeAnswer(value)); else body.textContent = value;
    content.append(heading, body); if (meta) content.append(node('div', 'message-meta', meta));
    article.append(node('div', 'message-avatar', role === 'user' ? '你' : 'AI'), content); $('messages').append(article);
    $('messages').scrollTop = $('messages').scrollHeight; return article;
  }
  function isPlanReply(question, answer) {
    if (typeof answer !== 'string' || !answer.trim()) return false;
    const asksForPlan = /计划|方案|步骤|建模|怎么做|如何做|plan|steps/i.test(question);
    const hasPlanTitle = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:建模计划|实施计划|执行计划|设计方案|操作步骤|plan\b)/im.test(answer);
    const numberedSteps = (answer.match(/(?:^|\n)\s*(?:\d+[.、)]|第[一二三四五六七八九十]+步|步骤\s*\d+)/gm) || []).length;
    return (asksForPlan && (hasPlanTitle || numberedSteps >= 2)) || (hasPlanTitle && numberedSteps >= 2);
  }
  async function addChatPlan(question, draft, button) {
    if (button.disabled || state.busy || state.remoteBusy || state.job) return;
    setBusy(true, '正在检查复核队列');
    try {
      await refreshReview();
      if (state.review?.hasPlan && !await dialog('替换当前计划？', '把这条聊天计划加入右侧复核队列会替换当前计划及复核进度。新计划仍需校验和人工复核。', '生成并替换')) return;
      text('activity-text', '正在把聊天计划加入复核队列');
      log('计划', '已从聊天回复发起计划生成与校验。');
      const result = requireOK(await api('/api/plan/author', { question, sourcePlan: draft }, 30000));
      if (!result.jobId) throw new Error('宿主未返回任务编号，请检查复核队列。');
      state.pendingPlanButton = button;
      rememberJob({ id: result.jobId, kind: 'author', source: 'chat', started: Date.now() });
      await pollJob();
    } catch (e) { log('计划', e.message, true); toast(e.message); }
    finally { setBusy(false); }
  }
  /* ---- 读图:选文件/拖入 → 宿主预处理 + 测量 → 附在下一条提问上 ----
   * 浏览器这边只负责"拿到字节"(WebView2 与普通浏览器都支持的 input[type=file]),
   * 解码、缩放、增强、测量全在宿主侧,这样 NX 自带解释器不需要任何第三方库。
   * 选完立刻送一次 /api/image/prepare:主人当场就能看到"这个模型能不能看图"、
   * 预处理做了哪几步、图像有多低分辨率,而不是发出去才发现读不出来。 */
  const IMAGE_MAX_SIDE = 1600;
  const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff', '.webp'];
  function imageSummary(prepared) {
    if (!prepared) return '';
    return prepared.width + '×' + prepared.height + ' px · ' + ((prepared.bytes || 0) / 1024).toFixed(0) + ' KB';
  }
  function clearImage() {
    state.image = null; state.imageInfo = null;
    $('image-attach').hidden = true;
    $('image-thumb').removeAttribute('src');
    text('image-name', '—'); text('image-meta', ''); text('image-route', '');
    const input = $('image-input'); if (input) input.value = '';
  }
  /** 把之前摘掉的图放回待发送区(发送失败时用,不让主人白选一次)。 */
  function restoreImage(saved) {
    if (!saved || !saved.image) return;
    state.image = saved.image; state.imageInfo = saved.info;
    const src = saved.image.dataUrl || (saved.info && saved.info.preview) || '';
    if (src) $('image-thumb').src = src;
    $('image-attach').hidden = false;
    text('image-name', saved.image.name || '图像');
    text('image-meta', saved.summary || '');
    text('image-route', saved.route || '');
  }
  async function preparePickedImage(source, name) {
    clearImage();
    $('image-attach').hidden = false;
    text('image-name', name || '图像'); text('image-meta', '正在预处理…');
    try {
      const result = await api('/api/image/prepare', { image: Object.assign({ name: name || '图像' }, source), options: { maxSide: state.imageMaxSide } }, 180000);
      if (!result.ok) {
        clearImage();
        const reason = (result.hint || '读图失败') + (result.message ? '：' + result.message : '');
        log('读图', reason, true); toast(reason);
        if (result.html) message('assistant', result.html, true);
        return;
      }
      state.imageInfo = result;
      state.image = {
        name: name || '图像',
        path: result.prepared.absolutePath || null,
        dataUrl: result.preview || source.dataUrl || null
      };
      $('image-thumb').src = state.image.dataUrl || '';
      $('image-attach').hidden = false;
      text('image-name', name || '图像');
      text('image-meta', imageSummary(result.prepared) + ' · ' + (result.prepared.steps || []).join(' → '));
      text('image-route', result.vision.supported ? '模型可直读图像'
        : (result.vision.unknown ? '看图能力未声明 → 附结构化简报' : '当前模型不能看图 → 附结构化简报'));
      log('读图', (name || '图像') + ' 已就绪：' + (result.vision.supported ? '按多模态发送' : '按结构化简报发送')
        + '（' + (result.prepared.steps || []).join(' → ') + '）');
      (result.warnings || []).filter(Boolean).forEach(w => log('读图', w, true));
      return true;
    } catch (e) { clearImage(); log('读图', e.message, true); toast(e.message); return false; }
  }
  /* NX 菜单里选的图会先 POST 到 /api/image/handoff;页面拿到就自动挂上。 */
  async function pickUpHandoff() {
    try {
      const result = await api('/api/image/handoff', undefined, 15000);
      if (!result || !result.path) return;
      const name = String(result.path).split(/[\\/]/).pop();
      log('读图', 'NX 传来一张图：' + result.path);
      await preparePickedImage({ path: result.path }, name);
    } catch (e) { /* 没有交接是常态,不吵 */ }
  }
  function pickImageFile(file) {
    if (!file) return;
    const ext = (String(file.name).match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) { toast('不支持的图像格式：' + (ext || file.type || '未知')); log('读图', '不支持的格式 ' + file.name, true); return; }
    if (file.size > 40 * 1024 * 1024) { toast('图像超过 40 MB 上限（' + (file.size / 1048576).toFixed(1) + ' MB）'); log('读图', file.name + ' 超过 40 MB 上限', true); return; }
    const reader = new FileReader();
    reader.onload = () => preparePickedImage({ dataUrl: String(reader.result) }, file.name);
    reader.onerror = () => { toast('读取文件失败'); log('读图', '读取 ' + file.name + ' 失败', true); };
    reader.readAsDataURL(file);
  }

  async function ask(event) {
    event?.preventDefault(); if ($('send-message').disabled) return;
    const question = $('prompt').value.trim();
    const attached = state.image;
    if (!question && !attached) { $('prompt').focus(); toast('请先输入问题或建模需求，或先读一张图。'); return; }
    const shown = question || '（只发了图，没有文字）';
    const userNode = message('user', shown);
    if (attached) {
      const bubble = userNode.querySelector('.message-main') || userNode;
      const img = node('img', 'message-image');
      img.src = attached.dataUrl || (state.imageInfo && state.imageInfo.preview) || '';
      img.alt = attached.name || '图像';
      bubble.append(img);
    }
    $('prompt').value = ''; setBusy(true, '正在发送问题');
    log('对话', attached ? '已发送问题（带图），等待模型返回。' : '已发送问题，等待模型返回。');
    // 「一发即摘」:图和这一条消息绑定,发出去就把待发送区腾空,不用主人再点 ×。
    // 先存一份,发送失败再放回去 —— 不能让人白选一次图。
    const savedImage = attached ? {
      image: attached, info: state.imageInfo,
      summary: $('image-meta').textContent, route: $('image-route').textContent
    } : null;
    if (attached && state.imageOneShot) clearImage();
    try {
      const payload = { question, history: state.history };
      // 已经预处理过的图直接给宿主路径,并告诉它别再处理一遍:选图时已经算过
      // 一次 prepare,重复做只会多出一个 *.prepared.jpg 和一次白白等待。
      if (attached) {
        payload.imageOptions = attached.path
          ? { maxSide: state.imageMaxSide, reusePrepared: true }
          : { maxSide: state.imageMaxSide };
        payload.image = attached.path
          ? { path: attached.path, name: attached.name }
          : { dataUrl: attached.dataUrl, name: attached.name };
      }
      const result = await api('/api/ask', payload, 900000);
      if (!result.data || typeof result.data.answer !== 'string') throw new Error('回答格式异常，请查看宿主日志。');
      const meta = result.meta || {};
      const badges = [meta.model, meta.ms != null ? (meta.ms / 1000).toFixed(1) + ' s' : '',
        meta.tools != null ? meta.tools + ' 次工具调用' : '',
        meta.image ? (meta.image.route === 'vision' ? '已发送图像' : '已发送图像简报') : ''].filter(Boolean);
      const reply = message('assistant', result.data.answer, true, badges.join(' · '));
      if (meta.provider && !meta.reviewSubmitted && isPlanReply(question, result.data.text)) {
        const actions = node('div', 'message-actions');
        const button = node('button', 'button chat-plan-button', '加入计划');
        button.type = 'button'; button.title = '根据这条聊天计划生成、校验并加入右侧复核队列';
        button.addEventListener('click', () => addChatPlan(question, result.data.text, button));
        actions.append(button); reply.querySelector('.message-main').append(actions);
        syncControls();
      }
      if (meta.provider && typeof result.data.text === 'string') {
        state.history.push({ role: 'user', content: question || '（图像）' + shown }, { role: 'assistant', content: result.data.text });
        state.history = state.history.slice(-8);
      }
      if (attached && meta.image) {
        log('读图', '图像已随本条消息发出（' + (meta.image.route === 'vision' ? '多模态' : '结构化简报') + '）'
          + (state.imageOneShot ? '；已自动摘除，想再问这张图请重新读入。' : '；已留在待发送区，下一条还会再带一次。'));
      }
      log('对话', meta.provider ? '已收到模型回答。' : '宿主返回错误说明，请查看对话。', !meta.provider);
      if (meta.reviewSubmitted) { await refreshReview(); toast('计划已提交，右侧可查看复核步骤。'); }
    } catch (e) {
      message('assistant', e.message); log('对话', e.message, true);
      // 发送没成功就不能把图吃掉:放回待发送区,主人重试一次即可。
      if (savedImage && !state.image) { restoreImage(savedImage); log('读图', '这次没发成功，图已放回待发送区。', true); }
    }
    finally { setBusy(false); $('prompt').focus(); }
  }
  function dialog(title, body, confirmLabel = '确认', info = false) {
    if ($('action-dialog').open) return Promise.resolve(false);
    text('dialog-title', title); text('dialog-body', body); text('dialog-confirm', confirmLabel);
    $('dialog-cancel').hidden = info; $('action-dialog').returnValue = 'cancel'; $('action-dialog').showModal();
    return new Promise(resolve => { $('action-dialog').addEventListener('close', () => resolve($('action-dialog').returnValue === 'confirm'), { once: true }); });
  }
  const workspaceDialog = $('workspace-dialog');
  let windowedPanel = null;
  let panelPlaceholder = null;
  let windowOpener = null;
  function restoreWindowPanel() {
    if (windowedPanel && panelPlaceholder) panelPlaceholder.replaceWith(windowedPanel);
    windowedPanel = null; panelPlaceholder = null;
  }
  function closeWorkspaceWindow() { if (workspaceDialog.open) workspaceDialog.close(); }
  workspaceDialog.addEventListener('close', () => {
    if (!workspaceDialog.open) {
      restoreWindowPanel();
      if (windowOpener?.isConnected) windowOpener.focus();
      windowOpener = null;
    }
  });
  $('workspace-dialog-close').addEventListener('click', closeWorkspaceWindow);
  function openWorkspaceWindow(title, surface, panelId, focusId = '', mode = '') {
    const opener = document.activeElement;
    if (workspaceDialog.open) { workspaceDialog.close(); restoreWindowPanel(); }
    windowOpener = opener;
    workspaceDialog.dataset.surface = surface;
    workspaceDialog.dataset.mode = mode || (surface === 'plan' && focusId === 'run-live' ? 'live'
      : surface === 'plan' && focusId === 'run-batch' ? 'batch' : '');
    text('workspace-dialog-title', title);
    const body = $('workspace-dialog-body');
    body.replaceChildren();
    if (panelId) {
      const panel = $(panelId);
      panelPlaceholder = node('div', 'panel-placeholder ' + (panelId === 'configuration' ? 'configuration' : panelId === 'plan-panel' ? 'plan-panel' : ''), '内容已在独立窗口打开');
      panel.before(panelPlaceholder);
      body.append(panel);
      windowedPanel = panel;
    }
    workspaceDialog.showModal();
    if (focusId && !$(focusId).disabled) $(focusId).focus();
    else $('workspace-dialog-close').focus();
    return body;
  }
  function openStatusWindow() {
    const body = openWorkspaceWindow('连接与运行状态', 'status');
    const content = node('section', 'window-content'); body.append(content);
    const draw = () => {
      content.replaceChildren(node('h3', '', '当前工作台状态'));
      for (const [label, value] of [
        ['本地宿主', $('host-label').textContent], ['当前模型', $('active-model').textContent],
        ['NX 环境', $('nx-status').textContent], ['复核队列', $('plan-name').textContent],
        ['工作区', $('footer-workspace').textContent]
      ]) content.append(node('p', '', label + '：' + value));
      const refresh = node('button', 'button primary', '重新读取状态'); refresh.type = 'button';
      refresh.addEventListener('click', async () => { refresh.disabled = true; await refreshAll(); draw(); });
      content.append(refresh);
    };
    draw();
    refreshAll().then(draw);
  }
  function rememberJob(job) {
    state.job = job; try { if (job) sessionStorage.setItem(JOB_KEY, JSON.stringify(job)); else sessionStorage.removeItem(JOB_KEY); } catch (_) { /* Storage can be disabled inside webviews. */ }
  }
  async function author() {
    if ($('author-plan').disabled) return;
    const question = $('prompt').value.trim(); if (!question) { $('prompt').focus(); toast('先输入零件形状、尺寸和约束，再生成计划。'); return; }
    if (state.review?.hasPlan && !await dialog('替换当前计划？', '新的计划会替换当前复核队列。请先导出需要保留的计划摘要。生成操作不会执行 NX 脚本。', '生成并替换')) return;
    if (state.busy || state.remoteBusy || state.job) return;
    setBusy(true, '正在生成建模计划'); message('user', question); log('计划', '已请求生成建模计划。');
    try {
      const result = requireOK(await api('/api/plan/author', { question }, 30000));
      if (!result.jobId) throw new Error('宿主未返回任务编号，请核对队列后再试。');
      rememberJob({ id: result.jobId, kind: 'author', started: Date.now() }); $('prompt').value = '';
      await pollJob();
    } catch (e) { log('计划', e.message, true); message('assistant', e.message); }
    finally { setBusy(false); }
  }
  async function run(mode) {
    if ($('run-' + mode).disabled) return;
    const count = state.review.steps.filter(s => s.operation === 'journal').length;
    const planId = state.review.plan.planId;
    const body = (mode === 'live'
      ? '将直接修改当前打开的 NX 工作零件。请先在 NX 中启动 NX Skill → Start NX Skill Live Bridge。脚本不自动保存。'
      : '将启动后台 NX，新建零件并尝试保存；不会显示建模过程。步骤失败后，后台执行仍可能继续。')
      + '\n\n本次执行 ' + count + ' 个脚本步骤。自动执行不会在“人工确认”步骤前暂停，其他类型步骤不会执行。若需要逐步确认，请使用 NX Skill → Review Plan。\n\n计划：' + planId;
    if (!await dialog(mode === 'live' ? '在当前 NX 会话执行？' : '后台新建零件执行？', body, '确认执行')) return;
    if (state.busy || state.remoteBusy || state.job) return;
    if (state.review?.plan?.planId !== planId) { toast('计划已变化，请重新检查后执行。'); return; }
    setBusy(true, '正在提交执行任务'); $('run-result').hidden = true;
    try {
      const result = requireOK(await api('/api/plan/run', { mode }, 30000));
      if (!result.jobId) throw new Error('未收到执行任务编号。请检查 NX 现场和宿主日志，不要立即重复执行。');
      rememberJob({ id: result.jobId, kind: 'run', mode, started: Date.now(), planId }); log('执行', '执行任务已提交：' + result.jobId);
      await pollJob();
    } catch (e) { log('执行', e.message, true); toast(e.message); }
    finally { setBusy(false); }
  }
  async function pollJob() {
    const job = state.job; if (!job || state.jobPolling) return;
    state.jobPolling = true;
    let result;
    try { result = requireOK(await api('/api/plan/' + job.kind + '/status?id=' + encodeURIComponent(job.id))); }
    catch (e) {
      if (!job.warned) { job.warned = true; log('任务', '任务状态暂不可读，保留任务编号并继续查询：' + job.id + '。' + e.message, true); }
      // Do not unlock and accidentally replay an operation whose outcome is unknown.
      if (/unknown job/i.test(e.message)) {
        rememberJob(null); log('任务', '宿主已无此任务记录，请检查 NX 现场与复核队列后再操作。', true);
        message('assistant', '任务记录已失效，无法确认上次操作结果。请检查 NX 现场与复核队列后再操作。');
      }
      syncControls(); state.jobPolling = false; return;
    }
    if (state.job?.id !== job.id) { state.jobPolling = false; return; }
    if (result.state === 'running') { text('activity-time', (result.elapsedMs / 1000).toFixed(0) + ' s'); state.jobPolling = false; return; }
    rememberJob(null);
    const output = result.result || { ok: false, error: '任务结束，但没有返回结果。' };
    if (job.kind === 'author') {
      if (output.ok) { message('assistant', '建模计划已生成并提交到复核队列，共 ' + output.stepCount + ' 步。请在右侧检查步骤，在 NX Skill → Review Plan 中逐步复核。'); log('计划', '生成完成：' + output.planId + '，' + output.stepCount + ' 步。');
        if (job.source === 'chat' && state.pendingPlanButton) { state.pendingPlanButton.textContent = '已加入计划'; state.pendingPlanButton.dataset.added = 'true'; }
      }
      else { const error = output.error || '计划生成失败'; message('assistant', error); log('计划', error, true); }
      state.pendingPlanButton = null;
    } else renderRun(output, job);
    try { await refreshReview(); } catch (e) { log('队列', e.message, true); }
    finally { state.jobPolling = false; syncControls(); }
  }
  function renderRun(output, job) {
    $('run-result').hidden = false;
    const label = job.mode === 'live' ? '当前会话' : '后台新建零件';
    const summary = [label + '：' + (output.ok ? '执行完成' : '执行未全部成功'), output.error,
      output.part ? '零件：' + output.part : '', output.saved === true ? '已保存零件' : output.saved === false ? '零件未保存' : '', output.note].filter(Boolean).join('\n');
    text('run-summary', summary); $('run-summary').className = output.ok ? 'success-text' : 'error-text';
    $('run-steps').replaceChildren(...(output.steps || []).map(s => node('li', s.status === 'failed' ? 'error-text' : '', (statusNames[s.status] || s.status) + ' · ' + s.name + (s.message ? '\n' + s.message : ''))));
    log('执行', summary, !output.ok);
    for (const step of output.steps || []) if (step.status === 'failed') log('步骤', step.name + '：' + (step.message || '执行失败'), true);
    toast(output.ok ? '执行完成，请检查 NX 中的实际结果。' : '执行出现问题，请查看右侧结果。');
  }
  async function clearPlan() {
    if ($('clear-plan').disabled || !await dialog('清空复核队列？', '删除当前计划和复核记录。此操作不会撤销已经在 NX 中执行的修改。', '清空队列')) return;
    setBusy(true, '正在清空复核队列');
    try { requireOK(await api('/api/review/clear', {}, 90000)); await refreshReview(); log('队列', '复核队列已清空。'); }
    catch (e) { log('队列', e.message, true); toast(e.message); }
    finally { setBusy(false); }
  }
  function download(name, contents, mime) {
    const url = URL.createObjectURL(new Blob([contents], { type: mime }));
    const link = node('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function refreshAll() {
    $('refresh-all').disabled = true;
    const results = await Promise.allSettled([api('/api/ping'), loadSettings(), refreshReview()]);
    connected(results[0].status === 'fulfilled' && !!results[0].value.ok);
    for (let i = 1; i < results.length; i++) if (results[i].status === 'rejected') log(i === 1 ? '配置' : '队列', results[i].reason.message, true);
    $('refresh-all').disabled = false; syncControls();
  }
  async function poll() {
    if (state.polling || document.hidden) return;
    state.polling = true;
    try {
      const progress = await api('/api/progress'); connected(true); state.remoteBusy = !!progress.active;
      if (progress.active) {
        const stage = stages[progress.stage] || '正在处理';
        text('activity-text', progress.detail || stage); text('activity-time', Math.floor(progress.elapsedMs / 1000) + ' s');
        if (state.lastStage !== progress.stage) { log('进度', stage); state.lastStage = progress.stage; }
        for (const tool of progress.tools || []) {
          const key = [tool.name, tool.ms, tool.ok, JSON.stringify(tool.args)].join(':');
          if (!state.toolsSeen.has(key)) { state.toolsSeen.add(key); log('工具', tool.name + ' · ' + tool.ms + ' ms' + (tool.ok === false ? ' · 失败' : ''), tool.ok === false); }
        }
      }
      state.lastProgressError = false;
      if (state.job) await pollJob();
      if (!state.review || Date.now() - (state.lastReviewPoll || 0) > 6500) { state.lastReviewPoll = Date.now(); await refreshReview(); }
      if (!state.settings) await loadSettings();
    } catch (e) {
      connected(false);
      if (!state.lastProgressError) { log('连接', e.message, true); state.lastProgressError = true; }
    } finally { syncControls(); state.polling = false; }
  }
  $('host-address').textContent = location.host;
  $('chat-form').addEventListener('submit', ask);
  $('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!$('send-message').disabled) $('chat-form').requestSubmit(); } });
  $('settings-form').addEventListener('submit', saveSettings);
  $('settings-form').addEventListener('input', event => { if (event.target.id !== 'provider') dirty(); });
  $('provider').addEventListener('change', () => { selectProvider(); dirty(); feedback('settings-feedback', '仅切换编辑对象；保存并启用后生效。'); });
  // Capture old provider fields before a select change; password drafts remain in memory only.
  $('provider').addEventListener('focus', snapshotDraft);
  $('clear-key').addEventListener('change', () => { $('api-key').disabled = $('clear-key').checked; dirty(); });
  $('test-connection').addEventListener('click', testConnection); $('check-environment').addEventListener('click', checkEnvironment);
  $('author-plan').addEventListener('click', author);
  ['budget-rounds', 'budget-calls', 'budget-timeout'].forEach(id => $(id).addEventListener('input', budgetInput));
  $('budget-one-shot').addEventListener('change', budgetInput);
  $('budget-save').addEventListener('click', saveBudget);
  // 读图:按钮 → 文件对话框;也支持把图直接拖到输入框里。两者走同一条管线。
  $('pick-image').addEventListener('click', () => $('image-input').click());
  $('ribbon-image').addEventListener('click', () => $('image-input').click());
  $('image-input').addEventListener('change', event => pickImageFile(event.target.files && event.target.files[0]));
  $('image-clear').addEventListener('click', () => { clearImage(); log('读图', '已移除待发送图像。'); });
  ['dragenter', 'dragover'].forEach(type => $('chat-form').addEventListener(type, event => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
      event.preventDefault(); $('chat-form').classList.add('drop-active');
    }
  }));
  ['dragleave', 'drop'].forEach(type => $('chat-form').addEventListener(type, () => $('chat-form').classList.remove('drop-active')));
  $('chat-form').addEventListener('drop', event => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) { event.preventDefault(); pickImageFile(files[0]); }
  });
  // 宿主可能存着"NX 菜单刚选好的图",进页面/切回页面时各取一次。
  pickUpHandoff();
  window.addEventListener('focus', () => { if (!state.image) pickUpHandoff(); });
  document.querySelectorAll('[data-run]').forEach(el => el.addEventListener('click', () => run(el.dataset.run)));
  document.querySelectorAll('[data-prompt]').forEach(el => el.addEventListener('click', () => { $('prompt').value = el.dataset.prompt; $('prompt').focus(); }));
  $('focus-prompt').addEventListener('click', () => openWorkspaceWindow('输入需求', 'chat', 'chat-panel', 'prompt'));
  $('ribbon-author').addEventListener('click', () => openWorkspaceWindow('生成计划', 'chat', 'chat-panel', 'prompt'));
  $('focus-settings').addEventListener('click', () => openWorkspaceWindow('模型配置', 'settings', 'configuration', 'provider'));
  document.querySelectorAll('[data-open-panel]').forEach(el => el.addEventListener('click', () => {
    const panel = el.dataset.openPanel;
    if (panel === 'chat') openWorkspaceWindow('Copilot 对话', 'chat', 'chat-panel', 'prompt');
    else if (panel === 'plan') openWorkspaceWindow('计划与复核', 'plan', 'plan-panel');
    else openWorkspaceWindow('连接配置', 'settings', 'configuration', 'provider');
  }));
  document.querySelectorAll('[data-open-run]').forEach(el => el.addEventListener('click', () => {
    const live = el.dataset.openRun === 'live';
    openWorkspaceWindow(live ? '当前会话执行' : '后台新建零件', 'plan', 'plan-panel', live ? 'run-live' : 'run-batch');
  }));
  $('refresh-all').addEventListener('click', openStatusWindow);
  $('refresh-plan').addEventListener('click', async () => { try { await refreshReview(); toast('复核队列已刷新。'); } catch (e) { toast(e.message); } });
  $('clear-plan').addEventListener('click', clearPlan);
  $('export-plan').addEventListener('click', () => { if (state.review?.hasPlan) download('plan-summary.json', JSON.stringify({ ...state.review, exportNote: '计划与复核状态摘要，不包含可执行脚本。' }, null, 2), 'application/json'); });
  $('export-log').addEventListener('click', () => download('workbench-log.txt', state.logs.map(l => l.time + ' [' + l.category + '] ' + l.message).join('\n'), 'text/plain;charset=utf-8'));
  $('toggle-log').addEventListener('click', () => { const collapsed = document.querySelector('.log-panel').classList.toggle('collapsed'); $('toggle-log').textContent = collapsed ? '+' : '−'; $('toggle-log').setAttribute('aria-expanded', String(!collapsed)); $('toggle-log').setAttribute('aria-label', collapsed ? '展开日志' : '折叠日志'); });
  $('new-chat').addEventListener('click', async () => {
    if (state.busy || state.remoteBusy || state.job) return;
    if ($('messages').querySelector('.message') && !await dialog('新建对话？', '将清除当前页面的对话记录。复核计划与 NX 零件保持不变。', '新建对话')) return;
    $('messages').querySelectorAll('.message').forEach(el => el.remove()); state.history = []; state.pendingPlanButton = null; $('welcome').hidden = false; $('prompt').value = ''; $('prompt').focus();
    openWorkspaceWindow('新建对话', 'chat', 'chat-panel', 'prompt');
  });
  $('help-button').addEventListener('click', () => dialog('本地工作台使用说明', '顶部导航和快捷操作会打开对应的独立操作窗口，关闭后可回到工作台，未提交的输入会保留。\n1. 在“模型配置”窗口设置供应商，点击“保存并启用”。\n2. 在“输入需求”窗口发送问题；计划类聊天回复下可点“加入计划”，经生成与校验后提交复核队列。也可在“生成计划”窗口直接生成。聊天会携带最近四轮问答，新建对话会清空上下文。\n3. 在 NX 中打开 NX Skill → Review Plan，可逐步执行并复核。\n4. 两种自动执行方式各有操作窗口，执行前仍需确认。\n\n本页对话和日志仅保留在当前页面。生成计划和静态检查不代表零件已经建成。', '知道了', true));
  $('review-guide').addEventListener('click', () => openWorkspaceWindow('人工复核', 'plan', 'plan-panel', '', 'review'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('beforeunload', event => { if (state.busy || state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  try { const saved = JSON.parse(sessionStorage.getItem(JOB_KEY)); if (saved?.id && ['author', 'run'].includes(saved.kind)) { state.job = saved; log('任务', '恢复任务状态查询：' + saved.id); } } catch (_) { /* Empty or disabled storage. */ }
  syncControls(); refreshAll().then(poll); setInterval(poll, 2500);
})();

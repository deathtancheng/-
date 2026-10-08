/* 华小牛 · 前端逻辑：流式渲染 + 工具调用可视化 */

const $ = (sel) => document.querySelector(sel);
const chat = $('#chat');
const input = $('#input');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const modelSel = $('#modelSel');
const tempRange = $('#tempRange');
const tempVal = $('#tempVal');
const toolToggle = $('#toolToggle');
const dot = $('#dot');
const statusText = $('#statusText');

let history = [];          // 发给后端的对话上下文
let controller = null;     // 中断控制器
let currentWrap = null;    // 当前轮次的容器
let bubble = null;         // 当前回答气泡
let buf = '';              // 当前回答的原始文本
let rafPending = false;

// ── 工具函数 ─────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inlineMd(text) {
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const lines = s.split('\n');
  let html = '';
  let inList = false;
  for (const ln of lines) {
    const m1 = /^\s*[-*]\s+(.*)$/.exec(ln);
    const m2 = /^\s*\d+[.)]\s+(.*)$/.exec(ln);
    if (m1 || m2) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${m1 ? m1[1] : m2[1]}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (!ln.trim()) continue;
      html += `<p>${ln}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function renderMd(src) {
  const parts = String(src).split('```');
  let out = '';
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const nl = p.indexOf('\n');
      const code = nl >= 0 ? p.slice(nl + 1) : p;
      out += `<pre><code>${esc(code)}</code></pre>`;
    } else {
      out += inlineMd(p);
    }
  });
  return out;
}

function flushRender() {
  rafPending = false;
  if (bubble) bubble.innerHTML = renderMd(buf) + '<span class="caret"></span>';
  chat.scrollTop = chat.scrollHeight;
}

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(flushRender);
}

function setStatus(kind, text) {
  dot.className = 'dot ' + kind;
  statusText.textContent = text;
  // 侧栏那颗光球跟着状态走：busy 转起来，err 变色
  const card = $('#agentCard');
  const title = $('#agentTitle');
  if (card) {
    card.classList.toggle('live', kind === 'busy');
    card.classList.toggle('err', kind === 'err');
  }
  if (title) title.textContent = kind === 'busy' ? '思考中…' : '华小牛';
}

// ── 消息渲染 ─────────────────────────────────────────────
function addUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML =
    `<div class="avatar">我</div><div class="bubble">${inlineMd(text)}</div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function ensureBubble() {
  if (bubble) return bubble;
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.innerHTML = `<div class="avatar">牛</div><div class="bubble"></div>`;
  (currentWrap || chat).appendChild(msg);
  bubble = msg.querySelector('.bubble');
  return bubble;
}

function addToolCard(name, args) {
  const card = document.createElement('div');
  card.className = 'tool';
  const argText = Object.entries(args || {})
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  card.innerHTML = `
    <div class="tool-head">
      <span class="gear">⚙</span>
      <span class="name">${esc(name)}</span>
      <span class="args">${esc(argText).slice(0, 120)}</span>
      <span class="state run">调用中…</span>
    </div>
    <div class="tool-body"></div>`;
  card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));
  (currentWrap || chat).appendChild(card);
  chat.scrollTop = chat.scrollHeight;
  return card;
}

function finishToolCard(card, result) {
  if (!card) return;
  card.querySelector('.state').textContent = '完成';
  card.querySelector('.state').className = 'state done';
  card.querySelector('.tool-body').textContent = String(result);
  chat.scrollTop = chat.scrollHeight;
}

// ── 发送 ─────────────────────────────────────────────────
async function send(text) {
  if (!text.trim() || controller) return;

  const welcome = chat.querySelector('.welcome');
  if (welcome) welcome.remove();

  addUser(text);
  history.push({ role: 'user', content: text });

  currentWrap = document.createElement('div');
  currentWrap.className = 'turn';
  chat.appendChild(currentWrap);
  bubble = null;
  buf = '';

  controller = new AbortController();
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  setStatus('busy', '生成中…');

  const cardMap = new Map();
  let cardSeq = 0;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        model: modelSel.value,
        temperature: Number(tempRange.value),
        useTools: toolToggle.checked,
      }),
      signal: controller.signal,
    });

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let raw = '';
    let finalText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      let i;
      while ((i = raw.indexOf('\n')) >= 0) {
        const line = raw.slice(0, i).trim();
        raw = raw.slice(i + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }

        if (evt.type === 'token') {
          buf += evt.text;
          finalText += evt.text;
          ensureBubble();
          scheduleRender();
        } else if (evt.type === 'tool_start') {
          const card = addToolCard(evt.name, evt.args);
          cardMap.set(cardSeq++, card);
        } else if (evt.type === 'tool_end') {
          for (const card of cardMap.values()) {
            const st = card.querySelector('.state');
            if (st && st.classList.contains('run')) { finishToolCard(card, evt.result); break; }
          }
        } else if (evt.type === 'error') {
          ensureBubble();
          buf += `\n\n⚠️ ${evt.message}`;
          flushRender();
        } else if (evt.type === 'done') {
          // 收尾
        }
      }
    }

    if (buf) {
      bubble.innerHTML = renderMd(buf);
      history.push({ role: 'assistant', content: finalText });
    }
    setStatus('ok', '就绪');
  } catch (err) {
    if (err.name !== 'AbortError') {
      ensureBubble();
      buf += `\n\n⚠️ 请求失败：${err.message}`;
      flushRender();
      setStatus('err', '连接失败');
    } else {
      setStatus('ok', '已停止');
    }
  } finally {
    controller = null;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    chat.scrollTop = chat.scrollHeight;
  }
}

// ── 事件绑定 ─────────────────────────────────────────────
sendBtn.addEventListener('click', () => {
  const text = input.value;
  input.value = '';
  autoGrow();
  send(text);
});

stopBtn.addEventListener('click', () => controller && controller.abort());

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
input.addEventListener('input', autoGrow);

tempRange.addEventListener('input', () => { tempVal.textContent = tempRange.value; });

document.querySelectorAll('.chip').forEach((c) => {
  c.addEventListener('click', () => {
    input.value = c.dataset.q;
    autoGrow();
    sendBtn.click();
  });
});

$('#newChat').addEventListener('click', () => {
  history = [];
  chat.innerHTML = `
    <div class="welcome">
      <h1>重新开始 🐮</h1>
      <p>上下文已清空，想聊点什么？</p>
    </div>`;
});

// ── 视觉面板（YOLO 实时检测） ─────────────────────────────
const appEl = document.querySelector('.app');
const visionEl = $('#drawerVision');
const harnessDrawer = $('#drawerHarness');
const driftEl = $('#drift');
const camStream = $('#camStream');
const camFallback = $('#camFallback');
const camStats = $('#camStats');
const camDetections = $('#camDetections');
let visionTimer = null;
let lastSummary = '';

const CAM_HINT = '摄像头服务未启动，先跑：python yolo/camera_server.py';

function renderDetections(items) {
  if (!items || !items.length) {
    camDetections.textContent = '画面中没有检测到目标。';
    return;
  }
  const counts = {};
  for (const d of items) counts[d.label] = (counts[d.label] || 0) + 1;
  camDetections.innerHTML = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="tag">${esc(k)} ×${v}</span>`)
    .join('');
}

async function refreshDetection() {
  try {
    const r = await fetch('/api/camera/detect');
    const j = await r.json();
    if (j.error) {
      camStats.textContent = '摄像头不可用';
      camFallback.textContent = j.error;
      camFallback.classList.add('show');
      return;
    }
    camFallback.classList.remove('show');
    camStats.textContent = `${j.latency_ms} ms · ${j.fps} FPS · ${j.detections.length} 个目标`;
    renderDetections(j.detections);
    lastSummary = j.summary;
  } catch {
    camStats.textContent = '摄像头服务未启动';
    camFallback.textContent = CAM_HINT;
    camFallback.classList.add('show');
  }
}

// ── 抽屉：同一时刻只开一个 ───────────────────────────────
function openDrawer(which) {
  const target = which === 'vision' ? visionEl : harnessDrawer;
  const other = which === 'vision' ? harnessDrawer : visionEl;
  if (!other.hidden) closeDrawer(other === visionEl ? 'vision' : 'harness');
  if (!target.hidden) return;

  target.hidden = false;
  driftEl.classList.add('show');
  requestAnimationFrame(() => target.classList.add('on'));

  const btn = which === 'vision' ? $('#visionToggle') : $('#harnessToggle');
  if (btn) btn.classList.add('on');

  if (which === 'vision') {
    camStream.src = '/api/camera/video?t=' + Date.now();
    refreshDetection();
    visionTimer = setInterval(refreshDetection, 2500);
  } else {
    loadHarnessState();
  }
}

function closeDrawer(which) {
  const el2 = which === 'vision' ? visionEl : harnessDrawer;
  if (el2.hidden) return;
  el2.classList.remove('on');
  const btn = which === 'vision' ? $('#visionToggle') : $('#harnessToggle');
  if (btn) btn.classList.remove('on');

  setTimeout(() => {
    if (el2.classList.contains('on')) return;   // 又被打开了，别真关
    el2.hidden = true;
    if (visionEl.hidden && harnessDrawer.hidden) driftEl.classList.remove('show');
  }, 240);

  if (which === 'vision') {
    camStream.removeAttribute('src');
    clearInterval(visionTimer);
    visionTimer = null;
  }
}

// 旧名字保留，兼容原有调用
const openVision = () => openDrawer('vision');
const closeVision = () => closeDrawer('vision');
const openHarness = () => openDrawer('harness');
const closeHarness = () => closeDrawer('harness');

$('#visionToggle').addEventListener('click', () => (visionEl.hidden ? openVision() : closeVision()));
$('#harnessToggle').addEventListener('click', () => (harnessDrawer.hidden ? openHarness() : closeHarness()));
document.querySelectorAll('.drawer-close').forEach((b) => {
  b.addEventListener('click', () => closeDrawer(b.dataset.close === 'drawerVision' ? 'vision' : 'harness'));
});
driftEl.addEventListener('click', () => { closeVision(); closeHarness(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeVision(); closeHarness(); }
});
$('#btnRefreshDetect').addEventListener('click', refreshDetection);
camStream.addEventListener('error', () => {
  camFallback.textContent = CAM_HINT;
  camFallback.classList.add('show');
});

$('#btnAskVision').addEventListener('click', async () => {
  await refreshDetection();
  input.value = `这是我摄像头当前画面里 YOLO 检测到的内容：${lastSummary || '（没有检测到目标）'}。`
    + `请你据此推断画面可能是什么场景，用两三句中文描述一下，并给一句应景的提醒。`;
  autoGrow();
  sendBtn.click();
});

// ── 初始化 ───────────────────────────────────────────────
(async function init() {
  autoGrow();
  try {
    const r = await fetch('/api/models');
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    modelSel.innerHTML = j.models
      .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
      .join('');
    const prefer = j.models.find((m) => m.startsWith('qwen3')) || j.models[0];
    if (prefer) modelSel.value = prefer;
    setStatus('ok', j.models.length ? `${j.models.length} 个模型已就绪` : '无模型');
  } catch (err) {
    setStatus('err', 'Ollama 未连接');
    modelSel.innerHTML = `<option value="qwen3:8b">qwen3:8b</option>`;
  }
})();

// ── Harness 工作台 ───────────────────────────────────────
//
// 和左边那个聊天窗的区别：左边只看到"答案"，这里看的是 Harness 的内部——
// 每一轮的边界、每个工具的进出、上下文什么时候被压缩、什么时候回来敲门。
// 事件全部来自 lifecycle.emit()，是纯观测流，不参与 agent 的决策。
const hEl = harnessDrawer;
const hTimeline = $('#hTimeline');
const hState = $('#hState');
const hConfirm = $('#hConfirm');
const hResult = $('#hResult');
const hGoal = $('#hGoal');
const hRun = $('#hRun');
const hAbort = $('#hAbort');

let hRunning = false;
let pendingConfirmId = null;

function hLine(level, tag, text, extra = '') {
  if (hTimeline.querySelector('.h-empty')) hTimeline.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'h-ev';
  const kind = tag === '工具' ? 'tool' : tag === '错误' ? 'err' : tag === '压缩' ? 'warn' : '';
  row.innerHTML =
    `<span class="lv">${esc(level)}</span>`
    + `<span class="tag2 ${kind}">${esc(tag)}</span>`
    + `<span class="txt">${esc(text)}</span>`
    + (extra ? `<span class="ms">${esc(extra)}</span>` : '');
  hTimeline.appendChild(row);
  hTimeline.scrollTop = hTimeline.scrollHeight;
}

async function loadHarnessState() {
  try {
    const j = await (await fetch('/api/harness/state')).json();
    if (j.error) throw new Error(j.error);
    const byLevel = {};
    for (const t of j.tools) byLevel[t.level] = (byLevel[t.level] || 0) + 1;
    hState.innerHTML =
      `模型 <b>${esc(j.model)}</b> · 工作区 <code>${esc(j.root.split(/[\\/]/).pop())}</code><br>`
      + `工具 <b>${j.tools.length}</b> 个（只读 ${byLevel.safe || 0} / 写入 ${byLevel.write || 0} / 危险 ${byLevel.danger || 0}）<br>`
      + `扩展 <b>${j.extensions.map((e) => e.name).join(', ') || '无'}</b><br>`
      + `记忆 ${j.memory ? `<b>${j.memory.facts}</b> 事实 / <b>${j.memory.episodes}</b> 条经历` : '未启用'} · `
      + `会话 <b>${j.session.nodes}</b> 节点`
      + `<div class="chip-line">${j.tools.map((t) => `<span class="tag2">${esc(t.name)}</span>`).join('')}</div>`;
  } catch (err) {
    hState.textContent = 'Harness 装载失败：' + err.message;
  }
}

function askHuman(info) {
  return new Promise((resolve) => {
    pendingConfirmId = info.id;
    $('#hConfirmBody').innerHTML =
      `工具 <code>${esc(info.name)}</code> 属于「${esc(info.levelLabel)}」操作。<br>`
      + `参数：<code>${esc(JSON.stringify(info.args).slice(0, 300))}</code>`;
    hConfirm.hidden = false;
    const done = (allow) => {
      hConfirm.hidden = true;
      pendingConfirmId = null;
      resolve(allow);
    };
    $('#hAllow').onclick = () => done(true);
    $('#hDeny').onclick = () => done(false);
  });
}

async function answerConfirm(id, allow) {
  await fetch('/api/harness/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, allow }),
  });
}

async function runHarness() {
  const goal = hGoal.value.trim();
  if (!goal || hRunning) return;

  hRunning = true;
  hRun.hidden = true;
  hAbort.hidden = false;
  hResult.hidden = true;
  hTimeline.innerHTML = '';
  setStatus('busy', 'Harness 运行中');
  hLine('·', '目标', goal);

  let buf2 = '';
  try {
    const res = await fetch('/api/harness/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf2 += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf2.indexOf('\n')) >= 0) {
        const line = buf2.slice(0, i).trim();
        buf2 = buf2.slice(i + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }

        if (evt.type === 'confirm_request') {
          // 关键：这里必须阻塞等待人类表态，agent 那边正挂着等这个答案
          hLine('!', '门禁', `${evt.name} 请求授权（${evt.levelLabel}）`, '等待中');
          const allow = await askHuman(evt);
          await answerConfirm(evt.id, allow);
          hLine('!', '门禁', allow ? `已放行 ${evt.name}` : `已拒绝 ${evt.name}`);
          continue;
        }

        switch (evt.type) {
          case 'trace':
            if (evt.phase === 'start') hLine('▶', 'trace', String(evt.goal).slice(0, 60));
            break;
          case 'turn':
            hLine(`t${evt.turn}`, '轮次', evt.phase === 'start' ? '开始' : evt.final ? '输出最终回答' : '等待下一轮');
            break;
          case 'content':
            if (evt.text) hLine(`t${evt.turn}`, '思考', evt.text.slice(0, 80));
            break;
          case 'tool_call': {
            const f = evt.call?.function || {};
            hLine(`t${evt.turn}`, '工具', `调用 ${f.name}`);
            break;
          }
          case 'tool': {
            if (evt.phase !== 'end') break;
            const flag = evt.ok ? '✓' : evt.blocked ? '⊘' : '✗';
            const out = String(evt.output || '').replace(/\s+/g, ' ').slice(0, 90);
            hLine(`t${evt.turn}`, '工具', `${flag} ${evt.name} — ${out}`, `${evt.ms}ms`);
            break;
          }
          case 'compact':
            hLine(`t${evt.turn}`, '压缩', `上下文压缩至 ${evt.tokens} tokens`);
            break;
          case 'error':
            hLine('!', '错误', evt.message);
            break;
          case 'final':
            showHarnessResult(evt);
            break;
        }
      }
    }
    loadHarnessState();
  } catch (err) {
    hLine('!', '错误', err.message);
  }

  hRunning = false;
  hRun.hidden = false;
  hAbort.hidden = true;
  setStatus('ok', '就绪');
}

function showHarnessResult(r) {
  hResult.hidden = false;
  const metrics =
    `${r.turns} 轮 · ${r.toolCalls} 次工具 · 压缩 ${r.compactions} 次 · ${(r.ms / 1000).toFixed(1)}s`
    + (r.reportPath ? ` · 报告 ${r.reportPath}` : '')
    + (r.aborted ? ' · 已中断' : '');
  hResult.innerHTML =
    `<div class="metric">${esc(metrics)}</div>`
    + (r.error ? `<p style="color:#c2563f">出错：${esc(r.error)}</p>` : '')
    + renderMd(r.text || '（无文本输出）');
}

$('#harnessClose')?.addEventListener('click', closeHarness);
hRun.addEventListener('click', runHarness);
$('#hClear').addEventListener('click', () => { hTimeline.innerHTML = '<div class="h-empty">已清空。</div>'; });
$('#hReset').addEventListener('click', async () => {
  await fetch('/api/harness/reset', { method: 'POST' });
  hTimeline.innerHTML = '<div class="h-empty">已开启新会话（长期记忆保留）。</div>';
  loadHarnessState();
});
hAbort.addEventListener('click', async () => {
  await fetch('/api/harness/abort', { method: 'POST' });
  hLine('!', '中断', '已请求中断');
});
hGoal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runHarness();
});

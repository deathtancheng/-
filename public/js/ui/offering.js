/**
 * 献祭取物：摄像头轮询 + 画框 + 祭品卡
 * ------------------------------------------------------------------
 * 摄像头每 1.2 秒问一次 YOLO「现在镜头前是什么」，把框画在画面上，
 * 顺便告诉玩家「这一件会被当成什么属性」。
 *
 * 手动举物（点下面那排按钮）优先级高于摄像头：
 * 一是有些机器没摄像头，二是演示克制关系时得能指定物件。
 * 手动举物是一次性的——献祭完就还回摄像头。
 */

import { el } from '../dom.js';
import { S, assign } from '../store.js';
import { getDetect } from '../net/api.js';
import { bump } from './fx.js';
// 只引这两个判断，不引整个 maze.js 的动作——那里会反过来引 hud/fx，容易成环
import { mazeNeedsItem, mazePendingFoe } from './maze.js';

const POLL_MS = 1200;

/** 跟服务端 pickOffering 同一套打分：认得准 + 占画面大 */
export function pickBest(js) {
  const W = js.width || 640;
  const H = js.height || 480;
  let best = null;
  for (const d of js.detections || []) {
    const box = d.box || [];
    if (box.length < 4) continue;
    const ratio = Math.min(1, (Math.abs(box[2] - box[0]) * Math.abs(box[3] - box[1])) / (W * H));
    const score = (d.conf || 0) * Math.sqrt(ratio + 1e-4);
    if (!best || score > best.score) best = { label: d.label, conf: d.conf, ratio, score };
  }
  return best;
}

/** 把 YOLO 的框画在摄像头画面上，当前祭品高亮成金色 */
function drawBoxes(js) {
  const cv = el.overlay;
  const img = el.cam;
  if (!cv || !img) return;
  const W = js.width || 640;
  const H = js.height || 480;
  const dw = img.clientWidth || W;
  const dh = img.clientHeight || H;
  cv.width = dw;
  cv.height = dh;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, dw, dh);
  // 画面是 contain（整幅都看得见，上下可能有黑边）——框必须画在"真正的画面"上，
  // 否则窄条取景框里框会压在人脸外面，看着像"只照到一部分"。
  const fit = Math.min(dw / W, dh / H);
  const vw = W * fit;
  const vh = H * fit;
  const ox = (dw - vw) / 2;
  const oy = (dh - vh) / 2;
  const sx = vw / W;
  const sy = vh / H;
  for (const d of js.detections || []) {
    const box = d.box || [];
    if (box.length < 4) continue;
    const x = ox + box[0] * sx;
    const y = oy + box[1] * sy;
    const w = (box[2] - box[0]) * sx;
    const h = (box[3] - box[1]) * sy;
    const hot = S.offering && d.label === S.offering.label;
    g.strokeStyle = hot ? '#f0b64a' : 'rgba(160, 200, 170, .75)';
    g.lineWidth = hot ? 3 : 1.5;
    g.strokeRect(x, y, w, h);
    const text = `${d.label} ${(d.conf || 0).toFixed(2)}`;
    g.font = '12px -apple-system, "PingFang SC", sans-serif';
    const tw = g.measureText(text).width;
    g.fillStyle = hot ? 'rgba(240, 182, 74, .92)' : 'rgba(40, 60, 50, .68)';
    g.fillRect(x, Math.max(0, y - 17), tw + 10, 17);
    g.fillStyle = '#fff';
    g.fillText(text, x + 5, Math.max(11, y - 4));
  }
}

/**
 * 前端也要知道物件属性，用来在按钮上方提示。
 * 对照表由后端推来（state 接口的 labelElement），前端不再自己抄一份——
 * 抄了改平衡时两边一定会走岔，表现是"手动举物标注的属性"跟"实际打出的克制"对不上。
 */
export function elementOfLocal(label) {
  const raw = String(label || '').toLowerCase().trim();
  const map = S.labelElement || {};
  if (map[raw]) return map[raw];
  const spaced = raw.replace(/_/g, ' ');
  if (map[spaced]) return map[spaced];
  return 'unknown';
}

/**
 * 手动举物的按钮表：每个属性各来一件，凑齐九种。
 * 以前只有八件、缺土／活／护，玩家想试"用护属性的东西接金系的招"根本没得试。
 * 中文名写在这儿，属性由 elementOfLocal 从后端对照表里取。
 */
const MANUAL_ITEMS = [
  { label: 'potted plant', cn: '盆栽' },   // 木
  { label: 'toaster',      cn: '烤面包机' }, // 火
  { label: 'chair',        cn: '椅子' },   // 土
  { label: 'scissors',     cn: '剪刀' },   // 金
  { label: 'cup',          cn: '杯子' },   // 水
  { label: 'cell phone',   cn: '手机' },   // 电
  { label: 'cat',          cn: '猫' },     // 活
  { label: 'book',         cn: '书' },     // 知
  { label: 'umbrella',     cn: '伞' },     // 护
];

let manualBuilt = false;

/** 按后端的属性表生成手动举物按钮。属性表没到就先不画 */
export function renderManual() {
  if (!el.mItems || manualBuilt) return;
  if (!S.elements || !Object.keys(S.elements).length) return;
  el.mItems.innerHTML = MANUAL_ITEMS.map((it) => {
    const ele = elementOfLocal(it.label);
    const n = S.elements[ele] ? S.elements[ele].name : '?';
    return `<button class="m-item" data-label="${it.label}">${it.cn}<i>${n}</i></button>`;
  }).join('');
  manualBuilt = true;
}

/** 画祭品卡 */
export function renderOffering() {
  const best = S.offering;
  if (!best) {
    el.offerName.textContent = '镜头前还没有东西';
    el.offerName.classList.add('empty');
    el.offerMeta.innerHTML = '';
    S.prev.label = null;
    // 没东西也要把按钮和文案同步对——不然阶段换了，按钮还挂着上一阶段的字
    syncOfferButton();
    return;
  }
  // 换了个东西才弹一下，不然每隔 1.2 秒轮询会一直闪
  if (best.label !== S.prev.label) {
    S.prev.label = best.label;
    bump(el.offerName, 'pop', 450);
  }
  el.offerName.textContent = best.label;
  el.offerName.classList.remove('empty');
  const ele = S.elements[elementOfLocal(best.label)];
  // 手动举物是用户自己点的，没有「识别置信度」这回事——别编数字
  el.offerMeta.innerHTML = best.manual
    ? ['手动举物', ele ? `属性 <b>${ele.name}</b>` : '', '威力按 <b>32%</b> 画面占比计']
      .filter(Boolean).join('')
    : [
      `识别置信度 <b>${(best.conf * 100).toFixed(0)}%</b>`,
      `占画面 <b>${(best.ratio * 100).toFixed(1)}%</b>`,
      ele ? `属性 <b>${ele.name}</b>` : '',
      S.detect && S.detect.detections ? `画面共 ${S.detect.detections.length} 个目标` : '',
    ].filter(Boolean).join('');
  syncOfferButton();
}

/**
 * 献祭按钮的可用条件 —— 这个按钮要干两件不同的事：
 *
 *   迷宫阶段：把手里的东西「交给」脚下的房间（拾物间收进来 / 砸妖物）。
 *             只有房间真的在等东西时才亮，否则玩家会对着空房间狂点。
 *   夜战阶段：把东西献祭给妖物换一次伤害。只要手里有东西、且还有香就能献。
 *
 * 文案和"要烧几炷香"也跟着变，让玩家按下去之前就知道会发生什么。
 */
export function syncOfferButton() {
  const st = S.state;
  const phase = st && st.phase;
  const over = !!(st && st.over);
  const inc = Math.max(0, Math.round(Number(st && st.incense) || 0));
  let ok = !S.busy && !!S.offering && !over;

  if (phase === 'maze') ok = ok && (mazeNeedsItem() || mazePendingFoe());
  else if (phase === 'night') ok = ok && inc > 0;   // 香烧完了，献不出火
  else ok = false;                                   // 阁楼/结算里献祭没有意义

  el.btnOffer.disabled = !ok;
  el.btnOffer.textContent = phase === 'maze' ? '递 上 此 物' : '献 祭 此 物';

  // 成本说明：夜战要烧香，白天只是把东西递过去，不烧。
  // 这一局已经结束时要说清楚是"结束了"——不然玩家会以为按钮坏了
  // （v4.1.1 前的"满香火点不动"就是它：局其实已经输了，界面却没说）。
  if (el.costLine) {
    if (over) {
      el.costLine.textContent = '这一局已经结束 —— 点右上角「重开一局」再战。';
      el.costLine.classList.add('ash');
    } else if (phase === 'night') {
      el.costLine.innerHTML = inc > 0
        ? `这一祭要烧 <b>1</b> 炷香 · 余 <b>${inc}</b> 炷`
        : '香火已经烧完了 —— 添了香才能再献（回阁找祭坛）';
      el.costLine.classList.toggle('ash', inc <= 0);
    } else {
      el.costLine.textContent = '白天递东西不烧香，只是把它交出去。';
      el.costLine.classList.remove('ash');
    }
  }
}

/* ── 画面：快照泵（v4.5.3）──────────────────────────────────
   前两版各踩了一个坑：
   · MJPEG 流：在预览面板/部分浏览器里只出第一帧就僵住，画面不动；
   · 快照兜底 v1：每 250ms 直接改 <img>.src —— 旧图先被清掉、
     新图还没到，一闪一闪，快到没法看。
   现在改成「快照泵」：后台 fetch 一张**完整的** JPEG → 转成 blob URL
   → 才让 <img> 换图。换上去的永远是完整一帧，天然不闪；
   抓完一张立刻抓下一张，帧率自己跟着机器走（快的机器能有 8-10 fps）。 */
let snapBusy = false;
let snapLoopOn = false;
let lastSnapUrl = null;

async function pumpSnapshot() {
  if (!el.cam || snapBusy) return;
  snapBusy = true;
  try {
    const res = await fetch('/api/camera/snapshot?ts=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    el.cam.src = url;                 // 完整帧才上屏——这就是不闪的关键
    if (lastSnapUrl) URL.revokeObjectURL(lastSnapUrl);
    lastSnapUrl = url;
    if (el.camWrap) el.camWrap.classList.remove('is-off');
  } catch { /* 这一帧失败了就等下一拍，别打扰玩家 */ }
  snapBusy = false;
}

function startSnapshots() {
  if (snapLoopOn) return;
  snapLoopOn = true;
  (async function loop() {
    while (snapLoopOn) {
      await pumpSnapshot();
      await new Promise((r) => setTimeout(r, 120));
    }
  })();
}

function stopSnapshots() { snapLoopOn = false; }

/** 起画面。整个前端只有这一处决定摄像头那张图的来源 */
export function startCamFeed() {
  if (!el.cam) return;
  el.cam.onerror = () => { if (el.camWrap) el.camWrap.classList.add('is-off'); };
  // 直接上快照泵。MJPEG 理论上更顺滑，但实测在太多环境里"有流无画"，
  // 与其先等 3 秒再降级，不如从一开始就走稳的那条路。
  startSnapshots();
}

let detectFails = 0;   // 连着失败几次才认输——单次抖动就把取景框标灰，看起来像"摄像头坏了在闪"

/** 摄像头轮询。自循环，失败了也只是把取景框标灰，不打断别的 */
export async function pollDetect() {
  // 手动举物期间不让摄像头轮询抢走祭品——用户明确指定的优先
  if (S.manual) {
    setTimeout(pollDetect, POLL_MS);
    return;
  }
  try {
    const js = await getDetect();
    if (js.error) throw new Error(js.error);
    detectFails = 0;
    el.camWrap.classList.remove('is-off');
    assign({ detect: js, offering: pickBest(js) });
    drawBoxes(js);
    renderOffering();
  } catch {
    detectFails += 1;
    if (detectFails >= 3) {
      el.camWrap.classList.add('is-off');
      assign({ offering: null });
      renderOffering();
    }
  }
  setTimeout(pollDetect, POLL_MS);
}

/** 手动举物：点一排物件按钮，绕过摄像头 */
export function setManual(btn) {
  const manual = {
    label: btn.dataset.label,
    conf: 0.9,
    ratio: 0.32,
    manual: true,
  };
  assign({ manual, offering: manual });
  el.mItems.querySelectorAll('.m-item').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  renderOffering();
}

/** 手动举物用完就还回摄像头 */
export function clearManual() {
  if (!S.manual) return;
  assign({ manual: null });
  el.mItems.querySelectorAll('.m-item').forEach((b) => b.classList.remove('on'));
}

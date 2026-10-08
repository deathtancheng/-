/**
 * 一次行动：献祭 / 对话
 * ------------------------------------------------------------------
 * 这是唯一会惊动模型的地方，也是唯一读 ndjson 流的地方。
 *
 * 流程：POST → 后端跑一次真正的 Harness trace → 事件一行行推回来，
 * 前端按类型分派：工具调用上角标、正文打字机、权限闸门弹模态、final 结算。
 *
 * 两条铁律：
 *   1. confirm_request 必须**在循环里原地 await**，先把流收完再处理会死锁
 *   2. finally 里一定 setBusy(false)，任何异常都不能把按钮锁死
 */

import { el } from '../dom.js';
import { S, set } from '../store.js';
import { postConfirm, streamAct } from '../net/api.js';
import { addLog, bump, centerOf, chip, floatDamage, flash } from './fx.js';
import { enemyAttack, setBusy, setTurn } from './hud.js';
import { askConfirm, showEnding } from './modal.js';
import { syncOfferButton } from './offering.js';

/**
 * @param {{offering?:object|null, prompt?:string|null, talk?:boolean}} args
 */
export async function act({ offering = null, prompt = null, talk = false } = {}) {
  if (S.busy) return;
  setBusy(true);
  // 献祭 = 你出手，裁判和反击都算妖物的动作——先切它的回合
  if (offering && S.state && S.state.phase === 'night') setTurn('enemy', '它在裁定你的祭品');
  el.chips.innerHTML = '';
  el.speech.textContent = '';
  el.speech.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
  const cursor = el.speech.querySelector('.cursor');

  const body = { talk, intent: S.intent };
  if (offering) {
    body.label = offering.label;
    body.conf = offering.conf;
    body.area_ratio = Number((offering.ratio * 100).toFixed(1));
  }
  if (prompt) body.prompt = prompt;

  try {
    for await (const evt of streamAct(body)) {
      // 后端没走流（没识别到东西 / 局面已结束），按普通提示处理
      if (evt.type === 'json') {
        cursor.remove();
        el.speech.textContent = evt.payload.message || evt.payload.error || '这一回没成。';
        return;
      }
      if (evt.type === 'tool' && evt.phase === 'start') {
        chip(evt.name, 'live');
      } else if (evt.type === 'tool' && evt.phase === 'end') {
        const c = el.chips.lastElementChild;
        if (c) c.className = 'chip ' + (evt.ok && !evt.blocked ? 'ok' : 'no');
      } else if (evt.type === 'content') {
        spokenAppend(cursor, evt.text || '');
      } else if (evt.type === 'confirm_request') {
        const ok = await askConfirm(evt);      // ← 必须在这里等
        await postConfirm(evt.id, ok);
      } else if (evt.type === 'compact') {
        chip('上下文压缩', 'ok');
      } else if (evt.type === 'final') {
        cursor.remove();
        onFinal(evt);
      } else if (evt.type === 'error') {
        cursor.remove();
        el.speech.textContent += `\n（出错了：${evt.message}）`;
      }
    }
  } catch (err) {
    // 网络断、服务重启、超时……都到这儿。关键是：绝不能把按钮锁死。
    cursor.remove();
    const why = String((err && err.message) || err && err.reason || err || '');
    el.speech.textContent = /timeout|aborted|abort/i.test(why)
      ? '妖物走神太久了（超时）。重开一局或稍后再试。'
      : '连不上妖物：' + why + '（服务可能没在跑，双击 game.bat 拉起来）';
  } finally {
    cursor.remove();   // 光标兜底：任何路径结束时都别留一个闪的
    setBusy(false);
    syncOfferButton();
  }
}

/** 打字机：光标永远挂在最后 */
let spoken = '';
function spokenAppend(cursor, text) {
  spoken += text;
  cursor.remove();
  el.speech.textContent = spoken;
  el.speech.appendChild(cursor);
}

/** final 事件：写局面 + 打击感演出 */
function onFinal(evt) {
  const prevPhase = S.state ? S.state.phase : null;

  // 写进 store 就够了：render.js 订阅了 store，会自动重画整屏
  if (evt.state) set({ state: evt.state, guardian: evt.guardian || S.guardian }, 'final');

  if (evt.lastOffering) {
    const o = evt.lastOffering;
    S.round += 1;
    const tag = o.verdict === '克制'
      ? '<span class="tag strong">克制</span>'
      : o.verdict === '被压制' ? '<span class="tag weak">被压制</span>' : '';
    addLog({
      idx: S.round,
      html: `献上 <b>${o.label}</b> <span class="tag">${o.elementName || ''}</span> ${tag}`,
      right: `<span class="grade ${o.grade}">${o.grade}</span>${o.damage} 伤害`,
      fresh: true,
    });

    // ---- 打击感 ----
    // 伤害先从妖物身上飘出来，克制时更大更金
    const crit = o.verdict === '克制' ? 'crit' : '';
    if (el.guardianBox) {
      const g = centerOf(el.guardianBox);
      floatDamage(`-${o.damage}`, g.x - 20, g.y - 10, crit);
      if (o.damage > 0) bump(el.guardianBox, 'struck', 500);
    }
    // 旅人挨的反伤——妖物先缓一口气，然后扑过来（回合制演出）
    if (o.counter > 0) setTimeout(() => enemyAttack(o), 650);
    else if (o.damage > 0) flash(crit ? 'gold' : '');
    if (o.heal > 0) {
      const p = el.pBarWrap ? centerOf(el.pBarWrap) : { x: window.innerWidth / 2, y: 200 };
      floatDamage(`+${o.heal}`, p.x - 20, p.y - 26, 'heal');
    }
    // 破防：这一击正对它的破法——要有个专门的响声
    if (o.pierced) {
      chip('破 · 架 势', 'ok');
      if (el.guardianBox) {
        const g = centerOf(el.guardianBox);
        floatDamage('破!', g.x + 40, g.y - 46, 'pierce');
      }
      if (el.stanceBar) bump(el.stanceBar, 'pierced', 700);
    }
    // 元素反应
    if (o.reaction) {
      chip('反应 · ' + o.reaction, 'ok');
      if (el.guardianBox) {
        const g = centerOf(el.guardianBox);
        floatDamage(o.reaction, g.x - 10, g.y + 20, 'react');
      }
    }
  }

  // 狂怒：拖太久的代价，得让玩家看见状态变了
  if (evt.frenzy) chip('狂 怒 · 反击翻倍', 'no');
  if (evt.win) S.winReport = evt.win;
  el.hStat.textContent = `${evt.turns} 轮 · ${evt.toolCalls} 次工具 · ${(evt.ms / 1000).toFixed(1)}s`;

  const st = evt.state;
  if (st && st.over) {
    // 一局到此为止：结算弹窗等演出落地再出
    setTimeout(() => showEnding(), 900);
  } else if (st && prevPhase === 'night' && st.phase === 'maze') {
    // 妖物退了，天亮了——v4 的"过关"就是活到第二天
    addLog({ idx: '夜', html: `<b>妖物退了。</b>第 ${st.day} 天的日头照进万物阁。`, right: '' });
  }
}

/** 新的一局/一层开始时把打字机内容清掉 */
export function resetSpeech() {
  spoken = '';
}

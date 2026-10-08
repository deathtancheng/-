/**
 * 施法：念咒 → 后端裁决 → 演出
 * ------------------------------------------------------------------
 * 咒要「念出来」才响：浏览器支持语音识别就开麦，不支持就降级成打字。
 * 玩法不能因为环境缺一块就断掉，所以降级路径是必须有的，不是补丁。
 *
 * 真正决定伤害的是后端 /api/game/skill，这里只负责把结果演出来。
 */

import { el } from '../dom.js';
import { S, set } from '../store.js';
import { postSkill } from '../net/api.js';
import { addLog, bump, centerOf, chip, floatDamage, flash } from './fx.js';
import { enemyAttack, setBusy, setTurn } from './hud.js';
import { SKILLS } from './traveler.js';
import { showEnding } from './modal.js';

let recog = null;

/** 麦克风念咒；不支持就退回打字 */
export function castFlow(skill) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return castByTyping(skill);

  el.castHint.hidden = false;
  el.castText.textContent = `正在听……念出「${skill.name}」`;
  el.skillRow.querySelectorAll('.skill').forEach((b) => b.classList.add('casting'));

  try { if (recog) recog.abort(); } catch { /* 没在听就算了 */ }
  recog = new SR();
  recog.lang = 'zh-CN';
  recog.interimResults = true;
  recog.continuous = false;
  let done = false;

  const finish = (ok, heard) => {
    if (done) return;
    done = true;
    el.castHint.hidden = true;
    el.skillRow.querySelectorAll('.skill').forEach((b) => b.classList.remove('casting'));
    if (ok) {
      doCast(skill);
    } else {
      el.speech.textContent = heard
        ? `听到的是「${heard}」，不是「${skill.name}」。咒没响——梁上那位在笑。`
        : `没听清。再念一次「${skill.name}」试试（或点点别的功能）。`;
    }
  };

  recog.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const text = (ev.results[i][0].transcript || '').replace(/\s+/g, '');
      if (text.includes(skill.name)) { finish(true, text); return; }
      if (ev.results[i].isFinal) {
        const hit = SKILLS.find((s) => text.includes(s.name));
        if (hit && hit.id === skill.id) { finish(true, text); return; }
        finish(false, text);
        return;
      }
    }
  };
  recog.onerror = (ev) => {
    if (ev.error === 'no-speech') finish(false, '');
    else if (ev.error === 'not-allowed') {
      el.castHint.hidden = true;
      el.speech.textContent = '麦克风权限没给。可以改成打字施法。';
      castByTyping(skill);
    }
  };
  recog.onend = () => { if (!done) finish(false, ''); };
  try {
    recog.start();
  } catch {
    castByTyping(skill);
  }
}

/** 降级：打字念咒 */
export function castByTyping(skill) {
  const v = window.prompt(`念出咒名以施放（${skill.name}）：`, '');
  if (v && String(v).replace(/\s+/g, '').includes(skill.name)) doCast(skill);
  else if (v) el.speech.textContent = `念错了（${v}），咒没响。`;
}

/** 念对了：交给后端算，回来只做演出 */
export async function doCast(skill) {
  if (S.busy) return;
  setBusy(true);
  setTurn('player', `吟诵「${skill.name}」`);
  try {
    const j = await postSkill(skill.id);
    if (!j.ok) {
      el.speech.textContent = j.error || '咒没响。';
      return;
    }

    // 咒光从旅人这边炸开，再飞向妖物
    const from = el.pBarWrap ? centerOf(el.pBarWrap) : { x: 300, y: 300 };
    const burst = document.createElement('div');
    burst.className = 'cast-burst';
    burst.style.left = from.x - 20 + 'px';
    burst.style.top = from.y - 20 + 'px';
    document.body.appendChild(burst);
    setTimeout(() => burst.remove(), 900);

    if (el.guardianBox) {
      const g = centerOf(el.guardianBox);
      floatDamage(`-${j.damage}`, g.x - 20, g.y - 10, 'crit');
      bump(el.guardianBox, 'struck', 500);
    }
    flash('gold');
    chip(`咒·${j.skill.name}`, 'ok');
    const eleName = S.elements && S.elements[j.skill.element] ? S.elements[j.skill.element].name : '';
    addLog({
      idx: '咒',
      html: `吟诵 <b>${j.skill.name}</b> <span class="tag">${eleName}</span>`,
      right: `${j.damage} 伤害${j.heal ? ` · 回 ${j.heal}` : ''}`,
      fresh: true,
    });
    // 后端给的几行旁白（反应 / 破防 / 精怪补刀 / 狂怒）都写进流水
    for (const line of (j.events || [])) addLog({ idx: '·', html: line, right: '' });

    // 元素反应：这一道咒和上一道凑成一对，额外炸一下
    if (j.reaction) {
      chip('反应 · ' + j.reaction.name, 'ok');
      if (el.guardianBox) {
        const g = centerOf(el.guardianBox);
        floatDamage(j.reaction.name, g.x - 10, g.y + 20, 'react');
      }
    }
    // 破防：这一击正对它的破法
    if (j.pierced) {
      chip('破 · 架 势', 'ok');
      if (el.guardianBox) {
        const g = centerOf(el.guardianBox);
        floatDamage('破!', g.x + 40, g.y - 46, 'pierce');
      }
      if (el.stanceBar) bump(el.stanceBar, 'pierced', 700);
    }
    if (j.justFrenzied) chip('狂 怒 · 反击翻倍', 'no');
    if (j.win) S.winReport = j.win;

    // 写进 store 就够了：render.js 订阅了 store，会自动重画整屏
    set({ state: j.state, guardian: j.guardian || S.guardian }, 'skill');

    if (j.heal > 0) {
      const p = el.pBarWrap ? centerOf(el.pBarWrap) : from;
      floatDamage(`+${j.heal}`, p.x - 20, p.y - 26, 'heal');
    }
    // 放完咒妖物照样还手
    if (j.counter > 0) setTimeout(() => enemyAttack({ counter: j.counter, special: j.frenzy }), 650);
    if (j.state && j.state.over) setTimeout(() => showEnding(), 1200);
    else if (j.cleared) {
      // v4：妖物不是"被你打退了一层"，而是今晚的守夜结束了，天要亮了
      addLog({ idx: '夜', html: `<b>妖物退了。</b>第 ${j.state.day} 天的日头照进万物阁。`, right: '' });
    }
  } catch (err) {
    el.speech.textContent = '施法失败：' + err.message;
  } finally {
    setBusy(false);
  }
}

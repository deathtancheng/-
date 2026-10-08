/**
 * 游戏路由：/api/game/*
 * ------------------------------------------------------------------
 * 后端这一侧只做四件事：算（规则在 src/game/rules/）、存（存档在 quest 扩展里）、
 * 推（局面一变就 SSE broadcast）、报（动作结果顺手返回给发起方）。
 * 叙事完全交给模型，这里一个字剧情都不写。
 *
 * 白天（迷宫 + 阁楼）全是纯规则、毫秒级，走下面的 /travel /room /hall /night；
 * 只有夜战（/act）会惊动模型——那是它唯一该出场的时候。
 *
 * 几条硬规矩：
 *   · 同一时刻只允许一个夜战回合在跑，后来的直接 409 —— 否则旧回合变孤儿占死 Ollama
 *   · 任何一次改动局面之后都要 publish，否则前端只有发起方看得到变化
 */

const {
  pickOffering, ELEMENTS, LABEL_ELEMENT, RELICS, turnsLeft, isFrenzy,
  runSnapshot, resolveRoom, step, here, descend, returnToHall, leaveHall,
  doBuild, doSell, doMelt, doFeed, doRelease, doRest, payWalk,
} = require('../../game/rules');
const { guardianFor } = require('../../game');
const { publish } = require('../../game/bus');
const { cameraDetect } = require('../../vision/detect');
const { SessionTree } = require('../../harness/context');
const { sendJson, readBody } = require('../util');
const { getGameHarness, questDef } = require('../context');

/** 局面快照：所有出口都走这一个，格式才不会前后不一致 */
function snap(st) {
  return runSnapshot(st);
}

function publishState(st, reason, extra) {
  publish({ type: 'state', state: snap(st), guardian: guardianFor(st), reason, extra });
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return {};
  }
}

/** 把前端的 offering 载荷变成规则层要的形状 */
function toOffering(payload) {
  if (!payload || !payload.label) return null;
  return {
    label: String(payload.label),
    conf: Number(payload.conf ?? 0.6),
    ratio: Number(payload.area_ratio ?? 20) / 100,
  };
}

module.exports = async function handle(req, res, url, ctx) {
  const p = url.pathname;

  /* ══ 读局面 ════════════════════════════════════════════════ */
  if (req.method === 'GET' && p === '/api/game/state') {
    try {
      const h = await getGameHarness();
      const st = questDef(h).getState();
      sendJson(res, 200, {
        ok: true,
        state: snap(st),
        guardian: guardianFor(st),
        elements: ELEMENTS,
        // 物件名 → 属性的对照表也一并推过去。
        // 手动举物是纯前端行为（没有摄像头时用它），属性必须跟服务端一致——
        // 前端自己抄一份小表，改平衡时两边一定会走岔。
        labelElement: LABEL_ELEMENT,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // 跨局存档：周目、已解锁遗物、历次成绩。跟 state 分开，因为它跨局累积

  if (req.method === 'GET' && p === '/api/game/legacy') {
    try {
      const h = await getGameHarness();
      const lg = (questDef(h).getLegacy && questDef(h).getLegacy()) || null;
      const history = (lg && Array.isArray(lg.history)) ? lg.history : [];
      sendJson(res, 200, {
        ok: true,
        legacy: lg,
        relics: RELICS.map((r) => ({ id: r.id, name: r.name, desc: r.desc })),
        owned: (lg && Array.isArray(lg.relics) ? lg.relics : [])
          .map((id) => RELICS.find((r) => r.id === id))
          .filter(Boolean)
          .map((r) => ({ id: r.id, name: r.name, desc: r.desc })),
        last: history.length ? history[history.length - 1] : null,
        best: history.length ? history.reduce((a, b) => (b.days > a.days ? b : a)) : null,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  /* ══ 重开一局 ══════════════════════════════════════════════ */
  if (req.method === 'POST' && p === '/api/game/reset') {
    const payload = await readJson(req);
    try {
      if (ctx.gameRun && ctx.gameRun.controller) {
        try { ctx.gameRun.controller.abort(new Error('reset')); } catch { /* 已经结束了 */ }
        ctx.gameRun = null;
      }
      const h = await getGameHarness();
      const def = questDef(h);
      // hard = 连跨局进度一起清（回到第一周目）。
      // 普通重开只重开这一局，周目和遗物是带过来的。
      if (payload && payload.hard === true && typeof def.resetProgress === 'function') {
        await def.resetProgress();
      } else {
        await def.reset();
      }
      h.agent.session = new SessionTree();   // 新一局，妖物不该记得上一局的恩怨
      const fresh = def.getState();
      publishState(fresh, 'reset');
      sendJson(res, 200, { ok: true, state: snap(fresh), cycle: fresh.cycle });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  /* ══ 白天的三个动作：移动 / 结算房间 / 下潜 · 回阁 ═════════ */

  if (req.method === 'POST' && p === '/api/game/travel') {
    const payload = await readJson(req);
    const h = await getGameHarness().catch(() => null);
    if (!h) { sendJson(res, 503, { error: '游戏内核起不来' }); return true; }
    const st = questDef(h).getState();
    if (st.over) { sendJson(res, 409, { error: '这一局已经结束，请先重开' }); return true; }
    if (st.phase !== 'maze') { sendJson(res, 409, { error: '现在不在迷宫里。', phase: st.phase }); return true; }

    const move = step(st, String(payload.dir || ''));
    if (!move.ok) {
      // blocked：脚下这一格还没处理完（妖物堵门、屋里没决断），不许走
      sendJson(res, 200, { ok: false, msg: move.msg, blocked: !!move.blocked, state: snap(st) });
      return true;
    }
    payWalk(st);   // 走一步的饱食成本

    // 走到一格就结算它；需要玩家再出一次手的（举物/抉择）先挂着
    let result = null;
    if (move.room && !move.room.solved) {
      result = resolveRoom(st, move.room, toOffering(payload) ? { offering: toOffering(payload) } : {});
    }
    await questDef(h).setState(st);
    publishState(st, 'travel', result);
    sendJson(res, 200, { ok: true, result, rerolled: move.rerolled || 0, state: snap(st) });
    return true;
  }

  // 结算当前脚下的房间：举物 / 抉择 / 买货 / 避战

  if (req.method === 'POST' && p === '/api/game/room') {
    const payload = await readJson(req);
    const h = await getGameHarness().catch(() => null);
    if (!h) { sendJson(res, 503, { error: '游戏内核起不来' }); return true; }
    const st = questDef(h).getState();
    if (st.over) { sendJson(res, 409, { error: '这一局已经结束，请先重开' }); return true; }
    if (st.phase !== 'maze') { sendJson(res, 409, { error: '现在不在迷宫里。', phase: st.phase }); return true; }

    const room = here(st.maze);
    const r = resolveRoom(st, room, {
      offering: toOffering(payload),
      choice: payload.choice,
      good: payload.good,
      skip: payload.skip === true,     // 「不捡了 / 不买了」——房间要有明确的了结方式
      intent: payload.intent,
    });
    await questDef(h).setState(st);
    publishState(st, 'room', r);
    sendJson(res, 200, { ok: true, result: r, state: snap(st) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/game/descend') {
    const h = await getGameHarness().catch(() => null);
    if (!h) { sendJson(res, 503, { error: '游戏内核起不来' }); return true; }
    const st = questDef(h).getState();
    const r = descend(st);
    await questDef(h).setState(st);
    publishState(st, 'descend', r);
    sendJson(res, 200, { ...r, state: snap(st) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/game/return') {
    const h = await getGameHarness().catch(() => null);
    if (!h) { sendJson(res, 503, { error: '游戏内核起不来' }); return true; }
    const st = questDef(h).getState();
    const r = returnToHall(st);
    await questDef(h).setState(st);
    publishState(st, 'return', r);
    sendJson(res, 200, { ...r, state: snap(st) });
    return true;
  }

  // 又出门：从阁回到迷宫（不刷新地图，刚记住的路不该白记）

  if (req.method === 'POST' && p === '/api/game/leave') {
    const h = await getGameHarness().catch(() => null);
    if (!h) { sendJson(res, 503, { error: '游戏内核起不来' }); return true; }
    const st = questDef(h).getState();
    const r = leaveHall(st);
    await questDef(h).setState(st);
    publishState(st, 'leave', r);
    sendJson(res, 200, { ...r, state: snap(st) });
    return true;
  }

  /* ══ 阁楼经营：建造 / 卖 / 炼精怪 / 喂 / 送走 / 进食歇息 ══ */

  if (req.method === 'POST' && p === '/api/game/hall') {
    const payload = await readJson(req);
    const h = await getGameHarness().catch(() => null);
    if (!h) { sendJson(res, 503, { error: '游戏内核起不来' }); return true; }
    const st = questDef(h).getState();
    if (st.over) { sendJson(res, 409, { error: '这一局已经结束，请先重开' }); return true; }

    const action = String(payload.action || '');
    const id = payload.id ? String(payload.id) : '';
    let out;
    switch (action) {
      case 'build':   out = doBuild(st, id); break;
      case 'sell':    out = doSell(st, id); break;
      case 'melt':    out = doMelt(st, id); break;
      case 'feed':    out = doFeed(st, id); break;
      case 'release': out = doRelease(st, id); break;
      case 'eat':
      case 'sleep':
      case 'study':
      case 'incense': out = doRest(st, action); break;
      default:        out = { ok: false, msg: `不知道怎么「${action}」。` };
    }
    await questDef(h).setState(st);
    publishState(st, 'hall', { action, out });
    sendJson(res, 200, { ...out, state: snap(st) });
    return true;
  }

  /* ══ 入夜：抽妖物、摆架势，夜战开始 ═══════════════════════ */

  if (req.method === 'POST' && p === '/api/game/night') {
    const h = await getGameHarness().catch(() => null);
    if (!h) { sendJson(res, 503, { error: '游戏内核起不来' }); return true; }
    const def = questDef(h);
    const st = def.getState();
    if (st.over) { sendJson(res, 409, { error: '这一局已经结束，请先重开' }); return true; }
    if (typeof def.beginNight !== 'function') { sendJson(res, 500, { error: 'quest 扩展没有 beginNight' }); return true; }
    const r = await def.beginNight();
    publishState(st, 'night', r);
    sendJson(res, 200, { ok: true, beast: guardianFor(st), state: snap(st) });
    return true;
  }

  /* ══ 夜战：一次出手，走模型叙事 ═══════════════════════════ */

  if (req.method === 'POST' && p === '/api/game/act') {
    let payload = await readJson(req);

    // 同一时刻只允许一个回合在跑
    if (ctx.gameRun) {
      sendJson(res, 409, { error: '上一回合还在裁定中，等它说完，或者点「重开一局」。' });
      return true;
    }

    const h = await getGameHarness().catch((err) => {
      sendJson(res, 503, { error: '游戏内核起不来：' + err.message });
      return null;
    });
    if (!h) return;
    const def = questDef(h);
    const st = def.getState();

    if (st.over) {
      sendJson(res, 409, { error: '这一局已经结束了，请先重开' });
      return true;
    }

    const talking = payload.talk === true;
    if (!talking && st.phase !== 'night') {
      sendJson(res, 409, { error: '天还亮着，妖物没来。先入夜再守阁。', phase: st.phase });
      return true;
    }

    // ---------------------------------------------------------- 祭品从哪来
    // 优先用仓库里的旧物（item_id）；否则用镜头；再否则才是手动 label
    let offering = null;
    let itemId = null;

    if (payload.item_id) {
      itemId = String(payload.item_id);
      const it = (st.store || []).find((x) => x.id === itemId);
      if (!it) { sendJson(res, 404, { error: '仓库里没有这件东西。' }); return true; }
      offering = { label: it.label, conf: it.conf, ratio: it.ratio };
    } else if (payload.label) {
      offering = {
        label: String(payload.label),
        conf: Number(payload.conf ?? 0.6),
        ratio: Number(payload.area_ratio ?? 20) / 100,
      };
    } else if (!talking) {
      try {
        const js = await cameraDetect();
        if (js.error) { sendJson(res, 503, { error: `摄像头不可用：${js.error}` }); return true; }
        const best = pickOffering(js.detections, js);
        if (!best) {
          sendJson(res, 200, {
            ok: false, empty: true,
            message: '画面里没有可识别的物件。把东西举高一点、离镜头近一点再来。',
          });
          return true;
        }
        offering = best;
      } catch (err) {
        sendJson(res, 503, { error: '读摄像头失败：' + err.message });
        return true;
      }
    }

    const confPct = offering ? (offering.conf * 100).toFixed(0) : '0';
    const areaPct = offering ? (offering.ratio * 100).toFixed(1) : '0';
    const intent = ['power', 'guard', 'arcane'].includes(payload.intent) ? payload.intent : 'power';

    let goal;
    if (talking) {
      goal = String(payload.prompt || '').trim() || '旅人站在你面前，什么也没说。';
    } else {
      const n = st.offerings.length + 1;
      // 每回合换一个切入角度，否则小模型会连续几回合复述同一个句子
      const ANGLES = [
        '这一回从声音写起', '这一回从气味写起', '这一回从触感写起',
        '这一回从光线写起', '这一回从你自己身上某个具体部位写起',
        '这一回从一段旧回忆写起', '这一回从地面或墙上的变化写起',
      ];
      const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
      const INTENT_WORD = { power: '强攻', guard: '固守', arcane: '蕴术' };
      const desc = itemId
        ? `旅人从阁里取出旧物【${offering.label}】砸过来（item_id="${itemId}"）`
        : `旅人把【${offering.label}】举到了你面前（识别置信度 ${offering.conf.toFixed(2)}，占画面 ${areaPct}%）`;
      goal = payload.prompt && String(payload.prompt).trim()
        ? String(payload.prompt).trim()
        : `这是第 ${st.day} 夜的第 ${n} 次交手，${desc}。`
          + `这一祭他要转化成「${INTENT_WORD[intent]}」，调用 quest_resolve 时 intent 必须传 "${intent}"`
          + (itemId ? `，item_id 必须原样传 "${itemId}"。` : '。')
          + `按规则裁定它。写剧情时${angle}。`;
    }

    // ---------------------------------------------------------- 流式回传
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const emit = (evt) => {
      if (!res.writableEnded) res.write(JSON.stringify(evt) + '\n');
    };

    const controller = new AbortController();
    ctx.gameRun = { controller, pending: null };

    if (!talking) {
      st.pendingIntent = intent;
      await def.setState(st).catch(() => {});
    }
    const off = h.lifecycle.onEvent(emit);

    emit({
      type: 'offering',
      label: offering ? offering.label : null,
      conf: offering ? offering.conf : null,
      areaRatio: offering ? Number(areaPct) : null,
      confPct: offering ? Number(confPct) : null,
      itemId,
      talk: talking,
    });

    try {
      const result = await h.agent.run(goal, {
        signal: controller.signal,
        continueSession: true,
        confirm: (info) =>
          new Promise((resolve) => {
            const id = `g${++ctx.confirmSeq}`;
            ctx.gameRun.pending = { id, resolve, info };
            emit({
              type: 'confirm_request',
              id,
              name: info.name,
              level: info.level,
              levelLabel: info.levelLabel,
              args: info.args,
            });
          }),
      });

      const after = def.getState();
      const last = after.offerings[after.offerings.length - 1] || null;
      emit({
        type: 'final',
        text: result.text,
        turns: result.turns,
        toolCalls: result.toolCalls,
        ms: result.ms,
        state: snap(after),
        lastOffering: last,
        guardian: guardianFor(after),
        stance: after.stance || null,
        turnsLeft: turnsLeft(after),
        frenzy: isFrenzy(after),
        win: after.lastWin || null,
      });
      publishState(after, 'act', { last });
    } catch (err) {
      emit({ type: 'error', message: err.message });
    }
    off();
    ctx.gameRun = null;
    res.end();
    return true;
  }

  /* ══ 放咒：麦克风念出咒名后调这里。纯规则，不等模型 ═══════ */

  if (req.method === 'POST' && p === '/api/game/skill') {
    const payload = await readJson(req);
    const h = await getGameHarness().catch(() => null);
    if (!h) { sendJson(res, 503, { error: '游戏内核起不来' }); return true; }
    const def = questDef(h);
    if (typeof def.castSkill !== 'function') {
      sendJson(res, 500, { error: 'quest 扩展没有 castSkill' });
      return true;
    }
    const out = await def.castSkill(String(payload.id || ''));
    const st = def.getState();
    sendJson(res, 200, { ...out, state: snap(st), guardian: guardianFor(st) });
    publishState(st, 'skill', out);
    return true;
  }

  /* ══ 权限表态（妖物要写战报时）═══════════════════════════ */

  if (req.method === 'POST' && p === '/api/game/confirm') {
    const payload = await readJson(req);
    if (!ctx.gameRun || !ctx.gameRun.pending || ctx.gameRun.pending.id !== payload.id) {
      sendJson(res, 409, { error: '没有待确认的请求' });
      return true;
    }
    const { resolve } = ctx.gameRun.pending;
    ctx.gameRun.pending = null;
    resolve(payload.allow === true);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
};

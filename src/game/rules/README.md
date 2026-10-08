# src/game/rules/ —— 规则纯函数

游戏玩法的"真理之源"。v4.0 按「肉鸽 + 生存 + 策略 + 模拟经营」分文件，
每个文件只负责一个主题，本目录里**没有一句剧情**——叙事归模型。

| 文件 | 主题 |
| --- | --- |
| `constants.js` | 全局数值：体力上限、基础属性、饱食/精神上限、开局铜钱与香火、迷宫尺寸 |
| `elements.js` | 九种属性、克制表、COCO 80 类 → 属性映射 |
| `survival.js` | v4：饱食与精神两条命线——扣减、饥饿掉血、失魂迷路、伤害打折 |
| `incense.js` | v4.1：香火——献祭的硬成本，上限随祭坛、来源靠经营、买香每日限量 |
| `facilities.js` | v4：万物阁六间房——造价、等级效果、货仓容量、门面夜进项 |
| `spirits.js` | v4：精怪（物件之灵）——炼成、喂食升级、夜战加成快照 |
| `maze.js` | v4：随机房间迷宫——生成、迷雾视野、走格、强制房间（没处理完不许走）、歇脚处、陷阱伪装 |
| `rooms.js` | v4：房间里发生什么——拾物、妖物（强制交手）、陷阱、箱笼、神龛、商贩、歇脚处 |
| `night.js` | v4：妖物池（十只，按天数分档）、缩放、反击公式、狂暴判定 |
| `run.js` | v4：本局状态机——开新局、下潜、回阁、营造/卖/炼/喂/日常、入夜、结算、前端快照 |
| `stats.js` | 玩家基础数值、装备、遗物效果 |
| `offering.js` | 献祭裁决：威力、命中、克制、连击、暴击、去向、境界加成 |
| `skills.js` | 五道咒、元素反应、咒术伤害 |
| `stance.js` | 妖物架势、破防、限时狂怒 |
| `legacy.js` | 多周目遗物表、周目缩放 |
| `dao.js` | 道行、境界、本命器、参悟心得 |
| `index.js` | 汇总导出（含常量表），调用方 `require('./rules')` 即可 |

## v4 的一局长什么样

```
newRun()          第 1 天，phase = 'maze'，一张新迷宫（必有歇脚处，陷阱伪装成空房）
  │ walk / payWalk        走一格：揭雾 + 扣饱食（失魂时迷路多扣）；
  │                       没处理完的房间扣住玩家，走不动
  │ resolveRoom           脚下的房间裁决（拾物 / 妖物 / 陷阱 / 箱笼 / 神龛 / 商贩 / 歇脚处）
  │ descend               顺着梯子下潜：换更深一张图，扣精神
  ▼ returnToHall          只在歇脚处可用——"今天就到这儿"是地图上的一个坐标
phase = 'hall'    万物阁：doBuild / doSell / doMelt / doFeed / doRelease / doRest
  │                       （进食、歇息、参悟、添香，每天各有限次）
  ▼ beginNight
phase = 'night'   妖物上门：pickBeast 抽怪 → scaleGuardian 按天数缩放 → rollStance
  │                       夜战献祭烧香（quest_resolve 里扣）；模型只负责把裁决写成故事
  ▼ endNight(won)
赢了 → nextDay：门面进账、天数 +1、换一张新迷宫、天气回一点气
输了 → over = 'lose'：runSummary() 编出"活了几天"，交给上层写跨局存档
```

## 前端快照

`runSnapshot(state)` 是**唯一**给前端的局面格式：所有 HTTP 出口和 SSE 推送都走它。
里面带上了设施造价、妖物血量、道行境界这些"前端本来容易自己抄一份"的东西——
抄了迟早跟规则层对不上，所以一律在这边算好再给。

## 如何加新机制

1. 在对应的主题文件里写纯函数。
2. 从该文件的 `module.exports` 导出，`index.js` 会自动带出去。
3. 在 `src/harness/extensions/quest.js` 或 `src/http/routes/game.js` 里调用。
4. 需要给前端看的字段，加进 `runSnapshot()`。
5. 在 `scripts/e2e-v40.js` 里写验证。

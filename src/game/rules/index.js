/**
 * 规则层对外接口
 * ------------------------------------------------------------------
 * 这一层是《拾物奇谭》的全部"物理定律"。
 *
 *     规则归代码，叙事归模型。
 *
 * 模型不能碰任何一个数字：它拿到的永远是这里已经算好的结构化裁决，
 * 它的活儿只是把数字翻译成故事。反过来说，想改平衡性只改这些表，
 * 一个字提示词都不用动。
 *
 * v4.0 按「肉鸽 + 生存 + 策略 + 模拟经营」重组，目录下按主题分文件，
 * 本文件只做汇总导出——调用方一律 `require('./rules')`，
 * 不需要知道内部分了几个文件。
 */

const constants = require('./constants');     // 全局数值（上限、开局资源、地图尺寸）
const elements = require('./elements');       // 属性与克制——玩法的地基
const night = require('./night');             // 妖物池、夜袭难度、反击公式
const stats = require('./stats');             // 旅人数值、装备、献祭去向
const skills = require('./skills');           // 咒术与元素反应
const stance = require('./stance');           // 架势与狂怒
const legacy = require('./legacy');           // 多周目与跨局遗物
const offering = require('./offering');       // 献祭裁决（最要紧的纯函数）
const survival = require('./survival');       // 饱食与精神
const incense = require('./incense');         // 香火：献祭的硬成本
const facilities = require('./facilities');   // 万物阁：设施与建造
const spirits = require('./spirits');         // 精怪：养成的物件之灵
const maze = require('./maze');               // 随机房间迷宫的几何与视野
const rooms = require('./rooms');             // 房间里发生什么
const dao = require('./dao');                 // 器修道行与参悟
const clock = require('./clock');             // 时辰：白天 / 黄昏 / 夜里，走完自动翻页
const run = require('./run');                 // 本局状态机（把上面这些串起来）

module.exports = {
  // 常量先铺一遍：后面各模块里同名的（PLAYER_HP / BASE_STATS）是同一个值，
  // 放前面只是为了让"上限/开局资源/地图尺寸"这类数字也能从这一层取到。
  ...constants,
  ...elements,
  ...night,
  ...stats,
  ...skills,
  ...stance,
  ...legacy,
  ...offering,
  ...survival,
  ...incense,
  ...facilities,
  ...spirits,
  ...maze,
  ...rooms,
  ...dao,
  ...clock,
  ...run,
};

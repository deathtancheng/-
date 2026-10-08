/**
 * DOM 引用集中地
 * ------------------------------------------------------------------
 * 所有 getElementById 只在这里出现一次。
 * 好处是：改 HTML 里的 id 时，只需要改这一个文件；
 * 其它模块永远只写 el.xxx，不碰选择器。
 *
 * v4.0 按三块界面（迷宫 / 阁楼 / 夜战）重新分过组。
 */

const $ = (id) => document.getElementById(id);

export const el = {
  /* —— 顶栏 —— */
  lv: $('lv'), verChip: $('verChip'), cyclePill: $('cyclePill'),
  btnReset: $('btnReset'), bossBg: $('bossBg'), dayTrack: $('dayTrack'),

  /* —— 生存资源条 —— */
  hpFill: $('hpFill'), hpNum: $('hpNum'),
  satFill: $('satFill'), satNum: $('satNum'),
  sanFill: $('sanFill'), sanNum: $('sanNum'),
  incFill: $('incFill'), incNum: $('incNum'),
  coinNum: $('coinNum'), resBar: $('resBar'),
  dayNight: $('dayNight'), dnIcon: $('dnIcon'), dnText: $('dnText'), dnSub: $('dnSub'),
  dnTime: $('dnTime'), dnFill: $('dnFill'),

  /* —— 开场标题画面 —— */
  titleScreen: $('titleScreen'), tsNote: $('tsNote'), tsLegacy: $('tsLegacy'),
  tsStart: $('tsStart'), tsNew: $('tsNew'), tsCycle: $('tsCycle'), tsLog: $('tsLog'),

  /* —— 摄像头 + 祭品（取景框没抬起时这一块让位给地图）—— */
  camBody: $('camBody'),
  cam: $('cam'), camWrap: $('camWrap'), overlay: $('overlay'),
  offerLabel: $('offerLabel'),
  offerName: $('offerName'), offerMeta: $('offerMeta'), btnOffer: $('btnOffer'),
  costLine: $('costLine'), intents: $('intents'), mItems: $('mItems'),

  /* —— GalGame 舞台 + 对话框（v4.4：场景层不再是遮罩，直接占中央）—— */
  galStage: $('galStage'), gsBg: $('gsBg'), gsTier: $('gsTier'),
  gsFoeName: $('gsFoeName'), gsFoeHp: $('gsFoeHp'), gsFoeHpTxt: $('gsFoeHpTxt'),
  gsHpWrap: $('gsHpWrap'),
  gsBadge: $('gsBadge'), gsHero: $('gsHero'), gsFoe: $('gsFoe'),
  gdName: $('gdName'), scActs: $('scActs'),
  mzNav: $('mzNav'),

  /* —— 旅人形象：立绘 + 三个装备图层 —— */
  figureCard: $('figureCard'), fcStage: $('fcStage'),
  fcL: [$('fcL0'), $('fcL1'), $('fcL2')],
  fcRealm: $('fcRealm'), fcAtk: $('fcAtk'), fcDef: $('fcDef'), fcCrit: $('fcCrit'),
  fcSlots: $('fcSlots'),

  /* —— 迷宫 —— */
  mazePanel: $('mazePanel'), mzDepth: $('mzDepth'), mzHint: $('mzHint'),
  mzGrid: $('mzGrid'), mzDpad: $('mzDpad'),
  roomCard: $('roomCard'), btnDescend: $('btnDescend'), btnReturn: $('btnReturn'),
  mzWarn: $('mzWarn'),

  /* —— 阁楼 —— */
  hallPanel: $('hallPanel'), hlTitle: $('hlTitle'), hlCoin: $('hlCoin'),
  hlFacilities: $('hlFacilities'), hlStore: $('hlStore'), hlStoreCap: $('hlStoreCap'),
  hlSpirits: $('hlSpirits'), hlSpiritCap: $('hlSpiritCap'), hlDaily: $('hlDaily'),
  btnBackMaze: $('btnBackMaze'), btnNight: $('btnNight'),

  /* —— 夜战 —— */
  nightPanel: $('nightPanel'),
  turnBanner: $('turnBanner'), turnLabel: $('turnLabel'), turnNote: $('turnNote'),
  stanceBar: $('stanceBar'), stName: $('stName'), stHint: $('stHint'), stTurns: $('stTurns'),
  gName: $('gName'), gEle: $('gEle'), gTone: $('gTone'),
  gBar: $('gBar'), gHp: $('gHp'), gScene: $('gScene'),
  gPortrait: $('gPortrait'), gRage: $('gRage'), gCombo: $('gCombo'),
  pBar: $('pBar'), pHp: $('pHp'), buffRow: $('buffRow'),
  speech: $('speech'), chips: $('chips'),
  guardianBox: document.querySelector('.guardian'),
  gBarWrap: $('gBarWrap'), pBarWrap: document.querySelector('.player-row .bar'),

  /* —— 旅人数值面板 —— */
  travelerBox: $('travelerBox'),
  stAtk: $('stAtk'), stDef: $('stDef'), stCrit: $('stCrit'),
  manaBar: $('manaBar'), manaNum: $('manaNum'),
  equipRow: $('equipRow'), skillRow: $('skillRow'),
  castHint: $('castHint'), castText: $('castText'),
  relicWrap: $('relicWrap'), relicRow: $('relicRow'),
  daoWrap: $('daoWrap'), daoRealm: $('daoRealm'), daoBar: $('daoBar'), daoMeta: $('daoMeta'),
  insightWrap: $('insightWrap'), insightRow: $('insightRow'),

  /* —— 流水与页脚 —— */
  newsList: $('newsList'), log: $('log'),
  chat: $('chat'), btnSay: $('btnSay'), hDot: $('hDot'), hStat: $('hStat'),

  /* —— 特效层 —— */
  fxLayer: $('fxLayer'), flash: $('flash'), bolt: $('bolt'),
  endingFx: $('endingFx'), endSeal: $('endSeal'),

  /* —— 模态 —— */
  modal: $('modal'), mTitle: $('mTitle'), mBody: $('mBody'), mPre: $('mPre'), mActs: $('mActs'),
};

/**
 * 属性与克制 —— 玩法的地基
 *
 * 九种属性（木火土金水电活知护），一张稀疏克制表。
 * 用稀疏表而不是 9×9 矩阵，是因为大部分组合本该是"无克制"，
 * 写全矩阵反而容易手滑填出互相克制。
 */

const ELEMENTS = {
  wood: { name: '木', color: '#6f9d5b', tone: '草木生长之力，柔韧而绵长' },
  fire: { name: '火', color: '#d9713f', tone: '炉火炙烈，一往无前' },
  earth: { name: '土', color: '#a8854f', tone: '厚重沉稳，能挡能压' },
  metal: { name: '金', color: '#8d97a8', tone: '锋锐凛冽，专破活物' },
  water: { name: '水', color: '#4f92b0', tone: '流转无形，能克烈火' },
  volt: { name: '电', color: '#c9a227', tone: '迅疾难测，穿金渡水' },
  life: { name: '活', color: '#c76b7a', tone: '生灵之气，破土而出' },
  lore: { name: '知', color: '#7a6fa3', tone: '书卷时序，专解虚妄' },
  guard: { name: '护', color: '#5f8c86', tone: '包容庇护，反制锋芒' },
  unknown: { name: '?', color: '#9a9a9a', tone: '来历不明，连守阁灵也认不出' },
};

/**
 * 克制表：攻击方属性 → 它压制哪些属性。
 * 用稀疏表而不是 9×9 矩阵，是因为大部分组合该是"无克制"，
 * 写全矩阵反而容易手滑填出互相克制。
 */

const COUNTERS = {
  water: ['fire', 'earth'],
  // 火除了烧草木、熔金石，也烧书——最后一层那个"没有形状的东西"怕的就是这个
  fire: ['wood', 'metal', 'lore'],
  wood: ['earth', 'water'],
  earth: ['water', 'volt'],
  metal: ['wood', 'life'],
  volt: ['water', 'metal'],
  life: ['earth', 'guard'],
  lore: ['volt', 'life'],
  guard: ['metal', 'fire'],
};

/** COCO 80 类 → 属性。查不到就归 unknown，让守阁灵自己圆。 */

const LABEL_ELEMENT = {
  // 生灵
  person: 'life', bird: 'life', cat: 'life', dog: 'life', horse: 'life',
  sheep: 'life', cow: 'life', elephant: 'life', bear: 'life', zebra: 'life', giraffe: 'life',

  // 草木与吃食 → 木
  'potted plant': 'wood', banana: 'wood', apple: 'wood', orange: 'wood',
  broccoli: 'wood', carrot: 'wood', sandwich: 'wood', pizza: 'wood',
  donut: 'wood', cake: 'wood', 'hot dog': 'wood', frisbee: 'wood',
  kite: 'wood', skateboard: 'wood', surfboard: 'wood', skis: 'wood',
  snowboard: 'wood', 'baseball bat': 'wood', 'tennis racket': 'wood',
  'sports ball': 'wood', 'teddy bear': 'wood',

  // 炉火 → 火
  oven: 'fire', toaster: 'fire', microwave: 'fire',

  // 家具重物 → 土
  chair: 'earth', couch: 'earth', bed: 'earth', 'dining table': 'earth',
  toilet: 'earth', refrigerator: 'earth', bench: 'earth', suitcase: 'earth',

  // 利器与车马 → 金
  knife: 'metal', fork: 'metal', spoon: 'metal', scissors: 'metal',
  bicycle: 'metal', car: 'metal', motorcycle: 'metal', airplane: 'metal',
  bus: 'metal', train: 'metal', truck: 'metal', boat: 'metal',

  // 容器流水 → 水
  bottle: 'water', 'wine glass': 'water', cup: 'water', bowl: 'water',
  sink: 'water', vase: 'water', 'fire hydrant': 'water',

  // 电子器械 → 电
  tv: 'volt', laptop: 'volt', mouse: 'volt', remote: 'volt', keyboard: 'volt',
  'cell phone': 'volt', 'hair drier': 'volt', 'traffic light': 'volt',
  'parking meter': 'volt',

  // 书卷时序 → 知
  book: 'lore', clock: 'lore', 'stop sign': 'lore',

  // 容具 → 护
  backpack: 'guard', umbrella: 'guard', handbag: 'guard', tie: 'guard',
  'baseball glove': 'guard',
};

/** ultralytics 的类别名带空格，别的来源可能带下划线，两种都要能命中 */

function elementOf(label) {
  const raw = String(label || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (LABEL_ELEMENT[raw]) return LABEL_ELEMENT[raw];
  const spaced = raw.replace(/_/g, ' ');
  if (LABEL_ELEMENT[spaced]) return LABEL_ELEMENT[spaced];
  const joined = raw.replace(/\s+/g, '');
  for (const k of Object.keys(LABEL_ELEMENT)) {
    if (k.replace(/\s+/g, '') === joined) return LABEL_ELEMENT[k];
  }
  return 'unknown';
}

// ------------------------------------------------------------------ 守阁灵

module.exports = {
  ELEMENTS,
  COUNTERS,
  LABEL_ELEMENT,
  elementOf,
};

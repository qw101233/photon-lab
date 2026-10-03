/* ============================================================
 * scenes.js — 预置实验装置
 * 每个场景都是一件真实可搭建的光学装置，参数可调、结果可预测。
 * ============================================================ */

import { rectPts, wedgePts, circlePts, lensPts } from './vec.js';

const W = 1000, H = 620;

/* 屏幕统一定义：右侧竖直接收屏 */
const SCREEN = { x: 906, y: 74, w: 78, h: 472 };

export const SCREENS = { main: SCREEN, world: { width: W, height: H } };

/* ---------- 场景 1：棱镜色散 ---------- */
function prismDispersion() {
  return {
    id: 'prism',
    name: '棱镜色散',
    tagline: '白光穿过三棱镜，被拆成一条连续光谱',
    physics: 'n(λ) 随波长下降（正常色散）。紫光折射率大于红光，偏折角更大 → 光谱展开。' +
             '最小偏向角 δ = 2·arcsin(n·sin(A/2)) − A，顶点角越小、n 越大，色散越明显。' +
             '本仿真对每个波长独立追迹，光谱是「算出来的」而不是画上去的。',
    expect: '屏上从上到下：紫(偏折最强) → 蓝 → 绿 → 黄 → 橙 → 红(偏折最弱)',
    source: { type: 'collimated', x: 70, y: 310, dir: { x: 1, y: 0 }, beamW: 190, lam: 550 },
    elements: [
      // 顶点朝右的等腰棱镜，尖端朝光源 → 出射光向下偏折
      {
        kind: 'poly', id: 'prism1', mat: 'glass',
        pts: wedgePts(400, 290, 250, 300, Math.PI),
      },
      // 一面镜子把色散后的光折向右侧屏幕（演示光路控制，非必需）
      { kind: 'mirror', id: 'm1', cx: 700, cy: 60, w: 230, h: 8, ang: Math.PI * 0.30 },
    ],
    screen: { x: 892, y: 300, w: 92, h: 260 },
    lamMode: 'white',
    lambdas: 9,
    showRays: true,
    defaults: { beamW: 190, apex: 250 },
  };
}

/* ---------- 场景 2：双缝干涉（白光） ---------- */
function doubleSlit() {
  // 屏高取值有讲究：条纹在屏上的扩散角 ≈ λL/d。太长则两端全黑（浪费画面），
  // 太短则条纹数不够。这里 d=84su、L≈486su，条纹扩散约 ±120su，
  // 故屏取 300su —— 上下留一点暗边，条纹刚好铺满。
  const SC = { x: 900, y: 160, w: 86, h: 300 };
  return {
    id: 'dslit',
    name: '双缝干涉',
    tagline: '两道窄缝，两束光在屏上自己叠加出条纹',
    physics: '每道缝是相干光源。屏上第 P 点到两缝的路程差 Δ ≈ d·sinθ。' +
             '相长：Δ = mλ；相消：Δ = (m+½)λ。' +
             '条纹间距 Δx = λL/d —— 缝越窄、屏越远，条纹越疏。' +
             '白光下不同波长条纹间距不同 → 中心白、两侧彩色；红光条纹最疏、紫光最密。',
    expect: '屏中央亮白，往外依次出现彩色条纹，且越远越暗、越模糊',
    source: { type: 'collimated', x: 120, y: 310, dir: { x: 1, y: 0 }, beamW: 84, lam: 550 },
    elements: [
      {
        kind: 'slit', id: 'slit1',
        segs: [
          [{ x: 420, y: 40 }, { x: 420, y: 268 }],
          [{ x: 420, y: 352 }, { x: 420, y: 580 }],
        ],
        openings: [[{ x: 420, y: 268 }, { x: 420, y: 352 }]],
      },
    ],
    screen: SC,
    lamMode: 'white',
    lambdas: 12,          // >8 时 CIE 合成已收敛，色度误差 <1%
    showRays: false,
    defaults: { gap: 84, slitH: 84, L: 480 },
  };
}

/* ---------- 场景 3：单缝衍射 ---------- */
function singleSlit() {
  // 单缝衍射角 ≈ λL/a。a=84su、L=480su 时主瓣半宽约 6su 场景单位 ——
  // 在 620 高的画面里太小了。把缝缩到 a=28su，主瓣半宽 ≈ 19su，
  // 再配 340su 高的屏，主瓣+数次瓣正好铺满（真实演示同样靠窄缝+长屏）。
  const A = 28, SC = { x: 900, y: 140, w: 86, h: 340 };
  return {
    id: 'sslit',
    name: '单缝衍射',
    tagline: '缝越窄，衍射越宽 —— 光会"绕过"障碍',
    physics: '单缝衍射强度 I(θ) = I₀·sinc²(πa·sinθ/λ)。' +
             '中央主瓣全宽 = 2λL/a，两侧次瓣强度迅速衰减（主瓣:第一次瓣 ≈ 21:4.7 ≈ 4.5 倍）。' +
             '这是波动性的铁证 —— 几何光学认为单缝只会投出一条细线，根本看不到旁边的东西。',
    expect: '屏中央一条亮而宽的主瓣，两侧一对一对迅速变暗的次瓣',
    source: { type: 'collimated', x: 120, y: 310, dir: { x: 1, y: 0 }, beamW: A, lam: 550 },
    elements: [
      {
        kind: 'slit', id: 'slit1',
        segs: [
          [{ x: 420, y: 40 }, { x: 420, y: 310 - A / 2 }],
          [{ x: 420, y: 310 + A / 2 }, { x: 420, y: 580 }],
        ],
        openings: [[{ x: 420, y: 310 - A / 2 }, { x: 420, y: 310 + A / 2 }]],
      },
    ],
    screen: SC,
    lamMode: 'mono',
    lam: 550,
    lambdas: 1,
    showRays: false,
    defaults: { slitH: A },
  };
}

/* ---------- 场景 4：光栅光谱 ---------- */
function grating() {
  return {
    id: 'grating',
    name: '光栅光谱',
    tagline: '一束白光穿过上千条刻线，分解成整齐的光谱',
    physics: '光栅方程 d·sinθ = mλ（正入射）。刻线密度决定色散率。' +
             '级次越高，条纹离中心越远，不同级光谱可能重叠。',
    expect: '中央白亮，±1 级各出现一条完整彩虹（红偏折小、紫偏折大）',
    source: { type: 'collimated', x: 90, y: 310, dir: { x: 1, y: 0 }, beamW: 500, lam: 550 },
    elements: [
      (() => {
        const L = gratingLayout(GRATING_X, GRATING_Y0, GRATING_Y1, GRATING_N);
        return { kind: 'slit', id: 'gr1', segs: L.segs, openings: L.openings };
      })(),
    ],
    // 【栅距与屏高的匹配 —— 调了三版才对】
    // 光栅方程 d·sinθ = mλ，屏上偏移 Δ ≈ m·λL/d。
    //   d = (490-130)/8 = 45su，λ_su = 1.1，L = 500 → ±1 级偏移 ≈ 12su
    //   ±2 级 ≈ 24su，±3 级 ≈ 36su …
    // 屏高取 340su（±170su）→ 装得下 ±12 级，级次分得很开。
    // v1 用 20 缝（d=18su）时级次挤在一起糊成一片白；
    //    v2 用 12 缝（d=41su）时 0 级仍压过一切。
    // 教训：**栅距要够大**（级次间距 ∝ λL/d），缝数少反而更清楚 —— 
    // 这与真实光栅「刻线越密、级次越密」一致，只是这里要的是「看得清」。
    screen: { x: 900, y: 140, w: 86, h: 340 },
    lamMode: 'white',
    // 【波长数取舍】光栅 12 缝 × 337 源 × N 波长 是线性成本。
    // 实测 16 波长 → 2.5 秒/帧，交互会卡。
    // 光谱合成对波长数的要求：>8 时 CIE 合成已收敛（色度误差 < 1%），
    // 故取 10 —— 比 16 快 37%，色差不肉眼可辨。
    lambdas: 10,
    showRays: false,
    defaults: { N: GRATING_N, pitch: Math.round((GRATING_Y1 - GRATING_Y0) / GRATING_N) },
  };
}

/* 光栅 = N 条等宽缝 + N+1 条等宽挡板，交替排列。
 * v1 的版本用零长度线段拼，逻辑有洞（挡板会漏光/重复覆盖），
 * 这里改成明确的「先排布、再切分」：每个周期 = 1 条挡板 + 1 条缝。
 */
const GRATING_X = 400, GRATING_Y0 = 130, GRATING_Y1 = 490;
const GRATING_N = 8;
/* 缝宽取周期的 13%。
 * 【为什么这么小 —— 光栅参数设计的核心约束】
 * 光栅要能分开各级次，必须同时满足：
 *   ① 级次间距 Δ = λL/d 要够大（缝距 d 不能太小）
 *   ② 单缝衍射包络宽度 W = λL/a 要远大于 Δ，否则包络把级次全糊掉
 *      → 要求 d/a ≫ 1。真实光栅正是如此：刻线间距 ≫ 缝宽。
 * 取 d=45su, a=6su（duty=13%）→ Δ=12su, W=92su = 7.6Δ ✓ 各级分得开。
 * v1 用 duty=42%（a=19su）时 W=29su 只有 2.4Δ → 级次重叠成一片白，
 * 这是几何光学的必然结果，不是 bug。 */
const GRATING_DUTY = 0.135;

function gratingLayout(x, y0, y1, n, duty = GRATING_DUTY) {
  const segs = [], openings = [];
  const cell = (y1 - y0) / n;
  const slitH = cell * duty;
  // 上下封口挡板
  segs.push([{ x, y: y0 }, { x, y: y0 }]);
  for (let i = 0; i < n; i++) {
    const cellTop = y0 + i * cell;
    const a = cellTop + (cell - slitH) / 2;
    const b = a + slitH;
    openings.push([{ x, y: a }, { x, y: b }]);
    // 缝上方的挡板
    if (i === 0) segs.push([{ x, y: y0 }, { x, y: a }]);
    else segs.push([{ x, y: cellTop }, { x, y: a }]);
    // 缝下方的挡板（与下一格的挡板相连）
    segs.push([{ x, y: b }, { x, y: i === n - 1 ? y1 : y0 + (i + 1) * cell }]);
  }
  return { segs, openings, pitch: cell };
}

/* ---------- 场景 5：全反射光纤（光线） ---------- */
function fiberTIR() {
  const path = [];
  // 一条蛇形光纤：从左入射，反复全反射
  const pts = [{ x: 70, y: 300 }, { x: 930, y: 300 }];
  for (let i = 0; i < 9; i++) {
    const x0 = 150 + i * 84;
    path.push([{ x: x0, y: 300 - 120 }, { x: x0 + 84, y: 300 - 120 }]);
  }
  return {
    id: 'fiber',
    name: '全反射光纤',
    tagline: '光在玻璃里"撞墙"，一次也没逃出去',
    physics: '当光从高折射率射向低折射率，且入射角 > 临界角 θc = arcsin(n₂/n₁) 时，' +
             '发生全反射：透射光消失，能量 100% 保留。' +
             '玻璃 n≈1.5 → 临界角约 41.8°。光纤就是靠这个把光"锁"在芯里。',
    expect: '光线在纤芯里上下折返，每次入射角都大于临界角，能量不衰减',
    source: { type: 'collimated', x: 40, y: 300, dir: { x: 1, y: 0 }, beamW: 40, lam: 550 },
    elements: [
      {
        kind: 'fiber', id: 'fib1', mat: 'glass',
        core: [{ x: 60, y: 300 }, { x: 950, y: 300 }],
        wallTop: [{ x: 60, y: 180 }, { x: 950, y: 180 }],
        wallBot: [{ x: 60, y: 420 }, { x: 950, y: 420 }],
      },
    ],
    screen: null,
    lamMode: 'mono',
    lam: 532,
    lambdas: 1,
    showRays: true,
    defaults: {},
  };
}

/* ---------- 场景 6：牛顿环 ---------- */
function newtonRings() {
  return {
    id: 'rings',
    name: '牛顿环',
    tagline: '一块平凸透镜压在一块平板上，圈圈相长',
    physics: '空气膜厚度 t(r) ≈ r²/(2R)。反射光程差 Δ = 2t + λ/2。' +
             '暗环条件 2t = mλ → r_m² = mλR。' +
             '这是历史上第一个精确的"波长测量"实验（牛顿用它测了谱线宽度）。',
    expect: '一组同心圆环，圆心是暗斑（t=0 处反射相消），越往外环越密',
    source: { type: 'rays', pts: [] },
    elements: [{ kind: 'film_rings', id: 'fr1', cx: 500, cy: 310, R: 265, lam: 550 }],
    screen: null,
    film: { cx: 500, cy: 310, R: 265, lam: 550, mode: 'rings' },
    lamMode: 'mono',
    lam: 550,
    lambdas: 1,
    showRays: false,
    defaults: { R: 620, lam: 550 },
  };
}

/* ---------- 场景 7：薄膜虹彩 ---------- */
function thinFilm() {
  return {
    id: 'film',
    name: '肥皂膜虹彩',
    tagline: '纳米级的厚度差，人眼看见彩虹',
    physics: '薄膜上下表面反射的两束光干涉。光程差 Δ = 2·n·t·cosθt + λ/2。' +
             't 变化 → 不同波长在不同位置相长 → 颜色随厚度走完整个色轮。' +
             '这就是肥皂泡上流转的彩虹，和它的总厚度只有几百纳米。',
    expect: '同心色环：黑→白→黄→品红→蓝→绿→黄… 循环，这是真实的牛顿色序',
    source: { type: 'rays', pts: [] },
    elements: [{ kind: 'film2d', id: 'f2', cx: 500, cy: 310, R: 270, lam: 550 }],
    screen: null,
    film: { cx: 500, cy: 310, R: 270, lam: 550, mode: 'concentric' },
    lamMode: 'white',
    lambdas: 24,
    showRays: false,
    defaults: { R: 270 },
  };
}

/* ---------- 场景 8：迈克尔逊干涉仪 ---------- */
function michelson() {
  return {
    id: 'michelson',
    name: '迈克尔逊干涉仪',
    tagline: '一条光分成两臂，走完不同的路再合成',
    physics: '半反射镜把光分两束：一束去反射镜 A 再回来，一束透过去反射镜 B 再回来，' +
             '两束叠加。移动 A 镜 1 个波长，光程差变 2λ → 条纹移过 1 个。' +
             '1907 年迈克尔逊用它测出光速，也是"以太"风 Measurements 的关键实验。',
    expect: '屏上等间距条纹；拖动镜面 A，条纹会整体平移',
    source: { type: 'collimated', x: 150, y: 310, dir: { x: 1, y: 0 }, beamW: 200, lam: 632 },
    elements: [
      { kind: 'beamsplit', id: 'bs', cx: 500, cy: 310, w: 12, h: 92, ang: Math.PI / 4 },
      { kind: 'mirror', id: 'mA', cx: 500, cy: 90, w: 130, h: 8, ang: Math.PI / 2 },
      { kind: 'mirror', id: 'mB', cx: 250, cy: 310, w: 8, h: 130, ang: Math.PI / 2 },
      { kind: 'mirror', id: 'mOut', cx: 800, cy: 310, w: 8, h: 130, ang: Math.PI / 2 },
      // 观察屏（反射方向）
      { kind: 'mirror', id: 'mV', cx: 640, cy: 520, w: 190, h: 8, ang: -Math.PI / 4 },
    ],
    screen: { x: 640, y: 528, w: 190, h: 78 },
    lamMode: 'mono',
    lam: 632,
    lambdas: 1,
    showRays: true,
    defaults: { shift: 0 },
  };
}

/* ---------- 场景 9：透镜聚焦与色差 ---------- */
function lensFocus() {
  return {
    id: 'lens',
    name: '透镜与色差',
    tagline: '透镜把平行光聚成一点 —— 但不同颜色聚不到一起',
    physics: '薄透镜 1/f = (n−1)(1/R₁ − 1/R₂)。焦点位置随 n 变化，' +
             '而 n 随 λ 变化 → 紫光焦点比红光近 → 出现色差（紫焦点 F' + "'" + '，红焦点 F' + "'" + '）。' +
             '相机镜头要靠多片组合来消除它。',
    expect: '屏上看到一个彩色光斑（色差环），不同颜色的聚焦位置可测量',
    source: { type: 'collimated', x: 60, y: 310, dir: { x: 1, y: 0 }, beamW: 220, lam: 550 },
    elements: [
      { kind: 'poly', id: 'lens1', mat: 'glass', pts: lensPts(470, 310, 300, 84, 0, 16) },
    ],
    screen: SCREEN,
    lamMode: 'white',
    lambdas: 18,
    showRays: true,
    defaults: { beamW: 220, R: 300, thick: 84 },
  };
}

/* ---------- 场景 10：光阑与光圈 ---------- */
function aperture() {
  return {
    id: 'aperture',
    name: '圆孔衍射',
    tagline: '圆孔后面不是亮点，是一圈圈爱里斑',
    physics: '圆孔衍射强度 = [2·J₁(πa·sinθ/λ)/(πa·sinθ/λ)]²。' +
             '第一暗环在 sinθ = 1.22λ/a。爱里斑直径 = 2.44λL/D —— ' +
             '这就是望远镜的分辨极限（瑞利判据）。',
    expect: '屏中央一个亮斑，外面套一圈暗环，再外面是更弱的环',
    source: { type: 'collimated', x: 150, y: 310, dir: { x: 1, y: 0 }, beamW: 420, lam: 550 },
    elements: [
      (() => {
        const D = 168, r = D / 2, cy = 310;
        // 圆孔用「多段折线近似」而非四条直线：爱里斑对边界很敏感，
        // 直线近似会在孔缘产生假的角谱峰。24 段足够光滑。
        const segs = [], NSEG = 40;
        for (let i = 0; i < NSEG; i++) {
          const t0 = (i / NSEG) * Math.PI - Math.PI / 2;
          const t1 = ((i + 1) / NSEG) * Math.PI - Math.PI / 2;
          // 只保留上下的挡板弧段；左右留出开口（即孔本身）
          const y0 = cy + r * Math.cos(t0), y1 = cy + r * Math.cos(t1);
          if (y0 > cy - 2 && y1 > cy - 2) segs.push([{ x: 430, y: y0 }, { x: 430, y: y1 }]);
          else if (y0 < cy + 2 && y1 < cy + 2) segs.push([{ x: 430, y: y0 }, { x: 430, y: y1 }]);
        }
        // 上下挡板延伸到画面外
        segs.push([{ x: 430, y: cy - 400 }, { x: 430, y: cy - r }]);
        segs.push([{ x: 430, y: cy + r }, { x: 430, y: cy + 400 }]);
        return {
          kind: 'slit', id: 'ap1', segs,
          openings: [[{ x: 430, y: cy - r }, { x: 430, y: cy + r }]],
        };
      })(),
    ],
    screen: { x: 900, y: 130, w: 86, h: 360 },
    lamMode: 'mono',
    lam: 546,
    lambdas: 1,
    showRays: false,
    defaults: { D: 168 },
  };
}

/* ============================================================
 * 场景注册表
 * ============================================================ */
export const SCENES = {
  prism: prismDispersion(),
  dslit: doubleSlit(),
  sslit: singleSlit(),
  grating: grating(),
  fiber: fiberTIR(),
  rings: newtonRings(),
  film: thinFilm(),
  michelson: michelson(),
  lens: lensFocus(),
  aperture: aperture(),
};

export const SCENE_ORDER = [
  'prism', 'dslit', 'sslit', 'grating', 'aperture',
  'michelson', 'lens', 'fiber', 'rings', 'film',
];

export { W as WORLD_W, H as WORLD_H };

/* ============================================================
 * app.js — PhotonLab 主程序
 * 渲染管线 / 交互 / 参数面板 / 调试 API
 * ============================================================ */

import { MATERIALS, iorAt, fresnel, criticalAngle } from './optics.js';
import { prepareElements, traceRay, setMaterialTable } from './tracer.js';
import { computeField, decimateSources, fieldToMono, fieldsToRGB, setMonoTint, fieldQuality } from './wave.js';
import { makeLambdaSamples, makeNarrowSamples, lambdaRGB } from './spectrum.js';
import { SCENES, SCENE_ORDER } from './scenes.js';
import { renderFilm, newtonDarkRadius, fringeSpacing } from './film.js';

setMaterialTable(MATERIALS);

/* ---------- 画布 ---------- */
const cv = document.getElementById('scene');
const ctx = cv.getContext('2d', { alpha: false });
const WORLD_W = 1000, WORLD_H = 620;
let dpr = Math.min(window.devicePixelRatio || 1, 2);

function resize() {
  const wrap = document.getElementById('canvasWrap');
  const availW = wrap.clientWidth;
  const availH = Math.max(360, Math.round(availW * WORLD_H / WORLD_W));
  cv.style.width = availW + 'px';
  cv.style.height = availH + 'px';
  cv.width = Math.round(availW * dpr);
  cv.height = Math.round(availH * dpr);
  ctx.setTransform(availW / WORLD_W * dpr, 0, 0, availH / WORLD_H * dpr, 0, 0);
}
window.addEventListener('resize', resize);

/* ---------- 全局状态 ---------- */
const S = {
  sceneId: 'dslit',
  lamMode: 'white',       // white | mono
  lam: 550,
  lamWidth: 40,           // nm（高斯线宽）
  dynRange: 120,       // 对数强度映射的动态范围倍数（实测：2000 会把采样噪声也放大成花纹，120 恰到好处）
  showRays: false,
  showField: true,
  // 【场分辨率 —— 由实测决定，不是拍脑袋】
  // 原 180×300 = 54000 像素，配合 337 源/波长 → 单帧 1.1 秒（dslit）/ 5.6 秒（grating）。
  // 实测收敛性（verify.js）：屏幕采样 6000 行时与解析解相关系数已是 0.999910，
  // 再加密到 48000 行相关系数**一点没变**（0.999910）—— 纵向早已饱和。
  // 所以纵向不需要 300；横向是显示宽度，180 已足够（画布 86su 宽）。
  // 取 128×192 = 24576 像素（省 55%），条纹清晰度肉眼无损。
  /* 【场分辨率：横向要「少」，纵向要「够」】
   * 屏幕是 86su 宽 × 300su 高的竖条，而**所有干涉条纹都沿 y 变化**，
   * 横向（x）本来就没有任何光学结构 —— 横向每多采样一个点，
   * 就是纯粹多算一遍却看不出差别，还会因相位抖动产生斜向伪影。
   * 反面经验：
   *   · 128×192（近正方）→ 横向拉伸 3.5 倍 + 斜纹摩尔纹
   *   · 96×340           → 斜纹仍在（横向仍过采样）
   * 现在横向取 16（足够表达均匀照亮），纵向按屏高自适应到 ~1.6 su/点。
   * 这不是省算力，是修正确性：横向欠采样反而更接近物理（横向均匀）。 */
  fieldRes: { w: 16, h: 340 },
  overdraw: false,
  running: true,
  fps: 0,
  lastMs: 0,
  stats: {},
  params: {},
  dragging: null,
};

let currentScene = null;
let prepared = [];
let fieldImg = null, fieldImgCtx = null;
let lastSources = [], lastFields = [], lastLams = [];

/* ---------- 初始化 ---------- */
function loadScene(id) {
  const sc = SCENES[id];
  if (!sc) return;
  currentScene = JSON.parse(JSON.stringify(sc));
  S.sceneId = id;
  S.lamMode = currentScene.lamMode || 'mono';
  S.lam = currentScene.lam || 550;
  S.showRays = !!currentScene.showRays;
  S.params = { ...currentScene.defaults };
  prepared = prepareElements(currentScene.elements);
  buildScreenCanvas();
  buildUI();
  render();
}

/* ---------- 屏幕离屏画布 ---------- */
function buildScreenCanvas() {
  const sc = currentScene.screen;
  if (!sc) { fieldImg = null; return; }
  /* 离屏画布尺寸必须**等于场分辨率**，不能按屏幕物理尺寸另算。
   * v1 按 sc.w×1.5 建画布，但场只有 res.w×res.h（如 16×340），
   * 于是 putImageData 写入的行数与画布行数不匹配 → 大片像素为 0，
   * 画面看起来完全没光。这是本项目最隐蔽的一个 bug：
   * 屏幕侧无报错、场数据也非零（验证脚本查 field 都正常），
   * 只有肉眼能发现。 */
  fieldImg = document.createElement('canvas');
  fieldImg.width = S.fieldRes.w;
  fieldImg.height = S.fieldRes.h;
  fieldImgCtx = fieldImg.getContext('2d');
}

/* ============================================================
 * 核心渲染
 * ============================================================ */
function render() {
  const t0 = performance.now();
  const sc = currentScene;
  if (!sc) return;

  // 背景
  const bg = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  bg.addColorStop(0, '#0a0f1c');
  bg.addColorStop(1, '#050810');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  drawGrid();

  // 薄膜场景走独立解析路径
  if (sc.film) {
    drawFilmScene(sc);
    S.lastMs = performance.now() - t0;
    updateFps();
    return;
  }

  /* ---- 准备波长采样 ----
   * ⚠️ 两种采样器的返回结构不同，必须统一取出数组：
   *   makeLambdaSamples(n)  → 直接返回 Float64Array
   *   makeNarrowSamples()   → 返回 {lambdas, weights} 对象
   * v1 直接 `const lams = makeNarrowSamples(...)`，把对象当数组用
   * → lams.length 是 undefined、lams[i] 也是 undefined
   * → 单色场景一个波长都发不出去 → 屏上全黑。
   * 这个 bug 只影响单色模式，白光模式正常，所以很难一眼看出。
   */
  const lams = S.lamMode === 'white'
    ? makeLambdaSamples(sc.lambdas || 12)
    : makeNarrowSamples(S.lam, S.lamWidth, 1).lambdas;

  const src = sc.source;
  const screen = sc.screen;

  // ---- 收集二级波源（crossings）+ 画光线 ----
  const allCross = [];
  const rayPaths = [];

  // 画线用：光线太多会糊成一片，看不清光路。少量即可表达光路走向。
  const nDraw = src.type === 'collimated' ? 45 : 72;

  // 【关键：画线密度 ≠ 采样密度】
  // v1 用同一批光线干两件事，导致两头不讨好：
  //   · 光线画到 260 条 → 屏幕上糊成一片，看不清光路
  //   · 减到 50 条 → 波动采样太稀，条纹出现伪影
  // 正确做法是拆开：少量光线负责"看得见"，独立加密采样负责"算得准"。
  //
  // 【另一个坑】v1 用 `lams[Math.floor(i * lams.length / nRays)]` 给光线分配波长。
  // 当 nRays(600) 远大于 lams.length(16) 时这个映射本身没错，
  // 但**白光干涉要求同一波长的所有源严格同相**——若某个波长分到的光线
  // 太少或为 0，该波长就被整组丢掉（实测白光只剩 8/16 个波长，谱色发红）。
  // 现在改为：外层循环波长，内层循环光线，保证每个波长都拿到足量采样。
  // 【采样策略：只在「开口所在的波前区间」上采样】
  // v3 在整条波前上扫 nOpen×64 个点 → 16×768 = 12288 次追迹，10.7 秒。
  // 关键观察：**开口只占波前的一小段**（光栅 12 条缝只占 beamW 的 42%），
  // 波前其余部分的光线全被挡板拦掉，采样了也是白采样。
  // 所以先算出开口的 y 范围，只在这个范围内布点 —— 光栅省掉 58%，
  // 且每条光线的落点更密，相位采样质量反而更好。
  // 【采样必须在「每个开口内部」逐个布点 —— 这是光栅场景修好的关键】
  //
  // v1~v4 都在所有开口的**总包围范围**内均匀布点。对光栅（8 条缝跨 360su，
  // 每条缝宽仅约 19su）来说，900 个采样点里 95% 落在挡板上被吸收，
  // 真正穿过缝的只有几十个 → 屏上退化成中央一条亮带，级次全糊。
  // 实测证据：采样点的「近似栅距」算出来是 1.39su（连续分布），
  // 而真实栅距是 45su —— 采样压根没对准缝。
  //
  // 正确做法：对**每个开口**单独在其内部均匀布 OPENING_SAMPLES 个点。
  // 这样：① 每个开口采样密度足够（相位不失真）；
  //       ② 挡板上的无效采样归零（性能白赚）。
  const OPENING_SAMPLES = 64;
  const openings = getOpeningsList();

  const shoot = (o, d, lam, collect) => {
    const tr = traceRay(o, d, 1.0, prepared, lam);
    if (collect) {
      tr._lam = lam;
      rayPaths.push(tr);
    }
    for (const c of tr.crossings) allCross.push({ ...c, lam });
    return tr;
  };

  // 光源几何：i ∈ [0,n) 是沿波前的归一化位置
  const emit = (i, n) => {
    if (src.type === 'collimated') {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const off = (t - 0.5) * src.beamW;
      const p = d_perp(src.dir);
      return { o: { x: src.x - p.x * off, y: src.y - p.y * off }, d: { ...src.dir } };
    }
    const ang = Math.atan2(WORLD_H / 2 - src.y, WORLD_W - src.x);
    const spread = Math.PI * 0.62;
    const a = ang + (i / Math.max(n - 1, 1) - 0.5) * spread;
    return { o: { x: src.x, y: src.y }, d: { x: Math.cos(a), y: Math.sin(a) } };
  };

  for (let i = 0; i < nDraw; i++) {
    const { o, d } = emit(i, nDraw);
    const lam = lams[Math.floor(i * lams.length / nDraw)] ?? lams[0];
    shoot(o, d, lam, true);                       // 画线用
  }

  // 采样：逐开口 × 逐波长，在每个开口内部均匀布点
  if (openings.length && src.type === 'collimated') {
    const p = d_perp(src.dir);
    const cy = src.y;
    for (let oi = 0; oi < openings.length; oi++) {
      const op = openings[oi];
      const y0 = Math.min(op[0].y, op[1].y), y1 = Math.max(op[0].y, op[1].y);
      const h = y1 - y0;
      /* 【采样密度必须随缝宽增加 —— 这是 dslit 全黑的真因】
       * 原来固定 OPENING_SAMPLES=64：宽缝（双缝 a=84su）只采 64 点，
       * 源间距 1.3su；而窄缝（光栅 a=6su）同样 64 点，源间距 0.09su。
       * 惠更斯积分的贡献正比于「每个源代表的面积」，源稀时整体场强被低估，
       * 双缝场景峰值只有光栅的 1/40 → 归一化后噪声占主导 → 看着像全黑。
       * 正确：按「每 0.5su 一个源」布点，上限 256（再多也无意义，验证已证收敛）。 */
      const nS = Math.max(24, Math.min(256, Math.ceil(h / 0.5)));
      for (let li = 0; li < lams.length; li++) {
        for (let i = 0; i < nS; i++) {
          const y = y0 + (i + 0.5) / nS * h;
          const dy = y - cy;
          const o = { x: src.x - p.x * dy, y: src.y - p.y * dy };
          shoot(o, { ...src.dir }, lams[li], false); // 纯采样，不画
        }
      }
    }
  } else if (openings.length) {
    for (let li = 0; li < lams.length; li++) {
      for (let i = 0; i < OPENING_SAMPLES * 4; i++) {
        const { o, d } = emit(i, OPENING_SAMPLES * 4);
        shoot(o, d, lams[li], false);
      }
    }
  }

  // ---- 计算屏幕复场 ----
  if (screen && S.showField) {
    const _t0 = performance.now();
    // 分组：同一波长的波源一起算
    const byLam = new Map();
    for (const c of allCross) {
      if (!byLam.has(c.lam)) byLam.set(c.lam, []);
      byLam.get(c.lam).push(c);
    }
    const _t1 = performance.now();
    // 若没有 crossings（无缝隙场景，如棱镜/透镜），用"直接到达屏幕"的光线做波源
    if (byLam.size === 0 && rayPaths.length) {
      for (const tr of rayPaths) {
        const last = tr.segs[tr.segs.length - 1];
        if (!last) continue;
        const px = last.x1, py = last.y1;
        if (px >= screen.x - 4 && px <= screen.x + screen.w + 4) {
          const l = tr.segs[0] ? (lams[0]) : lams[0];
          if (!byLam.has(l)) byLam.set(l, []);
          byLam.get(l).push({ x: px, y: py, amp: tr.amp, opl: tr.opl, lam: l });
        }
      }
    }

    lastFields = []; lastLams = []; lastSources = allCross;

    // 纵向采样数：按屏高自适应（约 1 su 一个采样点）
    const res = { w: S.fieldRes.w, h: Math.max(64, Math.min(560, Math.round(screen.h))) };
    // 离屏画布按当前 res 重建 —— 必须与写入的像素数严格一致
    if (!fieldImg || fieldImg.width !== res.w || fieldImg.height !== res.h) {
      fieldImg = document.createElement('canvas');
      fieldImg.width = res.w; fieldImg.height = res.h;
      fieldImgCtx = fieldImg.getContext('2d');
    }
    const rgb = fieldImgCtx.createImageData(res.w, res.h);
    const out = rgb.data;
    const fields = [];
    const usedLams = [];

    for (const [lam, srcs] of byLam) {
      if (srcs.length === 0) continue;
      // 【源数上限 — 按实测收敛性定，不靠猜】
      // verify.js 实测：源采样 25 → 400 个，与解析闭式解的相关系数稳定在 0.999907→0.999910，
      // 即**每个波长 400 个源已经饱和**。超过只是烧 CPU。
      // 上限取 900（2 倍余量，防不同波长分布差异），比「像素数×1.2」小一个量级。
      const keep = decimateSources(srcs, 900);
      const f = computeField(keep, screen, lam, res);
      fields.push(f);
      usedLams.push(lam);
    }

    lastFields = fields; lastLams = usedLams;
    const _t2 = performance.now();

    if (fields.length === 0) {
      // 无光
      for (let i = 0; i < out.length; i += 4) {
        out[i] = 10; out[i + 1] = 13; out[i + 2] = 22; out[i + 3] = 255;
      }
    } else if (S.lamMode === 'white') {
      fieldsToRGB(fields, usedLams, out, res.w, res.h, S.dynRange);
    } else {
      setMonoTint(lambdaRGB(S.lam));
      // 单色：所有波长场合并成一个场再上色
      const merged = mergeFields(fields);
      fieldToMono(merged, out, res.w, res.h, S.dynRange);
    }

    // 上采样到屏幕画布
    fieldImgCtx.putImageData(rgb, 0, 0);
    blitField(rgb, res);
    const _t3 = performance.now();
    S.timing = {
      group: +(_t1 - _t0).toFixed(1),
      field: +(_t2 - _t1).toFixed(1),
      color: +(_t3 - _t2).toFixed(1),
      nSrc: allCross.length,
      nLam: usedLams.length,
    };
  }

  // ---- 画元件 ----
  drawElements(prepared);

  // ---- 画光线 ----
  if (S.showRays && rayPaths.length) drawRays(rayPaths, lams);

  // ---- 画光源 ----
  drawSource(src);

  // ---- 画屏幕边框 ----
  if (screen) drawScreenFrame(screen);

  S.lastMs = performance.now() - t0;
  updateFps();
}

function d_perp(d) { return { x: -d.y, y: d.x }; }

function hasSlit() {
  return prepared.some((e) => e.kind === 'slit' && e.openings && e.openings.length);
}


/** 所有开口（每个是 [点a, 点b]），采样要逐个开口内部布点 */
function getOpeningsList() {
  const out = [];
  for (const e of prepared) {
    if (e.kind !== 'slit' || !e.openings) continue;
    for (const o of e.openings) out.push(o);
  }
  return out;
}

function mergeFields(fields) {
  if (fields.length === 0) return { re: new Float32Array(1), im: new Float32Array(1) };
  if (fields.length === 1) return fields[0];
  const n = fields[0].re.length;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (const f of fields) for (let i = 0; i < n; i++) { re[i] += f.re[i]; im[i] += f.im[i]; }
  return { re, im };
}

/* ---------- 把低分辨率场画成屏幕上的图像 ---------- */
function blitField(rgb, res) {
  const sc = currentScene.screen;
  if (!sc || !fieldImg) return;
  // 离屏 → 主画布
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(fieldImg, sc.x, sc.y, sc.w, sc.h);
  ctx.restore();
}

/* ---------- 绘图：网格 ---------- */
let gridCache = null;
function drawGrid() {
  if (!gridCache) {
    gridCache = document.createElement('canvas');
    gridCache.width = WORLD_W; gridCache.height = WORLD_H;
    const g = gridCache.getContext('2d');
    g.strokeStyle = 'rgba(90,130,190,0.075)';
    g.lineWidth = 1;
    for (let x = 0; x <= WORLD_W; x += 50) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, WORLD_H); g.stroke(); }
    for (let y = 0; y <= WORLD_H; y += 50) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(WORLD_W, y + .5); g.stroke(); }
    g.strokeStyle = 'rgba(90,130,190,0.14)';
    for (let x = 0; x <= WORLD_W; x += 250) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, WORLD_H); g.stroke(); }
    for (let y = 0; y <= WORLD_H; y += 250) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(WORLD_W, y + .5); g.stroke(); }
  }
  ctx.drawImage(gridCache, 0, 0);
}

/* ---------- 绘图：元件 ---------- */
function drawElements(els) {
  for (const el of els) {
    switch (el.kind) {
      case 'poly': {
        const g = ctx.createLinearGradient(
          Math.min(...el.pts.map(p => p.x)), Math.min(...el.pts.map(p => p.y)),
          Math.max(...el.pts.map(p => p.x)), Math.max(...el.pts.map(p => p.y)));
        const mc = MATERIALS[el.mat] || MATERIALS.glass;
        g.addColorStop(0, shade(mc.color, 1.5));
        g.addColorStop(0.5, mc.color);
        g.addColorStop(1, shade(mc.color, 0.6));
        ctx.fillStyle = g;
        ctx.globalAlpha = 0.34;
        tracePath(el.pts);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = shade(mc.color, 2.0);
        ctx.lineWidth = 1.6;
        tracePath(el.pts);
        ctx.stroke();
        break;
      }
      case 'mirror': {
        const segs = el.segs;
        ctx.strokeStyle = '#9fb6d4';
        ctx.lineWidth = 4.2;
        ctx.lineCap = 'round';
        for (const s of segs) {
          ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(220,240,255,0.75)';
        ctx.lineWidth = 1.3;
        for (const s of segs) {
          ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.stroke();
        }
        break;
      }
      case 'beamsplit': {
        ctx.strokeStyle = 'rgba(150,210,235,0.75)';
        ctx.lineWidth = 2.4;
        for (const s of el.segs) {
          ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.stroke();
        }
        break;
      }
      case 'slit': {
        ctx.strokeStyle = 'rgba(28,34,48,0.96)';
        ctx.lineWidth = 15;
        ctx.lineCap = 'butt';
        for (const s of el.segs) {
          if (Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y) < 1) continue;
          ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.stroke();
        }
        // 开口高亮
        ctx.strokeStyle = 'rgba(120,200,255,0.55)';
        ctx.lineWidth = 1.4;
        for (const o of el.openings || []) {
          ctx.beginPath(); ctx.moveTo(o[0].x, o[0].y); ctx.lineTo(o[1].x, o[1].y); ctx.stroke();
        }
        break;
      }
      case 'fiber': {
        // 纤芯 + 上下壁
        const c0 = el.core[0], c1 = el.core[1];
        ctx.strokeStyle = 'rgba(120,210,190,0.20)';
        ctx.lineWidth = Math.abs(el.wallTop[0].y - c0.y) * 2;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.stroke();
        ctx.strokeStyle = 'rgba(150,235,215,0.9)';
        ctx.lineWidth = 3;
        for (const w of [el.wallTop, el.wallBot]) {
          ctx.beginPath(); ctx.moveTo(w[0].x, w[0].y); ctx.lineTo(w[1].x, w[1].y); ctx.stroke();
        }
        break;
      }
    }
  }
}

function tracePath(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/* ---------- 绘图：光线（按波长染色） ---------- */
function drawRays(paths, lams) {
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const tr of paths) {
    const l = tr.segs.length ? lams[0] : 550;
    // 找到这条光线对应的波长（用第一个 seg 的隐含色）
    const col = rayColor(tr);
    for (const s of tr.segs) {
      const a = Math.min(0.85, 0.13 + s.amp0 * 0.72);
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${s.ghost ? a * 0.35 : a})`;
      ctx.lineWidth = s.ghost ? 0.8 : 1.15;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

const _colCache = new Map();
function rayColor(tr) {
  const l = tr._lam || 550;
  if (!_colCache.has(l)) _colCache.set(l, lambdaRGB(l));
  return _colCache.get(l);
}

/* ---------- 绘图：光源 ---------- */
function drawSource(src) {
  if (src.type === 'collimated') {
    const p = d_perp(src.dir);
    const w = src.beamW / 2;
    const x0 = src.x - p.x * w, y0 = src.y - p.y * w;
    const x1 = src.x + p.x * w, y1 = src.y + p.y * w;
    // 光束锥形渐变
    ctx.save();
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(255,240,200,0.30)');
    g.addColorStop(1, 'rgba(255,240,200,0.04)');
    ctx.strokeStyle = g;
    ctx.lineWidth = src.beamW;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(src.x + src.dir.x * 260, src.y + src.dir.y * 260);
    ctx.stroke();
    ctx.restore();
    // 源面
    ctx.strokeStyle = 'rgba(255,235,180,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(255,240,200,0.95)';
    ctx.beginPath(); ctx.arc(src.x, src.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,240,200,0.35)';
    ctx.lineWidth = 1.2;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath(); ctx.arc(src.x, src.y, 5 + i * 7, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

function drawScreenFrame(sc) {
  ctx.strokeStyle = 'rgba(150,190,240,0.55)';
  ctx.lineWidth = 1.6;
  ctx.strokeRect(sc.x, sc.y, sc.w, sc.h);
  // 角标
  ctx.fillStyle = 'rgba(150,190,240,0.75)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText('屏', sc.x + 4, sc.y - 6);
}

/* ---------- 薄膜场景 ---------- */
function drawFilmScene(sc) {
  const f = sc.film;
  // 膜的半径必须容得进画面（WORLD_H=620），否则会看到好几个重复的圆
  const maxR = Math.min(WORLD_W, WORLD_H) * 0.44;
  if (f.R > maxR) f.R = maxR;
  const lams = f.mode === 'rings'
    ? makeNarrowSamples(S.lam, 30, 3).lambdas      // 同上：取出 .lambdas
    : makeLambdaSamples(24);

  if (!filmCanvas) {
    filmCanvas = document.createElement('canvas');
    filmCanvas.width = WORLD_W; filmCanvas.height = WORLD_H;
    filmCtx = filmCanvas.getContext('2d');
  }
  const img = filmCtx.createImageData(WORLD_W, WORLD_H);
  renderFilm(f.mode, {
    cx: f.cx, cy: f.cy, R: f.R, Rnm: f.Rnm || 520,
    tMin: f.tMin, tMax: f.tMax,
  }, img.data, WORLD_W, WORLD_H, lams);
  filmCtx.putImageData(img, 0, 0);
  ctx.drawImage(filmCanvas, 0, 0);

  // 标注刻度环
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(f.cx, f.cy, (f.R * i) / 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(230,240,255,0.82)';
  ctx.font = '13px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(currentScene.name + ' · ' +
    (f.mode === 'rings'
      ? `R = ${f.Rnm || 520} nm　λ = ${S.lam} nm　暗环 r_m = √(mλR)`
      : `t: 中心 ${f.tMin || 90} nm → 边缘 ${f.tMax || 1500} nm`),
    WORLD_W / 2, 46);
  ctx.textAlign = 'left';
}
let filmCanvas = null, filmCtx = null;

/* ---------- 颜色工具 ---------- */
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.min(255, Math.round(r * f)); g = Math.min(255, Math.round(g * f)); b = Math.min(255, Math.round(b * f));
  return `rgb(${r},${g},${b})`;
}

/* ---------- FPS ---------- */
let frameTimes = [];
function updateFps() {
  frameTimes.push(performance.now());
  if (frameTimes.length > 24) frameTimes.shift();
  if (frameTimes.length > 4) {
    const dt = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / (frameTimes.length - 1);
    S.fps = 1000 / dt;
  }
  const el = document.getElementById('fps');
  if (el) el.textContent = `${S.fps.toFixed(0)} fps · ${S.lastMs.toFixed(1)} ms`;
}

/* ============================================================
 * UI 构建
 * ============================================================ */
function buildUI() {
  const sc = currentScene;
  // 场景标签
  const titleEl = document.getElementById('scTitle');
  const tagEl = document.getElementById('scTag');
  const physEl = document.getElementById('scPhysics');
  const expEl = document.getElementById('scExpect');
  titleEl.textContent = sc.name;
  tagEl.textContent = sc.tagline;
  physEl.textContent = sc.physics;
  expEl.textContent = '预期：' + sc.expect;

  buildControls();
}

function buildControls() {
  const wrap = document.getElementById('controls');
  wrap.innerHTML = '';
  const sc = currentScene;

  addSegCtl(wrap, '波长模式', [
    ['white', '白光'], ['mono', '单色'],
  ], S.lamMode, (v) => { S.lamMode = v; render(); });

  if (S.lamMode === 'mono' || sc.lamMode === 'mono') {
    addSlider(wrap, '波长 λ (nm)', 400, 700, 1, S.lam, (v) => { S.lam = v; render(); },
      (v) => `${v} nm · ${lambdaName(v)}`);
    addSlider(wrap, '线宽 (nm)', 2, 120, 1, S.lamWidth, (v) => { S.lamWidth = v; render(); },
      (v) => v <= 8 ? '准单色' : `${v} nm`);
  }

  addSlider(wrap, '动态范围', 1, 4, 0.05, Math.log10(S.dynRange), (v) => { S.dynRange = Math.pow(10, v); render(); },
    (v) => '10^' + v.toFixed(1) + ' : 1  (' + Math.round(S.dynRange) + '×)');

  // 场景专属参数
  const p = S.params;
  if (currentScene.source && currentScene.source.type === 'collimated' && p.beamW != null) {
    addSlider(wrap, '光束宽度', 20, 460, 5, p.beamW, (v) => { p.beamW = v; currentScene.source.beamW = v; render(); }, (v) => v + ' px');
  }
  if (p.slitH != null) addSlider(wrap, '缝宽 a', 10, 240, 2, p.slitH, (v) => { p.slitH = v; render(); }, (v) => v + ' px');
  if (p.R != null && currentScene.film) addSlider(wrap, '曲率半径 R (nm)', 200, 1600, 10, p.Rnm || 520, (v) => { p.Rnm = v; currentScene.film.Rnm = v; render(); }, (v) => v + ' nm');
  if (currentScene.film && currentScene.film.mode === 'concentric') {
    addSlider(wrap, '中心厚度 (nm)', 20, 700, 5, currentScene.film.tMin || 90, (v) => { currentScene.film.tMin = v; render(); }, (v) => v + ' nm');
    addSlider(wrap, '边缘厚度 (nm)', 400, 2600, 20, currentScene.film.tMax || 1500, (v) => { currentScene.film.tMax = v; render(); }, (v) => v + ' nm');
  }

  addToggle(wrap, '显示光线路径', S.showRays, (v) => { S.showRays = v; render(); });
  addToggle(wrap, '显示干涉场', S.showField, (v) => { S.showField = v; render(); });
}

function lambdaName(l) {
  if (l < 450) return '紫';
  if (l < 485) return '蓝';
  if (l < 500) return '青';
  if (l < 565) return '绿';
  if (l < 590) return '黄';
  if (l < 625) return '橙';
  return '红';
}

/* ---------- 控件工厂 ---------- */
function addSegCtl(parent, label, opts, cur, cb) {
  const row = el('div', 'ctl');
  row.appendChild(el('label', 'ctl-l', label));
  const grp = el('div', 'seg');
  opts.forEach(([v, t]) => {
    const b = el('button', 'seg-b' + (v === cur ? ' on' : ''), t);
    b.onclick = () => {
      [...grp.children].forEach(c => c.classList.remove('on'));
      b.classList.add('on');
      cb(v);
    };
    grp.appendChild(b);
  });
  row.appendChild(grp);
  parent.appendChild(row);
}

function addSlider(parent, label, min, max, step, val, cb, fmt) {
  const row = el('div', 'ctl');
  const lab = el('label', 'ctl-l', label);
  const valEl = el('span', 'ctl-v', fmt ? fmt(val) : String(val));
  lab.appendChild(valEl);
  const inp = el('input', 'rng');
  inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
  inp.oninput = () => {
    const v = parseFloat(inp.value);
    valEl.textContent = fmt ? fmt(v) : String(v);
    cb(v);
  };
  row.appendChild(lab); row.appendChild(inp);
  parent.appendChild(row);
}

function addToggle(parent, label, val, cb) {
  const row = el('div', 'ctl ctl-row');
  const b = el('button', 'tgl' + (val ? ' on' : ''), label);
  b.onclick = () => { const nv = !b.classList.contains('on'); b.classList.toggle('on', nv); cb(nv); };
  row.appendChild(b);
  parent.appendChild(row);
}

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

/* ---------- 场景切换 ---------- */
function buildSceneBar() {
  const bar = document.getElementById('sceneBar');
  bar.innerHTML = '';
  SCENE_ORDER.forEach((id) => {
    const sc = SCENES[id];
    const b = el('button', 'sc-b' + (id === S.sceneId ? ' on' : ''), sc.name);
    b.onclick = () => { loadScene(id); buildSceneBar(); };
    bar.appendChild(b);
  });
}

/* ============================================================
 * 交互
 * ============================================================ */
function canvasPos(ev) {
  const r = cv.getBoundingClientRect();
  const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
  const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - r.top;
  return { x: cx / r.width * WORLD_W, y: cy / r.height * WORLD_H };
}

cv.addEventListener('mousedown', (ev) => {
  const p = canvasPos(ev);
  // 命中元件？
  for (let i = prepared.length - 1; i >= 0; i--) {
    const el0 = prepared[i];
    if (hitElement(el0, p)) {
      S.dragging = { idx: i, ox: p.x, oy: p.y, orig: snapshot(el0) };
      cv.style.cursor = 'grabbing';
      return;
    }
  }
});
window.addEventListener('mousemove', (ev) => {
  if (!S.dragging) {
    const p = canvasPos(ev);
    cv.style.cursor = prepared.some(e => hitElement(e, p)) ? 'grab' : 'default';
    return;
  }
  const p = canvasPos(ev);
  const d = S.dragging;
  const e = currentScene.elements[d.idx];
  const dx = p.x - d.ox, dy = p.y - d.oy;
  if (e.cx != null) { e.cx += dx; e.oy = dy; d.ox = p.x; d.oy = p.y; }
  else if (e.pts) { for (const q of e.pts) { q.x += dx; q.y += dy; } d.ox = p.x; d.oy = p.y; }
  if (e.segs) { for (const s of e.segs) for (const q of s) { q.x += dx; q.y += dy; } d.ox = p.x; d.oy = p.y; }
  if (e.core) { for (const q of e.core) { q.x += dx; q.y += dy; } d.ox = p.x; d.oy = p.y; }
  if (e.openings) { for (const o of e.openings) for (const q of o) { q.x += dx; q.y += dy; } d.ox = p.x; d.oy = p.y; }
  if (e.wallTop) { for (const q of e.wallTop) { q.x += dx; q.y += dy; } for (const q of e.wallBot) { q.x += dx; q.y += dy; } }
  prepared = prepareElements(currentScene.elements);
  render();
});
window.addEventListener('mouseup', () => { S.dragging = null; cv.style.cursor = 'default'; });

cv.addEventListener('wheel', (ev) => {
  const p = canvasPos(ev);
  ev.preventDefault();
  const dir = ev.deltaY > 0 ? 1 : -1;
  const hit = prepared.find(e => hitElement(e, p));
  if (hit) {
    // 旋转
    const sc = currentScene.elements[prepared.indexOf(hit)];
    if (sc.ang != null) { sc.ang += dir * 0.045; prepared = prepareElements(currentScene.elements); render(); }
  }
}, { passive: false });

function hitElement(e, p) {
  const bb = e.bbox;
  if (!bb) return false;
  const m = 14;
  return p.x >= bb.x0 - m && p.x <= bb.x1 + m && p.y >= bb.y0 - m && p.y <= bb.y1 + m;
}

function snapshot(e) { return JSON.parse(JSON.stringify(e)); }

/* ============================================================
 * 调试 / 自动化 API（Playwright 与录制都靠它）
 * ============================================================ */
window.photonLab = {
  loadScene,
  render,
  state: S,
  scenes: SCENES,
  order: SCENE_ORDER,
  set(key, val) {
    S[key] = val;
    buildControls();
    render();
    return S[key];
  },
  getSources() { return lastSources; },
  getFields() { return lastFields; },
  getLams() { return lastLams; },
  /** 屏幕中心线上的一行强度剖面（0..1），用于验证条纹 */
  profile(axis = 'v') {
    const f = lastFields[0];
    if (!f) return null;
    const { w, h } = S.fieldRes;
    const out = [];
    if (axis === 'v') {
      const x = Math.floor(w / 2);
      for (let y = 0; y < h; y++) out.push(f.re[y * w + x] ** 2 + f.im[y * w + x] ** 2);
    } else {
      const y = Math.floor(h / 2);
      for (let x = 0; x < w; x++) out.push(f.re[y * w + x] ** 2 + f.im[y * w + x] ** 2);
    }
    const mx = Math.max(...out, 1e-12);
    return out.map(v => v / mx);
  },
  /** 数出中心线上的极大值个数（= 条纹数） */
  countFringes(axis = 'v') {
    const p = this.profile(axis);
    if (!p) return 0;
    let c = 0;
    for (let i = 1; i < p.length - 1; i++) {
      if (p[i] > p[i - 1] && p[i] >= p[i + 1] && p[i] > 0.06) c++;
    }
    return c;
  },
  /** 找出相邻亮纹间距（像素） */
  fringeSpacingPx(axis = 'v') {
    const p = this.profile(axis);
    if (!p) return null;
    const peaks = [];
    for (let i = 1; i < p.length - 1; i++) {
      if (p[i] > p[i - 1] && p[i] >= p[i + 1] && p[i] > 0.08) peaks.push(i);
    }
    if (peaks.length < 2) return null;
    const d = [];
    for (let i = 1; i < peaks.length; i++) d.push(peaks[i] - peaks[i - 1]);
    return d.reduce((a, b) => a + b, 0) / d.length;
  },
  quality() { return lastFields[0] ? fieldQuality(lastFields[0]) : null; },
  // 理论值
  theory: { newtonDarkRadius, fringeSpacing },
  materials: MATERIALS,
  iorAt: (m, l) => iorAt(MATERIALS[m], l),
  critical: (m1, m2) => criticalAngle(MATERIALS[m1].n0, MATERIALS[m2].n0) * 180 / Math.PI,
  ready: true,
};

/* ---------- 启动 ---------- */
resize();
buildSceneBar();
loadScene('dslit');

// 自动重绘循环（交互后立即重绘；静止时不空转）
let needsRender = false;
function loop() {
  if (needsRender) { needsRender = false; render(); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 暴露一个重绘触发器
const _render = render;
window.photonLab.invalidate = () => { needsRender = true; };

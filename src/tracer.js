/* ============================================================
 * tracer.js — 几何光线追迹（纯几何光学层）
 *
 * 只做一件事：给定起点与方向，逐次求交 → 反射/折射 → 记录路径。
 * 不含任何干涉计算（那是 wave.js 的活）。
 *
 * 输出 trace：
 *   { segs: [{x0,y0,x1,y1,amp0,amp1,ior}],
 *     amp, opl, blocked, crossings: [{x,y,opl,amp}] }
 *   · segs      —— 画线用
 *   · opl       —— 累计光程（相位来源）
 *   · crossings —— 与「波面/缝隙」开口的相交记录，wave.js 拿它做二级波源
 * ============================================================ */

import { rayConvex, buildNormals, bbox, pointInConvex, EPS } from './vec.js';
import { iorAt, fresnel, mirrorR, ampFromE } from './optics.js';

export const MAX_DEPTH = 16;
const PROBE = 0.06;      // 判定入射/出射的探针距离
const AMP_CUTOFF = 0.0015;

/* ============================================================
 * 元素预处理：预算法线与包围盒（性能关键）
 * ============================================================ */
export function prepareElements(list) {
  return list.map(prepare);
}

function prepare(e) {
  const el = { ...e };

  if (el.kind === 'poly') {
    el.normals = buildNormals(el.pts);
    const bb = bbox(el.pts);
    el.bbox = bb;
    el.mat = el.mat || 'glass';
    // 入射点与出射点都试，取最近的
    el.hit = (ox, oy, dx, dy) => {
      const o = { x: ox, y: oy }, d = { x: dx, y: dy };
      const hIn = rayConvex(o, d, el.pts, el.normals, true);
      const hOut = rayConvex(o, d, el.pts, el.normals, false);
      if (hIn && (!hOut || hIn.t < hOut.t)) return hIn;
      if (hOut) return hOut;
      return null;
    };
  } else if (el.kind === 'mirror' || el.kind === 'beamsplit' || el.kind === 'opaque') {
    el.segs = el.segs || segsFromRect(el);
    const bb = segsBBox(el.segs, 1.5);
    el.bbox = bb;
    el.hit = (ox, oy, dx, dy) => hitSegs(ox, oy, dx, dy, el.segs);
  } else if (el.kind === 'slit') {
    // 缝隙：openings 是透光的开口段，segs 是不透明挡板
    el.segs = el.segs || [];
    el.openings = el.openings || [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const acc = (a, b) => {
      x0 = Math.min(x0, a.x, b.x); x1 = Math.max(x1, a.x, b.x);
      y0 = Math.min(y0, a.y, b.y); y1 = Math.max(y1, a.y, b.y);
    };
    for (const s of el.segs) acc(s[0], s[1]);
    for (const o of el.openings) acc(o[0], o[1]);
    el.bbox = x0 === Infinity
      ? { x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 }
      : { x0: x0 - 1.5, y0: y0 - 1.5, x1: x1 + 1.5, y1: y1 + 1.5 };
    el.hit = (ox, oy, dx, dy) => hitSegs(ox, oy, dx, dy, el.segs);
  } else if (el.kind === 'circle') {
    el.bbox = { x0: el.c.x - el.r, y0: el.c.y - el.r, x1: el.c.x + el.r, y1: el.c.y + el.r };
    el.hit = (ox, oy, dx, dy) => hitCircle(ox, oy, dx, dy, el.c, el.r);
  } else {
    el.bbox = { x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 };
    el.hit = () => null;
  }
  return el;
}

function segsFromRect(el) {
  const { cx, cy, w, h, ang = 0 } = el;
  const c = Math.cos(ang), s = Math.sin(ang);
  const R = (x, y) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c });
  const p = [R(-w / 2, -h / 2), R(w / 2, -h / 2), R(w / 2, h / 2), R(-w / 2, h / 2)];
  return [[p[0], p[1]], [p[1], p[2]], [p[2], p[3]], [p[3], p[0]]];
}

function segsBBox(segs, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) {
    x0 = Math.min(x0, s[0].x, s[1].x); x1 = Math.max(x1, s[0].x, s[1].x);
    y0 = Math.min(y0, s[0].y, s[1].y); y1 = Math.max(y1, s[0].y, s[1].y);
  }
  if (x0 === Infinity) return { x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 };
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

function hitSegs(ox, oy, dx, dy, segs) {
  let best = null, bestT = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const h = raySegRaw(ox, oy, dx, dy, s[0].x, s[0].y, s[1].x, s[1].y);
    if (h && h.t < bestT) { bestT = h.t; best = h; }
  }
  return best;
}

function raySegRaw(ox, oy, dx, dy, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const den = dx * vy - dy * vx;
  if (Math.abs(den) < 1e-12) return null;
  const wx = ax - ox, wy = ay - oy;
  const t = (wx * vy - wy * vx) / den;
  const u = (wx * dy - wy * dx) / den;
  if (t <= EPS || u < -1e-9 || u > 1 + 1e-9) return null;
  let nx = vy, ny = -vx;
  const l = Math.hypot(nx, ny) || 1;
  nx /= l; ny /= l;
  if (dx * nx + dy * ny > 0) { nx = -nx; ny = -ny; }   // 法线朝向来光侧
  return { t, nx, ny };
}

function hitCircle(ox, oy, dx, dy, c, r) {
  const fx = ox - c.x, fy = oy - c.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t <= EPS) t = (-b + sq) / (2 * a);
  if (t <= EPS) return null;
  const px = ox + dx * t, py = oy + dy * t;
  let nx = (px - c.x) / r, ny = (py - c.y) / r;
  if (dx * nx + dy * ny > 0) { nx = -nx; ny = -ny; }
  return { t, nx, ny };
}

/** slab 包围盒剔除 —— 绝大多数光线在这里就被踢掉 */
function rayBoxHit(ox, oy, dx, dy, x0, y0, x1, y1) {
  const invx = 1 / (Math.abs(dx) < 1e-12 ? 1e-12 : dx);
  const invy = 1 / (Math.abs(dy) < 1e-12 ? 1e-12 : dy);
  const t1 = (x0 - ox) * invx, t2 = (x1 - ox) * invx;
  const t3 = (y0 - oy) * invy, t4 = (y1 - oy) * invy;
  const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4));
  const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4));
  return tmax >= Math.max(tmin, 0);
}

/* ============================================================
 * 追迹一条光线
 * ============================================================
 * @param src {x,y} 起点
 * @param dir {x,y} 方向（单位）
 * @param amp 初始场幅
 * @param els  已 prepare 的元素数组
 * @param lam  波长 nm（决定色散折射率）
 * @param opl0 初始光程（多臂干涉时可非 0）
 */
export function traceRay(src, dir, amp, els, lam, opl0 = 0) {
  const segs = [];
  const crossings = [];
  let ox = src.x, oy = src.y, dx = dir.x, dy = dir.y;
  let a = amp, opl = opl0, ior = 1.0;
  let blocked = false;

  // 【性能】开口表在每次 traceRay 都重建一遍，是光栅场景的大瓶颈
  // （12288 次调用 × 12 个开口的数组构建）。
  // 改为惰性缓存：els 数组不变时只算一次。
  // 注意不能用全局变量（多场景会串），挂在 els 对象的隐藏属性上。
  const openSegs = getOpenings(els);

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    // ① 记录与开口段的相交 —— 必须放在「是否命中」判断之前。
    //    穿过缝隙的光线不会被任何挡板命中，若在这里 break 就丢了二级波源，
    //    结果是双缝/单缝场景一个波源都没有（第一版就踩了这个坑）。
    if (openSegs.length) {
      for (const os of openSegs) {
        const h = raySegRaw(ox, oy, dx, dy, os[0].x, os[0].y, os[1].x, os[1].y);
        if (h) {
          crossings.push({
            x: ox + dx * h.t, y: oy + dy * h.t,
            opl: opl + h.t * ior, amp: a, id: os[2],
          });
        }
      }
    }

    // ② 最近命中
    let best = null, bestT = Infinity, bestEl = null;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const bb = el.bbox;
      if (!rayBoxHit(ox, oy, dx, dy, bb.x0, bb.y0, bb.x1, bb.y1)) continue;
      const h = el.hit(ox, oy, dx, dy);
      if (h && h.t < bestT) { bestT = h.t; best = h; bestEl = el; }
    }

    if (!best) {
      segs.push({ x0: ox, y0: oy, x1: ox + dx * 4000, y1: oy + dy * 4000, amp0: a, amp1: a, ior });
      break;
    }

    const t = bestT;
    let nx = best.nx, ny = best.ny;
    if (dx * nx + dy * ny > 0) { nx = -nx; ny = -ny; }   // 保证 dot(d,n)<0
    const cosI = -(dx * nx + dy * ny);
    if (cosI <= 1e-7) break;

    const px = ox + dx * t, py = oy + dy * t;
    const segOpl = t * ior;

    segs.push({ x0: ox, y0: oy, x1: px, y1: py, amp0: a, amp1: a, ior, opl0: opl, opl1: opl + segOpl });
    opl += segOpl;
    ox = px; oy = py;

    const kind = bestEl.kind;

    if (kind === 'opaque') { blocked = true; break; }

    if (kind === 'mirror') {
      const R = bestEl.R != null ? bestEl.R : mirrorR(cosI, bestEl.base || 0.985);
      a *= ampFromE(R);
      dx = dx - 2 * cosI * nx; dy = dy - 2 * cosI * ny;
      ox += dx * 1e-4; oy += dy * 1e-4;
      ior = 1.0;
      if (a < AMP_CUTOFF) break;
      continue;
    }

    if (kind === 'beamsplit') {
      // 半反射镜：主光线走反射，透射支路由 splitBeam 单独追
      const R = bestEl.R != null ? bestEl.R : 0.5;
      const aT = a * ampFromE(1 - R);
      if (aT > AMP_CUTOFF) {
        const t2 = traceRay({ x: ox + dx * 1e-3, y: oy + dy * 1e-3 }, { x: dx, y: dy },
                            aT, els, lam, opl);
        for (const s of t2.segs) segs.push({ ...s, ghost: true });
        for (const c of t2.crossings) crossings.push({ ...c, ghost: true });
        opl += t2.opl - opl;
      }
      a *= ampFromE(R);
      dx = dx - 2 * cosI * nx; dy = dy - 2 * cosI * ny;
      ox += dx * 1e-4; oy += dy * 1e-4;
      ior = 1.0;
      if (a < AMP_CUTOFF) break;
      continue;
    }

    if (kind === 'poly') {
      const el = bestEl;
      // 探针：命中点前方一点在多边形内 → 入射；否则出射
      const probe = { x: ox + dx * PROBE, y: oy + dy * PROBE };
      const entering = pointInConvex(probe, el.pts, el.normals);
      const nOut = iorAt(el.matObj || (el.matObj = getMat(el.mat)), lam);
      const n1 = entering ? ior : nOut;
      const n2 = entering ? nOut : ior;

      const F = fresnel(cosI, n1, n2);
      if (F.tir) {
        // 全反射：能量无损（光纤原理）
        dx = dx - 2 * cosI * nx; dy = dy - 2 * cosI * ny;
        ox += dx * 1e-4; oy += dy * 1e-4;
        continue;                       // ior 不变
      }

      const aR = a * ampFromE(F.R);
      if (aR > AMP_CUTOFF) {
        const r2 = traceRay({ x: ox + (-2 * cosI * nx) * 1e-3, y: oy + (-2 * cosI * ny) * 1e-3 },
                            { x: dx - 2 * cosI * nx, y: dy - 2 * cosI * ny },
                            aR, els, lam, opl);
        for (const s of r2.segs) segs.push({ ...s, ghost: true });
        for (const c of r2.crossings) crossings.push({ ...c, ghost: true });
      }

      const eta = n1 / n2;
      const cosT = Math.sqrt(Math.max(0, 1 - eta * eta * (1 - cosI * cosI)));
      const c = eta * cosI - cosT;
      let tx = eta * dx + c * nx, ty = eta * dy + c * ny;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      a *= ampFromE(F.T);
      dx = tx; dy = ty;
      ior = entering ? nOut : 1.0;
      ox += dx * 1e-4; oy += dy * 1e-4;
      if (a < AMP_CUTOFF) break;
      continue;
    }

    break;
  }

  return { segs, amp: a, opl, blocked, crossings, end: { x: ox, y: oy } };
}

/** 收集所有缝隙开口，供 tracing 时记录相交。
 *  结果按元素数组缓存 —— prepareElements 每次重建 els，所以用长度+版本号判断。
 */
const _openCache = new WeakMap();
function getOpenings(els) {
  let c = _openCache.get(els);
  if (c) return c;
  const out = [];
  for (const el of els) {
    if (el.kind !== 'slit' || !el.openings) continue;
    for (const o of el.openings) out.push([o[0], o[1], el.id]);
  }
  _openCache.set(els, out);
  return out;
}

let _MATCACHE = null;
export function setMaterialTable(M) { _MATCACHE = M; }
function getMat(key) {
  const M = _MATCACHE;
  if (!M) throw new Error('material table not set');
  const m = M[key];
  if (!m) throw new Error('unknown material: ' + key);
  return m;
}

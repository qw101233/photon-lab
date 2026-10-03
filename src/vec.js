/* ============================================================
 * vec.js — 极简二维向量 / 射线求交 / 凸多边形几何
 * 零依赖，纯函数。所有几何原语集中在此，方便单测。
 * ============================================================ */

export const EPS = 1e-9;

/* ---------- 向量（用 {x,y} 对象，够快且可读） ---------- */
export const V = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scl = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const len2 = (a) => a.x * a.x + a.y * a.y;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 单位化；退化向量返回 (1,0) 保证下游不炸 */
export function norm(a) {
  const l = Math.hypot(a.x, a.y);
  return l < EPS ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** 左法线（逆时针 90°） */
export const perp = (a) => ({ x: -a.y, y: a.x });

/** 把向量 a 绕原点旋转 ang 弧度 */
export function rot(a, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** d 关于法线 n（单位向量）的镜像方向 */
export const reflect = (d, n) => sub(d, scl(n, 2 * dot(d, n)));

/** 绕点 p 旋转 ang */
export const rotAbout = (p, ang) => add(p, rot(sub(p, ORIGIN), ang));

const ORIGIN = { x: 0, y: 0 };

/* ---------- 射线 × 线段 ----------
 * 射线 o+t·d (t>0)，线段 a→b。命中返回 {t,u,x,y}，否则 null。
 */
export function raySeg(o, d, a, b) {
  const v = sub(b, a);
  const den = cross(d, v);
  if (Math.abs(den) < 1e-12) return null;          // 平行
  const ao = sub(a, o);
  const t = cross(ao, v) / den;
  const u = cross(ao, d) / den;
  if (t <= EPS || u < 0 || u > 1) return null;
  return { t, u, x: o.x + d.x * t, y: o.y + d.y * t };
}

/** 射线 × 无向线段（线段存为 [a,b]），忽略法线方向 */
export function raySegU(o, d, seg) { return raySeg(o, d, seg[0], seg[1]); }

/* ---------- 凸多边形 ----------
 * pts 逆时针排列。outward[i] = 第 i 条边 (pts[i] → pts[i+1]) 的外法线。
 * 用半平面法做命中测试：O(log n) 不必要，O(n) 但 n 很小。
 */

/** 由顶点重建法线数组（保证指向多边形外） */
export function buildNormals(pts) {
  const n = pts.length;
  const c = centroid(pts);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    let nn = perp(sub(b, a));
    nn = norm(nn);
    // 保证朝外：法线起点若指向内部则翻转
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (dot(nn, sub(mid, c)) < 0) nn = scl(nn, -1);
    out.push(nn);
  }
  return out;
}

export function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: Math.hypot(x1 - x0, y1 - y0) / 2 };
}

/**
 * 射线 vs 凸多边形。
 * @param inward  false=找进入点(d·n<0 的边里 t 最小者)
 *               true =找离开点(d·n>0 的边里 t 最小者)
 * @returns {t,x,y,nx,ny} | null
 */
export function rayConvex(o, d, pts, normals, inward) {
  const n = pts.length;
  let best = Infinity, bnx = 0, bny = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const h = raySeg(o, d, a, b);
    if (!h || h.t >= best) continue;
    const nn = normals[i];
    const sgn = dot(d, nn);
    if (inward ? sgn < 0 : sgn > 0) continue;
    best = h.t; bnx = nn.x; bny = nn.y;
  }
  if (best === Infinity) return null;
  return { t: best, x: o.x + d.x * best, y: o.y + d.y * best, nx: bnx, ny: bny };
}

/** 点是否在凸多边形内（含边界，eps 容差） */
export function pointInConvex(p, pts, normals) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const nn = normals[i];
    if (nn.x * (p.x - a.x) + nn.y * (p.y - a.y) > 1e-6) return false;
  }
  return true;
}

/* ---------- 几何构造工具（供场景定义用） ---------- */

/** 矩形（中心 c，尺寸 w×h，旋转 ang，逆时针） */
export function rectPts(cx, cy, w, h, ang = 0) {
  const hw = w / 2, hh = h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    .map(([x, y]) => { const p = rot({ x, y }, ang); return { x: p.x + cx, y: p.y + cy }; });
}

/** 等腰三角形（顶点朝 +x 的"楔形"）：底边垂直于 ang，高 h，底宽 2*w */
export function wedgePts(cx, cy, w, h, ang = 0) {
  const local = [
    { x: 0, y: 0 },            // 尖端（顶角）
    { x: h, y: -w / 2 },
    { x: h, y: w / 2 },
  ];
  return local.map((p) => { const q = rot(p, ang); return { x: q.x + cx, y: q.y + cy }; });
}

/** 圆形折线（顺逆皆可，法线由 buildNormals 统一） */
export function circlePts(cx, cy, r, segs = 48) {
  const out = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** 圆弧（从 a0 到 a1，逆时针，圆心 c 半径 r），采样成折线 */
export function arcPts(cx, cy, r, a0, a1, segs = 16) {
  const out = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (a1 - a0) * (i / segs);
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** 中心 c、旋转 ang 的双凸透镜轮廓（球冠近似，两段圆弧） */
export function lensPts(cx, cy, r, thickness, ang = 0, segs = 14) {
  const half = thickness / 2;
  const cosA = half / r;                 // |cos| ≤ 1
  if (cosA > 0.999) cosA = 0.999;
  const a = Math.acos(cosA);
  // 上半弧：角度 π-a → π+a（左侧凸面），下半弧：-a → a（右侧凸面）
  const left = arcPts(cx, cy, r, Math.PI - a, Math.PI + a, segs);
  const right = arcPts(cx, cy, r, -a, a, segs);
  return left.concat(right.slice(1, -1)).map((p) => {
    const q = rot({ x: p.x - cx, y: p.y - cy }, ang);
    return { x: q.x + cx, y: q.y + cy };
  });
}

/* ---------- 复数（波动部分用，Float64 便于累加精度） ---------- */
export const cx = (re = 0, im = 0) => ({ re, im });

/** 复数乘 a·b */
export function cmul(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }

/** 复数除 a/b */
export function cdiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

/** exp(i·φ) */
export const cexp = (phi) => ({ re: Math.cos(phi), im: Math.sin(phi) });

/** |a|² */
export const cabs2 = (a) => a.re * a.re + a.im * a.im;
export const cabs = (a) => Math.hypot(a.re, a.im);

/** 复数幅值 —— 光线追迹里传播的是"振幅"，强度 = 幅值² */
export const csqrtRe = (x) => (x <= 0 ? 0 : Math.sqrt(x));

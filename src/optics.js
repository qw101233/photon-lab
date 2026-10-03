/* ============================================================
 * optics.js — Snell 折射 / Fresnel 反射 / Cauchy 色散
 *
 * 约定
 *  - 光线携带「场幅 amp」（强度 = amp²），能量分配用 amp·√(能量比)
 *  - 无偏振：R = (Rs + Rp)/2
 *  - 法线 n 始终满足 dot(d, n) < 0（指向入射侧），这样 cosI = -dot(d,n) > 0
 *  - 色散：Cauchy n(λ) = A + B/λ²（λ 单位 μm），短波折射率更高
 * ============================================================ */

import { dot, norm } from './vec.js';

/* ---------- 材料库 ----------
 * A/B：Cauchy 系数；n0 为 589.3nm 处折射率（仅用于界面显示）。
 * B 越大 → 色散越强 → 棱镜出的彩虹越宽。
 */
export const MATERIALS = {
  air:     { label: '空气',      n0: 1.0000, A: 1.0000, B: 0.0,      color: '#22314a' },
  glass:   { label: '冕牌玻璃',   n0: 1.5168, A: 1.5046, B: 0.00420, color: '#2f7d9f' },
  flint:   { label: '重火石玻璃', n0: 1.6200, A: 1.6097, B: 0.01329, color: '#7d4a9c' },
  water:   { label: '水',        n0: 1.3330, A: 1.3199, B: 0.00305, color: '#2f6fa8' },
  diamond: { label: '金刚石',    n0: 2.4170, A: 2.3800, B: 0.01106, color: '#4f9f8a' },
  mica:    { label: '云母(慢镜)', n0: 1.5900, A: 1.5500, B: 0.00380, color: '#6a8f5a' },
};

export function iorAt(mat, lambdaNm) {
  const um = lambdaNm / 1000;
  return mat.A + mat.B / (um * um);
}

/** 从 d 线折射率 n0 反推 Cauchy A（保留标准色散比例） */
export function dispersionFromN0(n0, strength = 1) {
  const B = 0.00420 * strength;
  return { ...({ A: n0 - B / (0.5893 * 0.5893), B }) };
}

/* ---------- Snell 折射 ---------- */
/**
 * @param d  入射方向（单位）
 * @param n  表面法线（单位，dot(d,n) < 0）
 * @param n1 入射介质折射率, n2 透射介质折射率
 * @returns {t, cosI, cosT, tir}
 *          tir=true 表示全反射（t = null）
 */
export function refract(d, n, n1, n2) {
  const cosI = -dot(d, n);
  if (cosI <= 0) return { t: null, cosI, cosT: 0, tir: true };
  const eta = n1 / n2;
  const k = 1 - eta * eta * (1 - cosI * cosI);
  if (k < 0) return { t: null, cosI, cosT: 0, tir: true };   // 全反射
  const cosT = Math.sqrt(k);
  const c = eta * cosI - cosT;
  return { t: norm({ x: eta * d.x + c * n.x, y: eta * d.y + c * n.y }), cosI, cosT, tir: false };
}

/** 临界角（n1 > n2 时存在），单位弧度 */
export function criticalAngle(n1, n2) {
  if (n1 <= n2) return null;
  return Math.asin(n2 / n1);
}

/* ---------- Fresnel（无偏振） ---------- */
/** @returns {R 反射能量比, T 透射能量比, tir 全反射标记} */
export function fresnel(cosI, n1, n2) {
  const eta = n1 / n2;
  const k = 1 - eta * eta * (1 - cosI * cosI);
  if (k < 0) return { R: 1, T: 0, tir: true };
  const cosT = Math.sqrt(k);
  const rs = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
  const rp = (n2 * cosI - n1 * cosT) / (n2 * cosI + n1 * cosT);
  const R = 0.5 * (rs * rs + rp * rp);
  return { R, T: 1 - R, tir: false };
}

/* ---------- 金属镜 ---------- */
/** 镀银镜面反射率：轻微随角度下降，近掠射时明显变暗 */
export function mirrorR(cosI, base = 0.985) {
  const c = Math.min(Math.max(cosI, 0), 1);
  return base - 0.16 * Math.pow(1 - c, 3);
}

/** 场幅 = √(能量比) */
export const ampFromE = (E) => Math.sqrt(Math.max(E, 0));

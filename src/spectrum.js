/* ============================================================
 * spectrum.js — 光谱 → 颜色
 * CIE 1931 配色函数用 Wyman/Sloan/Shirley 多高斯解析近似
 * （无需 471 项数表，误差 < 1%，肉眼无差别）。
 * 干涉条纹的颜色由此"真算"出来，不是手调 RGB。
 * ============================================================ */

export const LAMBDA_MIN = 400;
export const LAMBDA_MAX = 700;

/* ---------- 长度单位约定（重要，别踩坑） ----------
 * 场景坐标是抽象的「场景单位」(su)，不是米也不是像素。
 * 物理公式 λL/d 要求三者同单位，所以必须有一个换算系数：
 *
 *     λ_su = λ_nm × WAVE_SCALE
 *
 * 为什么需要它：真实双缝的条纹间距 λL/d 在实验中是**亚毫米**的
 * （d≈0.5mm, L≈1m, λ=550nm → Δx≈1.1mm 更宽，但 d=0.1mm 时 Δx 只有 0.05mm），
 * 肉眼在米级屏幕上根本分辨不出。真实实验靠透镜放大或几十米长的管子。
 * 本仿真把整个装置压进 1000×620 的画面，所以必须放大波长才能看见条纹。
 *
 * （下方 WAVE_SCALE=0.008 时：550nm → 4.4 su，配合 L≈480 su、d≈84 su
 * 得到 Δx≈25 su，屏幕上约 12 条条纹 —— 数量级刚好可读且不至于摩尔纹。
 * 这个系数只影响"看见多少条"，不影响任何物理关系：
 * Snell/Fresnel 用的是比值 n(λ)→n(λ)，全反射临界角与波长无关，
 * 条纹间距严格正比于 λ，改 WAVE_SCALE 等价于连续缩放条纹密度。
 */
/* WAVE_SCALE 由「屏上要看到多少条条纹」反推，不是随便取的。
 * 双缝：Δx = λ_su·L/d。屏高 300su 想要 ~25 条清晰条纹 → Δx ≈ 12su
 *       → λ_su = 12·84/480 = 2.1su → WAVE_SCALE ≈ 0.0038
 * 取 0.0035（λ550 → 1.93su，Δx ≈ 11su，屏上约 27 条）。
 *
 * 【调这个系数时踩过的坑，留个记录】
 *   0.002 → Δx=6su，50+ 条挤在一起，画面糊成一片彩色绒
 *   0.008 → Δx=25su，12 条，但单缝包络 λL/a 也同步放大到 190su，
 *           超过屏高 → 条纹只占顶部一小块，其余全黑
 * 关键认知：**λ 放大时条纹间距和包络宽度是同比例放大的**，
 * 所以「条纹数 = 屏高/(λL/d)」与「包络/屏高 = d/a」是**互相独立**的两个量，
 * 前者调 λ、后者调缝宽与缝距之比。好在双缝的 d/a = 84/84 = 1，
 * 包络恰好等于间距量级 —— 所以条纹能填满整个包络，这就是真实现象。
 * 注意：这个系数只影响看见多少条，不影响任何物理关系 ——
 * Snell/Fresnel 只依赖 n 的比值，临界角与波长无关，
 * 条纹间距严格正比于 λ（验证脚本正是用这个正比关系做断言的）。 */
export const WAVE_SCALE = 0.0035;

/** 物理波长(nm) → 场景单位波长(su)，用于所有相位计算 */
export const nmToSu = (nm) => nm * WAVE_SCALE;
/** 场景单位波长(su) → 物理波长(nm) */
export const suToNm = (su) => su / WAVE_SCALE;

/** 单高斯：λ 处，中心 μ，σ1(μ 左侧)/σ2(右侧) */
function g(x, mu, s1, s2) {
  const s = x < mu ? s1 : s2;
  const t = (x - mu) / s;
  return Math.exp(-0.5 * t * t);
}

/** CIE x̄ 配色函数 */
export function cieX(l) {
  return 1.056 * g(l, 599.8, 37.9, 31.0)
       + 0.362 * g(l, 442.0, 16.0, 26.7)
       - 0.065 * g(l, 501.1, 20.4, 26.2);
}
/** CIE ȳ 配色函数（视觉亮度） */
export function cieY(l) {
  return 0.821 * g(l, 568.8, 46.9, 40.5)
       + 0.286 * g(l, 530.9, 16.3, 31.1);
}
/** CIE z̄ 配色函数 */
export function cieZ(l) {
  return 1.217 * g(l, 437.0, 11.8, 36.0)
       + 0.681 * g(l, 459.0, 26.0, 13.8);
}

/** 单色光 sRGB（0-255），γ 已编码 —— 用于给射线染色 */
export function lambdaRGB(l) {
  const X = cieX(l), Y = cieY(l), Z = cieZ(l);
  return xyz2rgb255(X, Y, Z);
}

function xyz2rgb255(X, Y, Z) {
  let r =  3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b =  0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  const enc = (u) => {
    u = Math.max(0, u);
    u = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(u * 255)));
  };
  return [enc(r), enc(gg), enc(b)];
}

/**
 * 把一组「每波长的 XYZ 贡献」按亮度归一后转 sRGB。
 * @param {Float32Array|Float64Array} X Y Z 累积的 XYZ（未归一）
 * @param {number} scale 亮度缩放
 * @param {Uint8ClampedArray} out 长度 = X.length*3 的 sRGB 缓冲
 */
export function xyzToImage(X, Y, Z, scale, out) {
  for (let i = 0, p = 0; i < X.length; i++, p += 3) {
    out[p]     = srgbEnc(3.2406 * X[i] - 1.5372 * Y[i] - 0.4986 * Z[i], scale);
    out[p + 1] = srgbEnc(-0.9689 * X[i] + 1.8758 * Y[i] + 0.0415 * Z[i], scale);
    out[p + 2] = srgbEnc(0.0557 * X[i] - 0.2040 * Y[i] + 1.0570 * Z[i], scale);
  }
}

function srgbEnc(u, scale) {
  u *= scale;
  if (u <= 0) return 0;
  if (u > 1) u = 1 + (u - 1) / (1 + (u - 1) * 1.6);   // 软压缩，避免过曝死白
  const v = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * 均匀光谱的波长采样点（等距）。
 * 宽带（白光）用多点；窄带（准单色）用少点即可。
 */
export function makeLambdaSamples(n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = LAMBDA_MIN + (LAMBDA_MAX - LAMBDA_MIN) * ((i + 0.5) / n);
  }
  return out;
}

/**
 * 按「中心波长 + 线宽」构造采样权重（高斯分布），用于准单色模式。
 * 返回 {lambdas, weights, norm}
 */
export function makeNarrowSamples(center, fwhm, n) {
  const sigma = Math.max(fwhm / 2.3548, 1.2);
  const lo = Math.max(LAMBDA_MIN, center - 3 * sigma);
  const hi = Math.min(LAMBDA_MAX, center + 3 * sigma);
  const lambdas = new Float64Array(n);
  const weights = new Float64Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const l = lo + (hi - lo) * ((i + 0.5) / n);
    const w = Math.exp(-0.5 * ((l - center) / sigma) ** 2);
    lambdas[i] = l;
    weights[i] = w;
    norm += w;
  }
  for (let i = 0; i < n; i++) weights[i] /= norm;
  // ⚠️ 必须同时给出扁平数组别名 —— app.js 侧用的是 
  //（makeLambdaSamples 返回 {lambdas} 但调用处直接当数组用）。
  // v1 只返回 {lambdas}，导致单色场景拿到 undefined → 全黑。
  return { lambdas, weights, norm: 1, lambdas_: lambdas };
}

/** 人眼视觉亮度权重（用于把能量归一到「看起来多亮」） */
export const photopic = (l) => cieY(l);

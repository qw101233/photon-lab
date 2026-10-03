/* ============================================================
 * film.js — 薄膜干涉（牛顿环 / 肥皂膜虹彩）
 *
 * 这是**纵向**干涉：光在薄膜上下表面来回反射形成驻波。
 * 与双缝的横向传播干涉不同，条纹是同心等厚线。
 *
 * 反射光程差：Δ = 2·n·t·cosθt + λ/2
 *   · 2nt·cosθt —— 往返穿过膜的相位
 *   · λ/2       —— 上表面反射（光疏→光密）产生的半波损失
 *                     下表面反射（光密→光疏）无半波损失
 *                     两者之差 = λ/2，这就是"中心为什么是暗的"
 *
 * 反射光强：I_r = I_0 · sin²(π·2nt·cosθt / λ)  ← 把 λ/2 吸收进去了
 * 透射光强：I_t = I_0 · cos²(...)             （两者互补）
 * ============================================================ */

import { cieX, cieY, cieZ } from './spectrum.js';

/**
 * 牛顿环：平凸透镜压平板，空气膜厚度 t(r) = r²/(2R)
 * @param r  距接触点的半径（nm）
 * @param R  透镜曲率半径（nm）
 * @param lam 波长 nm，n=1（空气）
 * @returns 反射光相对强度 0..1
 */
export function newtonRingIntensity(r, R, lam, n = 1) {
  const t = (r * r) / (2 * R);            // nm
  return ringIntensity(t, lam, n, 0);
}

/** 通用：给定厚度 t 的反射强度 */
export function ringIntensity(t, lam, n = 1, phase0 = 0) {
  const arg = Math.PI * (2 * n * t) / lam + phase0;
  return Math.sin(arg) * Math.sin(arg);
}

/** 牛顿环：透射（互补） */
export function newtonRingTransmit(r, R, lam, n = 1) {
  const t = (r * r) / (2 * R);
  const arg = Math.PI * (2 * n * t) / lam;
  return Math.cos(arg) * Math.cos(arg);
}

/**
 * 同心厚度场（肥皂膜）：t(r) 随半径线性增长
 * 真实肥皂膜厚度从上到下逐渐变薄 → 形成牛顿色序的色环。
 * @param u 归一化半径 0..1
 * @param tMax 边缘最大厚度 nm
 * @param lamMin 中心最薄处的厚度 nm
 */
export function soapThickness(u, tMin = 100, tMax = 1400) {
  // 平方根型厚度分布：中心薄，边缘厚，中段变化快 → 环更密
  const s = Math.sqrt(Math.max(u, 0));
  return tMin + (tMax - tMin) * s;
}

/**
 * 渲染薄膜干涉图为真彩色。
 * 每个像素算厚度 → 对每个波长算反射强度 → 按 CIE 合成 RGB。
 *
 * @param mode 'rings' | 'concentric'
 * @param cfg  {cx, cy, R(px), lam0, tMax, tMin, showRings}
 * @param out  Uint8ClampedArray RGB
 */
export function renderFilm(mode, cfg, out, W, H, lamSamples) {
  // ⚠️ out 必须是 ImageData 的 4 字节/像素缓冲（RGBA）。
  //    v1 误按 3 字节步进写 RGB，导致像素错位 —— 现象是
  //    画面出现「4 个重复的圆」且颜色是 [10,13,20]/[13,20,10]/[20,10,13]
  //    这种毫无意义的循环色（RGB 三个通道互相串位）。
  const { cx, cy } = cfg;
  const Rp = cfg.R;
  const Rnm = cfg.Rnm || 500;          // 曲率半径（nm）
  const lams = lamSamples;
  const R2 = Rp * Rp;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const rpx2 = dx * dx + dy * dy;
      const i = (y * W + x) * 4;   // ImageData 是 RGBA 4 字节
      if (rpx2 > R2) {
        out[i] = 10; out[i + 1] = 13; out[i + 2] = 20; out[i + 3] = 255;
        continue;
      }
      const rpx = Math.sqrt(rpx2);
      const u = rpx / Rp;

      // 求该点厚度（nm）
      let t;
      if (mode === 'rings') {
        // 牛顿环：真实物理厚度 t = r²/(2R)
        const rnm = u * Rp / 8;        // 像素半径→物理半径（比例尺任意，只要与 Rnm 自洽）
        t = (rnm * rnm) / (2 * Rnm);
      } else {
        t = soapThickness(u, cfg.tMin || 90, cfg.tMax || 1500);
      }

      // 多波长反射强度 → XYZ
      let X = 0, Y = 0, Z = 0;
      for (let li = 0; li < lams.length; li++) {
        const l = lams[li];
        const I = ringIntensity(t, l, 1, 0);
        X += I * cieX(l); Y += I * cieY(l); Z += I * cieZ(l);
      }
      // 归一化：除以「全波段同相长」时的 XYZ 参考值。
      // 不除会整体过曝成白（v1 的症状：满屏白到看不见颜色）；
      // 除太多又会全黑（v2 的症状：系数取了 1/(N·0.62)，压掉了 15 倍）。
      // 参考值取白光单位反射的 XYZ（∫cmf dλ ≈ 1.2/1.0/0.6），
      // 再乘 2.2 的增益 —— 让最亮处刚好到白，最暗处保留颜色。
      // 【归一化的正确做法 —— 试了三版才对】
      // v1 不归一：24 个波长的 CIE 值直接累加，X 可达 ~25 → 全白过曝
      // v2 除以 N×0.62：压掉 15 倍 → 全黑
      // v3 固定增益 0.42：X 仍达 10 → 还是白
      // 正确：先除以波长数 N（等间距采样下 dλ 是常数，可约掉），
      // 此时 X/Y/Z 就是「平均单波长贡献」，量级 ~1，再乘 1.15 增益即可。
      const k = (1.15 / lams.length);
      const Xv = X * k, Yv = Y * k, Zv = Z * k;
      out[i]     = enc(3.2406 * Xv - 1.5372 * Yv - 0.4986 * Zv);
      out[i + 1] = enc(-0.9689 * Xv + 1.8758 * Yv + 0.0415 * Zv);
      out[i + 2] = enc(0.0557 * Xv - 0.2040 * Yv + 1.0570 * Zv);
      out[i + 3] = 255;   // ⚠️ 必须写 alpha！createImageData 的 alpha 初始为 0，
                           //    不写的话 putImageData 视为全透明 → 画面全黑。
                           //    这个 bug 让我误以为是颜色计算错了。
    }
  }
}

function enc(u) {
  if (u <= 0) return 0;
  if (u > 1) u = 1 + (u - 1) / (1 + (u - 1) * 2.0);
  const v = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * 牛顿环暗环半径：r_m = √(m·λ·R)
 * 用于自动验证条纹是否出现在理论位置。
 */
export function newtonDarkRadius(m, lam, R) {
  return Math.sqrt(m * lam * R);
}

/**
 * 双缝条纹间距：Δx = λL/d
 * 用于自动验证。
 */
export function fringeSpacing(lam, L, d) {
  return (lam * L) / d;
}

/** 单缝主瓣半角：sinθ = λ/a */
export function singleSlitFirstMin(lam, a) {
  return lam / a;
}

/** 光栅衍射角：sinθ = mλ/d */
export function gratingAngle(m, lam, d) {
  const s = (m * lam) / d;
  return Math.abs(s) <= 1 ? Math.asin(s) : null;
}

/** 圆孔爱里斑第一暗环：sinθ = 1.22λ/D */
export function airyFirstMin(lam, D) {
  return 1.22 * lam / D;
}

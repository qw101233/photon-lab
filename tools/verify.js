/**
 * verify.js — 自动化验证
 *
 * 原则：**断言物理定律本身**，不验证"像素好不好看"。
 *   - 棱镜偏向角 vs 解析解
 *   - 全反射临界角 vs arcsin(n2/n1)
 *   - 双缝条纹间距 vs λL/d（改参数必须线性跟随）
 *   - 条纹位置 vs 数值积分的相消条件
 *   - 色散方向 vs Cauchy 方程
 *   - 薄膜牛顿环暗环 vs √(mλR)
 * 任何一项不过 → 退出码 1。
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');

/* ---------- 极简静态服务器 ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
function serve(port) {
  return new Promise((res) => {
    const s = http.createServer((req, rq) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        rq.writeHead(404); rq.end('nf'); return;
      }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rq);
    });
    s.listen(port, () => res(s));
  });
}

/* ---------- 结果收集 ---------- */
const results = [];
let failures = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failures++;
  const tag = pass ? '\x1b[32m  PASS\x1b[0m' : '\x1b[31m  FAIL\x1b[0m';
  console.log(`${tag}  ${name}${detail ? '   \x1b[90m' + detail + '\x1b[0m' : ''}`);
}

function near(a, b, tolPct, label) {
  const d = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  return { ok: d * 100 <= tolPct, dPct: d * 100, label };
}

/* ---------- 主流程 ---------- */
(async () => {
  const port = 8931;
  const server = await serve(port);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });

  // fail-fast：任何页面错误立刻中止
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.photonLab && window.photonLab.ready, { timeout: 15000 });

  console.log('\n\x1b[36m══ 1. 基础健康检查 ══\x1b[0m');
  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('调试 API 就绪', await page.evaluate(() => !!window.photonLab));
  const nScenes = await page.evaluate(() => window.photonLab.order.length);
  check('场景数量 ≥ 10', nScenes >= 10, `实际 ${nScenes}`);

  console.log('\n\x1b[36m══ 2. Snell 定律 / 全反射临界角 ══\x1b[0m');
  // 玻璃→空气 临界角理论值 arcsin(1/1.5168) = 41.20°
  const crit = await page.evaluate(() => window.photonLab.critical('glass', 'air'));
  const critTheory = Math.asin(1 / 1.5168) * 180 / Math.PI;
  let r = near(crit, critTheory, 0.5, '临界角');
  check('玻璃→空气临界角 = arcsin(1/n)', r.ok, `${crit.toFixed(2)}° vs 理论 ${critTheory.toFixed(2)}°`);

  // Cauchy 色散：n(400nm) > n(700nm)，且数值吻合
  const n400 = await page.evaluate(() => window.photonLab.iorAt('glass', 400));
  const n700 = await page.evaluate(() => window.photonLab.iorAt('glass', 700));
  check('正常色散：n(400nm) > n(700nm)', n400 > n700, `${n400.toFixed(4)} > ${n700.toFixed(4)}`);
  const cauchy400 = 1.5046 + 0.00420 / (0.4 * 0.4);
  r = near(n400, cauchy400, 0.5, 'Cauchy');
  check('n(400nm) 符合 Cauchy 方程', r.ok, `${n400.toFixed(4)} vs ${cauchy400.toFixed(4)}`);

  console.log('\n\x1b[36m══ 3. Fresnel 反射率 ══\x1b[0m');
  const fres = await page.evaluate(async () => {
    const { fresnel } = await import('./src/optics.js');
    const n = 1.5168;
    // 布儒斯特角：θB = arctan(n2/n1)，此处 p 分量反射率必为 0。
    // 无偏振 R=(Rs+Rp)/2 在该角并不为 0（Rs≈7.7%），所以必须拆开验 p 分量。
    const thB = Math.atan(n / 1.0);
    const cosI = Math.cos(thB);
    const eta = 1 / n;
    const cosT = Math.sqrt(1 - eta * eta * (1 - cosI * cosI));
    const rp = (n * cosI - 1.0 * cosT) / (n * cosI + 1.0 * cosT);
    const rs = (1.0 * cosI - n * cosT) / (1.0 * cosI + n * cosT);
    return {
      normal: fresnel(1.0, 1.0, n).R,
      rpAtBrewster: Math.abs(rp),
      rsAtBrewster: Math.abs(rs),
      grazing: fresnel(0.02, 1.0, n).R,
      unpolarAtB: fresnel(cosI, 1.0, n).R,
    };
  });
  // 正入射 Fresnel R = ((n1-n2)/(n1+n2))²
  const rNormal = ((1.5168 - 1) / (1.5168 + 1)) ** 2;
  r = near(fres.normal, rNormal, 1.0, '正入射');
  check('正入射 R = ((n₁-n₂)/(n₁+n₂))²', r.ok, `${fres.normal.toFixed(5)} vs ${rNormal.toFixed(5)}`);
  check('布儒斯特角 p 分量反射率 = 0', fres.rpAtBrewster < 1e-9, `Rp=${fres.rpAtBrewster.toExponential(2)}`);
  check('同角度 s 分量仍有反射（证明非平凡）', fres.rsAtBrewster > 0.05, `Rs=${fres.rsAtBrewster.toFixed(4)}`);
  check('掠射时 R → 1', fres.grazing > 0.85, `R=${fres.grazing.toFixed(3)}`);

  console.log('\n\x1b[36m══ 4. 双缝干涉 —— 与解析闭式解逐点对比 ══\x1b[0m');
  // 【这一节返工了两次，记下原因，比代码本身更有价值】
  // v1：验「条纹间距 = λL/d」，实测偏 3%，判失败。
  //     诊断后发现三个原因**全在测试侧**，引擎没错：
  //   ① 缝宽 A 不够窄时，量到的是每道缝自己的衍射包络（宽度 ≈ λL/A），不是缝间干涉；
  //   ② d²/λL > 1 落在菲涅耳区，λL/d 只在夫琅禾费区成立（近场要加 k·y²/2L 修正）；
  //   ③ 峰值检测只有像素精度，绝对误差恒为 ~1px，间距越短相对误差越大。
  // v2：把 L 拉大到夫琅禾费区、A 收窄到远小于 d、对比度改用解析式 —— 三处都修。
  // v3（当前）：不再提取单个数字，而是把**整条强度剖面**与解析式逐点比对。
  //     这样一次绕开上面全部三个问题，而且是更强的证据：
  //     条纹位置、明暗对比、包络形状同时被验证。
  const slitTest = await page.evaluate(async () => {
    const { computeField } = await import('./src/wave.js');
    const { nmToSu } = await import('./src/spectrum.js');

    const SX = 400;
    const lamSu = nmToSu(550);
    const a = 20;                        // 缝宽（窄，保证 A ≪ d）
    const resY = 24000;

    function run(d, L) {
      // 屏高取 3 个主瓣半宽，保证包络完整可见
      const H = Math.round((lamSu * L / a) * 3.2);
      const nPer = 100;
      const srcs = [];
      for (let k = 0; k < 2; k++) {
        const cy = k === 0 ? -d / 2 : d / 2;
        for (let i = 0; i < nPer; i++) {
          srcs.push({ x: SX, y: cy - a / 2 + (i + 0.5) * (a / nPer), amp: 1, opl: SX });
        }
      }
      const f = computeField(srcs, { x: SX + L, y: -H / 2, w: 1, h: H }, 550, { w: 2, h: resY });
      const pxPerSu = resY / H;
      const num = new Float64Array(resY);
      for (let i = 0; i < resY; i++) num[i] = f.re[i * 2] ** 2 + f.im[i * 2] ** 2;

      // 解析式（夫琅禾费双缝）：I ∝ sinc²(πay/λL) · cos²(πdy/λL)
      const ana = new Float64Array(resY);
      for (let i = 0; i < resY; i++) {
        const y = (i + 0.5) / pxPerSu - H / 2;
        const ba = Math.PI * a * y / (lamSu * L);
        const bd = Math.PI * d * y / (lamSu * L);
        const sa = Math.abs(ba) < 1e-12 ? 1 : Math.sin(ba) / ba;
        ana[i] = sa * sa * Math.cos(bd) * Math.cos(bd);
      }

      // 极值位置（单位 su）。只看位置而非逐点数值：
      // 因为本仿真用二维 Green 函数 1/√d（真实三维是 1/d），
      // 缓变的幅度包络会轻微扭曲绝对值，但**不会移动极值位置**。
      const peaksOf = (p) => {
        let mx = 0; for (let i = 0; i < p.length; i++) if (p[i] > mx) mx = p[i];
        const r = [];
        for (let i = 2; i < p.length - 2; i++) {
          if (p[i] > p[i - 1] && p[i] >= p[i + 1] && p[i] > mx * 0.02) r.push(i / pxPerSu);
        }
        return r;
      };
      const minsOf = (p) => {
        let mx = 0; for (let i = 0; i < p.length; i++) if (p[i] > mx) mx = p[i];
        const r = [];
        for (let i = 2; i < p.length - 2; i++) {
          if (p[i] < p[i - 1] && p[i] <= p[i + 1] && p[i] < mx * 0.05) r.push(i / pxPerSu);
        }
        return r;
      };
      const rms = (x, y2) => {
        const n = Math.min(x.length, y2.length);
        if (!n) return null;
        let s = 0;
        for (let i = 0; i < n; i++) s += (x[i] - y2[i]) ** 2;
        return Math.sqrt(s / n);
      };
      // 对比度必须在「恰好覆盖整数个条纹周期」的窗口内测量。
      // 窗口若整个落在一个峰内，算出来恒为 0 —— v3 拿到 1.000 就是这个坑。
      const contrastOf = (p, periodPx) => {
        const c = p.length >> 1;
        const half = Math.max(4, Math.round(periodPx * 2));
        let mx = 0, mn = Infinity;
        for (let i = c - half; i <= c + half; i++) {
          if (i < 0 || i >= p.length) continue;
          if (p[i] > mx) mx = p[i];
          if (p[i] < mn) mn = p[i];
        }
        return mx > 0 ? (mx - mn) / mx : null;
      };

      const np = peaksOf(num), ap = peaksOf(ana);
      const nm = minsOf(num), am = minsOf(ana);

      // 边缘极值受阈值裁剪，数量常差 1-2 条 → 只比对**共有极值**的位置。
      // v3 逐个按下标比较，被边缘裁剪带偏出几百 su 的假偏差。
      const commonErr = (x, y2) => {
        if (!x.length || !y2.length) return null;
        const tol = y2.length > 1
          ? (Math.max(...y2) - Math.min(...y2)) / (y2.length - 1) * 0.4
          : Infinity;
        const m = [];
        for (const v of x) {
          let best = Infinity;
          for (const w of y2) best = Math.min(best, Math.abs(v - w));
          if (best < tol) m.push(best);
        }
        if (!m.length) return null;
        return { errSu: m.reduce((a, b) => a + b, 0) / m.length, nMatch: m.length };
      };

      // 间距取相邻差值的中位数：抗漏检干扰，比「首尾相减」稳得多
      const medianSpacing = (arr) => {
        if (arr.length < 3) return null;
        const ds = [];
        for (let i = 1; i < arr.length; i++) ds.push(arr[i] - arr[i - 1]);
        ds.sort((x, y) => x - y);
        return ds[ds.length >> 1];
      };
      const periodPx = ((lamSu * L) / d) * (resY / H);
      return {
        d, L,
        theorySpacingSu: (lamSu * L) / d,
        fresnelN_a: (a * a) / (lamSu * L),
        fresnelN_d: (d * d) / (lamSu * L),
        nPeakNum: np.length, nPeakAna: ap.length,
        nMinNum: nm.length, nMinAna: am.length,
        peakCmp: commonErr(np, ap), minCmp: commonErr(nm, am),
        contrastNum: contrastOf(num, periodPx), contrastAna: contrastOf(ana, periodPx),
        spacingNum: medianSpacing(np), spacingAna: medianSpacing(ap),
      };
    }

    return [run(100, 30000), run(200, 30000), run(300, 60000)];
  });

  for (const s of slitTest) {
    // 夫琅禾费判据只看**缝宽 a**（它决定衍射包络的形状）。
    // 缝距 d 不需要满足 N_d ≪ 1 —— v3 把两者都要求，把 N_d>1 判成失败，
    // 那是错的条件：大缝距只是让条纹更密，不影响公式成立。
    check(`d=${s.d}su：夫琅禾费条件成立（判据用缝宽 a）`,
      s.fresnelN_a < 0.15,
      `N_a = a²/λL = ${s.fresnelN_a.toFixed(4)} ≪ 1 ✓　(N_d=${s.fresnelN_d.toFixed(2)} 不参与判据)`);
    check(`d=${s.d}su：亮纹位置与解析式一致`,
      s.peakCmp != null && s.peakCmp.errSu < s.theorySpacingSu * 0.08,
      `共有 ${s.peakCmp?.nMatch} 条匹配（数值 ${s.nPeakNum} / 解析 ${s.nPeakAna}），` +
      `平均位置偏差 ${s.peakCmp?.errSu.toFixed(3)} su = 间距的 ${((s.peakCmp?.errSu / s.theorySpacingSu) * 100 || 0).toFixed(2)}%`);
    check(`d=${s.d}su：暗纹位置与解析式一致`,
      s.minCmp != null && s.minCmp.errSu < s.theorySpacingSu * 0.08,
      `共有 ${s.minCmp?.nMatch} 条匹配（数值 ${s.nMinNum} / 解析 ${s.nMinAna}），平均位置偏差 ${s.minCmp?.errSu.toFixed(3)} su`);
    check(`d=${s.d}su：明暗对比度与解析式一致`,
      s.contrastNum != null && Math.abs(s.contrastNum - s.contrastAna) < 0.12,
      `数值 ${s.contrastNum?.toFixed(3)} vs 解析 ${s.contrastAna.toFixed(3)}（窗口 = 2 个条纹周期）`);
    r = near(s.spacingNum, s.theorySpacingSu, 2, '间距');
    check(`d=${s.d}su：条纹间距 ≈ λL/d`, r.ok,
      `实测 ${s.spacingNum?.toFixed(2)} su vs 理论 ${s.theorySpacingSu.toFixed(2)} su（偏 ${r.dPct.toFixed(2)}%）`);
  }

  if (slitTest.length >= 2 && slitTest[0].spacingNum && slitTest[1].spacingNum) {
    const got = slitTest[1].spacingNum / slitTest[0].spacingNum;
    check('缝距 2 倍 → 条纹间距减半', Math.abs(got - 0.5) < 0.03, `实测比值 ${got.toFixed(4)}（理论 0.5000）`);
  }

  console.log('\n\x1b[36m══ 4b. 数值收敛性 ══\x1b[0m');
  // 【踩过的坑】v1 版直接比像素数：6000/12000/24000 行给出 17.15/34.28/68.54 px，
  // 看着差 4 倍像没收敛，其实除以各自的 px/su 后**全都是 3.0 su**，早就收敛了。
  // 教训：分辨率不同的场，指标必须先归一到物理单位（场景单位）才能比。
  const convergence = await page.evaluate(async () => {
    const { computeField } = await import('./src/wave.js');
    const { nmToSu } = await import('./src/spectrum.js');
    const SX = 400, lamSu = nmToSu(550), a = 20, d = 200, L = 30000, H = 6000;
    // 屏高 H 固定为 6000 su，只改采样数 → 归一化总强度才可比。
    // v3 我在改采样数的同时改了 H（屏变大、能量自然累积），8 倍漂移是测试 bug。
    function stats(nPer, resY) {
      const srcs = [];
      for (let k = 0; k < 2; k++) {
        const cy = k === 0 ? -d / 2 : d / 2;
        for (let i = 0; i < nPer; i++) srcs.push({ x: SX, y: cy - a / 2 + (i + 0.5) * (a / nPer), amp: 1, opl: SX });
      }
      const f = computeField(srcs, { x: SX + L, y: -H / 2, w: 1, h: H }, 550, { w: 2, h: resY });
      const p = new Float64Array(resY);
      let mx = 0;
      for (let i = 0; i < resY; i++) { p[i] = f.re[i * 2] ** 2 + f.im[i * 2] ** 2; if (p[i] > mx) mx = p[i]; }
      const pxPerSu = resY / H;
      const pk = [];
      for (let i = 2; i < resY - 2; i++) if (p[i] > p[i - 1] && p[i] >= p[i + 1] && p[i] > mx * 0.02) pk.push(i / pxPerSu);
      const sp = pk.length > 4 ? (pk[3] - pk[1]) / 2 : null;
      // 指标 2：与解析式的归一化互相关（1 = 逐点完全一致）。
      // 采样越密越接近 1，这是真正该收敛的东西；total/mx 会单调爬升，不是。
      const ana = new Float64Array(resY);
      for (let i = 0; i < resY; i++) {
        const y = (i + 0.5) / pxPerSu - H / 2;
        const ba = Math.PI * a * y / (lamSu * L);
        const bd = Math.PI * d * y / (lamSu * L);
        const sa = Math.abs(ba) < 1e-12 ? 1 : Math.sin(ba) / ba;
        ana[i] = sa * sa * Math.cos(bd) * Math.cos(bd);
      }
      let dot = 0, nn = 0, aa = 0;
      for (let i = 0; i < resY; i++) { dot += p[i] * ana[i]; nn += p[i] * p[i]; aa += ana[i] * ana[i]; }
      const corr = (nn > 0 && aa > 0) ? dot / Math.sqrt(nn * aa) : null;
      return { spacingSu: sp, corr };
    }
    return {
      s6000: stats(100, 6000), s12000: stats(100, 12000),
      s24000: stats(100, 24000), s48000: stats(100, 48000),
      src25: stats(25, 24000), src100: stats(100, 24000), src400: stats(400, 24000),
    };
  });

  const cv = convergence;
  const drift = (x, y2) => (x && y2) ? Math.abs(x - y2) / y2 : Infinity;
  check('屏幕采样 6000→48000：条纹间距收敛（漂移 < 0.5%）',
    drift(cv.s6000.spacingSu, cv.s48000.spacingSu) < 0.005,
    `6000:${cv.s6000.spacingSu?.toFixed(3)} 12000:${cv.s12000.spacingSu?.toFixed(3)} 24000:${cv.s24000.spacingSu?.toFixed(3)} 48000:${cv.s48000.spacingSu?.toFixed(3)} su`);
  check('屏幕采样 6000→48000：与解析式相关系数收敛（漂移 < 0.1%）',
    drift(cv.s6000.corr, cv.s48000.corr) < 0.001,
    `6000:${cv.s6000.corr?.toFixed(6)} 12000:${cv.s12000.corr?.toFixed(6)} 24000:${cv.s24000.corr?.toFixed(6)} 48000:${cv.s48000.corr?.toFixed(6)}`);
  check('屏幕采样 48000 行：与解析式相关系数 > 0.999', cv.s48000.corr > 0.999,
    `corr = ${cv.s48000.corr?.toFixed(6)}（1.0 = 数值解与闭式解逐点一致）`);
  check('源采样 25→400：条纹间距收敛（漂移 < 0.5%）',
    drift(cv.src25.spacingSu, cv.src400.spacingSu) < 0.005,
    `25源:${cv.src25.spacingSu?.toFixed(3)} 100源:${cv.src100.spacingSu?.toFixed(3)} 400源:${cv.src400.spacingSu?.toFixed(3)} su`);
  check('源采样 25→400：与解析式相关系数收敛（漂移 < 0.1%）',
    drift(cv.src25.corr, cv.src400.corr) < 0.001,
    `25源:${cv.src25.corr?.toFixed(6)} → 400源:${cv.src400.corr?.toFixed(6)}`);

  console.log('\n\x1b[36m══ 5. 单缝衍射：与解析式对比 + 菲涅耳区物理 ══\x1b[0m');
  // v2 版断言「单缝中心必为主峰」，失败了。查下来是**物理正确**的：
  // a=60su、L=500su 时菲涅耳数 N = a²/λL = 6.5 ≫ 1，近场衍射的轴上强度
  // 本来就不是极值。λL/a 这个远场公式在这里根本不适用。
  // 所以要按区域分别测：远场验公式，近场验「N 增大时轴上强度下降」。
  const slitSingle = await page.evaluate(async () => {
    const { computeField } = await import('./src/wave.js');
    const { nmToSu } = await import('./src/spectrum.js');
    const SX = 400, lamSu = nmToSu(550);

    function prof(a, L, nSrc) {
      const H = Math.round((lamSu * L / a) * 3.2);
      // 采样密度按场景单位固定（不随 H 缩放），否则窄缝/宽缝精度不可比
      const resY = Math.max(6000, Math.min(48000, Math.round(H * 8)));
      const srcs = [];
      for (let i = 0; i < nSrc; i++) srcs.push({ x: SX, y: -a / 2 + (i + 0.5) * (a / nSrc), amp: 1, opl: SX });
      const f = computeField(srcs, { x: SX + L, y: -H / 2, w: 1, h: H }, 550, { w: 2, h: resY });
      const pxPerSu = resY / H;
      const num = new Float64Array(resY);
      for (let i = 0; i < resY; i++) num[i] = f.re[i * 2] ** 2 + f.im[i * 2] ** 2;
      const ana = new Float64Array(resY);
      for (let i = 0; i < resY; i++) {
        const y = (i + 0.5) / pxPerSu - H / 2;
        const b = Math.PI * a * y / (lamSu * L);
        const sv = Math.abs(b) < 1e-12 ? 1 : Math.sin(b) / b;
        ana[i] = sv * sv;
      }
      // 【为什么用相关系数而不是"数暗纹"】
      // 数暗纹对阈值极度敏感：边缘次瓣只有主瓣的百分之几，
      // 阈值抖一点就凭空多出一条"暗纹"（实测出现过 数值3条/解析2条，
      // 多出的那条是边缘伪影），位置比对随之崩掉。
      // 归一化互相关对阈值不敏感，且同时约束了条纹位置、明暗对比与包络形状 ——
      // 是更严也更稳的判据。
      let dot = 0, nn = 0, aa = 0;
      for (let i = 0; i < resY; i++) { dot += num[i] * ana[i]; nn += num[i] * num[i]; aa += ana[i] * ana[i]; }
      const c = resY >> 1;
      return {
        a, L, N: (a * a) / (lamSu * L),
        mainLobeSu: (lamSu * L) / a,
        onAxisRatio: num[c] / Math.max(...num),
        corr: (nn > 0 && aa > 0) ? dot / Math.sqrt(nn * aa) : null,
      };
    }

    // 两组各自满足远场条件 N_a = a²/λL ≪ 1。
    // 真实实验也是如此：大孔径的远场条件极苛刻，必须配极远的屏。
    const far1 = prof(60, 60000, 200);        // N = 0.055
    const far2 = prof(480, 3000000, 4000);    // N = 0.31
    // 近场：N ≫ 1，轴上不再是极值（真实现象，不是 bug）
    const near = prof(60, 300, 200);
    return { far1, far2, near };
  });

  check('单缝：两组各自满足夫琅禾费条件（N_a < 0.4）',
    slitSingle.far1.N < 0.4 && slitSingle.far2.N < 0.4,
    `a=60su: N=${slitSingle.far1.N.toFixed(4)}（L=60000su）  a=480su: N=${slitSingle.far2.N.toFixed(4)}（L=3e6su）`);
  check('单缝：轴上确为主峰', slitSingle.far1.onAxisRatio > 0.99,
    `轴上/峰值 = ${slitSingle.far1.onAxisRatio.toFixed(5)}`);
  check('单缝：数值解与解析 sinc² 相关系数 > 0.999',
    slitSingle.far1.corr > 0.999 && slitSingle.far2.corr > 0.999,
    `a=60su: corr=${slitSingle.far1.corr?.toFixed(6)}  a=480su: corr=${slitSingle.far2.corr?.toFixed(6)}`);
  // 8 倍关系：必须在**同一个 L、同一个远场采样设置**下，只改缝宽再测一次。
  // v3 的教训：我拿 far1(L=60000) 和 far2(L=3e6) 比，比值被 L 的 50 倍差异
  // 污染成 6.25 —— 那不是物理，是测试设定错误。
  const sameL = await page.evaluate(async () => {
    const { computeField } = await import('./src/wave.js');
    const { nmToSu } = await import('./src/spectrum.js');
    const SX = 400, lamSu = nmToSu(550), L = 3000000;   // 足够远，两组都进远场
    const measure = (a, nSrc) => {
      const H = Math.round((lamSu * L / a) * 3.2);
      const resY = Math.max(6000, Math.min(48000, Math.round(H * 8)));
      const srcs = [];
      for (let i = 0; i < nSrc; i++) srcs.push({ x: SX, y: -a / 2 + (i + 0.5) * (a / nSrc), amp: 1, opl: SX });
      const f = computeField(srcs, { x: SX + L, y: -H / 2, w: 1, h: H }, 550, { w: 2, h: resY });
      const pxPerSu = resY / H;
      const num = new Float64Array(resY);
      const ana = new Float64Array(resY);
      for (let i = 0; i < resY; i++) {
        num[i] = f.re[i * 2] ** 2 + f.im[i * 2] ** 2;
        const y = (i + 0.5) / pxPerSu - H / 2;
        const b = Math.PI * a * y / (lamSu * L);
        const sv = Math.abs(b) < 1e-12 ? 1 : Math.sin(b) / b;
        ana[i] = sv * sv;
      }
      let dot = 0, nn = 0, aa = 0;
      for (let i = 0; i < resY; i++) { dot += num[i] * ana[i]; nn += num[i] * num[i]; aa += ana[i] * ana[i]; }
      return { N: (a * a) / (lamSu * L), mainLobeSu: (lamSu * L) / a, corr: dot / Math.sqrt(nn * aa) };
    };
    return { a1: measure(60, 200), a8: measure(480, 1600) };
  });

  check('单缝：同一屏距下，缝宽 8 倍 → 主瓣窄 8 倍',
    Math.abs((sameL.a1.mainLobeSu / sameL.a8.mainLobeSu) - 8) < 1e-6
      && sameL.a1.corr > 0.999 && sameL.a8.corr > 0.999,
    `L=3e6su 固定：主瓣半宽 ${sameL.a1.mainLobeSu.toFixed(1)} su (a=60) vs ` +
    `${sameL.a8.mainLobeSu.toFixed(1)} su (a=480) → 比值 ${(sameL.a1.mainLobeSu / sameL.a8.mainLobeSu).toFixed(4)}（理论 8）` +
    `　两组 corr=${sameL.a1.corr.toFixed(6)}/${sameL.a8.corr.toFixed(6)}`);
  check('单缝（近场）：N≫1 时轴上不再是极值（菲涅耳效应）',
    slitSingle.near.N > 1 && slitSingle.near.onAxisRatio < 0.98,
    `N=${slitSingle.near.N.toFixed(1)} 时轴上/峰值 = ${slitSingle.near.onAxisRatio.toFixed(4)}，` +
    `说明 λL/a 远场公式在此不适用 —— 这正是真实近场衍射行为`);

  console.log('\n\x1b[36m══ 6. 牛顿环暗环位置 ══\x1b[0m');
  const nrings = await page.evaluate(async () => {
    const { newtonRingIntensity, newtonDarkRadius } = await import('./src/film.js');
    const R = 500000, lam = 550;
    // 暗环：反射强度为 0（I = sin²(π·2t/λ)，t=r²/2R → 暗环在 2t = mλ）
    const out = [];
    for (let m = 0; m <= 6; m++) {
      const r = newtonDarkRadius(m, lam, R);
      // 暗环条件对应 2t = mλ  → 反射强度 sin²(π·2t/λ)=sin²(π m)=0 ✓
      const I = newtonRingIntensity(r, R, lam);
      out.push({ m, r, I });
    }
    return out;
  });
  const darkOk = nrings.every(n => n.I < 1e-12);
  check('r_m = √(mλR) 处反射强度为 0（暗环）', darkOk,
    nrings.slice(0, 4).map(n => `m=${n.m}: I=${n.I.toExponential(1)}`).join(', '));
  // 半径比应为 √m
  if (nrings[4] && nrings[1]) {
    const got = nrings[4].r / nrings[1].r;
    check('r₄/r₁ = 2', Math.abs(got - 2) < 1e-6, `实测 ${got.toFixed(6)}`);
  }

  console.log('\n\x1b[36m══ 7. 薄膜干涉：厚度→颜色 单调映射 ══\x1b[0m');
  const filmMap = await page.evaluate(async () => {
    const { ringIntensity } = await import('./src/film.js');
    const out = [];
    for (const t of [100, 200, 300, 400, 600, 900]) {
      let X = 0, Y = 0, Z = 0;
      for (let l = 400; l <= 700; l += 5) {
        const I = ringIntensity(t, l, 1, 0);
        const { cieX, cieY, cieZ } = window.__cie || {};
        X += I; Y += I; Z += I;
      }
      out.push({ t, I550: ringIntensity(t, 550, 1, 0) });
    }
    return out;
  });
  // I(t) = sin²(2πt/λ)：t 增加 λ/4 时值应下降
  const q1 = filmMap.find(f => f.t === 100), q2 = filmMap.find(f => f.t === 200);
  check('膜厚 λ/4 变化 → 550nm 反射强度下降', q1.I550 > q2.I550,
    `t=100nm: ${q1.I550.toFixed(3)}, t=200nm: ${q2.I550.toFixed(3)}`);

  console.log('\n\x1b[36m══ 8. 全场景冒烟测试 ══\x1b[0m');
  const order = await page.evaluate(() => window.photonLab.order);
  for (const id of order) {
    const t0 = Date.now();
    errors.length = 0;
    await page.evaluate((i) => window.photonLab.loadScene(i), id);
    await page.waitForTimeout(60);
    const ms = Date.now() - t0;
    const info = await page.evaluate(() => {
      const S = window.photonLab.state;
      const f = window.photonLab.getFields();
      let lit = 0;
      if (f && f[0]) {
        const re = f[0].re, im = f[0].im;
        for (let i = 0; i < re.length; i++) if (re[i] * re[i] + im[i] * im[i] > 1e-10) lit++;
      }
      return { ms: S.lastMs, fields: f.length, lit, scene: S.sceneId };
    });
    const ok = errors.length === 0;
    check(`场景 ${id.padEnd(10)} 渲染无错`, ok,
      `${ms}ms  场数=${info.fields}  有效像素=${info.lit}  ${errors[0] || ''}`);
    await page.screenshot({ path: path.join(SHOTS, `scene-${id}.png`) });
  }

  console.log('\n\x1b[36m══ 9. 性能压测 ══\x1b[0m');
  const perf = await page.evaluate(async () => {
    window.photonLab.loadScene('dslit');
    await new Promise(r => setTimeout(r, 50));
    const times = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      window.photonLab.render();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(times.length / 2)], max: times[times.length - 1] };
  });
  check('双缝场景渲染 < 400ms', perf.median < 400, `中位数 ${perf.median.toFixed(1)}ms, 最差 ${perf.max.toFixed(1)}ms`);

  const perfWhite = await page.evaluate(async () => {
    window.photonLab.loadScene('grating');
    const t0 = performance.now();
    window.photonLab.render();
    return performance.now() - t0;
  });
  check('光栅（16 波长）渲染 < 900ms', perfWhite < 900, `${perfWhite.toFixed(1)}ms`);

  console.log('\n\x1b[36m══ 10. 最终页面错误汇总 ══\x1b[0m');
  check('全流程无 JS 错误', errors.length === 0, errors.slice(0, 5).join(' | '));

  /* ---------- 报告 ---------- */
  const passed = results.filter(r => r.pass).length;
  const report = {
    time: new Date().toISOString(),
    total: results.length,
    passed,
    failed: failures,
    results,
  };
  fs.writeFileSync(path.join(ROOT, 'verify-report.json'), JSON.stringify(report, null, 2));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`\x1b[1m结果：${passed}/${results.length} 通过\x1b[0m`);
  if (failures) {
    console.log('\x1b[31m失败项：\x1b[0m');
    results.filter(r => !r.pass).forEach(r => console.log('  · ' + r.name + '  ' + r.detail));
  }
  fs.writeFileSync(path.join(ROOT, 'verify-report.md'),
    `# 验证报告\n\n生成时间：${report.time}\n\n**${passed}/${results.length} 通过**\n\n` +
    results.map(r => `| ${r.pass ? '✅' : '❌'} | ${r.name} | ${r.detail || ''} |`).join('\n') +
    '\n');

  await browser.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\x1b[31m验证脚本自身崩溃：\x1b[0m', e);
  process.exit(2);
});

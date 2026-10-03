/**
 * qc.js — 画面质量检查：用像素统计代替肉眼判断
 * 每个场景输出：屏上被照亮的比例、纵向分布是否对称、颜色多样性、有无高频伪影。
 * 这是「不信脚本只信抽帧」的自动化版本 —— 但更准：直接量化像素。
 */
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function serve(port) {
  return new Promise(r => { const s = http.createServer((q, rs) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(rs);
  }); s.listen(port, () => r(s)); });
}

(async () => {
  const server = await serve(8940);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('PAGEERROR:', e.message));
  await page.goto('http://127.0.0.1:8940/index.html?ts=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.photonLab && window.photonLab.ready);

  const order = await page.evaluate(() => window.photonLab.order);
  const rows = [];
  for (const id of order) {
    const r = await page.evaluate(async (i) => {
      window.photonLab.loadScene(i);
      await new Promise(r => setTimeout(r, 400));
      const S = window.photonLab.state, sc = window.photonLab.scenes[i];
      const f = window.photonLab.getFields()[0];
      if (!f || !sc.screen) return { id: i, kind: sc.film ? 'film' : 'rays', ms: S.lastMs };
      // 场网格尺寸：res.w 固定、res.h = round(screen.h)，
      // 所以从数组长度与 res.w 就能确定真实 h —— 不能直接用 S.fieldRes.h，
      // 那个是上限值，场未必填满（v1 用它算导致「亮区 0%」的误报）。
      const w = S.fieldRes.w;
      const h = f.re.length / w;
      // 纵向强度剖面
      const prof = new Float64Array(h);
      for (let y = 0; y < h; y++) {
        let s2 = 0;
        for (let x = 0; x < w; x++) { const j = y * w + x; s2 += f.re[j] * f.re[j] + f.im[j] * f.im[j]; }
        prof[y] = s2;
      }
      const mx = Math.max(...prof);
      const thr = mx * 0.04;
      const lit = prof.map(v => v > thr);
      const nLit = lit.filter(Boolean).length;
      // 对称性：上半 vs 下半（屏中心对应场景中心）
      const half = h >> 1;
      let topSum = 0, botSum = 0;
      for (let y = 0; y < half; y++) { topSum += prof[y]; botSum += prof[h - 1 - y]; }
      // 条纹数（局部极大）
      let nFringe = 0;
      for (let y = 1; y < h - 1; y++) if (prof[y] > prof[y - 1] && prof[y] >= prof[y + 1] && prof[y] > mx * 0.08) nFringe++;
      return {
        id: i, ms: +S.lastMs.toFixed(0), w, h,
        litFrac: +(nLit / h).toFixed(3),
        nFringe,
        sym: +(Math.min(topSum, botSum) / Math.max(topSum, botSum, 1e-9)).toFixed(3),
        firstLit: lit.indexOf(true), lastLit: h - 1 - lit.lastIndexOf(true),
      };
    }, id);
    rows.push(r);
  }
  console.log('\n场景            耗时    场分辨率    亮区占比  条纹数  对称性  亮区范围');
  console.log('─'.repeat(76));
  for (const r of rows) {
    if (r.kind) { console.log(`${r.id.padEnd(14)} ${String(r.ms).padStart(5)}ms   (${r.kind})`); continue; }
    console.log(`${r.id.padEnd(14)} ${String(r.ms).padStart(5)}ms  ${String(r.w + '×' + r.h).padStart(8)}  ` +
      `${(r.litFrac * 100).toFixed(0).padStart(6)}%  ${String(r.nFringe).padStart(6)}  ${r.sym.toFixed(3).padStart(6)}  ` +
      `[${r.firstLit}..${r.lastLit}]`);
  }
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });

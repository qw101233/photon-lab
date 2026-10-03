/**
 * shot.js — 场景截图（用于文档与图文素材）
 * 用法：node tools/shot.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve(port) {
  return new Promise((res) => {
    const s = http.createServer((req, rq) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end(); return; }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rq);
    });
    s.listen(port, () => res(s));
  });
}

/* 裁出「演示视图」：只保留有内容的区域。
 * 【为什么要裁】场景画布是 1000×620 的固定世界坐标，
 * 但双缝这类场景的有效内容（缝 + 屏）只占中间一小块，
 * 直接贴进 9:16 幻灯片会有 60% 是空白，条纹小到看不清。
 * 这里按「屏 + 主要元件」的并集算包围盒，再留 4% 余量。
 */
async function cropDemo(page, id) {
  const box = await page.evaluate((sceneId) => {
    const sc = window.photonLab.scenes[sceneId];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { if (x<x0)x0=x; if (y<y0)y0=y; if (x>x1)x1=x; if (y>y1)y1=y; };
    // 光源
    if (sc.source && sc.source.type === 'collimated') {
      add(sc.source.x - 30, sc.source.y - sc.source.beamW/2 - 20);
      add(sc.source.x + 30, sc.source.y + sc.source.beamW/2 + 20);
    }
    // 元件
    for (const e of (sc.elements||[])) {
      if (e.pts) for (const p of e.pts) add(p.x, p.y);
      if (e.segs) for (const sg of e.segs) { add(sg[0].x,sg[0].y); add(sg[1].x,sg[1].y); }
      if (e.openings) for (const o of e.openings) { add(o[0].x,o[0].y); add(o[1].x,o[1].y); }
      if (e.core) for (const p of e.core) add(p.x,p.y);
      if (e.wallTop) for (const p of e.wallTop) add(p.x,p.y);
      if (e.wallBot) for (const p of e.wallBot) add(p.x,p.y);
      if (e.cx!=null) add(e.cx,e.cy);
    }
    // 屏
    if (sc.screen) { add(sc.screen.x, sc.screen.y); add(sc.screen.x+sc.screen.w, sc.screen.y+sc.screen.h); }
    // 薄膜是整幅画面
    if (sc.film) return { x0:0, y0:0, x1:1000, y1:620 };
    if (x0 === Infinity) return { x0:0, y0:0, x1:1000, y1:620 };
    const pad = 24;
    return { x0:Math.max(0,x0-pad), y0:Math.max(0,y0-pad), x1:Math.min(1000,x1+pad), y1:Math.min(620,y1+pad) };
  }, id);

  const el = await page.$('#scene');
  const r = await el.boundingBox();
  // 世界坐标 → 元素像素坐标
  const sx = r.width / 1000, sy = r.height / 620;
  const clip = {
    x: r.x + box.x0 * sx, y: r.y + box.y0 * sy,
    width: (box.x1 - box.x0) * sx, height: (box.y1 - box.y0) * sy,
  };
  // 演示视图统一做成 3:2 左右，适配幻灯片
  const targetH = Math.max(clip.height, clip.width / 1.9);
  clip.height = targetH;
  clip.y = Math.max(0, clip.y - (targetH - (box.y1-box.y0)*sy) / 2);
  await page.screenshot({ path: path.join(SHOTS, `demo-${id}.png`), clip });
}


/* 屏幕特写：把接收屏单独放大，用于图文里展示条纹细节。
 * 【为什么单独出图】屏在整幅场景里只占 ~10% 面积，
 * 贴进幻灯片后条纹只有几十像素高，完全看不出干涉结构。
 */
async function cropScreen(page, id) {
  const sc = await page.evaluate((i) => {
    const s = window.photonLab.scenes[i];
    return s.screen ? { x: s.screen.x, y: s.screen.y, w: s.screen.w, h: s.screen.h } : null;
  }, id);
  if (!sc) return;
  const el = await page.$('#scene');
  const r = await el.boundingBox();
  const sx = r.width / 1000, sy = r.height / 620;
  const pad = 14;
  await page.screenshot({
    path: path.join(SHOTS, `screen-${id}.png`),
    clip: {
      x: Math.max(r.x, r.x + (sc.x - pad) * sx),
      y: Math.max(r.y, r.y + (sc.y - pad) * sy),
      width: (sc.w + pad * 2) * sx,
      height: (sc.h + pad * 2) * sy,
    },
  });
}

/* 薄膜/牛顿环的「纯渲染图」：不含任何 UI 元素。
 * 薄膜本身是全屏内容，套在场景截图里会带上侧栏和按钮，
 * 贴进图文很脏。这里直接把膜的画布抠出来单独出图。
 */
async function shotFilmOnly(page, id) {
  const ok = await page.evaluate((i) => !!window.photonLab.scenes[i].film, id);
  if (!ok) return;
  await page.evaluate((i) => {
    const sc = window.photonLab.scenes[i];
    // 复用页面里已经画好的薄膜离屏画布：它就是纯内容
    window.__filmOut = window.__filmOut || null;
  }, id);
  // filmCanvas 是模块内的私有变量，改为直接从主画布裁剪中央区域
  const el = await page.$('#scene');
  const r = await el.boundingBox();
  const sc = await page.evaluate((i) => {
    const f = window.photonLab.scenes[i].film;
    return f ? { cx: f.cx, cy: f.cy, R: f.R } : null;
  }, id);
  if (!sc) return;
  const sx = r.width / 1000, sy = r.height / 620;
  const side = (sc.R + 14) * 2;
  await page.screenshot({
    path: path.join(SHOTS, `film-only-${id}.png`),
    clip: {
      x: r.x + (sc.cx - sc.R - 14) * sx, y: r.y + (sc.cy - sc.R - 14) * sy,
      width: side * sx, height: side * sy,
    },
  });
}
(async () => {
  const server = await serve(8933);
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', e => console.error('PAGEERROR:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });

  await page.goto('http://127.0.0.1:8933/index.html?ts=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.photonLab && window.photonLab.ready);

  const order = await page.evaluate(() => window.photonLab.order);
  fs.mkdirSync(SHOTS, { recursive: true });

  for (const id of order) {
    await page.evaluate((i) => { window.photonLab.loadScene(i); }, id);
    await page.waitForTimeout(500);          // 等重绘 + 场收敛
    // 截图两种：① 完整画布（README 用）② 裁掉大片留白的「演示视图」（图文用）
    const el = await page.$('#canvasWrap');
    await el.screenshot({ path: path.join(SHOTS, `scene-${id}.png`) });
    await cropDemo(page, id);
    await cropScreen(page, id);
    await shotFilmOnly(page, id);
    const info = await page.evaluate(() => ({
      ms: window.photonLab.state.lastMs,
      fields: window.photonLab.getFields().length,
    }));
    console.log(`  ✓ ${id.padEnd(11)} ${info.ms.toFixed(0)}ms  场数=${info.fields}`);
  }

  // 整页截图（含 UI，用于 README 顶部展示）
  await page.evaluate(() => { window.photonLab.loadScene('dslit'); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'full-ui.png') });
  console.log('  ✓ full-ui');

  await browser.close();
  server.close();
  console.log('\n截图完成 →', SHOTS);
})().catch(e => { console.error(e); process.exit(1); });

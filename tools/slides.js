/**
 * slides.js — 生成 9:16 竖屏图文（抖音比例 1080×1920）
 * 每张是一个 HTML，用 Playwright 按同尺寸 viewport 截图。
 * 用法：node tools/slides.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'slides');
const SHOTS = path.join(ROOT, 'shots');

const W = 1080, H = 1920;

/* ---------- 通用样式 ---------- */
const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{
  width:${W}px;height:${H}px;overflow:hidden;
  font-family:"PingFang SC","Microsoft YaHei","Segoe UI",-apple-system,sans-serif;
  background:radial-gradient(900px 700px at 20% -8%, #16294a 0%, #0a1120 45%, #05070f 100%);
  color:#e8f0fb;position:relative;
}
.glow{position:absolute;border-radius:50%;filter:blur(90px);opacity:.30;pointer-events:none}
.g1{width:820px;height:820px;background:#1e5fa8;top:-240px;left:-260px}
.g2{width:700px;height:700px;background:#7b3fa0;bottom:-200px;right:-240px}
.wrap{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;
  padding:96px 76px 84px}
.kicker{display:flex;align-items:center;gap:16px;font-size:26px;letter-spacing:6px;
  color:#6fa8e0;font-weight:600}
.kicker .bar{width:56px;height:5px;background:linear-gradient(90deg,#4ea3ff,#7ee0c0);
  border-radius:3px}
h1{font-size:96px;line-height:1.14;font-weight:800;letter-spacing:-1px;margin-top:26px}
h1 em{font-style:normal;background:linear-gradient(100deg,#6fc3ff,#8affd8);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:34px;line-height:1.6;color:#9fb6d4;margin-top:22px}
.body{flex:1;display:flex;flex-direction:column;justify-content:space-evenly;gap:24px;padding:18px 0}
/* 图片框：不裁切、不拉伸，按原比例居中。
 * 【踩坑】先后试过 object-fit:cover（裁掉屏）、contain（上下黑边）——
 * 竖屏 9:16 里横图只能二选一，都难看。
 * 正解：图片框给固定高度（不是 flex:1），图按 contain 居中，
 * 剩余空间由文字块自然填充，视觉上更平衡。 */
.grow{border-radius:24px;overflow:hidden;height:560px;
  border:1px solid rgba(110,160,220,.26);box-shadow:0 26px 70px rgba(0,0,0,.62);
  display:flex;align-items:center;justify-content:center;background:#070b14}
.grow img{width:100%;height:100%;object-fit:contain;display:block}
.grow.tall{height:900px}
.pair{display:flex;gap:26px;align-items:stretch}
.sq{flex:0 0 300px;height:400px;border-radius:20px;overflow:hidden;
  border:1px solid rgba(110,160,220,.26);background:#070b14}
.sq img{width:100%;height:100%;object-fit:cover;display:block}
.side{flex:1;display:flex;align-items:center}
.duo{display:flex;gap:20px;height:600px}
.duo>div{border-radius:22px;overflow:hidden;border:1px solid rgba(110,160,220,.26);
  box-shadow:0 22px 60px rgba(0,0,0,.6);background:#070b14}
.duo-a{flex:1.55}
.duo-b{flex:1}
.duo img{width:100%;height:100%;object-fit:cover;display:block}
.labels{display:flex;gap:20px;font-size:24px;color:#5f7799}
.labels span{flex:1.55;text-align:center}
.labels span+span{flex:1}
.flow{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.fnode{flex:1;background:rgba(20,32,56,.7);border:1px solid rgba(110,160,220,.24);
  border-radius:16px;padding:18px 8px;text-align:center;font-size:25px;font-weight:600}
.fnode span{display:block;font-size:20px;color:#6f8fb4;font-weight:400;margin-top:6px}
.fnode.hi{border-color:rgba(78,163,255,.5);color:#9fd0ff;
  box-shadow:0 0 24px rgba(78,163,255,.16)}
.farrow{color:#4a6284;font-size:26px;flex:0 0 auto}
.card{background:rgba(20,32,56,.62);border:1px solid rgba(110,160,220,.22);
  border-radius:26px;padding:38px 40px}
.card h3{font-size:30px;color:#7ee0c0;font-weight:700;margin-bottom:16px;
  display:flex;align-items:center;gap:14px}
.card h3::before{content:'';width:8px;height:30px;background:#7ee0c0;border-radius:4px}
.card p{font-size:29px;line-height:1.72;color:#c3d4e8}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
.eq{background:rgba(10,18,32,.85);border:1px solid rgba(110,160,220,.18);
  border-radius:18px;padding:26px 30px;font-size:30px;color:#ffd98a;
  text-align:center;letter-spacing:1px}
.foot{font-size:26px;color:#5f7799;display:flex;justify-content:space-between;
  align-items:center;padding-top:30px;border-top:1px solid rgba(110,160,220,.14)}
.shotwrap{border-radius:24px;overflow:hidden;border:1px solid rgba(110,160,220,.26);
  box-shadow:0 26px 70px rgba(0,0,0,.62)}
.shotwrap img{width:100%;display:block}
.shotwrap.ratio img{aspect-ratio:16/10;object-fit:cover}
.hero{margin:26px -20px 0}
.hero img{width:calc(100% + 40px);display:block}
.cap{font-size:25px;color:#8fa6c4;margin-top:16px;text-align:center;line-height:1.5}
.num{position:absolute;top:64px;right:76px;font-size:26px;color:#4a6284;
  font-family:ui-monospace,monospace}
ul{list-style:none}
li{font-size:29px;line-height:1.7;color:#c3d4e8;padding-left:38px;position:relative;margin-bottom:12px}
li::before{content:'▸';position:absolute;left:0;color:#4ea3ff}
.tag{display:inline-block;padding:8px 20px;border-radius:999px;font-size:24px;
  background:rgba(78,163,255,.16);border:1px solid rgba(78,163,255,.36);color:#9fd0ff;
  margin-right:12px}
`;

/* ---------- 幻灯片定义 ---------- */
const SLIDES = [
  {
    file: '01-cover.html',
    html: `
<div class="glow g1"></div><div class="glow g2"></div>
<div class="num">01 / 07</div>
<div class="wrap">
  <div class="kicker"><span class="bar"></span>PHOTONLAB</div>
  <h1>把<em>光的本性</em><br>算给你看</h1>
  <p class="sub">二维光学实验室 · 几何追迹 × 波动干涉</p>
  <div class="body">
    <div class="duo">
      <div class="duo-a"><img src="../shots/demo-dslit.png"></div>
      <div class="duo-b"><img src="../shots/screen-dslit.png"></div>
    </div>
    <div class="labels"><span>双缝装置</span><span>屏幕特写</span></div>
    <p class="cap" style="font-size:28px">白光穿过双缝 —— 屏幕上自己长出的彩色条纹<br>
      <span style="color:#5f7799">条纹不是画上去的，是复振幅叠加算出来的</span></p>
    <div class="card" style="padding:30px 34px">
      <p style="font-size:27px">10 个实验场景 · 52 项物理验证全通过<br>
      与解析闭式解的相关系数 <b style="color:#7ee0c0">0.99991</b></p>
    </div>
  </div>
  <div class="foot"><span>零依赖 · 单页应用</span><span>10 个实验场景</span></div>
</div>`
  },
  {
    file: '02-why.html',
    html: `
<div class="glow g1"></div><div class="glow g2"></div>
<div class="num">02 / 07</div>
<div class="wrap">
  <div class="kicker"><span class="bar"></span>WHY</div>
  <h1>几何光学<br><em>看不到干涉</em></h1>
  <p class="sub">这不是渲染质量问题，是物理本身的限制</p>
  <div class="body">
    <div class="card">
      <h3>光线只会直走、折射、反射</h3>
      <p>纯几何光学追迹一万条光线，双缝实验的结果依然是「两条亮线」——
         它<b>原理上</b>看不到条纹和衍射。</p>
    </div>
    <div class="card">
      <h3>波动性来自惠更斯原理</h3>
      <p>波面上<b>每一点</b>都是二级波源。把缝隙开口上的每一点当成独立波源，
         各带自己的相位，向屏幕辐射球面波，再把复振幅加起来——
         条纹就<b>自己长出来了</b>。</p>
    </div>
    <div class="eq mono">E(P) = Σⱼ aⱼ · e<sup>i·k·dⱼ</sup> / √dⱼ</div>
    <p class="cap">屏幕每一点的复振幅 = 所有二级波源贡献之和</p>
  </div>
</div>`
  },
  {
    file: '03-arch.html',
    html: `
<div class="glow g1"></div><div class="glow g2"></div>
<div class="num">03 / 07</div>
<div class="wrap">
  <div class="kicker"><span class="bar"></span>ARCHITECTURE</div>
  <h1>两套引擎<br><em>共用一份几何</em></h1>
  <p class="sub">几何追迹与波动求解，缝合成一条流水线</p>
  <div class="body">
    <div class="flow">
      <div class="fnode">光源<span>λ₁…λₙ</span></div>
      <div class="farrow">→</div>
      <div class="fnode hi">几何追迹<span>Snell·Fresnel</span></div>
      <div class="farrow">→</div>
      <div class="fnode hi">惠更斯叠加<span>Σ e<sup>ikd</sup></span></div>
      <div class="farrow">→</div>
      <div class="fnode">CIE 合成<span>→ sRGB</span></div>
    </div>
    <div class="card">
      <h3>① 几何层：Snell + Fresnel + Cauchy</h3>
      <p>逐次求交 → 折射 / 反射 / 全反射，按 Fresnel 系数分配能量。
         折射率按 Cauchy 方程 n(λ)=A+B/λ² <b>逐波长</b>计算，
         所以紫光偏折天然比红光大。</p>
    </div>
    <div class="card">
      <h3>② 波动层：惠更斯-菲涅尔叠加</h3>
      <p>每条光线累计<b>光程 OPL</b>，落点带自己的相位 e<sup>i·2π·OPL/λ</sup>。
         多条光线在同一像素叠加 → 干涉条纹。</p>
    </div>
    <div class="card">
      <h3>③ 色度层：CIE 1931 合成</h3>
      <p>每个波长独立求场，按 CIE 配色函数加权合成 XYZ → sRGB。
         <b>干涉的彩色是算出来的，不是画上去的。</b></p>
    </div>
  </div>
</div>`
  },
  {
    file: '04-prism.html',
    html: `
<div class="glow g1"></div><div class="glow g2"></div>
<div class="num">04 / 07</div>
<div class="wrap">
  <div class="kicker"><span class="bar"></span>01 · 棱镜色散</div>
  <h1>白光被拆成<em>一条光谱</em></h1>
  <p class="sub">正常色散：n(λ) 随波长下降，短波偏折更强</p>
  <div class="body">
    <div class="shotwrap grow"><img src="../shots/demo-prism.png"></div>
    <div class="pair">
      <div class="shotwrap sq"><img src="../shots/screen-prism.png"></div>
      <div class="side">
        <p class="cap" style="text-align:left;font-size:27px;line-height:1.62">
          <b style="color:#7ee0c0">出射光谱</b><br>
          紫光偏折最强 → 红光最弱<br>
          <b style="color:#ffd98a">光谱是逐波长<br>追迹出来的</b><br>
          <span style="color:#5f7799">不是贴图</span></p>
      </div>
    </div>
    <div class="eq mono">δ = 2·arcsin(n·sin(A/2)) − A</div>
    <p class="cap">顶点角越小、n 越大 → 色散越明显</p>
  </div>
</div>`
  },
  {
    file: '05-dslit.html',
    html: `
<div class="glow g1"></div><div class="glow g2"></div>
<div class="num">05 / 07</div>
<div class="wrap">
  <div class="kicker"><span class="bar"></span>02 · 双缝干涉</div>
  <h1>两束光<em>自己叠出条纹</em></h1>
  <p class="sub">中心全波长同相 → 白；两侧红光条纹最疏、紫光最密</p>
  <div class="body">
    <div class="shotwrap grow"><img src="../shots/demo-dslit.png"></div>
    <div class="pair">
      <div class="shotwrap sq"><img src="../shots/screen-dslit.png"></div>
      <div class="side">
        <p class="cap" style="text-align:left;font-size:27px;line-height:1.62">
          <b style="color:#7ee0c0">屏幕特写</b><br>
          中心处全波长同相 → 白亮<br>
          向外依次出现彩色条纹<br>
          <b style="color:#ffd98a">红光条纹最疏<br>紫光条纹最密</b></p>
      </div>
    </div>
    <div class="eq mono">Δx = λL / d　　缝越窄、屏越远，条纹越疏</div>
  </div>
</div>`
  },
  {
    file: '06-diffraction.html',
    html: `
<div class="glow g1"></div><div class="glow g2"></div>
<div class="num">06 / 07</div>
<div class="wrap">
  <div class="kicker"><span class="bar"></span>03 · 衍射与光栅</div>
  <h1>光会<em>绕过障碍</em></h1>
  <p class="sub">缝越窄，衍射越宽 —— 波动性的铁证</p>
  <div class="body">
    <div class="shotwrap grow"><img src="../shots/demo-grating.png"></div>
    <div class="pair">
      <div class="shotwrap sq"><img src="../shots/screen-grating.png"></div>
      <div class="side">
        <p class="cap" style="text-align:left;font-size:27px;line-height:1.62">
          <b style="color:#7ee0c0">各级衍射</b><br>
          中央 0 级最亮<br>
          ±1 级出现完整彩虹<br>
          <b style="color:#ffd98a">要 d ≫ a<br>级次才分得开</b></p>
      </div>
    </div>
    <div class="eq mono">d · sinθ = mλ</div>
  </div>
</div>`
  },
  {
    file: '07-film.html',
    html: `
<div class="glow g1"></div><div class="glow g2"></div>
<div class="num">07 / 07</div>
<div class="wrap">
  <div class="kicker"><span class="bar"></span>04 · 薄膜干涉</div>
  <h1>几百纳米厚度<br><em>走出整个色轮</em></h1>
  <p class="sub">牛顿色序：黑→白→黄→品红→蓝→绿，循环往复</p>
  <div class="body">
    <div class="shotwrap grow tall"><img src="../shots/film-only-film.png"></div>
    <div class="eq mono">Δ = 2·n·t·cosθ<sub>t</sub> + λ/2</div>
    <p class="cap">那个 <b style="color:#ffd98a">λ/2 半波损失</b>，就是圆心为什么是暗点的原因<br>
      环上颜色随厚度连续流转 —— 牛顿色序</p>
  </div>
  <div class="foot"><span>PhotonLab</span><span>全部现象实时求解</span></div>
</div>`
  },
];

/* ---------- 运行 ---------- */
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  SLIDES.forEach(s => {
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${CSS}</style></head><body>${s.html}</body></html>`;
    fs.writeFileSync(path.join(OUT, s.file), html, 'utf-8');
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('PAGEERROR', s.file, e.message));

  for (const s of SLIDES) {
    await page.goto('file:///' + path.join(OUT, s.file).replace(/\\/g, '/'));
    await page.waitForTimeout(300);
    const outName = s.file.replace('.html', '.png');
    await page.screenshot({ path: path.join(SHOTS, outName) });
    console.log('  ✓', outName);
  }

  await browser.close();
  console.log('\n图文已生成 →', SHOTS);
})().catch(e => { console.error(e); process.exit(1); });

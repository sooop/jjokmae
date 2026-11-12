// 항목7: 실제 브라우저(Chrome headless)에서 PDF.js 로 한글 미내장 PDF 렌더
import fs from 'fs'; import http from 'http'; import path from 'path';
import { chromium } from 'playwright-core';
const root = path.resolve('.');
const html = `<!doctype html><meta charset=utf-8><body style="margin:0"><canvas id=c></canvas><script type=module>
import * as pdfjs from '/node_modules/pdfjs-dist/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc='/node_modules/pdfjs-dist/build/pdf.worker.mjs';
const name=new URLSearchParams(location.search).get('f');
try{const doc=await pdfjs.getDocument({url:'/samples/'+name,cMapUrl:'/node_modules/pdfjs-dist/cmaps/',cMapPacked:true,standardFontDataUrl:'/node_modules/pdfjs-dist/standard_fonts/'}).promise;
const page=await doc.getPage(1);const vp=page.getViewport({scale:1.5});const c=document.getElementById('c');c.width=vp.width;c.height=vp.height;
await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;window.__done='ok';}catch(e){window.__done='err '+e}
</script>`;
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') { r.setHeader('content-type', 'text/html'); return r.end(html); }
  const f = path.join(root, u); if (!f.startsWith(root) || !fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('content-type', u.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream'); r.end(fs.readFileSync(f)); }).listen(0);
const port = srv.address().port; const res = {};
for (const [ch, exe] of [['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe']]) {
  try {
    const br = await chromium.launch({ executablePath: exe, headless: true }); res.version = br.version();
    for (const f of ['ko_nonembedded.pdf', 'ko_embedded.pdf']) {
      const pg = await br.newPage(); const errs = []; pg.on('console', m => m.type() === 'error' && errs.push(m.text().slice(0, 150)));
      await pg.goto(`http://localhost:${port}/?f=${f}`); await pg.waitForFunction('window.__done', null, { timeout: 60000 });
      const st = await pg.evaluate('window.__done'); await (await pg.$('#c')).screenshot({ path: `out2/m7_${f.replace('.pdf', '')}.chrome_pdfjs.png` }); res[f] = { status: st, consoleErrors: errs.slice(0, 3) }; await pg.close();
    }
    await br.close();
  } catch (e) { res.error = String(e).slice(0, 300); }
}
srv.close(); fs.writeFileSync('out2/m7_result.json', JSON.stringify(res, null, 1)); console.log(JSON.stringify(res));

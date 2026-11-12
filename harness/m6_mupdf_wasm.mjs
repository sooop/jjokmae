// 항목6: MuPDF WASM 바이트를 외부에서 주입해 초기화 (파일 경로 접근 차단 상태로 검증)
import fs from 'fs';
const wasm = fs.readFileSync('node_modules/mupdf/dist/mupdf-wasm.wasm');
const res = {};
// 방법 A: wasmBinary
let located = [];
globalThis.$libmupdf_wasm_Module = { wasmBinary: new Uint8Array(wasm), locateFile: (p) => { located.push(p); return 'Z:/nonexistent/' + p; } };
const mupdfA = await import('mupdf');
const doc = mupdfA.Document.openDocument(fs.readFileSync('samples/ko_embedded.pdf'), 'application/pdf');
res.A_wasmBinary = { ok: true, pages: doc.countPages(), locateFileCalled: located };
fs.writeFileSync('out2/m6_result.json', JSON.stringify(res, null, 1)); console.log(JSON.stringify(res));

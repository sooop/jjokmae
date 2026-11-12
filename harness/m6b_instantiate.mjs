// 방법 B: instantiateWasm 훅 (웹에서 fetch/스트리밍 컴파일 직접 제어 시)
import fs from 'fs';
const wasm = fs.readFileSync('node_modules/mupdf/dist/mupdf-wasm.wasm'); let called = 0;
globalThis.$libmupdf_wasm_Module = { instantiateWasm: (imports, done) => { called++; WebAssembly.instantiate(wasm, imports).then(r => done(r.instance, r.module)); return {}; }, locateFile: p => { throw new Error('locateFile must not be called: ' + p); } };
const m = await import('mupdf');
const d = m.Document.openDocument(fs.readFileSync('samples/ko_embedded.pdf'), 'application/pdf');
console.log(JSON.stringify({ B_instantiateWasm: true, called, pages: d.countPages() }));

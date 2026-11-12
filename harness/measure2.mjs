// 재측정 실행기: node measure2.mjs  (결과는 out2/ 와 각 m*.json)
// 선행: npm install, .venv 에 pyhanko/reportlab 설치(make_fixtures2.py 참고)
import { spawnSync } from 'child_process';
const run = (cmd, args, env = {}) => { const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }); if (r.status) console.error('FAILED', cmd, args.join(' ')); };
run('.venv/Scripts/python', ['make_fixtures2.py']);
run('node', ['m1_font.mjs', 'C:/Windows/Fonts/malgun.ttf', 'malgun']);
run('node', ['m1_font.mjs', 'C:/Windows/Fonts/NotoSansKR-VF.ttf', 'noto']);
run('node', ['m2_annots.mjs']); run('node', ['m2_annots.mjs'], { KOFONT: 'C:/Windows/Fonts/malgun.ttf' });
run('node', ['m3_forms.mjs']); run('node', ['m3_forms.mjs'], { KOFONT: 'C:/Windows/Fonts/malgun.ttf' });
run('node', ['m4_sign.mjs']); run('node', ['m5_garbage.mjs']);
run('node', ['m6_mupdf_wasm.mjs']); run('node', ['m6b_instantiate.mjs']); run('node', ['m7_browser.mjs']);

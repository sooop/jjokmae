// 사용: node contact.mjs out.png sx sy sw sh file1 file2 ...  (2열 배치)
import fs from 'fs'; import { createCanvas, loadImage } from '@napi-rs/canvas';
const [o, sx, sy, sw, sh, ...fs_] = process.argv.slice(2); const [X, Y, W, Hh] = [sx, sy, sw, sh].map(Number);
const rows = Math.ceil(fs_.length / 2); const cv = createCanvas(W * 2, Hh * rows); const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
for (let i = 0; i < fs_.length; i++) { const im = await loadImage(fs_[i]); c.drawImage(im, X, Y, W, Hh, (i % 2) * W, Math.floor(i / 2) * Hh, W, Hh); c.strokeStyle = '#0a0'; c.strokeRect((i % 2) * W, Math.floor(i / 2) * Hh, W, Hh); }
fs.writeFileSync(o, cv.toBuffer('image/png'));

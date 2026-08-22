/**
 * make-test-image.mjs — 生成一张 3200×2000 的测试 PNG（纯色块，不依赖 sharp）
 *
 * 把图分成 2 列 × 3 行的色块，每块用可区分的纯色填满，用于切图与像素校验。
 * 输出：tests/fixtures/test-3200x2000.png
 *
 * 用法：node scripts/make-test-image.mjs
 */
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'tests', 'fixtures');
mkdirSync(outDir, { recursive: true });

const WIDTH = 3200;
const HEIGHT = 2000;

// 2 列 × 3 行的可区分色块（RGB）
const colors = [
  [255, 0, 0],    // 红
  [0, 255, 0],    // 绿
  [0, 0, 255],    // 蓝
  [255, 255, 0],  // 黄
  [0, 255, 255],  // 青
  [255, 0, 255]   // 品红
];

const cols = 2;
const rows = 3;
const cellW = Math.floor(WIDTH / cols);
const cellH = Math.floor(HEIGHT / rows);

const data = Buffer.alloc(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y += 1) {
  const rowIdx = Math.min(rows - 1, Math.floor(y / cellH));
  for (let x = 0; x < WIDTH; x += 1) {
    const colIdx = Math.min(cols - 1, Math.floor(x / cellW));
    const c = colors[rowIdx * cols + colIdx];
    const off = (y * WIDTH + x) * 4;
    data[off] = c[0];
    data[off + 1] = c[1];
    data[off + 2] = c[2];
    data[off + 3] = 255;
  }
}

const png = new PNG({ width: WIDTH, height: HEIGHT });
png.data = data;
const buf = Buffer.from(PNG.sync.write(png));
const outPath = join(outDir, 'test-3200x2000.png');
writeFileSync(outPath, buf);

console.log(`已生成测试图：${outPath}（${WIDTH}×${HEIGHT}，${cols}×${rows} 色块，${buf.length} 字节）`);

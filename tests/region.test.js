/**
 * region.test.js — 针对 tile-engine.js 新增区域裁剪能力的单元测试
 *
 * 覆盖两个新导出（不影响已有 splitImage/computeGrid/shouldSplit 等）：
 *  - normalizeRect(rect, imgWidth, imgHeight)：把 [x0,y0,x1,y1] 统一为整数像素矩形
 *    （相对坐标换算 / 像素原样 / 自动排序 / round / 边界钳制 / 最小 1px 保护）
 *  - cropRegion(buf, ext, {rect, maxEdge, format, quality, rotate})：按区域裁剪 +
 *    缩放（最长边 maxEdge，保持宽高比），返回输出尺寸与 src 原图矩形。
 *
 * 依赖：pngjs（生成/校验测试图）、sharp（cropRegion 需要，已在本项目 node_modules）。
 * 若 sharp 不可用，cropRegion 相关用例按引擎惯例跳过，但仍能通过 normalizeRect 用例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeRect, cropRegion } from '../src/tile-engine.js';

const require2 = createRequire(import.meta.url);

// 判断 sharp 是否可用（cropRegion 依赖 sharp，与 tile-engine 内部同款加载方式）
let hasSharp = false;
try {
  require2('sharp');
  hasSharp = true;
} catch {
  hasSharp = false;
}

/* ---------------------------- 测试图生成工具 ---------------------------- */

/**
 * 用 pngjs 生成一张 宽×高 的纯色 PNG，可选在「右上角」画一个 square×square 的色块。
 * 默认全图填充 green（0,255,0,255），右上角色块填充 red（255,0,0,255）。
 * 返回 PNG Buffer（给 sharp / cropRegion 读取）。
 */
function makeRegionImage(width, height, { square = 0 } = {}) {
  const { PNG } = require2('pngjs');
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const off = (y * width + x) * 4;
      let r = 0, g = 255, b = 0; // 默认绿色
      // 右上角 square 方形色块（红）
      if (square > 0 && x >= width - square && y < square) {
        r = 255; g = 0; b = 0;
      }
      data[off] = r;
      data[off + 1] = g;
      data[off + 2] = b;
      data[off + 3] = 255;
    }
  }
  const png = new PNG({ width, height });
  png.data = data;
  return Buffer.from(PNG.sync.write(png));
}

/** 用 pngjs 读出 PNG 中某个像素的 RGBA（channels 取前 3 通道 RGB）。 */
function readPixel(buffer, x, y) {
  const { PNG } = require2('pngjs');
  const img = PNG.sync.read(buffer);
  const off = (y * img.width + x) * 4;
  return {
    r: img.data[off],
    g: img.data[off + 1],
    b: img.data[off + 2],
    w: img.width,
    h: img.height,
  };
}

/* ---------------------------- normalizeRect ---------------------------- */

test('normalizeRect：相对坐标 [0.25,0.5,0.75,1] 在 4000×3000 下换算为精确整数', () => {
  const r = normalizeRect([0.25, 0.5, 0.75, 1], 4000, 3000);
  assert.deepEqual(r, {
    x0: 1000, y0: 1500, x1: 3000, y1: 3000, w: 2000, h: 1500,
  });
  // 全部为整数（round 后），w/h 精确
  assert.equal(r.w, 2000);
  assert.equal(r.h, 1500);
});

test('normalizeRect：像素坐标原样返回（含自动排序）', () => {
  // 正常顺序（像素坐标，任意值 >1 → 不做相对换算）
  const r1 = normalizeRect([800, 1200, 2400, 1800], 4000, 3000);
  assert.equal(r1.x0, 800);
  assert.equal(r1.y0, 1200);
  assert.equal(r1.x1, 2400);
  assert.equal(r1.y1, 1800);
  assert.equal(r1.w, 1600);
  assert.equal(r1.h, 600);

  // 逆序输入（模型可能输出 x0>x1）→ 自动排序回 x0<x1
  const r2 = normalizeRect([2400, 1200, 800, 1800], 4000, 3000);
  assert.equal(r2.x0, 800);
  assert.equal(r2.y0, 1200);
  assert.equal(r2.x1, 2400);
  assert.equal(r2.y1, 1800);
  assert.deepEqual(r2, { x0: 800, y0: 1200, x1: 2400, y1: 1800, w: 1600, h: 600 });
});

test('normalizeRect：越界钳制到 [0..width-1]/[0..height-1]，且保证 w>=1/h>=1', () => {
  // 超出四边 → 全钳到边界内
  const r = normalizeRect([-50, -50, 200, 200], 100, 100);
  assert.equal(r.x0, 0);
  assert.equal(r.y0, 0);
  assert.equal(r.x1, 100); // 钳到 width（100）
  assert.equal(r.y1, 100); // 钳到 height（100）
  assert.ok(r.w >= 1 && r.h >= 1);
  assert.equal(r.w, 100);
  assert.equal(r.h, 100);

  // 整体落在负方向 / 超界之外 → 最小尺寸保护为 1px
  const r2 = normalizeRect([-10, -10, -5, -5], 100, 100);
  assert.ok(r2.x0 >= 0 && r2.y0 >= 0);
  assert.ok(r2.x1 <= 99 && r2.y1 <= 99);
  assert.equal(r2.w, 1); // 最小 1px
  assert.equal(r2.h, 1);

  // 下限钳制：x1/y1 超过图宽高时，cx1/cy1 不能超过 width/height
  const r3 = normalizeRect([0, 0, 9999, 9999], 200, 100);
  assert.equal(r3.x1, 200);
  assert.equal(r3.y1, 100);
  assert.equal(r3.w, 200);
  assert.equal(r3.h, 100);
});

test('normalizeRect：非法输入抛出错误', () => {
  // 长度非 4
  assert.throws(() => normalizeRect([1, 2, 3], 100, 100), /四元数组|必须是/);
  assert.throws(() => normalizeRect([1, 2, 3, 4, 5], 100, 100), /四元数组|必须是/);
  // 含 NaN
  assert.throws(() => normalizeRect([0, 0, 1, NaN], 100, 100), /有限数字|NaN/);
  // 非数组（含 undefined 长度）
  assert.throws(() => normalizeRect('bad', 100, 100), /四元数组|必须是/);
  assert.throws(() => normalizeRect(null, 100, 100), /四元数组|必须是/);
});

/* ---------------------------- cropRegion ---------------------------- */

test('cropRegion：2000×1500 裁剪缩放为 800×600，颜色保持（绿底/红角）',
  { skip: hasSharp ? false : 'cropRegion 需要 sharp，跳过' }, async () => {
    // 生成 2000×1500 测试图：右上角 500×500 红色方块，其余绿色
    const srcBuf = makeRegionImage(2000, 1500, { square: 500 });

    const res = await cropRegion(srcBuf, '.png', { rect: [0, 0, 1, 1], maxEdge: 800, format: 'png' });

    // 缩放后尺寸：4:3 保持，最长边 800
    assert.equal(res.mediaType, 'image/png');
    assert.equal(res.width, 800);
    assert.equal(res.height, 600);
    // src 为原图整幅（相对 [0,0,1,1] → 全图）
    assert.equal(res.src.w, 2000);
    assert.equal(res.src.h, 1500);

    // 用 pngjs 读输出，校验像素颜色（缩放后颜色保持）
    const center = readPixel(res.buffer, Math.floor(res.width / 2), Math.floor(res.height / 2));
    assert.ok(center.g > 200 && center.r < 60, `center green=${center.g} red=${center.r}`);
    const corner = readPixel(res.buffer, 700, 100); // 输出右上角（红方块缩放后位置）
    assert.ok(corner.r > 200 && corner.g < 60, `corner red=${corner.r} green=${corner.g}`);

    // 输出为 PNG 魔数
    assert.equal(res.buffer[0], 0x89);
    assert.equal(res.buffer[1], 0x50);
  });

test('cropRegion：区域长边未超过 maxEdge 时不缩放（1:1 无损）',
  { skip: hasSharp ? false : 'cropRegion 需要 sharp，跳过' }, async () => {
    const srcBuf = makeRegionImage(2000, 1500); // 全绿
    // 裁一个 400×300 区域（长边 400 ≤ maxEdge 800）→ 不缩放，输出 = 原区域尺寸
    const res = await cropRegion(srcBuf, '.png', { rect: [0, 0, 400, 300], maxEdge: 800, format: 'png' });

    assert.equal(res.width, 400);
    assert.equal(res.height, 300);
    assert.equal(res.src.w, 400);
    assert.equal(res.src.h, 300);
    // 输出仍为原区域 1:1，像素保持绿色
    const px = readPixel(res.buffer, 200, 150);
    assert.ok(px.g > 200 && px.r < 60, `pixel green=${px.g} red=${px.r}`);
  });

test('cropRegion：rotate=90 时宽高互换（src 反映旋转后图像）',
  { skip: hasSharp ? false : 'rotate 需要 sharp，跳过' }, async () => {
    // 原图 1600×800（宽 > 高）
    const srcBuf = makeRegionImage(1600, 800);
    // 相对全图矩形 + rotate=90：cropRegion 先 rotate 再 normalizeRect，
    // 因此 src 基于「旋转后」的 800×1600 图像 → 宽高与原图互换
    const res = await cropRegion(srcBuf, '.png', { rect: [0, 0, 1, 1], maxEdge: 800, rotate: 90 });

    // 原图 1600×800 → 旋转后 src 宽高互换：w=800, h=1600
    assert.equal(res.src.w, 800);
    assert.equal(res.src.h, 1600);
    // 输出 maxEdge=800：旋转后 800×1600 → 高更长 → 高缩到 800，宽等比 400
    assert.equal(res.width, 400);
    assert.equal(res.height, 800);
  });

test('cropRegion：jpeg 格式输出 mediaType===\'image/jpeg\' 且为 JPEG 魔数',
  { skip: hasSharp ? false : 'cropRegion 需要 sharp，跳过' }, async () => {
    const srcBuf = makeRegionImage(2000, 1500, { square: 500 });
    const res = await cropRegion(srcBuf, '.png', {
      rect: [0, 0, 1, 1], maxEdge: 800, format: 'jpeg', quality: 90,
    });

    assert.equal(res.mediaType, 'image/jpeg');
    // JPEG 文件以 FF D8 开头
    assert.equal(res.buffer[0], 0xff);
    assert.equal(res.buffer[1], 0xd8);
    // 尺寸仍为缩放后的 800×600
    assert.equal(res.width, 800);
    assert.equal(res.height, 600);
  });

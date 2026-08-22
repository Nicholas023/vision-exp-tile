/**
 * pixelgrid.js — 简化像素网格转文本（供模型理解版式的辅助信息）
 *
 * 功能参考自开源像素文本化工具（MIT，例如 picturereader 的 image_scan），本模块为自包含实现：
 *  - 用 sharp 把图片解码并缩放到 cols×rows 网格（长边默认 32 格，可配 size 8..64），
 *    通过 `kernel: 'nearest'` 拿到每格的代表像素（raw RGBA）；
 *  - 每格依据明度映射为一个字符（字符集 '.:-=+*#%@'，空格=透明，'.'=最暗，'@'=最亮），
 *    得到 ASCII 明度网格（行序自上而下、行内左到右）；
 *  - 按 3bit 颜色量化（每通道 1 bit，合并为 0..7 共 8 个色桶）统计「颜色占比」，
 *    并给出主要颜色的占比与分布中心（@r行c列）。
 *
 * 输出为统一文本（首行尺寸/网格规格 → ASCII 明度网格 → 颜色统计 → 区块列表），
 * 供模型理解整图版式，而不依赖 DSH 服务，便于单元测试。
 *
 * 本模块只使用 node 内置能力 + 项目已有依赖 sharp，不引入新依赖。
 */

import { createRequire } from 'node:module';

/* ------------------------------------------------------------------ */
/* 常量与辅助导出                                                       */
/* ------------------------------------------------------------------ */

/**
 * 明度字符集（下标越大越亮）：'.' 最暗、'@' 最亮；「空格」由代码单独用于「透明」。
 * 注意：该字符串不含空格，空格仅作透明标记，不属于明度档位。
 */
export const ASCII_RAMP = '.:-=+*#%@';

/** 明度档位数（即 ASCII_RAMP 长度，共 9 档） */
export const RAMP_LEN = ASCII_RAMP.length;

/**
 * 3bit 色桶字符集（每桶一个字符，下标即桶号 0..7）：
 *   0=k 黑  1=b 蓝  2=g 绿  3=c 青  4=r 红  5=m 品红  6=y 黄  7=w 白
 * 这是一个「字符集常量」，用于把色桶号渲染成单字符。
 */
export const GRID_PALETTE = 'kbgcrmyw';

/** 3bit 色桶名称（与 GRID_PALETTE 下标一一对应） */
export const GRID_COLOR_NAMES = ['black', 'blue', 'green', 'cyan', 'red', 'magenta', 'yellow', 'white'];

/** 默认网格规格：长边格数 */
export const DEFAULT_SIZE = 32;
/** 允许的网格规格范围（长边格数） */
export const SIZE_MIN = 8;
export const SIZE_MAX = 64;

/** 透明阈值：alpha 小于该值视为透明（输出空格） */
const ALPHA_THRESHOLD = 128;

/**
 * 3bit 颜色量化：把 RGB 每通道按 0x80 阈值打 1 bit，合并为 0..7 色桶号。
 * 桶号 = (R高bit << 2) | (G高bit << 1) | B高bit，对应 RGB 立方体的 8 个角。
 * @param {number} r - 红 0..255
 * @param {number} g - 绿 0..255
 * @param {number} b - 蓝 0..255
 * @returns {number} 0..7 色桶号
 */
export function quantize3bit(r, g, b) {
  const rb = r >= 0x80 ? 1 : 0;
  const gb = g >= 0x80 ? 1 : 0;
  const bb = b >= 0x80 ? 1 : 0;
  return (rb << 2) | (gb << 1) | bb;
}

/** 把任意值规整到 [min, max] 的整数（用于网格 size 钳制）。 */
function clampInt(raw, fallback, min, max) {
  const n = Math.round(Number(raw === undefined || raw === null ? fallback : raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 懒加载 sharp（本项目依赖；若环境未安装则抛清晰的错误，而非静默降级）。
 * @returns {Function} sharp 工厂函数
 */
function loadSharp() {
  try {
    // ESM 下用 createRequire 加载 CJS 的 sharp（与 vision-client 同款方式）
    const require = createRequire(import.meta.url);
    const sharp = require('sharp');
    if (typeof sharp === 'function') return sharp;
  } catch {
    /* 落到下方抛出 */
  }
  throw new Error('pixelgrid: 需要 sharp 解码图片（请安装项目依赖 npm i sharp），当前环境未提供 sharp');
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/**
 * 构建像素网格文本（整图版式辅助信息）。
 * @param {Buffer} buffer - 图片字节（PNG/JPEG/GIF/WebP 等，sharp 可解码）
 * @param {object} [opts] - {size} 长边格数（8..64，默认 32）
 * @returns {Promise<string>} 统一文本（首行规格 → ASCII 明度网格 → 颜色统计 → 区块列表）
 */
export async function buildPixelGrid(buffer, opts = {}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('pixelgrid: 需要传入图片 Buffer（PNG/JPEG/GIF/WebP 等图片字节）');
  }
  const size = clampInt(opts.size, DEFAULT_SIZE, SIZE_MIN, SIZE_MAX);
  const sharp = loadSharp();

  // 1) 解码取尺寸；失败给出清晰错误（含 sharp 原因）
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'none' }).metadata();
  } catch (err) {
    throw new Error(`pixelgrid: 无法解码图片（sharp: ${String(err?.message ?? err)}）`);
  }
  const width = meta.width;
  const height = meta.height;
  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`pixelgrid: 图片尺寸无效（width=${width}, height=${height}）`);
  }

  // 2) 计算网格 cols/rows：长边铺满 size 格，短边按比例取整（ceil，保证短边至少 1 格）
  let cols;
  let rows;
  if (width >= height) {
    cols = size;
    rows = Math.max(1, Math.ceil((height * size) / width));
  } else {
    rows = size;
    cols = Math.max(1, Math.ceil((width * size) / height));
  }

  // 3) shrink 到 cols×rows（nearest 采样 ≈ 每格取代表像素），强制 RGBA，取 raw 数据
  let data;
  let info;
  try {
    const out = await sharp(buffer, { failOn: 'none' })
      .resize(cols, rows, { fit: 'fill', kernel: 'nearest' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = out.data;
    info = out.info;
  } catch (err) {
    throw new Error(`pixelgrid: 生成网格失败（sharp: ${String(err?.message ?? err)}）`);
  }
  const ch = info.channels; // 理论为 4（ensureAlpha），防御式取实际值
  if (ch < 3) throw new Error('pixelgrid: 解码后通道不足（需至少 RGB）');

  // 4) 逐格解析：明度字符 + 3bit 色桶（透明格桶号记 -1）
  /** @type {{row:number,col:number,chr:string,bucket:number,luma:number}[]} */
  const cells = [];
  const gridLines = [];
  for (let row = 0; row < rows; row += 1) {
    let line = '';
    for (let col = 0; col < cols; col += 1) {
      const off = (row * cols + col) * ch;
      const r = data[off];
      const g = data[off + 1];
      const b = data[off + 2];
      const a = ch > 3 ? data[off + 3] : 255;
      let chr = ' ';
      let bucket = -1;
      let luma = 0;
      if (a >= ALPHA_THRESHOLD) {
        // 感知明度（Rec.601 权重），映射到 ASCII_RAMP 的 0..RAMP_LEN-1 档
        luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const idx = Math.min(RAMP_LEN - 1, Math.floor((luma / 256) * RAMP_LEN));
        chr = ASCII_RAMP[idx];
        bucket = quantize3bit(r, g, b);
      }
      cells.push({ row, col, chr, bucket, luma });
      line += chr;
    }
    gridLines.push(line);
  }

  // 5) 统计各色桶：数量、占比、分布中心（row/col 平均，取整）
  const bucketCells = [[], [], [], [], [], [], [], []];
  let opaque = 0;
  for (const c of cells) {
    if (c.bucket === -1) continue;
    bucketCells[c.bucket].push({ row: c.row, col: c.col });
    opaque += 1;
  }

  // 颜色统计行：`colors by area: name pct%, ...`（按占比降序，最多 8 个）
  const colorStats = [];
  for (let b = 0; b < 8; b += 1) {
    if (bucketCells[b].length === 0) continue;
    colorStats.push({
      name: GRID_COLOR_NAMES[b],
      bucket: b,
      pct: opaque > 0 ? (bucketCells[b].length / opaque) * 100 : 0
    });
  }
  colorStats.sort((x, y) => y.pct - x.pct);
  const colorsLine = opaque > 0
    ? `colors by area: ${colorStats.map((s) => `${s.name} ${s.pct.toFixed(1)}%`).join(', ')}`
    : 'colors by area: (all transparent)';

  // 区块列表行：`blocks: name pct% @r行c列; ...`（按占比降序，最多 6 个）
  const blocks = [];
  for (let b = 0; b < 8; b += 1) {
    if (bucketCells[b].length === 0) continue;
    const arr = bucketCells[b];
    const rowCenter = arr.reduce((s, c) => s + c.row, 0) / arr.length;
    const colCenter = arr.reduce((s, c) => s + c.col, 0) / arr.length;
    blocks.push({
      name: GRID_COLOR_NAMES[b],
      pct: opaque > 0 ? (arr.length / opaque) * 100 : 0,
      row: Math.round(rowCenter),
      col: Math.round(colCenter),
      count: arr.length
    });
  }
  blocks.sort((x, y) => y.count - x.count);
  const topBlocks = blocks.slice(0, 6);
  const blocksLine = opaque > 0 && topBlocks.length > 0
    ? `blocks: ${topBlocks.map((b) => `${b.name} ${b.pct.toFixed(1)}% @r${b.row}c${b.col}`).join('; ')}`
    : 'blocks: (none)';

  // 6) 拼装统一文本
  const perCellW = Math.round(width / cols);
  const perCellH = Math.round(height / rows);
  const header = `pixel-grid: ${width}x${height} -> ${cols}x${rows} cells (~${perCellW}x${perCellH}px per cell)`;
  const body = [header, ...gridLines, colorsLine, blocksLine].join('\n');

  // 输出字符量控制在 ~4KB 内：默认 32 格稳定在此范围内（更大的 size 由调用方权衡）
  return body;
}

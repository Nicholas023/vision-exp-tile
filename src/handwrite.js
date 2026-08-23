/**
 * handwrite.js — 手写判别器（本地启发式，v0.2.0 分流管线组件）
 *
 * v0.2.0「分类分流」：每个文字区域先判断是否手写——
 *   ① 视觉预检标记（previewImage 让模型标注 isHandwrite，精度高、零本地算力）；
 *   ② 本地启发式判别器（本模块：笔画连通域密度 + 行投影起伏 + 笔画占比），
 *      用于视觉标记缺失/预检失败时回退，并与视觉标记互相验证（分歧时取视觉、标注冲突）。
 *
 * 特征（对二值化灰度图计算，pnjs 本地、确定性）：
 *   - darkShare         ：笔画（黑）像素占比（手写 4%-40%，印刷 8%-50%，重叠但可辅助）
 *   - components120     ：8-邻域连通域数（采样步长 2；手写笔画碎、连通块多）
 *   - compPerArea       ：连通域密度（个/万像素）
 *   - hProjVar          ：水平投影（每行黑像素数）归一化方差（手写行高/字数不均→起伏大）
 *   - meanCompHeight    ：连通域平均高度（px，采样块）
 *  评分：加权综合 → [0,1]，>0.5 判手写；calibration 校准后可调权重/阈值。
 */

import { PNG } from 'pngjs';

/** 二值化（Otsu 复用 preprocess 的实现，避免重复） */
import { toGray, otsuThreshold } from './preprocess.js';

/**
 * 对 PNG 字节计算手写特征（不修改原图）。
 * @param {Buffer} pngBuffer
 * @returns {{score:number,isHandwrite:boolean,features:object,error?:string}}
 */
export function detectHandwrite(pngBuffer, { sampleStep = 2 } = {}) {
  let png;
  try {
    png = PNG.sync.read(pngBuffer);
  } catch (e) {
    return { score: 0.5, isHandwrite: false, features: {}, error: String(e?.message ?? e).slice(0, 80) };
  }
  const { width, height, data } = png;
  const gray = toGray(png);
  const t = otsuThreshold(gray);
  // 二值化（像素 1=笔画）
  const bin = new Uint8Array(width * height);
  let darkCount = 0;
  for (let i = 0; i < bin.length; i += 1) {
    bin[i] = gray[i] < t ? 1 : 0;
    darkCount += bin[i];
  }
  const darkShare = darkCount / Math.max(1, bin.length);

  // 采样步长缩小后的连通域统计（BFS，8 邻域；约 1/4 像素量）
  const step = sampleStep;
  const sw = Math.max(2, Math.ceil(width / step));
  const sh = Math.max(2, Math.ceil(height / step));
  const small = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      small[y * sw + x] = bin[Math.min(height - 1, y * step) * width + Math.min(width - 1, x * step)];
    }
  }
  const visited = new Uint8Array(sw * sh);
  const stack = new Int32Array(sw * sh);
  let components = 0;
  let compHeightSum = 0;
  for (let i = 0; i < sw * sh; i += 1) {
    if (small[i] === 0 || visited[i]) continue;
    // BFS 一个连通域
    let top = 0;
    stack[top++] = i;
    visited[i] = 1;
    let minY = sh, maxY = 0;
    while (top > 0) {
      const cur = stack[--top];
      const cy = (cur / sw) | 0;
      const cx = cur % sw;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const ny = cy + dy;
          const nx = cx + dx;
          if (ny < 0 || nx < 0 || ny >= sh || nx >= sw) continue;
          const ni = ny * sw + nx;
          if (small[ni] === 1 && !visited[ni]) {
            visited[ni] = 1;
            stack[top++] = ni;
          }
        }
      }
    }
    components += 1;
    compHeightSum += (maxY - minY + 1) * step;
  }
  const compPerArea = components / Math.max(1, sw * sh / 10000); // 个/万采样像素
  const meanCompHeight = components > 0 ? compHeightSum / components : 0;

  // 水平投影起伏（每行黑像素占比的归一化方差——手写行高/字数不均）
  const rows = Math.min(48, sh);
  const proj = new Float32Array(rows);
  const rowH = sh / rows;
  for (let y = 0; y < rows; y += 1) {
    let cnt = 0;
    const y0 = Math.floor(y * rowH);
    const y1 = Math.min(sh, Math.ceil((y + 1) * rowH));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = 0; xx < sw; xx += 2) cnt += small[yy * sw + xx];
    }
    proj[y] = cnt / Math.max(1, (y1 - y0) * Math.ceil(sw / 2));
  }
  let mean = 0;
  for (let y = 0; y < rows; y += 1) mean += proj[y];
  mean /= rows;
  let v = 0;
  for (let y = 0; y < rows; y += 1) v += (proj[y] - mean) ** 2;
  const hProjStd = Math.sqrt(v / rows);

  // 评分（校准版：特征方向经 15 样本实测修正——手写行投影平滑（低 hProjStd）、
  // 连通域更高更大更密；印刷连通域高度集中 28-34、投影起伏大；阈值 0.55）
  const scoreV = 1 - Math.min(1, hProjStd / 0.13); // 低起伏 = 手写（修正方向）
  const scoreH = Math.min(1, meanCompHeight / 60); // 单连通域越高越像手写
  const scoreC = Math.min(1, components / 300); // 连通域数量
  const scoreD = darkShare >= 0.03 && darkShare <= 0.3 ? 0.8 : 0.4; // 笔画占比适中
  const score = 0.35 * scoreV + 0.3 * scoreH + 0.2 * scoreC + 0.15 * scoreD;

  return {
    score: Number(score.toFixed(3)),
    isHandwrite: score >= 0.55, // 校准阈值：样本集 手写 0.62-0.82 / 印刷 0.37-0.49
    features: {
      darkShare: Number(darkShare.toFixed(4)),
      components,
      compPerArea: Number(compPerArea.toFixed(2)),
      meanCompHeight: Number(meanCompHeight.toFixed(1)),
      hProjStd: Number(hProjStd.toFixed(2))
    }
  };
}

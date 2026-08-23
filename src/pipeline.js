/**
 * pipeline.js — 插件全自动编排（strategy=pipeline）：一次调用完成整套智能识图
 *
 * 流程（全部在插件内部执行，不需要模型指挥）：
 *   1. precheck ：整图预检（detail:'low' 512×512 缩略）→ 有无文字 / 文字区域 / 兴趣点 / 概要
 *   2. 文字区   ：每个文字区域 1:1 裁剪 → 本地 OCR（paddle→rapid→windows 自动降级）
 *                 + 内置简化像素网格（版式辅助）
 *   3. 兴趣点   ：每个兴趣点区域按比例裁剪（最长边 800，4:3→800×600）
 *                 → 直连 DeepSeek 视觉 API 详细识别
 *   4. 汇总     ：本地模板组装修辞（整图概要 / 文字转录 / 兴趣点详情 / 不确定项）
 *   5. 落盘     ：区域 PNG 与 OCR/网格文本写入临时目录（默认 OS temp，可配 tempDir）
 *
 * 与"模型编排"（strategy=assist/smart）的区别：smart 只做第 1 步（预检）并把结果交给
 * 会话模型去调度（vision_region_crop 逐区域识别，且模型可先问用户）；
 * pipeline 则一步到位、无交互（重点不明时在汇总中说明并提示重试方式）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { cropRegion, normalizeRect } from './tile-engine.js';
import { ocrText } from './ocr-local.js';
import { previewImage, recognizeRegion } from './vision-client.js';
import { buildPixelGrid } from './pixelgrid.js';

/** 默认兴趣点区域识别提问（要求中文、结构化） */
const REGION_QUESTION = '详细识别该区域的内容：文字、物体、图表、颜色布局等；有文字则逐字转录。';

/**
 * 运行全自动智能识图编排。
 * @param {object} opts - {
 *   apiKey, baseURL, model,            // DeepSeek 视觉 API 配置
 *   buf, ext, width, height,           // 原图字节/扩展名/尺寸（w/h 用于坐标换算前展示）
 *   question,                          // 用户问题（可选）
 *   rotate,                            // 识别前旋转（0/90/180/270）
 *   ocrEngine,                         // 'auto'|'paddle'|'rapid'|'windows'
 *   ocrOverride,                       // 测试注入：fn(pngBuffer, opts) => {engine,text,lines}（不指定用默认 ocrText）
 *   maxEdge,                           // 兴趣点区域最长边（默认 800）
 *   maxTokens,                         // 单次请求输出上限（默认 8192；预检/区域识别共用）
 *   tempDir,                           // 落盘目录（默认 OS temp 下 vision-tile-pipeline-xxx）
 *   signal, fetchImpl, timeoutMs,      // 网络控制
 * }
 * @returns {Promise<{
 *   answer:string, stages:Array, hasText:boolean,
 *   textRegions:Array, interestRegions:Array,
 *   ocr:{engine:string,text:string}|null, pixelGrids:Array,
 *   regionDetails:Array, outputDir:string
 * }>}
 */
export async function runPipeline(opts) {
  const {
    apiKey, baseURL, model, buf, ext, width, height,
    question = '', rotate = 0, ocrEngine = 'auto',
    ocrOverride, maxEdge = 800, maxTokens = 8192,
    tempDir, signal, fetchImpl, timeoutMs = 300000
  } = opts;
  // OCR 函数可注入（单元测试用）；默认走本地 ocrText（paddle→rapid→windows 降级链）
  const ocrFn = typeof ocrOverride === 'function' ? ocrOverride : ocrText;

  const stages = [];
  // 原图媒体类型（官方视觉 API 支持 PNG/JPEG/WebP/GIF，按扩展名推断）
  const mediaType =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
          : 'image/png';

  // 落盘目录（供复查；默认系统临时目录）
  const outputDir = tempDir || join(tmpdir(), `vision-tile-pipeline-${randomBytes(4).toString('hex')}`);
  await mkdir(outputDir, { recursive: true });

  /* ── 1. 整图预检（512×512 缩略，判断有无文字/兴趣点） ── */
  stages.push({ kind: 'precheck' });
  const preview = await previewImage({
    apiKey, baseURL, model,
    buffer: buf, mediaType,
    question,
    maxTokens,
    signal, fetchImpl, timeoutMs
  });
  const hasText = Boolean(preview.hasText);
  // 相对坐标 → 原图像素坐标（预检输出的是 0..1，统一换算供后续裁剪/回写）
  const toPx = (r) => normalizeRect([r.x0, r.y0, r.x1, r.y1], width, height);
  const textRegions = (preview.textRegions ?? []).slice(0, 3).map((r) => ({ ...toPx(r), relative: r }));
  const interestRegions = (preview.interestRegions ?? []).slice(0, 6).map((r) => ({
    ...toPx(r),
    label: String(r.label ?? '').slice(0, 40),
    relative: r
  }));
  // 预检原文落盘（便于复查）
  await writeFile(join(outputDir, 'precheck.json'), JSON.stringify({
    hasText, textRegions, interestRegions, summary: preview.summary, raw: preview.raw ?? ''
  }, null, 2), 'utf-8');
  stages.push({ kind: 'precheck-done', hasText, textRegions: textRegions.length, interestRegions: interestRegions.length });

  /* ── 2. 文字区域：1:1 裁剪 → 本地 OCR + 简化像素网格 ──
   * 性能优化：区域间**并发**处理（cropRegion/OCR/网格并行；OCR 走常驻进程池，
   * 池满自动排队，多核利用由池控制），串行循环改为 mapLimit（默认并发 3，可用
   * DSH_PIPELINE_CONCURRENCY 覆盖；1 = 旧行为）。 */
  let ocr = null;
  const pixelGrids = [];
  if (hasText && textRegions.length > 0) {
    const ocrParts = [];
    const concurrencyRaw = Number(process.env.DSH_PIPELINE_CONCURRENCY);
    const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0
      ? Math.min(6, Math.floor(concurrencyRaw))
      : 3;
    // 简易并发限流器（无第三方依赖）：items 逐批调度，fn 返回 Promise
    const runConcurrent = async (items, limit, fn) => {
      const results = new Array(items.length);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
          const idx = cursor;
          cursor += 1;
          results[idx] = await fn(items[idx], idx);
        }
      });
      await Promise.all(workers);
      return results;
    };
    const jobs = await runConcurrent(textRegions, concurrency, async (region, i) => {
      // 1:1 裁剪（maxEdge=0 不缩放），保证 OCR 面对原始像素
      const cropped = await cropRegion(buf, ext, {
        rect: [region.x0, region.y0, region.x1, region.y1],
        maxEdge: 0,
        rotate
      });
      const regionPath = join(outputDir, `text-region-${i}-${region.x0}_${region.y0}_${region.x1}_${region.y1}.png`);
      await writeFile(regionPath, cropped.buffer);
      stages.push({ kind: 'text-crop', index: i, path: regionPath });
      // 本地 OCR（自动降级链；测试可注入 ocrOverride）。
      // 兜底：任何 OCR 环境都不可用时（如非 Windows 且未装 paddle/rapid），
      // 降级为视觉 API 直接转录该文字区域——保证 pipeline 跨平台不中断。
      let ocrResult;
      try {
        ocrResult = await ocrFn(cropped.buffer, { engine: ocrEngine, timeoutMs: 120000 });
      } catch (error) {
        try {
          const fallback = await recognizeRegion({
            apiKey, baseURL, model,
            buffer: cropped.buffer,
            mediaType: cropped.mediaType,
            label: `文字区域 ${i}`,
            question: '该区域内容为文字：请完整、准确地转录全部文字内容。',
            maxTokens,
            signal, fetchImpl, timeoutMs
          });
          ocrResult = {
            engine: 'vision-fallback',
            text: fallback.description,
            lines: [],
            degraded: true,
            reason: error.message
          };
        } catch (fallbackError) {
          ocrResult = { engine: 'unavailable', text: '', lines: [], degraded: true, reason: `${error.message}；${fallbackError.message}` };
        }
      }
      // 简化像素网格（版式辅助）
      let grid = null;
      if (typeof buildPixelGrid === 'function') {
        try {
          grid = await buildPixelGrid(cropped.buffer);
        } catch {
          /* 网格失败不影响主流程 */
        }
      }
      return { region, index: i, regionPath, ocrResult, grid };
    });
    for (const j of jobs) {
      ocrParts.push(`【文字区域 ${j.index}】原图坐标 (${j.region.x0},${j.region.y0})~(${j.region.x1},${j.region.y1})${j.region.relative ? ` [相对 ${JSON.stringify(j.region.relative)}]` : ''}
引擎：${j.ocrResult.engine}${j.ocrResult.degraded ? '（原引擎不可用，已降级）' : ''}
${j.ocrResult.text || '（未检出文字）'}`);
      if (j.grid) {
        pixelGrids.push({ regionIndex: j.index, coordinates: { x0: j.region.x0, y0: j.region.y0, x1: j.region.x1, y1: j.region.y1 }, grid: j.grid });
      }
    }
    ocr = {
      // 引擎细节（paddle/rapid/windows/降级）已写入各区域文本段；此处仅作占位标记
      engine: 'local-ocr',
      text: ocrParts.join('\n\n'),
      parts: ocrParts
    };
    await writeFile(join(outputDir, 'ocr.txt'), ocr.text, 'utf-8');
    if (pixelGrids.length > 0) {
      await writeFile(join(outputDir, 'pixel-grids.txt'),
        pixelGrids.map((g) => `# 区域 ${g.regionIndex} @ (${g.coordinates.x0},${g.coordinates.y0})(${g.coordinates.x1},${g.coordinates.y1})\n${g.grid}`).join('\n\n'),
        'utf-8');
    }
    stages.push({ kind: 'ocr-done', regions: textRegions.length });
  } else {
    stages.push({ kind: 'ocr-skipped', reason: hasText ? '无文字区域' : '判断为无文字，跳过 OCR' });
  }

  /* ── 3. 兴趣点区域：按比例裁剪（最长边 800）→ 视觉 API 识别 ── */
  const regionDetails = [];
  for (let i = 0; i < interestRegions.length; i += 1) {
    const region = interestRegions[i];
    const cropped = await cropRegion(buf, ext, {
      rect: [region.x0, region.y0, region.x1, region.y1],
      maxEdge,
      rotate
    });
    const regionPath = join(outputDir, `interest-${i}-${region.label?.replace(/[^\w\u4e00-\u9fa5]/g, '_') || 'region'}-${region.x0}_${region.y0}.png`);
    await writeFile(regionPath, cropped.buffer);
    stages.push({ kind: 'interest-crop', index: i, path: regionPath, outSize: `${cropped.width}x${cropped.height}` });
    const res = await recognizeRegion({
      apiKey, baseURL, model,
      buffer: cropped.buffer,
      mediaType: cropped.mediaType,
      label: region.label,
      question: question ? `${question}；${REGION_QUESTION}` : REGION_QUESTION,
      maxTokens,
      signal, fetchImpl, timeoutMs
    });
    regionDetails.push({
      index: i,
      label: region.label,
      coordinates: { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 },
      relative: region.relative,
      outSize: `${cropped.width}x${cropped.height}`,
      description: res.description,
      path: regionPath
    });
    stages.push({ kind: 'interest-done', index: i });
  }
  if (interestRegions.length === 0) {
    stages.push({ kind: 'interest-none', note: '预检未识别出明确兴趣点区域' });
  }

  /* ── 4. 汇总（本地模板；不做额外的模型聚合调用，省时省 cost） ── */
  const answer = buildAnswer({
    question, hasText, preview, textRegions, interestRegions,
    ocr, pixelGrids, regionDetails, outputDir
  });
  await writeFile(join(outputDir, 'answer.md'), answer, 'utf-8');

  return {
    answer,
    stages,
    hasText,
    textRegions,
    interestRegions,
    ocr,
    pixelGrids,
    regionDetails,
    outputDir
  };
}

/** 本地汇总模板：拼装结构化答案（输出语言跟随 question 语言，默认中文） */
function buildAnswer({ question, hasText, preview, textRegions, interestRegions, ocr, pixelGrids, regionDetails, outputDir }) {
  const parts = [];
  parts.push(`# 智能识图结果${question ? `（目标：${question}）` : ''}`);
  parts.push('');
  parts.push(`## 整图概要`);
  parts.push(preview.summary || '（模型未给出概要）');
  parts.push('');
  parts.push(`## 文字内容${hasText ? '（本地 OCR 转录）' : '（未检测到文字）'}`);
  if (ocr && ocr.text) {
    parts.push(ocr.text);
  } else {
    parts.push(hasText ? '（文字区域未识别出可转录内容）' : '（无文字内容）');
  }
  if (pixelGrids.length > 0) {
    parts.push('', `## 像素网格（版式辅助，${pixelGrids.length} 个区域）`);
    for (const g of pixelGrids) {
      parts.push(`### 文字区域 ${g.regionIndex} @ (${g.coordinates.x0},${g.coordinates.y0})(${g.coordinates.x1},${g.coordinates.y1})`);
      parts.push('```');
      parts.push(g.grid);
      parts.push('```');
    }
  }
  if (regionDetails.length > 0) {
    parts.push('', `## 重点区域详情（${regionDetails.length} 处）`);
    for (const d of regionDetails) {
      parts.push(`### ${d.label || `区域 ${d.index}`} @ (${d.coordinates.x0},${d.coordinates.y0})(${d.coordinates.x1},${d.coordinates.y1})`);
      parts.push(d.description);
      parts.push('');
    }
  } else {
    parts.push('', `## 重点区域`);
    parts.push('（预检未给出明确兴趣点区域；如需定位某处，可指定坐标重试：vision_region_crop 或 vision_tile_recognize(question 说明位置)）');
  }
  parts.push('', `---`, `明细文件目录：${outputDir}（precheck.json / ocr.txt / pixel-grids.txt / 区域 PNG / answer.md）`);
  return parts.join('\n');
}

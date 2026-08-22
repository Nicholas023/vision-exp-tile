/**
 * prompts.js — 坐标标注 + 分块聚合逻辑的提示模板
 *
 * 设计依据（deepseek-v4-flash-vision-exp 官方 API 文档）：
 *  - 官方的硬限制：图片只能出现在 user 消息中（system/assistant 消息放图 = 400 错误）。
 *    因此本插件的策略是：把所有「聚合逻辑 / 识别指令」放进 system 文本；
 *    「坐标清单 + 问题」与所有图片一起放进同一条 user 消息。
 *  - 官方缩放规则使 800×800 块不降采样、每块 ≤384 token —— 提示中会明确告诉模型
 *    "每个块代表原图的原始像素，细节无损"，引导模型充分利用。
 *  - 模型是视觉模型：直接看块图，无需 OCR 文本化；提示只负责定位（坐标）与组织（聚合）。
 *
 * 所有模板均为纯文本（不含图片），保证遵守"图片仅可在 user 消息"的限制。
 */

/**
 * 生成坐标清单表：块编号（行优先，与 overview 图上的数字一致）+ 原图坐标。
 * 例：
 *   | # | 行列   | 原图坐标(x0,y0 -> x1,y1) | 尺寸         |
 *   | 0 | r0c0   | 0,0 -> 800,800           | 800x800      |
 * @param {number} width - 原图宽
 * @param {number} height - 原图高
 * @param {Array} tiles - 切块数组（含 row,col,x,y,w,h）
 * @param {object} grid - computeGrid 结果（{rows, cols}）
 * @param {string} [fileName] - 每块文件名前缀（可选，供映射到磁盘文件）
 * @returns {string} 坐标清单文本
 */
export function buildTileListText(width, height, tiles, grid, fileName = '') {
  const lines = [
    `坐标清单：原图 ${width}×${height}px，网格 ${grid.rows}×${grid.cols}（行优先编号，从 0 开始）`,
    '| #  | 行列  | 原图坐标 x0,y0 → x1,y1 | 尺寸 |',
    '|----|-------|------------------------|------|'
  ];
  for (let i = 0; i < tiles.length; i += 1) {
    const t = tiles[i];
    const id = t.row * grid.cols + t.col;
    const name = fileName.length > 0 ? `（文件 ${fileName.replace('{id}', String(id)).replace('{row}', String(t.row)).replace('{col}', String(t.col))}）` : '';
    lines.push(`| ${id} | r${t.row}c${t.col} | ${t.x},${t.y} → ${t.x + t.w},${t.y + t.h} | ${t.w}×${t.h} ${name} |`);
  }
  return lines.join('\n');
}

/**
 * 生成"分块聚合逻辑"指令段（工具 1 的输出与工具 2 的 system 提示共用主体）。
 * 这是一段面向识别模型的执行规则，而不是给用户的说明。
 * @param {object} opts - {width, height, blockSize, overlap}
 * @returns {string} 聚合逻辑文本
 */
export function aggregateRulesText({ width, height, blockSize = 800, overlap = 0 } = {}) {
  const overlapNote = overlap > 0
    ? `相邻块有 ${overlap}px 交叠区域：交叠内容只用于衔接判断，不重复计入全局描述。`
    : '各块无交叠，块边界处被切断的物体/文字必须借用相邻块上下文合并识别。';
  return [
    '## 分块聚合逻辑（必须严格执行）',
    `1. 块保真说明：原图为 ${width}×${height}px，每块边长 ${blockSize}px，块是原图的 1:1 原始像素（未缩放、未降采样，细节无损）。请以"高清晰度"标准逐块识别。`,
    '2. 识别顺序：按上表编号升序（行优先：先 r0 行所有块，再 r1 行…），逐块观察，不要跳跃、不要遗漏。',
    '3. 定位说明：坐标清单给出每块的"原图坐标"(x0,y0)→(x1,y1)。块内任何物体都应以该块的局部像素坐标 + 其在该块中的相对位置描述（例如"位于该块左上角"），并在聚合时换算回原图整体方位。',
    `4. 合并还原：识别完成后按坐标把各块内容拼接为整张图的结构化描述；跨块对象（被切到两块及以上的文字行、表格、人/物）必须结合相邻块的编号与坐标判断是否为同一对象并合并描述，不得重复计数，也不得遗漏。`,
    `5. 禁止编造：只能描述某块内确有其物的内容；某块看不清时必须明说"该块内容不清晰"，绝不能臆测；整个图块之外的区域视为未知。`,
    `6. 全局一致：若各块描述相互矛盾（如同一物体出现在相邻两块），说明该物体横跨边界，按坐标衔接合并，取信息更完整的一侧为准。`,
    overlapNote,
    '7. 输出要求：输出按"全局概述 → 分区域细节（按块编号或原图坐标）"组织；若要求 JSON 结构，则严格遵循请求中给出的字段定义。',
    '8. 方向保持：所有块沿用原图方向（未旋转、未镜像），文字默认正向、从上到下从左到右阅读；禁止主观旋转或镜像坐标轴。若某块内容整体明显旋转（图本身横倒/倒置），以该块内的文字可读方向为准阅读，并在输出中标注该块编号及其实际方向（如"块 5 逆时针 90°"），供聚合层校正。'
  ].join('\n');
}

/**
 * 工具 1（vision_tile_split）的完整输出文本：切块结果 + 坐标清单 + 聚合逻辑。
 * 模型拿到这份文本后，可自行调用查看工具（或直接调用识别工具）继续工作。
 * @param {object} r - {filePath, outDir, width, height, tiles, grid, blockSize, overlap, overviewPath}
 * @returns {string} 模型可读的输出文本
 */
export function buildSplitResultText(r) {
  const lines = [
    `# 切块结果：${r.filePath}`,
    `原图 ${r.width}×${r.height}px → 切为 ${r.grid.rows}×${r.grid.cols} 网格，共 ${r.tiles.length} 块（块边长 ${r.blockSize}px${r.overlap > 0 ? `，交叠 ${r.overlap}px` : ''}）`,
    `块文件目录：${r.outDir}`,
    ''
  ];
  lines.push(buildTileListText(r.width, r.height, r.tiles, r.grid, r.fileNamePattern ?? ''));
  if (r.overviewPath) {
    lines.push('', `全局布局参考图（网格+编号）：${r.overviewPath} —— 建议先查看该图确认布局，再逐块识别。`);
  }
  lines.push('', aggregateRulesText({ width: r.width, height: r.height, blockSize: r.blockSize, overlap: r.overlap }));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 工具 2（vision_tile_recognize）的提示模板                            */
/* ------------------------------------------------------------------ */

/**
 * 单请求模式的 system 提示：识别 + 聚合一体化指令。
 * @param {object} opts - {question?, json, width, height, blockSize, overlap}
 * @returns {string} system 文本
 */
export function buildRecognizeSystem({ question = '', json = false, width = 0, height = 0, blockSize = 800, overlap = 0 } = {}) {
  const goal = question.trim().length > 0 ? `你的任务：${question.trim()}` : '你的任务：完整识别这张大图的全部内容（布局、文字、物体、图表等），并给出与整图规模匹配的详细描述。';
  const jsonNote = json
    ? [
        '输出格式：仅输出一个 JSON 对象（不要 markdown 代码块、不要多余文字），字段如下：',
        '{',
        '  "summary": "整图的全局概述（有层次的详细描述）",',
        '  "regions": [ { "id": 块编号, "rect": [x0,y0,x1,y1], "content": "该区域内容描述", "type": "text|image|chart|object|table|unknown" } ],',
        '  "crossBoundary": [ { "ids": [相邻块编号...], "note": "跨块对象的合并说明" } ],',
        '  "uncertain": [ "无法辨认的内容" ]',
        '}'
      ].join('\n')
    : '输出格式：先给一段整图全局概述，再按原图坐标（上→下、左→右）分区域给细节描述；最后列出跨块对象与不确定项。';
  return [
    '你是视觉识别助手，正在识别一张被切分成多块的大图。',
    goal,
    aggregateRulesText({ width, height, blockSize, overlap }),
    jsonNote,
    '注意：本消息中的所有图片来自同一张原图，按坐标清单顺序排列；正文请以坐标与块编号为准定位内容。'
  ].join('\n\n');
}

/**
 * 单请求模式的 user 文本：问题 + 坐标清单（与全部图片同一条 user 消息）。
 * @param {object} opts - {question?, width, height, tiles, grid, blockSize, overlap}
 * @returns {string} user 文本
 */
export function buildRecognizeUserText({ question = '', width = 0, height = 0, tiles = [], grid = { rows: 0, cols: 0 }, blockSize = 800, overlap = 0 } = {}) {
  const parts = [];
  if (question.trim().length > 0) parts.push(`【识别目标】${question.trim()}`);
  else parts.push('【识别目标】完整识别大图内容。');
  parts.push(buildTileListText(width, height, tiles, grid));
  parts.push(aggregateRulesText({ width, height, blockSize, overlap }));
  return parts.join('\n\n');
}

/**
 * 分层聚合模式（块数较多时）的组识别 system 提示。
 * 每组最多 groupSize 块；要求输出严格 JSON 数组（每块一个条目）。
 * @returns {string} system 文本
 */
export function buildGroupSystem() {
  return [
    '你是视觉识别助手。本消息包含同一张大图的若干 1:1 无损小块（每块 800×800 或边缘实际尺寸）。',
    '任务：逐块识别每张图的内容，按消息中给定的坐标清单把每块编号对应到原图坐标。',
    '输出：仅输出一个 JSON 数组（不要 markdown 代码块、不要多余文字），每块一个对象：',
    '[ { "id": 块编号, "rect": [x0, y0, x1, y1], "content": "该块详细内容描述（文字内容、物体、图表、颜色布局等）", "type": "text|image|chart|object|table|unknown" } ]',
    '规则：1) 只描述块内确实可见的内容，看不清就写 type="unknown" 并在 content 中说明；2) id 必须使用消息中坐标清单的编号；3) 绝不要臆造块外内容。'
  ].join('\n');
}

/**
 * 分层聚合模式的组 user 文本：坐标清单 + 组内图片（同一条 user 消息）。
 * @param {object} opts - {width, height, tiles, grid}
 * @returns {string} user 文本
 */
export function buildGroupUserText({ width = 0, height = 0, tiles = [], grid = { rows: 0, cols: 0 } } = {}) {
  return ['本组块清单：', buildTileListText(width, height, tiles, grid)].join('\n\n');
}

/**
 * 分层聚合模式的最终聚合 system 提示：把各组（逐块 JSON）汇总为全图描述。
 * @param {object} opts - {json}
 * @returns {string} system 文本
 */
export function buildAggregateSystem({ json = false } = {}) {
  const jsonNote = json
    ? '输出：仅输出一个 JSON 对象（不要 markdown 代码块），字段：{ "summary": 全局概述, "regions": [逐区域细节], "crossBoundary": [跨块对象合并说明], "uncertain": [不确定项] }'
    : '输出：先给整图全局概述，再按原图坐标分区域给出细节，最后列出跨块对象与不确定项。';
  return [
    '你是视觉识别助手。下面给出同一张大图被切分后，各块识别的结构化结果（每块带编号与原图坐标）。',
    jsonNote,
    '合并规则：1) 按坐标把相邻块内容拼接还原；2) 横跨多块的同一对象（文字行/表格/物体）合并为一条描述，不得重复；3) 块描述之间矛盾的，以坐标衔接判断是否为同一对象；4) 没有对应块内容的区域不得编造。'
  ].join('\n');
}

/**
 * 分层聚合模式的最终聚合 user 文本：拼接各组 JSON 结果。
 * @param {Array<{groupIndex:number, groupText:string}>} groups - 每组识别结果文本
 * @param {string} [question] - 用户问题（可为空）
 * @returns {string} user 文本
 */
export function buildAggregateUserText(groups, question = '') {
  const q = question.trim().length > 0 ? `【识别目标】${question.trim()}` : '【识别目标】完整识别大图内容。';
  const body = groups.map((g) => `## 第 ${g.groupIndex + 1} 组逐块识别结果\n${g.groupText}`).join('\n\n');
  return `${q}\n\n以下是各组逐块识别的结构化结果（id 为该块在坐标清单中的编号，rect 为原图坐标）：\n\n${body}`;
}

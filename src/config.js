/**
 * config.js — vision-exp-tile 插件的纯 JS 配置定义与归一化校验
 *
 * 设计说明：
 *  - 本模块不依赖 schemastery（避免运行时 schema 解析风险），用纯 JS 对象 +
 *    手写校验函数提供一套「默认配置 + 用户覆盖 + 合法性修正」的最小配置层。
 *  - 所有数值都限定在官方 API 文档与切图引擎（tile-engine）允许的安全范围内，
 *    非法取值直接抛出带 `config:` 前缀的中文错误，便于用户在配置阶段即发现问题。
 *  - 配置项同时作为两个工具（vision_tile_split / vision_tile_recognize）的默认值；
 *    工具执行时可以被参数（args）覆盖，但覆盖值仍在本文件界定的范围内二次校验。
 *
 * @module vision-exp-tile/config
 */

/** 本插件拥有的设置命名空间名（v0.3.0，DSH Web 设置页「图像识别」分区）。 */
export const NS = 'vision-exp-tile';

/* ------------------------------------------------------------------ */
/* 默认配置                                                             */
/* ------------------------------------------------------------------ */

/**
 * 插件默认配置。
 * - apiKeyEnv   读取 DeepSeek API key 的环境变量名。
 * - baseURL     DeepSeek 视觉 API 端点（OpenAI 兼容 chat/completions）。
 * - model       视觉模型名（deepseek-v4-flash-vision-exp）。
 * - blockSize   块边长（px）；800 是官方缩放甜蜜点：800×800 的块不降采样、每块 ≤384 token。
 * - cutThreshold 长边超过该值才切分；800×800 及以下不切（单图可直接识别）。
 * - overlap     相邻块交叠像素；0=不交叠，推荐 64 防止跨块边界文字/图形被切断。
 * - groupSize   分层聚合模式下每组最多块数。
 * - maxTokens   每次请求的输出 token 上限。
 * - timeoutMs   单次请求超时（毫秒）。
 * - format      输出块格式：png（无损，默认）/ jpeg（更省请求体）。
 * - quality     jpeg 质量（40..100，默认 90；png 不产生有损压缩，该值仅对 jpeg 生效）。
 * - mode        识别模式：auto（自动）/ single（单请求）/ layered（分层聚合）。
 * - json        是否要求模型输出 JSON 对象（结构化结果）。
 * - withOverview 是否同时生成并落盘 overview 缩略图（网格+块号，辅助全局布局）。
 * - outDir      块输出目录；空字符串表示「原图同目录下 <原名>_tiles 子目录」。
 * - rotate      识别前顺时针旋转角度（0/90/180/270）；默认 0。
 * - ocrPoolTimeoutMs OCR 池单请求超时（毫秒，20000..1200000）；默认 120s。
 * - performanceTier 性能档位（auto/fast/normal/slow）；默认 auto=自动探测。
 * - testTimeoutFactor 测试超时判定倍率（1..8，推荐 4=slow 档默认，手动最保守 8）；默认 1。
 * - testSkipTiming 是否跳过时序敏感断言（默认 false）。
 */
export const DEFAULT_CONFIG = Object.freeze({
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash-vision-exp',
  blockSize: 800,
  cutThreshold: 800,
  overlap: 0,
  groupSize: 40,
  maxTokens: 8192,
  timeoutMs: 300000,
  format: 'png',
  quality: 90,
  mode: 'auto',
  json: false,
  withOverview: true,
  outDir: '',
  rotate: 0,
  // v0.4.1：慢机测试自适应
  ocrPoolTimeoutMs: 120000,
  performanceTier: 'auto',
  testTimeoutFactor: 1,
  testSkipTiming: false,
  // v0.4.1 扩展：低性能设备适配增强（每项可控开关）
  deviceBenchmark: true,
  devicePowerProbe: true,
  platformFallback: 'auto',
  slowNetAdapt: true
});

/* ------------------------------------------------------------------ */
/* 取值/校验辅助函数                                                    */
/* ------------------------------------------------------------------ */

/**
 * 校验并读取一个必为整数且在 [min, max] 范围内的配置项。
 * @param {unknown} raw - 用户给定的原始值（可为 undefined）。
 * @param {number} fallback - 默认值（当 raw 为 undefined 时使用）。
 * @param {number} min - 最小允许值（含端点）。
 * @param {number} max - 最大允许值（含端点）。
 * @param {string} key - 配置键名（用于报错文案）。
 * @returns {number} 通过校验的整数。
 */
function readInt(raw, fallback, min, max, key) {
  const v = raw === undefined || raw === null ? fallback : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`config: ${key} 必须是 ${min}~${max} 的整数（实际：${raw === undefined ? `默认 ${fallback}` : String(raw)}）`);
  }
  return v;
}

/**
 * 校验并读取一个必为有限正数的配置项（用于价格等浮点字段）。
 * @param {unknown} raw - 用户给定的原始值。
 * @param {number} fallback - 默认值。
 * @param {string} key - 配置键名（用于报错文案）。
 * @returns {number} 通过校验的正数。
 */
function readPositive(raw, fallback, key) {
  const v = raw === undefined || raw === null ? fallback : Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`config: ${key} 必须是正数（实际：${raw === undefined ? `默认 ${fallback}` : String(raw)}）`);
  }
  return v;
}

/**
 * 校验并读取一个必须属于 allowed 枚举的字符串配置项。
 * @param {unknown} raw - 用户给定的原始值。
 * @param {string} fallback - 默认值。
 * @param {string[]} allowed - 允许的取值集合。
 * @param {string} key - 配置键名（用于报错文案）。
 * @returns {string} 通过校验的枚举值。
 */
function readEnum(raw, fallback, allowed, key) {
  const v = raw === undefined || raw === null ? fallback : String(raw);
  if (!allowed.includes(v)) {
    throw new Error(`config: ${key} 必须是 ${allowed.join('/')}（实际：${v}）`);
  }
  return v;
}

/**
 * 校验并读取一个非空字符串（用于 apiKeyEnv / baseURL 等）。
 * @param {unknown} raw - 用户给定的原始值。
 * @param {string} fallback - 默认值。
 * @param {string} key - 配置键名（用于报错文案）。
 * @returns {string} 去除首尾空白后的非空字符串。
 */
function readNonEmptyString(raw, fallback, key) {
  const v = String(raw === undefined || raw === null ? fallback : raw).trim();
  if (v.length === 0) {
    throw new Error(`config: ${key} 必须是非空字符串（实际为空）`);
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* normalizeConfig：合并默认 + 校验/修正                                 */
/* ------------------------------------------------------------------ */

/**
 * 归一化配置：把用户的原始配置与 {@link DEFAULT_CONFIG} 合并，并对每个字段做
 * 合法性校验（非法取值抛出带 `config:` 前缀的中文错误）。
 *
 * 校验范围一览（含边界）：
 *  - blockSize    整数 64..4096
 *  - overlap      整数 0..floor(blockSize/2)-1（须小于块边长的一半，否则块数爆炸）
 *  - cutThreshold 整数 64..8192
 *  - groupSize    整数 1..240
 *  - maxTokens    整数 256..65536
 *  - timeoutMs    整数 1000..3600000
 *  - quality      整数 40..100
 *  - format       仅 png/jpeg
 *  - mode         仅 auto/single/layered
 *  - apiKeyEnv    非空字符串
 *
 * @param {object} [raw] - 用户提供的部分配置；可为 undefined / null（此时几乎全用默认值）。
 * @returns {object} 校验并修正后的完整配置。
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  // 1. 先确定 blockSize，因为 overlap 上限依赖它。
  const blockSize = readInt(src.blockSize, DEFAULT_CONFIG.blockSize, 64, 4096, 'blockSize');
  const overlapMax = Math.floor(blockSize / 2) - 1; // 交叠必须严格小于块边长的一半
  const overlap = readInt(src.overlap, DEFAULT_CONFIG.overlap, 0, overlapMax, 'overlap');

  // 2. 其余可独立校验的数值字段。
  const cutThreshold = readInt(src.cutThreshold, DEFAULT_CONFIG.cutThreshold, 64, 8192, 'cutThreshold');
  const groupSize = readInt(src.groupSize, DEFAULT_CONFIG.groupSize, 1, 240, 'groupSize');
  const maxTokens = readInt(src.maxTokens, DEFAULT_CONFIG.maxTokens, 256, 65536, 'maxTokens');
  const timeoutMs = readInt(src.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 3600000, 'timeoutMs');
  const quality = readInt(src.quality, DEFAULT_CONFIG.quality, 40, 100, 'quality');

  // 3. 枚举字段。
  const format = readEnum(src.format, DEFAULT_CONFIG.format, ['png', 'jpeg'], 'format');
  const mode = readEnum(src.mode, DEFAULT_CONFIG.mode, ['auto', 'single', 'layered'], 'mode');

  // 4. 字符串字段。（baseURL / model 也做非空校验，但允许用户覆盖。）
  const apiKeyEnv = readNonEmptyString(src.apiKeyEnv, DEFAULT_CONFIG.apiKeyEnv, 'apiKeyEnv');
  const baseURL = readNonEmptyString(src.baseURL, DEFAULT_CONFIG.baseURL, 'baseURL');
  const model = readNonEmptyString(src.model, DEFAULT_CONFIG.model, 'model');

  // 5. 布尔字段（允许字符串 "true"/"false" 或布尔值）。
  const boolVal = (v, fallback) => {
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 'false') return v === 'true';
    throw new Error(`config: 布尔字段（如 json / withOverview）仅接受 true/false（实际：${String(v)}）`);
  };
  const json = boolVal(src.json, DEFAULT_CONFIG.json);
  const withOverview = boolVal(src.withOverview, DEFAULT_CONFIG.withOverview);

  // 6. outDir：仅接受字符串；空字符串=默认「原图同目录 _tiles」。
  const outDir = typeof src.outDir === 'string' ? src.outDir : DEFAULT_CONFIG.outDir;

  // 7. rotate：仅允许 0/90/180/270（顺时针），用于把"歪图"转正后再识别。
  const rotateRaw = src.rotate === undefined || src.rotate === null ? DEFAULT_CONFIG.rotate : Number(src.rotate);
  if (![0, 90, 180, 270].includes(rotateRaw)) {
    throw new Error(`config: rotate 必须是 0/90/180/270（实际：${String(src.rotate ?? DEFAULT_CONFIG.rotate)}）`);
  }
  const rotate = rotateRaw;

  // 8. v0.4.1：慢机测试自适应字段（OCR 池超时/性能档位/测试倍率/跳过声明）。
  const ocrPoolTimeoutMs = readInt(src.ocrPoolTimeoutMs, DEFAULT_CONFIG.ocrPoolTimeoutMs, 20000, 1200000, 'ocrPoolTimeoutMs');
  const performanceTier = readEnum(src.performanceTier, DEFAULT_CONFIG.performanceTier, ['auto', 'fast', 'normal', 'slow'], 'performanceTier');
  const testTimeoutFactor = readInt(src.testTimeoutFactor, DEFAULT_CONFIG.testTimeoutFactor, 1, 8, 'testTimeoutFactor');
  const testSkipTiming = boolVal(src.testSkipTiming, DEFAULT_CONFIG.testSkipTiming);

  // 9. v0.4.1 扩展：低性能设备适配增强（每项可控开关）。
  const deviceBenchmark = boolVal(src.deviceBenchmark, DEFAULT_CONFIG.deviceBenchmark);
  const devicePowerProbe = boolVal(src.devicePowerProbe, DEFAULT_CONFIG.devicePowerProbe);
  const platformFallback = readEnum(src.platformFallback, DEFAULT_CONFIG.platformFallback, ['auto', 'on', 'off'], 'platformFallback');
  const slowNetAdapt = boolVal(src.slowNetAdapt, DEFAULT_CONFIG.slowNetAdapt);

  return {
    apiKeyEnv,
    baseURL,
    model,
    blockSize,
    cutThreshold,
    overlap,
    groupSize,
    maxTokens,
    timeoutMs,
    format,
    quality,
    mode,
    json,
    withOverview,
    outDir,
    rotate,
    ocrPoolTimeoutMs,
    performanceTier,
    testTimeoutFactor,
    testSkipTiming,
    deviceBenchmark,
    devicePowerProbe,
    platformFallback,
    slowNetAdapt
  };
}

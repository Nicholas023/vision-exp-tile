/**
 * runtime.js — vision-exp-tile 运行时配置快照（设置合并 + env 映射）
 *
 * v0.3.0：宿主侧把「图像识别」设置命名空间的最新解析值通过 setRuntimeSource()
 * 注入本模块。各工具在 execute 时读 getRuntimeConfig() 得到「当前有效」的归一化
 * 配置（camelCase，兼容 normalizeConfig 输出 + 纯设置项透传），从而做到改设置
 * 热生效，且保持优先级：工具参数(显式) > 设置页 > 默认值。
 *
 * 两种注入方式：
 *  - setRuntimeConfig(cfg)：直接替换快照（测试 / 手动）。
 *  - setRuntimeSource(fn)：注册一个返回「设置解析后配置对象的 getter」；读取时
 *    惰性重读 getter 并覆盖快照，保证设置热更立即生效。
 *
 * envFromSettings(raw)：把设置快照映射成「应写入 process.env 的 DSH_* 键值对」。
 *  applySettingsEnv(raw)：把上述键值对写入 process.env，幂等——但绝不覆盖用户
 *    显式设置的环境变量（用户在插件加载前就设的 DSH_* 值优先于设置页）；对「我们
 *    上一次写入、本次设置已取消该映射」的键会清理回读默认，避免设置改回 auto/默认
 *    后残留旧值。
 *
 * normalizeFromSettings(raw)：设置快照 → snake_case 键映射为 camelCase 配置键
 * （base_url→baseURL 等，见 settings-schema.js 的 SETTINGS_FIELDS.configKey），
 * 再交给 normalizeConfig 统一校验归一化；config.js 保持纯函数不被修改。
 *
 * @module vision-exp-tile/runtime
 */

import { normalizeConfig } from './config.js';
import { SETTINGS_FIELDS } from './settings-schema.js';

/* ------------------------------------------------------------------ */
/* 内部状态                                                             */
/* ------------------------------------------------------------------ */

/** 当前有效配置对象（normalizeConfig 输出 + 纯设置项透传）。 */
let current = {};
/** source getter；注册后 getRuntimeConfig() 惰性重读它。 */
let sourceFn = null;

/** 受管的环境变量（只允许这些键被设置）。 */
const SETTINGS_ENV_KEYS = [
  'DSH_OCR_ENGINE',
  'DSH_OCR_HANDWRITE',
  'DSH_OCR_UPGRADE',
  'DSH_INTEREST_CONCURRENCY',
  'DSH_OCR_POOL',
  'DSH_OCR_CACHE',
  'DSH_OCR_PREPROC'
];

/**
 * 模块加载时已存在的 DSH_* 值视为「用户显式设置」的基线——设置页永远不能覆盖
 * 它们（用户显式 env 优先）。后续每次 applySettingsEnv 都会据此判断是否写入。
 */
const userEnvBaseline = {};
for (const k of SETTINGS_ENV_KEYS) {
  if (process.env[k] !== undefined) userEnvBaseline[k] = process.env[k];
}

/** 上一次由我们写入（并因此受管理）的 env 键；用于设置回退时清理残留。 */
const appliedByUs = new Set();

/* ------------------------------------------------------------------ */
/* 快照读写                                                             */
/* ------------------------------------------------------------------ */

/**
 * 直接替换运行时快照（测试 / 手动；不设 source 时不会被覆盖）。
 * @param {object} [cfg] - 归一化后的配置对象。
 */
export function setRuntimeConfig(cfg = {}) {
  current = cfg && typeof cfg === 'object' ? cfg : {};
}

/**
 * 注册一个返回「当前设置解析后的配置对象」的 getter（宿主：() => normalizeFromSettings(scope.get())）。
 * 读取时惰性重读，保证热生效。
 * @param {() => object|null} fn
 */
export function setRuntimeSource(fn) {
  sourceFn = typeof fn === 'function' ? fn : null;
  refresh();
}

/** 若注册了 source getter，则先同步一次最新值。 */
function refresh() {
  if (sourceFn) {
    try {
      const raw = sourceFn();
      if (raw && typeof raw === 'object') current = raw;
    } catch {
      // 读取失败则沿用上次快照。
    }
  }
}

/**
 * 读取运行时快照（返回内部引用；调用方不应修改）。
 * @returns {object} 归一化后的配置对象。
 */
export function getRuntimeConfig() {
  refresh();
  return current;
}

/**
 * 测试专用：重置运行时内部状态（基线 / 已写入记录 / source / 快照）。
 * 通过 env 参数模拟「用户显式设置的环境变量基线」，便于确定性测试。
 * @param {object} [env] - 作为用户基线的环境变量视图（缺省用 process.env）。
 */
export function _resetRuntimeForTest(env = process.env) {
  for (const k of Object.keys(userEnvBaseline)) delete userEnvBaseline[k];
  for (const k of appliedByUs) appliedByUs.delete(k);
  for (const k of SETTINGS_ENV_KEYS) {
    if (env[k] !== undefined) userEnvBaseline[k] = env[k];
  }
  sourceFn = null;
  current = {};
}

/* ------------------------------------------------------------------ */
/* 设置 → env 映射                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把设置快照映射成「应写入 process.env 的 DSH_* 键值对」。
 *
 * 仅映射那些在设置页中有明确含义、且能直接落 env 的键：
 *  - 枚举：auto/默认值（=不设置，交给模块自动降级/默认）不生成键。
 *  - 数值：交叠出界/非整数则忽略（模块自行回退）。
 *  - 布尔：true=不设置（模块默认开）；false=显式 "0" 关闭。
 *
 * @param {object} [raw] - 设置快照（snake_case，scope.get() 的解析值）。
 * @returns {Record<string,string>} env 键值对（不写入 process.env，纯计算）。
 */
export function envFromSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  // DSH_OCR_ENGINE：auto/空=不设置（模块自动降级）。
  const engine = String(v.ocr_engine ?? 'auto').trim();
  if (engine !== '' && engine !== 'auto') out.DSH_OCR_ENGINE = engine;

  // DSH_OCR_HANDWRITE：smart=默认（也显式写入，安全）。
  const hw = String(v.handwrite_route ?? 'smart').trim();
  if (hw !== '') out.DSH_OCR_HANDWRITE = hw;

  // DSH_OCR_UPGRADE：full=默认。
  const up = String(v.upgrade ?? 'full').trim();
  if (up !== '') out.DSH_OCR_UPGRADE = up;

  // DSH_INTEREST_CONCURRENCY（1..4）。
  const ic = Number(v.interest_concurrency);
  if (Number.isInteger(ic) && ic >= 1 && ic <= 4) out.DSH_INTEREST_CONCURRENCY = String(ic);

  // DSH_OCR_POOL（0..8）。
  const pool = Number(v.ocr_pool);
  if (Number.isInteger(pool) && pool >= 0 && pool <= 8) out.DSH_OCR_POOL = String(pool);

  // DSH_OCR_CACHE：true=不设置（默认开）；false="0"。
  if (v.ocr_cache === false) out.DSH_OCR_CACHE = '0';

  // DSH_OCR_PREPROC：true=不设置（默认开）；false="0"。
  if (v.ocr_preproc === false) out.DSH_OCR_PREPROC = '0';

  return out;
}

/**
 * 把设置快照转换为的 env 键值对写入 process.env（幂等）。
 *
 * 规则：
 *  - 用户显式设置（模块加载前已存在的 DSH_*）优先：绝不覆盖。
 *  - 其余：本次设置给出的值写入；若本次设置不再需要该键（如引擎改回
 *    auto），则清理掉我们上次写入的残留，避免旧值影响下次工具调用。
 *
 * @param {object} [raw] - 设置快照。
 * @returns {Record<string,string>} 本次实际写入的 env 键值对（供日志/测试）。
 */
export function applySettingsEnv(raw) {
  const pairs = envFromSettings(raw);
  const written = {};
  for (const k of SETTINGS_ENV_KEYS) {
    // 用户显式设置的 env 永远是最高优先级：设置页不覆盖。
    if (userEnvBaseline[k] !== undefined) continue;

    if (pairs[k] !== undefined) {
      process.env[k] = pairs[k];
      appliedByUs.add(k);
      written[k] = pairs[k];
    } else if (appliedByUs.has(k)) {
      // 设置已取消该映射（改回 auto/默认）→ 清理我们之前写入的残留。
      delete process.env[k];
      appliedByUs.delete(k);
    }
  }
  return written;
}

/* ------------------------------------------------------------------ */
/* 设置 → 归一化配置                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把设置快照转换为归一化配置对象。
 *
 * 先把 snake_case 设置键映射成 camelCase 配置键（见 SETTINGS_FIELDS.configKey），
 * 交给 normalizeConfig 统一校验归一化（config.js 纯函数，不做任何修改）；随后把
 * 纯设置项（preprocess / ocr_engine / handwrite_route / upgrade / debug 等，
 * 不属于 config.js 的字段）透传附加，供工具读取。
 *
 * @param {object} [raw] - 设置快照（scope.get() 的解析值）。
 * @returns {object} 归一化后的配置对象（含纯设置项透传）。
 */
export function normalizeFromSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};

  // 1. snake_case → camelCase 的 config 键候选。
  const candidate = {};
  for (const f of SETTINGS_FIELDS) {
    if (!f.configKey) continue;
    if (v[f.key] !== undefined) candidate[f.configKey] = v[f.key];
  }

  // 2. 交给 normalizeConfig 统一校验归一化（纯函数）。
  const cfg = normalizeConfig(candidate);

  // 3. 追加纯设置项（不经 normalizeConfig；为工具读取/调试用）。
  return {
    ...cfg,
    preprocess: String(v.preprocess ?? 'auto'),
    ocr_engine: String(v.ocr_engine ?? 'auto'),
    handwrite_route: String(v.handwrite_route ?? 'smart'),
    upgrade: String(v.upgrade ?? 'full'),
    interest_concurrency: Number.isFinite(Number(v.interest_concurrency)) ? Number(v.interest_concurrency) : 2,
    ocr_pool: Number.isFinite(Number(v.ocr_pool)) ? Number(v.ocr_pool) : 4,
    ocr_cache: v.ocr_cache === undefined ? true : Boolean(v.ocr_cache),
    ocr_preproc: v.ocr_preproc === undefined ? true : Boolean(v.ocr_preproc),
    debug: v.debug === true
  };
}

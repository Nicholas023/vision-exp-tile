/**
 * settings.test.js — v0.3.0 设置命名空间 / 运行时快照 / env 映射 纯逻辑测试
 *
 * 不依赖 DSH 服务器（无需 node_modules 安装：schemastery 经 dev 目录已有的
 * node_modules junction 解析）。覆盖：
 *  - SETTINGS_FIELDS 与 SettingsSchema 键一致。
 *  - normalizeFromSettings：snake_case→camelCase 键映射（base_url→baseURL 等）。
 *  - envFromSettings：设置→DSH_* 环境变量映射（含 auto/默认=不设置规则）。
 *  - applySettingsEnv：用户显式 env 优先、写入未设置项、回退时清理残留。
 *  - setRuntimeSource / getRuntimeConfig：快照语义（热生效）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_NS, SettingsSchema, SETTINGS_FIELDS } from '../src/settings-schema.js';
import {
  envFromSettings,
  applySettingsEnv,
  normalizeFromSettings,
  setRuntimeSource,
  setRuntimeConfig,
  getRuntimeConfig,
  _resetRuntimeForTest
} from '../src/runtime.js';

/* ------------------------------------------------------------------ */
/* 环境变量快照/恢复助手（applySettingsEnv 会写 process.env）            */
/* ------------------------------------------------------------------ */

const DSH_KEYS = [
  'DSH_OCR_ENGINE', 'DSH_OCR_HANDWRITE', 'DSH_OCR_UPGRADE',
  'DSH_INTEREST_CONCURRENCY', 'DSH_OCR_POOL', 'DSH_OCR_CACHE', 'DSH_OCR_PREPROC',
  // v0.4.1：新增可写 env（含 GPU/慢机自适应相关），测试后须还原避免污染
  'DSH_OCR_GPU_PROVIDER', 'DSH_OCR_GPU_PYTHON', 'DSH_OCR_GPU_DEVICE', 'DSH_OCR_GPU_FALLBACK',
  'DSH_OCR_POOL_TIMEOUT', 'DSH_OCR_PERF_TIER', 'VISION_TEST_TIMEOUT_FACTOR', 'VISION_TEST_SKIP_TIMING'
];

function snapshotEnv() {
  const snap = {};
  for (const k of DSH_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const k of DSH_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

/* ------------------------------------------------------------------ */
/* SETTINGS_FIELDS 与 SettingsSchema 键一致                             */
/* ------------------------------------------------------------------ */

test('SETTINGS_NS 为 vision-exp-tile', () => {
  assert.equal(SETTINGS_NS, 'vision-exp-tile');
});

test('SETTINGS_FIELDS 键与 SettingsSchema.dict 键完全一致', () => {
  const fromSchema = Object.keys(SettingsSchema.dict ?? {});
  const fromFields = SETTINGS_FIELDS.map((f) => f.key);
  // 双向都无缺失/多余
  const missingInFields = fromSchema.filter((k) => !fromFields.includes(k));
  const extraInFields = fromFields.filter((k) => !fromSchema.includes(k));
  assert.deepEqual(missingInFields, [], `schema 有而 fields 缺：${missingInFields}`);
  assert.deepEqual(extraInFields, [], `fields 有而 schema 缺：${extraInFields}`);
});

test('SETTINGS_FIELDS 每个字段含必需元信息（key/type/labelKey/advanced）', () => {
  for (const f of SETTINGS_FIELDS) {
    assert.ok(f.key, `字段缺 key：${JSON.stringify(f)}`);
    assert.ok(['enum', 'number', 'boolean', 'text'].includes(f.type), `字段 ${f.key} 的 type 非法：${f.type}`);
    assert.ok(f.labelKey, `字段 ${f.key} 缺 labelKey`);
    assert.equal(typeof f.advanced, 'boolean', `字段 ${f.key} 的 advanced 应为布尔`);
  }
});

/* ------------------------------------------------------------------ */
/* normalizeFromSettings：键映射                                        */
/* ------------------------------------------------------------------ */

test('normalizeFromSettings 映射 base_url→baseURL / api_key_env→apiKeyEnv 等', () => {
  const cfg = normalizeFromSettings({
    base_url: 'https://vision.example.com',
    api_key_env: 'MY_VISION_KEY',
    model: 'custom-vision',
    block_size: 900,
    cut_threshold: 1200,
    overlap: 64,
    group_size: 25,
    max_tokens: 2048,
    timeout_ms: 60000,
    format: 'jpeg',
    quality: 80,
    mode: 'layered',
    json: true,
    with_overview: false,
    out_dir: '/tmp/blocks',
    rotate: 90
  });
  assert.equal(cfg.baseURL, 'https://vision.example.com');
  assert.equal(cfg.apiKeyEnv, 'MY_VISION_KEY');
  assert.equal(cfg.model, 'custom-vision');
  assert.equal(cfg.blockSize, 900);
  assert.equal(cfg.cutThreshold, 1200);
  assert.equal(cfg.overlap, 64);
  assert.equal(cfg.groupSize, 25);
  assert.equal(cfg.maxTokens, 2048);
  assert.equal(cfg.timeoutMs, 60000);
  assert.equal(cfg.format, 'jpeg');
  assert.equal(cfg.quality, 80);
  assert.equal(cfg.mode, 'layered');
  assert.equal(cfg.json, true);
  assert.equal(cfg.withOverview, false);
  assert.equal(cfg.outDir, '/tmp/blocks');
  assert.equal(cfg.rotate, 90);
});

test('normalizeFromSettings 空 raw 回落 DEFAULT_CONFIG，且透传纯设置项', () => {
  const cfg = normalizeFromSettings({});
  assert.equal(cfg.baseURL, 'https://api.deepseek.com');
  assert.equal(cfg.model, 'deepseek-v4-flash-vision-exp');
  assert.equal(cfg.blockSize, 800);
  assert.equal(cfg.maxTokens, 8192);
  // 纯设置项透传（默认值）
  assert.equal(cfg.preprocess, 'auto');
  assert.equal(cfg.ocr_engine, 'auto');
  assert.equal(cfg.debug, false);
});

test('normalizeFromSettings 越界数值抛错（与 config.js 校验一致）', () => {
  assert.throws(() => normalizeFromSettings({ block_size: 9999 }), /blockSize/);
});

/* ------------------------------------------------------------------ */
/* envFromSettings：设置→DSH_* env                                       */
/* ------------------------------------------------------------------ */

test('envFromSettings 映射枚举/数值/布尔到 DSH_* env', () => {
  const env = envFromSettings({
    ocr_engine: 'paddle',
    handwrite_route: 'visual',
    upgrade: 'low',
    interest_concurrency: 3,
    ocr_pool: 6,
    ocr_cache: false,
    ocr_preproc: false
  });
  assert.equal(env.DSH_OCR_ENGINE, 'paddle');
  assert.equal(env.DSH_OCR_HANDWRITE, 'visual');
  assert.equal(env.DSH_OCR_UPGRADE, 'low');
  assert.equal(env.DSH_INTEREST_CONCURRENCY, '3');
  assert.equal(env.DSH_OCR_POOL, '6');
  assert.equal(env.DSH_OCR_CACHE, '0');
  assert.equal(env.DSH_OCR_PREPROC, '0');
});

test('envFromSettings：auto/默认=不设置对应键', () => {
  const env = envFromSettings({
    ocr_engine: 'auto',      // auto → 不设置 DSH_OCR_ENGINE
    ocr_cache: true,         // true → 不设置 DSH_OCR_CACHE
    ocr_preproc: true        // true → 不设置 DSH_OCR_PREPROC
  });
  assert.equal(env.DSH_OCR_ENGINE, undefined);
  assert.equal(env.DSH_OCR_CACHE, undefined);
  assert.equal(env.DSH_OCR_PREPROC, undefined);
  assert.equal(env.DSH_OCR_HANDWRITE, 'smart'); // smart 默认也显式写入（安全）
  assert.equal(env.DSH_OCR_UPGRADE, 'full');    // full 默认也显式写入（安全）
});

test('envFromSettings：越界/非整数数值被忽略', () => {
  const env = envFromSettings({ interest_concurrency: 99, ocr_pool: -1 });
  assert.equal(env.DSH_INTEREST_CONCURRENCY, undefined);
  assert.equal(env.DSH_OCR_POOL, undefined);
});

/* ------------------------------------------------------------------ */
/* applySettingsEnv：用户显式 env 优先 / 写入未设置 / 回退清理             */
/* ------------------------------------------------------------------ */

test('applySettingsEnv：用户显式设置的 env 不被覆盖（基线优先）', () => {
  const snap = snapshotEnv();
  try {
    // 模拟插件加载前用户已显式设置 DSH_OCR_ENGINE=rapid
    _resetRuntimeForTest({ DSH_OCR_ENGINE: 'rapid' });
    const written = applySettingsEnv({ ocr_engine: 'paddle' });
    // 基线键不覆盖 → 未写入 DSH_OCR_ENGINE
    assert.equal(written.DSH_OCR_ENGINE, undefined);
    // 其余键正常写入（基线只含 DSH_OCR_ENGINE）
    assert.equal(written.DSH_OCR_HANDWRITE, 'smart');
  } finally {
    restoreEnv(snap);
    _resetRuntimeForTest();
  }
});

test('applySettingsEnv：未设置项被写入（回退值）', () => {
  const snap = snapshotEnv();
  try {
    _resetRuntimeForTest({});
    const written = applySettingsEnv({ ocr_engine: 'paddle', ocr_pool: 5 });
    assert.equal(process.env.DSH_OCR_ENGINE, 'paddle');
    assert.equal(process.env.DSH_OCR_POOL, '5');
    assert.ok(written.DSH_OCR_ENGINE);
  } finally {
    restoreEnv(snap);
    _resetRuntimeForTest();
  }
});

test('applySettingsEnv：设置改回 auto 时清理我们之前写入的残留', () => {
  const snap = snapshotEnv();
  try {
    _resetRuntimeForTest({});
    // 第一次：写 DSH_OCR_ENGINE=paddle
    applySettingsEnv({ ocr_engine: 'paddle' });
    assert.equal(process.env.DSH_OCR_ENGINE, 'paddle');
    // 第二次：引擎改回 auto → 应删除我们写入的残留
    applySettingsEnv({ ocr_engine: 'auto' });
    assert.equal(process.env.DSH_OCR_ENGINE, undefined);
  } finally {
    restoreEnv(snap);
    _resetRuntimeForTest();
  }
});

/* ------------------------------------------------------------------ */
/* setRuntimeSource / getRuntimeConfig：快照语义                         */
/* ------------------------------------------------------------------ */

test('setRuntimeSource + getRuntimeConfig：读最新归一化配置（热生效）', () => {
  _resetRuntimeForTest({});
  try {
    let source = { base_url: 'https://a', block_size: 512 };
    setRuntimeSource(() => normalizeFromSettings(source));
    assert.equal(getRuntimeConfig().baseURL, 'https://a');
    assert.equal(getRuntimeConfig().blockSize, 512);
    // 更新源后，下一次读取立即拿到新值（热生效）
    source = { ...source, base_url: 'https://b', block_size: 640 };
    assert.equal(getRuntimeConfig().baseURL, 'https://b');
    assert.equal(getRuntimeConfig().blockSize, 640);
  } finally {
    _resetRuntimeForTest();
  }
});

test('setRuntimeConfig 直接替换快照（无 source 时不被覆盖）', () => {
  _resetRuntimeForTest({});
  try {
    setRuntimeConfig({ blockSize: 300, baseURL: 'https://direct' });
    assert.equal(getRuntimeConfig().blockSize, 300);
    assert.equal(getRuntimeConfig().baseURL, 'https://direct');
  } finally {
    _resetRuntimeForTest();
  }
});

test('source getter 抛错时沿用上次快照', () => {
  _resetRuntimeForTest({});
  try {
    setRuntimeConfig({ blockSize: 777 });
    setRuntimeSource(() => { throw new Error('boom'); });
    assert.equal(getRuntimeConfig().blockSize, 777); // 沿用上次快照，不崩
  } finally {
    _resetRuntimeForTest();
  }
});

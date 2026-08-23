/**
 * gpu.test.js — v0.4.0 GPU 多设备加速 纯逻辑/决策 单元测试（不依赖真 GPU，不启动真实推理）
 *
 * 覆盖：
 *  - resolveGpuProvider：DSH_OCR_GPU_PROVIDER + 可用 provider → 实际 EP（镜像 worker 决策表）。
 *  - gpuPython()：DSH_OCR_GPU_PYTHON 覆盖 / venv 缺失回退 null。
 *  - resolveEngine()：DSH_OCR_ENGINE=gpu/auto/默认 的决策（经 _setEngineAvailableOverride mock 探测）。
 *  - settings 一致性：SETTINGS_FIELDS 含 GPU 字段、SettingsSchema 键一致、env 映射、回退规则。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { SETTINGS_NS, SettingsSchema, SETTINGS_FIELDS } from '../src/settings-schema.js';
import { envFromSettings, normalizeFromSettings } from '../src/runtime.js';
import {
  resolveGpuProvider,
  gpuPython,
  gpuRuntimeFailedFlag,
  setGpuRuntimeFailed,
  _setEngineAvailableOverride,
  resolveEngine
} from '../src/ocr-local.js';

/* ------------------------------------------------------------------ */
/* 环境变量快照/恢复（避免测试间污染）                                   */
/* ------------------------------------------------------------------ */
const ENV_KEYS = ['DSH_OCR_ENGINE', 'DSH_OCR_GPU_PROVIDER', 'DSH_OCR_GPU_PYTHON', 'DSH_OCR_GPU_DEVICE', 'DSH_OCR_GPU_FALLBACK', 'DSH_RAPID_PYTHON'];
function snapEnv() {
  const s = {};
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restoreEnv(s) {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

/* ------------------------------------------------------------------ */
/* resolveGpuProvider：provider 决策表（镜像 python worker 逻辑）        */
/* ------------------------------------------------------------------ */

test('resolveGpuProvider：auto 优先 cuda→dml→openvino→cpu', () => {
  assert.equal(resolveGpuProvider('auto', ['DmlExecutionProvider', 'CPUExecutionProvider']), 'dml');
  assert.equal(resolveGpuProvider('auto', ['CUDAExecutionProvider', 'CPUExecutionProvider']), 'cuda');
  assert.equal(resolveGpuProvider('auto', ['OpenVINOExecutionProvider', 'CPUExecutionProvider']), 'openvino');
  assert.equal(resolveGpuProvider('auto', ['CPUExecutionProvider']), 'cpu');
  assert.equal(resolveGpuProvider('auto', []), 'cpu');
});

test('resolveGpuProvider：显式 EP 不可用回退 cpu', () => {
  assert.equal(resolveGpuProvider('cuda', ['DmlExecutionProvider', 'CPUExecutionProvider']), 'cpu');
  assert.equal(resolveGpuProvider('dml', ['DmlExecutionProvider', 'CPUExecutionProvider']), 'dml');
  assert.equal(resolveGpuProvider('cuda', ['CUDAExecutionProvider', 'CPUExecutionProvider']), 'cuda');
  assert.equal(resolveGpuProvider('openvino', ['OpenVINOExecutionProvider', 'CPUExecutionProvider']), 'openvino');
  assert.equal(resolveGpuProvider('openvino', ['DmlExecutionProvider', 'CPUExecutionProvider']), 'cpu');
});

test('resolveGpuProvider：off 强制 cpu；大小写/空值容错', () => {
  assert.equal(resolveGpuProvider('off', ['CUDAExecutionProvider', 'DmlExecutionProvider']), 'cpu');
  assert.equal(resolveGpuProvider('DML', ['DmlExecutionProvider', 'CPUExecutionProvider']), 'dml');
  assert.equal(resolveGpuProvider('', ['CUDAExecutionProvider', 'CPUExecutionProvider']), 'cuda');
  assert.equal(resolveGpuProvider(undefined, ['CPUExecutionProvider']), 'cpu');
});

/* ------------------------------------------------------------------ */
/* gpuPython：路径解析与缺失回退                                        */
/* ------------------------------------------------------------------ */

test('gpuPython：DSH_OCR_GPU_PYTHON 指向存在文件 → 返回该路径；不存在 → null', () => {
  const snap = snapEnv();
  // 用临时目录自建"存在文件"，避免依赖本机 venv 是否存在（CI/Linux 通用）
  const tmp = mkdtempSync(join(tmpdir(), 'gpu-py-'));
  try {
    const realPy = join(tmp, 'python.exe');
    writeFileSync(realPy, ''); // 创建空文件即视为"存在"
    process.env.DSH_OCR_GPU_PYTHON = realPy;
    assert.equal(gpuPython(), realPy);
    const bad = join(tmp, 'no_such', 'python.exe');
    process.env.DSH_OCR_GPU_PYTHON = bad;
    assert.equal(gpuPython(), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    restoreEnv(snap);
  }
});

test('gpuPython：未设置 env 时用默认 ~/rapid_gpu_venv，缺失即 null', () => {
  const snap = snapEnv();
  try {
    delete process.env.DSH_OCR_GPU_PYTHON;
    const p = join(homedir(), 'rapid_gpu_venv', 'Scripts', 'python.exe');
    if (existsSync(p)) assert.equal(gpuPython(), p);
    else assert.equal(gpuPython(), null);
  } finally {
    restoreEnv(snap);
  }
});

/* ------------------------------------------------------------------ */
/* resolveEngine：gpu/auto 决策（mock 探测）                            */
/* ------------------------------------------------------------------ */

test('resolveEngine：gpu 强制 + 探测通过 → gpu；探测失败 → rapid/windows', async () => {
  const snap = snapEnv();
  try {
    process.env.DSH_OCR_ENGINE = 'gpu';
    _setEngineAvailableOverride(async (eng) => eng === 'gpu');
    assert.equal(await resolveEngine(), 'gpu');
    _setEngineAvailableOverride(async (eng) => eng === 'rapid');
    assert.equal(await resolveEngine(), 'rapid');
    _setEngineAvailableOverride(async () => false);
    assert.equal(await resolveEngine(), 'windows');
  } finally {
    _setEngineAvailableOverride(null);
    restoreEnv(snap);
  }
});

test('resolveEngine：auto 探测通过 → gpu；探测失败走默认顺序（rapid 优先）', async () => {
  const snap = snapEnv();
  try {
    process.env.DSH_OCR_ENGINE = 'auto';
    _setEngineAvailableOverride(async (eng) => eng === 'gpu');
    assert.equal(await resolveEngine(), 'gpu');
    _setEngineAvailableOverride(async (eng) => eng === 'rapid');
    assert.equal(await resolveEngine(), 'rapid');
  } finally {
    _setEngineAvailableOverride(null);
    restoreEnv(snap);
  }
});

test('resolveEngine：默认（未设置）不探测 GPU，保持 rapid 优先（向后兼容）', async () => {
  const snap = snapEnv();
  try {
    delete process.env.DSH_OCR_ENGINE;
    // 即使 gpu 探测为 true，默认也不应切到 gpu（rapid 优先，向后兼容）
    _setEngineAvailableOverride(async (eng) => eng === 'gpu' || eng === 'rapid');
    assert.equal(await resolveEngine(), 'rapid');
    _setEngineAvailableOverride(async () => false);
    assert.equal(await resolveEngine(), 'windows');
  } finally {
    _setEngineAvailableOverride(null);
    restoreEnv(snap);
  }
});

test('resolveEngine：gpuRuntimeFailed 置位后 auto/gpu 不再尝试 GPU', async () => {
  const snap = snapEnv();
  try {
    process.env.DSH_OCR_ENGINE = 'auto';
    _setEngineAvailableOverride(async (eng) => eng === 'gpu' || eng === 'rapid');
    setGpuRuntimeFailed(true);
    assert.equal(gpuRuntimeFailedFlag(), true);
    assert.equal(await resolveEngine(), 'rapid');
  } finally {
    setGpuRuntimeFailed(false);
    _setEngineAvailableOverride(null);
    restoreEnv(snap);
  }
});

/* ------------------------------------------------------------------ */
/* settings 一致性（schema/fields/env 映射/回退）                       */
/* ------------------------------------------------------------------ */

test('SETTINGS_NS 仍为 vision-exp-tile；GPU 字段在 SettingsSchema 与 SETTINGS_FIELDS 中一致', () => {
  assert.equal(SETTINGS_NS, 'vision-exp-tile');
  const gpuKeys = ['gpu_provider', 'gpu_python', 'gpu_device', 'gpu_fallback'];
  const schemaKeys = Object.keys(SettingsSchema.dict ?? {});
  const fieldKeys = SETTINGS_FIELDS.map((f) => f.key);
  for (const k of gpuKeys) {
    assert.ok(schemaKeys.includes(k), `schema 缺 GPU 字段：${k}`);
    assert.ok(fieldKeys.includes(k), `fields 缺 GPU 字段：${k}`);
  }
  const missingInFields = schemaKeys.filter((k) => !fieldKeys.includes(k));
  const extraInFields = fieldKeys.filter((k) => !schemaKeys.includes(k));
  assert.deepEqual(missingInFields, []);
  assert.deepEqual(extraInFields, []);
});

test('GPU 字段类型/高级/环境变量映射正确', () => {
  const byKey = Object.fromEntries(SETTINGS_FIELDS.map((f) => [f.key, f]));
  assert.equal(byKey.gpu_provider.type, 'enum');
  assert.deepEqual(byKey.gpu_provider.options, ['auto', 'cuda', 'dml', 'openvino', 'off']);
  assert.equal(byKey.gpu_provider.envKey, 'DSH_OCR_GPU_PROVIDER');
  assert.equal(byKey.gpu_python.type, 'text');
  assert.equal(byKey.gpu_python.envKey, 'DSH_OCR_GPU_PYTHON');
  assert.equal(byKey.gpu_device.type, 'text');
  assert.equal(byKey.gpu_device.envKey, 'DSH_OCR_GPU_DEVICE');
  assert.equal(byKey.gpu_fallback.type, 'boolean');
  assert.equal(byKey.gpu_fallback.envKey, 'DSH_OCR_GPU_FALLBACK');
  for (const k of ['gpu_provider', 'gpu_python', 'gpu_device', 'gpu_fallback']) {
    assert.equal(byKey[k].advanced, true, `${k} 应为高级字段`);
  }
});

test('ocr_engine 枚举已包含 gpu', () => {
  const byKey = Object.fromEntries(SETTINGS_FIELDS.map((f) => [f.key, f]));
  assert.ok(byKey.ocr_engine.options.includes('gpu'), 'ocr_engine 枚举应含 gpu');
  assert.ok(byKey.ocr_engine.options.includes('auto'), 'ocr_engine 枚举应含 auto');
});

test('envFromSettings：GPU provider/python/device/fallback 映射与默认不设置规则', () => {
  const env = envFromSettings({
    ocr_engine: 'gpu',
    gpu_provider: 'dml',
    gpu_python: 'C:/Users/HP/rapid_gpu_venv/Scripts/python.exe',
    gpu_device: '1',
    gpu_fallback: false
  });
  assert.equal(env.DSH_OCR_ENGINE, 'gpu');
  assert.equal(env.DSH_OCR_GPU_PROVIDER, 'dml');
  assert.equal(env.DSH_OCR_GPU_PYTHON, 'C:/Users/HP/rapid_gpu_venv/Scripts/python.exe');
  assert.equal(env.DSH_OCR_GPU_DEVICE, '1');
  assert.equal(env.DSH_OCR_GPU_FALLBACK, '0');
});

test('envFromSettings：GPU auto/空/true 默认不设置（backward compat）', () => {
  const env = envFromSettings({
    ocr_engine: 'auto',
    gpu_provider: 'auto',
    gpu_python: '',
    gpu_device: 'auto',
    gpu_fallback: true
  });
  assert.equal(env.DSH_OCR_ENGINE, undefined);
  assert.equal(env.DSH_OCR_GPU_PROVIDER, undefined);
  assert.equal(env.DSH_OCR_GPU_PYTHON, undefined);
  assert.equal(env.DSH_OCR_GPU_DEVICE, undefined);
  assert.equal(env.DSH_OCR_GPU_FALLBACK, undefined);
});

test('normalizeFromSettings：GPU 参数透传到归一化配置', () => {
  const cfg = normalizeFromSettings({ gpu_provider: 'cuda', gpu_python: '/x', gpu_device: '2', gpu_fallback: false });
  assert.equal(cfg.gpu_provider, 'cuda');
  assert.equal(cfg.gpu_python, '/x');
  assert.equal(cfg.gpu_device, '2');
  assert.equal(cfg.gpu_fallback, false);
});

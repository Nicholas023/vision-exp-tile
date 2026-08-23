/**
 * suite-env.test.js — v0.4.1 测试套件环境辅助（tests/helpers/suite-env.mjs）纯逻辑测试
 *
 * 覆盖 timingFactor / poolTimeoutMs / skipTiming 的边界：默认、非法回退、clamp 上限、
 * 布尔解析（1/true/yes/on → 跳过；0/false → 不跳）。平台无关、CI/Linux 通吃。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingFactor, poolTimeoutMs, skipTiming } from './helpers/suite-env.mjs';

/** 环境变量快照/恢复助手（避免测试间污染）。 */
const FACTOR_KEYS = ['VISION_TEST_TIMEOUT_FACTOR', 'VISION_TEST_SKIP_TIMING'];
function snapEnv() {
  const s = {};
  for (const k of FACTOR_KEYS) s[k] = process.env[k];
  return s;
}
function restoreEnv(s) {
  for (const k of FACTOR_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

test('timingFactor：默认 1；显式 2/3/4 生效', () => {
  const snap = snapEnv();
  try {
    delete process.env.VISION_TEST_TIMEOUT_FACTOR;
    assert.equal(timingFactor(), 1);
    process.env.VISION_TEST_TIMEOUT_FACTOR = '2';
    assert.equal(timingFactor(), 2);
    process.env.VISION_TEST_TIMEOUT_FACTOR = '4';
    assert.equal(timingFactor(), 4);
  } finally {
    restoreEnv(snap);
  }
});

test('timingFactor：非法值回退 1；>8 clamp 到 8；<=0 回退 1', () => {
  const snap = snapEnv();
  try {
    process.env.VISION_TEST_TIMEOUT_FACTOR = 'abc';
    assert.equal(timingFactor(), 1);
    process.env.VISION_TEST_TIMEOUT_FACTOR = '9';
    assert.equal(timingFactor(), 8, '超出上限 clamp 到 8');
    process.env.VISION_TEST_TIMEOUT_FACTOR = '0';
    assert.equal(timingFactor(), 1);
    process.env.VISION_TEST_TIMEOUT_FACTOR = '-3';
    assert.equal(timingFactor(), 1);
    process.env.VISION_TEST_TIMEOUT_FACTOR = '2.7';
    assert.equal(timingFactor(), 2, '小数向下取整');
  } finally {
    restoreEnv(snap);
  }
});

test('poolTimeoutMs：基准 × 倍率；倍率 1 时不变；非法基准原样返回', () => {
  const snap = snapEnv();
  try {
    delete process.env.VISION_TEST_TIMEOUT_FACTOR;
    assert.equal(poolTimeoutMs(2000), 2000);
    assert.equal(poolTimeoutMs(300), 300);
    process.env.VISION_TEST_TIMEOUT_FACTOR = '2';
    assert.equal(poolTimeoutMs(300), 600);
    assert.equal(poolTimeoutMs(2000), 4000);
    assert.equal(poolTimeoutMs('xyz'), 'xyz', '非法基准原样返回');
  } finally {
    restoreEnv(snap);
  }
});

test('skipTiming：默认 false；1/true/yes/on → true；0/false → false', () => {
  const snap = snapEnv();
  try {
    delete process.env.VISION_TEST_SKIP_TIMING;
    assert.equal(skipTiming(), false);
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
      process.env.VISION_TEST_SKIP_TIMING = v;
      assert.equal(skipTiming(), true, `值 "${v}" 应视为跳过`);
    }
    for (const v of ['0', 'false', 'no', 'off', '']) {
      process.env.VISION_TEST_SKIP_TIMING = v;
      assert.equal(skipTiming(), false, `值 "${v}" 应不跳过`);
    }
  } finally {
    restoreEnv(snap);
  }
});

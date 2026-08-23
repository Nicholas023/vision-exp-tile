/**
 * client-bundle.test.js — client.js 浏览器 bundle 冒烟断言（只读文件正则 + 纯逻辑模拟）
 *
 * 用 fs 读 client.js 做结构冒烟检查，不执行浏览器环境：
 *  - client.js 存在且是 ModuleLoader 格式（含 window.__ModuleLoader__.load）。
 *  - exports 了 apply / inject。
 *  - 注册了 settings.section 分区，id="vision-exp-tile"、order=35、label=nav。
 *  - enum 字段「显示值(options)↔真实值(mapOptions)」按索引一一对应（小写落盘）。
 * 由于 client.js 是浏览器 bundle 无法在 node 直接执行，enum 映射以「从源码解析字段
 * 定义 + 复现同款映射函数」的方式做纯逻辑验证，保证保存写入小写、展示按真实值反查。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientPath = join(__dirname, '..', 'client.js');

/* ------------------------------------------------------------------ */
/* 纯逻辑：复现 client.js 的 enum 映射函数（用于验证字段定义与行为）       */
/* ------------------------------------------------------------------ */

function indexForReal(f, realValue) {
  const rv = String(realValue ?? '');
  for (let i = 0; i < f.real.length; i += 1) if (String(f.real[i]) === rv) return i;
  for (let j = 0; j < f.display.length; j += 1) if (String(f.display[j]) === rv) return j;
  return 0;
}
function realFromDisplay(f, displayValue) {
  const dv = String(displayValue ?? '');
  for (let i = 0; i < f.display.length; i += 1) if (String(f.display[i]) === dv) return f.real[i];
  return dv;
}
function saveValue(realValue) {
  const rv = String(realValue ?? '');
  return /^\d+$/.test(rv) ? Number(rv) : rv;
}

// 从 client.js 源码解析出枚举字段 { key, display[], real[] }。
function parseEnumFields(src) {
  const out = [];
  for (const line of src.split('\n')) {
    if (!line.includes('type: "enum"') || !line.includes('mapOptions:')) continue;
    const key = line.match(/key:\s*"([^"]+)"/)?.[1];
    const optRaw = line.match(/options:\s*OPT\(\[([\s\S]*?)\],/)?.[1];
    const realRaw = line.match(/mapOptions:\s*\[([\s\S]*?)\]/)?.[1];
    if (!key || !optRaw || !realRaw) continue;
    const quoted = (s) => [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    out.push({ key, display: quoted(optRaw), real: quoted(realRaw) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 测试                                                                 */
/* ------------------------------------------------------------------ */

test('client.js 存在', () => {
  assert.ok(existsSync(clientPath), 'client.js 应存在');
});

test('client.js 是 ModuleLoader bundle（含 __ModuleLoader__.load）', () => {
  const src = readFileSync(clientPath, 'utf8');
  assert.match(src, /window\.__ModuleLoader__\.load\s*\(\s*\{/);
  assert.match(src, /id:\s*["']vision-exp-tile["']/);
});

test('client.js 导出 apply 与 inject（module.exports 格式）', () => {
  const src = readFileSync(clientPath, 'utf8');
  assert.match(src, /exports\.apply\s*=\s*apply/);
  assert.match(src, /exports\.inject\s*=\s*inject/);
  // inject 应请求 slots / locale / settingsScope
  assert.match(src, /["']slots["']/);
  assert.match(src, /["']locale["']/);
  assert.match(src, /["']settingsScope["']/);
});

test('client.js 注册 settings.section 分区（id / order / label / locale）', () => {
  const src = readFileSync(clientPath, 'utf8');
  assert.match(src, /settings\.section/);
  assert.match(src, /id:\s*["']vision-exp-tile["']/);
  assert.match(src, /order:\s*35/);
  assert.match(src, /label:\s*function\s*\(\)\s*\{\s*return\s*t\(["']nav["']\)/);
  assert.match(src, /locale:\s*NS/);
});

test('client.js 含中文「图像识别」与英文「Image Recognition」字典', () => {
  const src = readFileSync(clientPath, 'utf8');
  assert.match(src, /图像识别/);
  assert.match(src, /Image Recognition/);
});

/* ------------------------------------------------------------------ */
/* enum 映射「显示值 ↔ 真实值」校验                                       */
/* ------------------------------------------------------------------ */

test('enum 字段均声明 mapOptions，且显示值/真实值等长、真实值为小写', () => {
  const src = readFileSync(clientPath, 'utf8');
  const fields = parseEnumFields(src);
  // 覆盖规格列出的全部 enum 字段
  const expectedKeys = ['ocr_engine', 'preprocess', 'handwrite_route', 'upgrade', 'format', 'mode', 'rotate', 'gpu_provider', 'performance_tier', 'platform_fallback'];
  assert.deepEqual(fields.map((f) => f.key), expectedKeys);
  for (const f of fields) {
    assert.equal(f.display.length, f.real.length, `字段 ${f.key} 的 options 与 mapOptions 应等长`);
    assert.ok(f.real.length > 0, `字段 ${f.key} 应有非空 mapOptions`);
    // 真实值应为小写（数字枚举 rotate 除外）
    if (f.key !== 'rotate') {
      for (const r of f.real) {
        assert.equal(r, r.toLowerCase(), `字段 ${f.key} 的真实值应小写：${r}`);
      }
    }
  }
});

test('enum 映射：保存时 显示值→真实值(小写落盘)，展示时 真实值→显示项', () => {
  const src = readFileSync(clientPath, 'utf8');
  const fields = parseEnumFields(src);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

  // 字符串枚举：ocr_engine 显示 'Auto' → 真实 'auto'，保存为字符串 'auto'
  const ocr = byKey.ocr_engine;
  assert.equal(realFromDisplay(ocr, 'Auto'), 'auto');
  assert.equal(saveValue(realFromDisplay(ocr, 'Auto')), 'auto');
  // 展示反查：真实 'paddle' → 显示项 'Paddle'
  assert.equal(ocr.display[indexForReal(ocr, 'paddle')], 'Paddle');

  // 数字枚举：rotate 显示 '90' → 真实 '90' → 保存为 number 90
  const rot = byKey.rotate;
  assert.equal(realFromDisplay(rot, '90'), '90');
  assert.equal(saveValue(realFromDisplay(rot, '90')), 90);
  // 展示反查：真实 '180' → 显示项 '180'
  assert.equal(rot.display[indexForReal(rot, '180')], '180');

  // 全部字段 round-trip：display[i] → real[i] → display[i]（显示值必须能往返）
  for (const f of fields) {
    for (let i = 0; i < f.display.length; i += 1) {
      const real = realFromDisplay(f, f.display[i]);
      assert.equal(real, f.real[i], `字段 ${f.key} 显示值 ${f.display[i]} 应映射到真实值 ${f.real[i]}`);
      assert.equal(f.display[indexForReal(f, real)], f.display[i], `字段 ${f.key} 真实值 ${real} 应反查回显示值 ${f.display[i]}`);
    }
  }
});

test('client.js 的保存/展示路径已接线到 enum 映射函数', () => {
  const src = readFileSync(clientPath, 'utf8');
  // 定义了三个映射助手
  assert.match(src, /function\s+enumIndexForReal\s*\(/);
  assert.match(src, /function\s+enumRealFromDisplay\s*\(/);
  assert.match(src, /function\s+enumSaveValue\s*\(/);
  // 保存分支调用 enumRealFromDisplay + enumSaveValue
  assert.match(src, /enumRealFromDisplay\s*\(\s*f\s*,\s*str\s*\)/);
  assert.match(src, /enumSaveValue\s*\(\s*f\s*,\s*realVal\s*\)/);
  // 渲染分支反查显示下标 enumIndexForReal，且 onChange 用 enumRealFromDisplay 归一化真实值
  assert.match(src, /enumIndexForReal\s*\(\s*f\s*,\s*fieldDraft\s*\(\s*f\s*\)\s*\)/);
  assert.match(src, /enumRealFromDisplay\s*\(\s*f\s*,\s*e\.target\.value\s*\)/);
});

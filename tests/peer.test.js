/**
 * peer.test.js — v0.4.2 picturereader 适应性优化 纯逻辑/注入 单元测试
 *
 * 覆盖：共存探测（双通道/异常）、分工引导（在场/不在场/拼接）、peer 配置读取
 * （临时 YAML 分区：正常/缺键/畸形/无分区）、peer 默认复用优先级（显式>peer>默认）、
 * venv 候选优先级（resolveVenvPython 纯函数 + rapid/paddle 集成）。
 * 全部用临时目录 + 注入（不依赖真实 picturereader 安装/真实 venv），CI/Linux 通吃。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isPicturereaderPresent,
  collabGuideText,
  withCollabIfPresent
} from '../src/picturereader-detector.js';
import { readPeerSettings, applyPeerDefaults } from '../src/peer-config.js';
import { createSplitTool, createRecognizeTool, createRegionCropTool } from '../src/index.js';
import {
  resolveVenvPython,
  rapidPython,
  paddlePython,
  _setVenvHomeForTest,
  _clearVenvHomeForTest
} from '../src/ocr-local.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 会清理的临时目录（一次性）。 */
function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'peer-test-'));
}

/* ------------------------------------------------------------------ */
/* A. 共存探测                                                          */
/* ------------------------------------------------------------------ */

test('isPicturereaderPresent：通道① 注册表命中（tool.get 返真值）→ true', () => {
  assert.equal(isPicturereaderPresent({ toolsApi: { get: () => ({ name: 'image_scan' }) }, dshHome: '/nope' }), true);
});

test('isPicturereaderPresent：通道② 插件目录存在 → true', () => {
  const t = tmpDir();
  try {
    mkdirSync(join(t, 'plugins', 'picturereader'), { recursive: true });
    assert.equal(isPicturereaderPresent({ toolsApi: { get: () => undefined }, dshHome: t }), true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('isPicturereaderPresent：双 miss → false', () => {
  const t = tmpDir();
  try {
    assert.equal(isPicturereaderPresent({ toolsApi: { get: () => undefined }, dshHome: t }), false);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('isPicturereaderPresent：异常路径（get 抛错 / 目录不存在）→ 不在场', () => {
  // get 抛错：通道① catch；通道② 目录不存在 → false。
  assert.equal(isPicturereaderPresent({ toolsApi: { get: () => { throw new Error('boom'); } }, dshHome: '/no-such-dir' }), false);
  // toolsApi 缺省（null/undefined）→ 仅通道②。
  const t = tmpDir();
  try {
    assert.equal(isPicturereaderPresent({ dshHome: t }), false);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('isPicturereaderPresent：缺省 dshHome 用 DSH_HOME（可设为临时目录）', () => {
  const t = tmpDir();
  const old = process.env.DSH_HOME;
  try {
    mkdirSync(join(t, 'plugins', 'picturereader'), { recursive: true });
    process.env.DSH_HOME = t;
    assert.equal(isPicturereaderPresent({ toolsApi: { get: () => undefined } }), true);
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
    rmSync(t, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* collabGuideText / withCollabIfPresent                                */
/* ------------------------------------------------------------------ */

test('collabGuideText：在场返回 ≤220 字且含分工关键词；不在场返回空串', () => {
  const t = collabGuideText(true);
  assert.ok(typeof t === 'string' && t.length > 0);
  assert.ok(t.length <= 220, '应在 220 字内（实际 ' + t.length + '）');
  assert.match(t, /picturereader/);
  assert.match(t, /vision_tile/);
  assert.match(t, /分工/);
  assert.equal(collabGuideText(false), '');
});

test('withCollabIfPresent：在场拼接分工段；不在场返回原对象（描述与基线一致）', () => {
  const base = { name: 'vision_tile_split', description: 'abc' };
  // 在场：克隆并追加。
  const withCollab = withCollabIfPresent(base, true);
  assert.notEqual(withCollab, base, '在场应返回新对象');
  assert.ok(withCollab.description.startsWith('abc'));
  assert.ok(withCollab.description.includes('【与 picturereader 分工】'));
  // 不在场：返回原对象（不克隆，description 不变）。
  const noCollab = withCollabIfPresent(base, false);
  assert.equal(noCollab, base, '不在场应返回原对象');
  assert.equal(noCollab.description, 'abc');
  // 无 description 字段：不崩，且返回同一对象（不克隆）。
  const noDesc = { name: 'x' };
  assert.equal(withCollabIfPresent(noDesc, true), noDesc);
});

/* ------------------------------------------------------------------ */
/* B. peer 配置读取                                                     */
/* ------------------------------------------------------------------ */

test('readPeerSettings：正常 picturereader 分区解析（去引号/去注释）', () => {
  const t = tmpDir();
  try {
    const p = join(t, 'settings.yaml');
    writeFileSync(p, [
      'ui-onboarding:',
      '  welcomeNoticeVersion: 2026-08-13',
      'picturereader:',
      '  vlm_base: "https://api.deepseek.com"',
      "  vlm_model: 'deepseek-v4-flash-vision-exp'",
      '  vlm_key_env: DEEPSEEK_API_KEY   # 密钥',
      '  ocr_engine: rapid',
      '  unknown_key: whatever'
    ].join('\n'));
    const peer = readPeerSettings(p);
    assert.equal(peer.vlm_base, 'https://api.deepseek.com');
    assert.equal(peer.vlm_model, 'deepseek-v4-flash-vision-exp');
    assert.equal(peer.vlm_key_env, 'DEEPSEEK_API_KEY');
    assert.equal(peer.ocr_engine, 'rapid');
    assert.equal(peer.unknown_key, undefined, '非目标键不读取');
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('readPeerSettings：缺键 → undefined；无分区/无文件/畸形 → 不抛错且不误读', () => {
  const t = tmpDir();
  try {
    // 缺键：只有 vlm_base。
    const p1 = join(t, 's1.yaml');
    writeFileSync(p1, 'picturereader:\n  vlm_base: https://x\n');
    const peer1 = readPeerSettings(p1);
    assert.equal(peer1.vlm_base, 'https://x');
    assert.equal(peer1.vlm_model, undefined);
    // 无分区。
    const p2 = join(t, 's2.yaml');
    writeFileSync(p2, 'ui-onboarding:\n  a: b\n');
    assert.equal(readPeerSettings(p2), null);
    // 文件不存在。
    assert.equal(readPeerSettings(join(t, 'no-such.yaml')), null);
    // 畸形（分区名后无内容也应返回空对象而非崩）。
    const p3 = join(t, 's3.yaml');
    writeFileSync(p3, 'picturereader:\n  @@@ : ###\n');
    const peer3 = readPeerSettings(p3);
    assert.equal(typeof peer3, 'object');
    assert.equal(peer3.vlm_base, undefined);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* applyPeerDefaults：显式 > peer > 默认                                */
/* ------------------------------------------------------------------ */

test('applyPeerDefaults：config 未显式（=默认）且 peer 非空 → 以 peer 覆盖 baseURL/model', () => {
  const cfg = { baseURL: DEFAULT_CONFIG.baseURL, model: DEFAULT_CONFIG.model };
  const peer = { vlm_base: 'https://peer.example.com', vlm_model: 'peer-vision' };
  applyPeerDefaults(cfg, peer);
  assert.equal(cfg.baseURL, 'https://peer.example.com');
  assert.equal(cfg.model, 'peer-vision');
});

test('applyPeerDefaults：用户显式值（非默认）不被 peer 覆盖；peer=null 不修改', () => {
  const explicit = { baseURL: 'https://explicit.com', model: 'my-model' };
  applyPeerDefaults(explicit, { vlm_base: 'https://peer.com', vlm_model: 'peer' });
  assert.equal(explicit.baseURL, 'https://explicit.com', '显式优先');
  assert.equal(explicit.model, 'my-model', '显式优先');
  const def = { baseURL: DEFAULT_CONFIG.baseURL, model: DEFAULT_CONFIG.model };
  applyPeerDefaults(def, null);
  assert.equal(def.baseURL, DEFAULT_CONFIG.baseURL, 'peer=null 不改');
});

/* ------------------------------------------------------------------ */
/* C. peer venv 候选优先级                                              */
/* ------------------------------------------------------------------ */

test('resolveVenvPython：优先级 env > own(存在) > peer(存在) > own(兜底)', () => {
  // 纯函数，注入 exists 隔离文件系统。
  const own = '/own/python';
  const peer = '/peer/python';
  const fx = (map) => (p) => map[p] === true;
  // env 最高。
  assert.equal(resolveVenvPython({ env: '/env', own, peer, exists: fx({}) }), '/env');
  // own 存在 → own。
  assert.equal(resolveVenvPython({ env: undefined, own, peer, exists: fx({ [own]: true }) }), own);
  // own 不存在、peer 存在 → peer。
  assert.equal(resolveVenvPython({ env: undefined, own, peer, exists: fx({ [peer]: true }) }), peer);
  // 都不存在 → own（兜底，失败安全）。
  assert.equal(resolveVenvPython({ env: undefined, own, peer, exists: fx({}) }), own);
});

test('rapidPython/paddlePython：venv 根目录可注入；own 存在即返回 own（真实临时文件）', () => {
  const t = tmpDir();
  const snapR = process.env.DSH_RAPID_PYTHON;
  const snapP = process.env.DSH_PADDLE_PYTHON;
  try {
    _setVenvHomeForTest(t);
    delete process.env.DSH_RAPID_PYTHON;
    delete process.env.DSH_PADDLE_PYTHON;
    // 建本插件默认 venv（Windows 用 Scripts/python.exe，Linux 用 bin/python3）。
    const base = process.platform === 'win32' ? 'Scripts' : 'bin';
    mkdirSync(join(t, 'rapid_venv', base), { recursive: true });
    writeFileSync(join(t, 'rapid_venv', base, process.platform === 'win32' ? 'python.exe' : 'python3'), '');
    const expectedRapid = join(t, 'rapid_venv', base, process.platform === 'win32' ? 'python.exe' : 'python3');
    assert.equal(rapidPython(), expectedRapid, 'own 存在 → own');
    // paddle：own 不存在 → 走兜底（返回 own 路径，虽不存在）。
    assert.equal(paddlePython(), join(t, 'paddle_venv', base, process.platform === 'win32' ? 'python.exe' : 'python3'));
  } finally {
    _clearVenvHomeForTest();
    if (snapR === undefined) delete process.env.DSH_RAPID_PYTHON; else process.env.DSH_RAPID_PYTHON = snapR;
    if (snapP === undefined) delete process.env.DSH_PADDLE_PYTHON; else process.env.DSH_PADDLE_PYTHON = snapP;
    rmSync(t, { recursive: true, force: true });
  }
});

test('rapidPython：显式 env 最高优先（即便 own 存在）', () => {
  const t = tmpDir();
  const snap = process.env.DSH_RAPID_PYTHON;
  try {
    _setVenvHomeForTest(t);
    const base = process.platform === 'win32' ? 'Scripts' : 'bin';
    mkdirSync(join(t, 'rapid_venv', base), { recursive: true });
    writeFileSync(join(t, 'rapid_venv', base, process.platform === 'win32' ? 'python.exe' : 'python3'), '');
    process.env.DSH_RAPID_PYTHON = '/env-rapid';
    assert.equal(rapidPython(), '/env-rapid', '显式 env 优先');
  } finally {
    _clearVenvHomeForTest();
    if (snap === undefined) delete process.env.DSH_RAPID_PYTHON; else process.env.DSH_RAPID_PYTHON = snap;
    rmSync(t, { recursive: true, force: true });
  }
});

test('回归：collabGuideText(false) 为空，tools 描述不含分工段关键词', () => {
  // 不在场时 collab 为空串 → withCollabIfPresent 返回原对象；分工关键词不应出现。
  const desc = withCollabIfPresent({ description: '纯描述' }, false).description;
  assert.equal(desc, '纯描述');
  assert.ok(!desc.includes('picturereader'));
  assert.ok(!desc.includes('分工'));
});

test('回归：三个真实工具——不在场 description 不含分工段（与基线一致），在场则含', () => {
  // 用最小 ctx/cfg 创建真实工具对象（create*Tool 仅同步构建，不调用 ctx.fs）。
  const fakeCtx = { logger: {} };
  const cfg = DEFAULT_CONFIG;
  const makers = [createSplitTool, createRecognizeTool, createRegionCropTool];
  for (const make of makers) {
    const tool = make(fakeCtx, cfg);
    // 不在场：返回原对象，description 不含分工关键词（回归红线：逐字节一致）。
    const noCollab = withCollabIfPresent(tool, false);
    assert.equal(noCollab, tool, make.name + ' 不在场应返回原对象');
    assert.equal(noCollab.description, tool.description, make.name + ' 描述不应被改');
    assert.ok(!noCollab.description.includes('picturereader'), make.name + ' 不应含 picturereader');
    assert.ok(!noCollab.description.includes('分工'), make.name + ' 不应含分工');
    // 在场：追加分工段。
    const yes = withCollabIfPresent(tool, true);
    assert.ok(yes.description !== tool.description, make.name + ' 在场应生成新描述');
    assert.ok(yes.description.includes('【与 picturereader 分工】'), make.name + ' 应含分工段');
  }
});

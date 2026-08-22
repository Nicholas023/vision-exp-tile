/**
 * ocr-local.js — 本地 OCR 引擎封装（全自动编排用）
 *
 * 设计原则：本插件**只使用纯官方 DSH 能力与开源/系统组件**，不依赖任何第三方 DSH 插件。
 *  - paddle：$HOME/paddle_venv（PaddleOCR，Apache-2.0，用户自行安装的可选环境）
 *  - rapid ：$HOME/rapid_venv（RapidOCR，Apache-2.0，用户自行安装的可选环境）
 *  - windows：Windows.Media.Ocr（WinRT，操作系统自带，零依赖兜底）
 * 引擎选择：paddle → rapid → windows（自动降级，全部不可用时由 pipeline 转交视觉 API）。
 * 每个引擎路径可用环境变量覆盖（DSH_PADDLE_PYTHON / DSH_RAPID_PYTHON / DSH_PADDLE_CACHE）。
 * 说明：OCR 的命令/脚本写法参考自开源项目 picturereader（MIT License），
 * 本实现为独立封装，运行时与 picturereader 插件互不依赖。
 *
 * 输出统一结构：{ engine, text, lines: [{text, x, y, width, height, score?}] }
 * lines 为像素框（相对传入 PNG 的尺寸），供模型理解版式。
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/* ------------------------------------------------------------------ */
/* 引擎路径探测                                                         */
/* ------------------------------------------------------------------ */

/** venv Python 可执行文件（Windows 在 Scripts/，类 Unix 在 bin/） */
function venvPython(venvDir) {
  const base = join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  return join(base, process.platform === 'win32' ? 'python.exe' : 'python3');
}

/**
 * PaddleOCR venv Python（可移植默认：$HOME/<venv 名>；环境变量 DSH_PADDLE_PYTHON 覆盖）。
 * 例如 Windows 默认 C:\Users\你\paddle_venv\Scripts\python.exe；
 * Linux/macOS 默认 ~/paddle_venv/bin/python3。
 */
export function paddlePython() {
  return process.env.DSH_PADDLE_PYTHON ?? venvPython(join(homedir(), 'paddle_venv'));
}

/** RapidOCR venv Python（同 paddlePython 的可移植约定；DSH_RAPID_PYTHON 覆盖） */
export function rapidPython() {
  return process.env.DSH_RAPID_PYTHON ?? venvPython(join(homedir(), 'rapid_venv'));
}

/** PaddleX 模型缓存目录（环境变量覆盖 > $HOME/.paddlex-cache） */
export function paddleCacheHome() {
  return process.env.DSH_PADDLE_CACHE ?? join(homedir(), '.paddlex-cache');
}

/** 探测某引擎环境是否可用（Paddle 会额外等待模型 import ~2s） */
export async function engineAvailable(engine) {
  // Windows OCR（WinRT）仅在 Windows 平台可用；非 Windows 必须依赖 paddle/rapid
  if (engine === 'windows') return process.platform === 'win32';
  const python = engine === 'paddle' ? paddlePython() : rapidPython();
  if (!existsSync(python)) return false;
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      const child = spawn(python, ['-c', engine === 'paddle' ? 'import paddleocr' : 'import rapidocr_onnxruntime'], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        stdio: 'ignore'
      });
      timer = setTimeout(() => { try { child.kill(); } catch {} done(false); }, 30_000);
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}

/** 按序解析可用引擎（外部指定引擎不存在时自动降级） */
export async function resolveEngine(preferred = 'paddle') {
  const order = preferred === 'rapid' ? ['rapid', 'paddle', 'windows'] : ['paddle', 'rapid', 'windows'];
  for (const eng of order) {
    if (await engineAvailable(eng)) return eng;
  }
  return 'windows'; // 兜底
}

/* ------------------------------------------------------------------ */
/* 各引擎执行                                                           */
/* ------------------------------------------------------------------ */

/**
 * Windows 中文字体 OCR（WinRT Windows.Media.Ocr），零依赖。
 * 命令编写参考自开源项目 picturereader（MIT）的 buildOcrCommand；输出 base64 JSON（含像素框）。
 */
function runWindowsOcr(pngPath, timeoutMs = 30_000) {
  const esc = (s) => String(s).replaceAll("'", "''");
  const command = [
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]',
    '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]',
    '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]',
    "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    'Function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }',
    `$path = '${esc(pngPath)}'`,
    '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])',
    '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
    '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
    "if ($engine -eq $null) { Write-Error 'no OCR engine for the requested language'; exit 2 }",
    '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
    '$lines = @()',
    'foreach ($line in $result.Lines) {',
    '  $words = @()',
    '  foreach ($w in $line.Words) { $words += [PSCustomObject]@{ Text = $w.Text; X = [int]$w.BoundingRect.X; Y = [int]$w.BoundingRect.Y; W = [int]$w.BoundingRect.Width; H = [int]$w.BoundingRect.Height } }',
    '  $lines += [PSCustomObject]@{ Text = $line.Text; X = [int]$line.BoundingRect.X; Y = [int]$line.BoundingRect.Y; W = [int]$line.BoundingRect.Width; H = [int]$line.BoundingRect.Height; Words = $words }',
    '}',
    '$json = [PSCustomObject]@{ Width = $decoder.PixelWidth; Height = $decoder.PixelHeight; Lines = $lines } | ConvertTo-Json -Depth 5',
    '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))'
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ocr-local: Windows OCR timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ocr-local: cannot start Windows OCR: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`ocr-local: Windows OCR failed (exit ${code}): ${stderr.trim().slice(0, 300)}`)); return; }
      try {
        const parsed = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
        const lines = (parsed.Lines ?? []).map((l) => ({
          text: l.Text,
          x: Math.round(l.X),
          y: Math.round(l.Y),
          width: Math.round(l.W),
          height: Math.round(l.H)
        }));
        resolve({ width: parsed.Width, height: parsed.Height, lines });
      } catch (e) {
        reject(new Error(`ocr-local: cannot parse Windows OCR result: ${e.message}`));
      }
    });
  });
}

/**
 * PaddleOCR（paddle_venv，PaddleX 接口）。模型加载约 2s。
 * 脚本编写参考自开源项目 picturereader（MIT）的 runPaddleOcr；输出 base64 JSON（含像素框与置信度）。
 */
function runPaddleOcr(pngPath, timeoutMs = 120_000) {
  const escaped = String(pngPath).replaceAll("'", "''");
  const script = [
    'import base64, json',
    'from paddleocr import PaddleOCR',
    "ocr = PaddleOCR(lang='ch', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, enable_mkldnn=False)",
    `result = ocr.predict(r'${escaped}')`,
    'lines = []',
    'for res in result:',
    "    texts = res.get('rec_texts') or []",
    "    scores = res.get('rec_scores') or []",
    "    polys = res.get('rec_polys') or []",
    '    for i, t in enumerate(texts):',
    '        if i < len(polys):',
    '            pts = [[int(float(v)) for v in pt] for pt in polys[i]]',
    '            xs = [pt[0] for pt in pts]; ys = [pt[1] for pt in pts]',
    '            box = {"x": min(xs), "y": min(ys), "w": max(xs)-min(xs), "h": max(ys)-min(ys)}',
    '        else:',
    '            box = {"x": 0, "y": 0, "w": 0, "h": 0}',
    "        score = round(float(scores[i]), 3) if i < len(scores) else 0.0",
    "        lines.append({'text': t, 'score': score, **box})",
    "sys.stdout.write(base64.b64encode(json.dumps({'lines': lines}, ensure_ascii=False).encode('utf-8')).decode('ascii'))",
    'import sys'
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(paddlePython(), ['-c', script], {
      env: { ...process.env, PADDLE_PDX_CACHE_HOME: paddleCacheHome(), PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ocr-local: PaddleOCR timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ocr-local: cannot start PaddleOCR: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter((l) => /error|traceback/i.test(l)).slice(-3).join(' | ') || stderr.trim().slice(-200);
        reject(new Error(`ocr-local: PaddleOCR failed (exit ${code}): ${tail}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
        resolve({ lines: (parsed.lines ?? []).map((l) => ({ text: l.text, x: l.x, y: l.y, width: l.w, height: l.h, score: l.score })) });
      } catch (e) {
        reject(new Error(`ocr-local: cannot parse PaddleOCR result: ${e.message}`));
      }
    });
  });
}

/**
 * RapidOCR（rapid_venv，bundled ONNX 模型，无需网络下载）。
 * 脚本编写参考自开源项目 picturereader（MIT）的 runRapidOcr：进程参数传 PNG 路径，stdout JSON。
 */
function runRapidOcr(pngPath, timeoutMs = 90_000) {
  const script = [
    'import json, sys',
    'from rapidocr_onnxruntime import RapidOCR',
    '_engine = RapidOCR()',
    '_result, _elapse = _engine(sys.argv[1])',
    '_out = []',
    'for _it in (_result or []):',
    '    _pts = [[float(c) for c in _p] for _p in _it[0]]',
    '    _xs = [_p[0] for _p in _pts]; _ys = [_p[1] for _p in _pts]',
    "    _out.append({'text': _it[1], 'score': float(_it[2]), 'x': int(min(_xs)), 'y': int(min(_ys)), 'width': int(max(_xs)-min(_xs)), 'height': int(max(_ys)-min(_ys))})",
    "print(json.dumps({'lines': _out}, ensure_ascii=False), flush=True)"
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(rapidPython(), ['-c', script, String(pngPath)], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ocr-local: RapidOCR timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ocr-local: cannot start RapidOCR: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter((l) => /error|traceback/i.test(l)).slice(-3).join(' | ') || stderr.trim().slice(-200);
        reject(new Error(`ocr-local: RapidOCR failed (exit ${code}): ${tail}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ lines: (parsed.lines ?? []).map((l) => ({ text: l.text, x: l.x, y: l.y, width: l.width, height: l.height, score: l.score })) });
      } catch (e) {
        reject(new Error(`ocr-local: cannot parse RapidOCR result: ${e.message}`));
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                           */
/* ------------------------------------------------------------------ */

/**
 * 对一块 PNG 执行 OCR。
 * 流程：临时 PNG 落盘 → 目标引擎（自动降级）→ 解析文本行 → 清理临时文件。
 * @param {Buffer} pngBuffer - 待识别区域的 PNG 字节
 * @param {object} opts - {engine('paddle'|'rapid'|'windows'|'auto'), timeoutMs}
 * @returns {Promise<{engine:string, text:string, lines:Array}>}
 */
export async function ocrText(pngBuffer, { engine = 'auto', timeoutMs } = {}) {
  const engineUsed = engine === 'auto' ? await resolveEngine('paddle') : engine;
  const tmpPath = join(tmpdir(), `vision-tile-ocr-${randomBytes(6).toString('hex')}.png`);
  await writeFile(tmpPath, pngBuffer);
  try {
    let result;
    if (engineUsed === 'paddle') result = await runPaddleOcr(tmpPath, timeoutMs);
    else if (engineUsed === 'rapid') result = await runRapidOcr(tmpPath, timeoutMs);
    else result = await runWindowsOcr(tmpPath, timeoutMs);
    // 统一输出：[按行拼接文本 + 行像素框]
    const lines = result.lines ?? [];
    return {
      engine: engineUsed,
      text: lines.map((l) => l.text).join('\n'),
      lines
    };
  } catch (error) {
    // 目标引擎失败 → windows 兜底（若目标已失败且不是 windows）
    if (engineUsed !== 'windows') {
      try {
        const fallback = await runWindowsOcr(tmpPath, 30_000);
        return { engine: 'windows', text: fallback.lines.map((l) => l.text).join('\n'), lines: fallback.lines, degraded: true, reason: error.message };
      } catch {
        throw error;
      }
    }
    throw error;
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

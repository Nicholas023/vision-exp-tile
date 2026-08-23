# -*- coding: utf-8 -*-
"""
ocr_worker.py — 常驻 OCR 工作进程（vision-exp-tile 本地 OCR 池的子进程）

设计目标（针对"大规模识别特别卡"的量身方案）：
  1. **模型常驻**：进程启动时一次性加载引擎（PaddleOCR / RapidOCR），
     之后每张图的推理不再付出"进程启动 + 模型加载"成本（实测每次 =2.25s Paddle / 0.55s Rapid）；
  2. **多核并行**：Node 侧启动多个本进程（进程池），每个进程跑满单线程推理，
     按 8 物理核/16 逻辑核编排（池大小由 Node 侧 DSH_OCR_POOL 决定），天然并行；
  3. **视频流式行协议**：stdin 逐行 JSON 命令 → stdout 逐行 JSON 结果，
     与 Node 侧 child_process 的 readline 无缝对接，无磁盘脚本文件、无临时文件泄漏。

协议：
  in : {"id": <number>, "engine": "paddle"|"rapid", "path": "<abs png path>", "timeout_ms": int?}
  out: {"id": <number>, "ok": true, "lines": [...], "elapsed_ms": number}
       {"id": <number>, "ok": false, "error": "..."}
  engine 可按请求切换（懒加载：首次请求某引擎时才初始化；paddle 初始化较重，
  建议上层让同一 worker 尽量接同一引擎的批次）。

仅使用官方 pip 包（paddleocr / rapidocr_onnxruntime），零其他依赖；零网络调用。
"""

import json
import sys
import time
import os
import threading

# 全局句柄（懒加载、线程安全）
_engines = {}
_lock = threading.Lock()

# 线程预算：单进程 onnxruntime 线程数（实测 4 最优：0.179s vs 默认 0.245s / 16 线程 0.404s）
# 池 4 进程 × 4 线程 = 16 线程 ≈ 16 逻辑核 → 全核利用且无抖动
RAPID_THREADS = int(os.environ.get("DSH_RAPID_THREADS", "4") or 4)


def get_paddle(timeout_ms=None):
    """懒加载 PaddleOCR——首次调用初始化约 2.25s（已实测），之后常驻。"""
    engine = _engines.get("paddle")
    if engine is None:
        with _lock:
            engine = _engines.get("paddle")
            if engine is None:
                # 与 ocr-local.js 旧脚本保持同样配置（mkldnn 关闭是因为 PIR+oneDNN
                # 在 paddle 3.3.1 下不兼容，开启会抛 NotImplementedError——保护性关闭）
                from paddleocr import PaddleOCR
                engine = PaddleOCR(
                    lang="ch",
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                    enable_mkldnn=False,
                )
                _engines["paddle"] = engine
    return engine


def get_rapid(timeout_ms=None):
    """懒加载 RapidOCR——首次加载约 0.55s（已实测），之后常驻。
    注意：intra_op_num_threads 显式限线程（默认全核过分配反而慢，实测 4 最优）。"""
    engine = _engines.get("rapid")
    if engine is None:
        with _lock:
            engine = _engines.get("rapid")
            if engine is None:
                from rapidocr_onnxruntime import RapidOCR
                engine = RapidOCR(intra_op_num_threads=RAPID_THREADS)
                _engines["rapid"] = engine
    return engine


def _run_engine(engine, path):
    """执行推理并统一输出词汇行（结构兼容 ocr-local.js 的旧解析）。"""
    if engine == "paddle":
        ocr = get_paddle()
        result = ocr.predict(path)
        lines = []
        for res in result or []:
            texts = res.get("rec_texts") or []
            scores = res.get("rec_scores") or []
            polys = res.get("rec_polys") or []
            for i, t in enumerate(texts):
                if i < len(polys):
                    pts = [[int(float(v)) for v in pt] for pt in polys[i]]
                    xs = [pt[0] for pt in pts]
                    ys = [pt[1] for pt in pts]
                    box = {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)}
                else:
                    box = {"x": 0, "y": 0, "width": 0, "height": 0}
                score = round(float(scores[i]), 3) if i < len(scores) else 0.0
                lines.append({"text": t, "score": score, **box})
        return lines
    else:
        ocr = get_rapid()
        result, _elapse = ocr(path)
        lines = []
        for it in result or []:
            pts = [[float(c) for c in p] for p in it[0]]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            lines.append({
                "text": it[1],
                "score": float(it[2]) if len(it) > 2 else 0.0,
                "x": int(min(xs)),
                "y": int(min(ys)),
                "width": int(max(xs) - min(xs)),
                "height": int(max(ys) - min(ys)),
            })
        return lines


def main():
    """主循环：逐行读 stdin，逐行写 stdout（行协议，flush 保证即时性）。"""
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:
            # 协议错误：回一个假 id 的失败响应，保证上层 readline 不阻塞
            sys.stdout.write(json.dumps({"id": -1, "ok": False, "error": f"bad request: {e}"}) + "\n")
            sys.stdout.flush()
            continue
        rid = req.get("id")
        engine = req.get("engine", "rapid")
        path = req.get("path", "")
        try:
            t0 = time.perf_counter()
            lines = _run_engine(engine, path)
            sys.stdout.write(json.dumps({
                "id": rid,
                "ok": True,
                "lines": lines,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            }, ensure_ascii=False) + "\n")
        except Exception as e:
            sys.stdout.write(json.dumps({"id": rid, "ok": False, "error": str(e)[:500]}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

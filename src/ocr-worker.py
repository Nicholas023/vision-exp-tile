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
  out: {"id": <number>, "ok": true, "lines": [...], "elapsed_ms": number,
        "engine": "rapid", "provider": "dml"|"cuda"|"cpu", "gpu_device": number|null}
       {"id": <number>, "ok": false, "error": "..."}
  engine 可按请求切换（懒加载：首次请求某引擎时才初始化；paddle 初始化较重，
  建议上层让同一 worker 尽量接同一引擎的批次）。

仅使用官方 pip 包（paddleocr / rapidocr_onnxruntime），零其他依赖；零网络调用。

v0.4.0（GPU 多设备加速）：
  - get_rapid() 支持 GPU：通过环境变量 DSH_OCR_GPU_PROVIDER / DSH_OCR_GPU_DEVICE /
    DSH_OCR_GPU_FALLBACK 控制；默认 auto（检测到可用 GPU provider 即走 GPU，否则 CPU）。
  - 采用「monkeypatch OrtInferSession._get_ep_list」的稳健路径，可显式指定
    device_id（DML=D3D12 适配器索引 / CUDA=GPU 索引），并把 provider 列表固定为
    [首选 EP(含 device_id), CPUExecutionProvider]，满足多设备 + 指定 + 回退。
  - probe + 回退：GPU 构造或 warmup 失败/超时 → 记 warning；若 DSH_OCR_GPU_FALLBACK=1
    自动回退 CPU RapidOCR 并缓存 _gpu_ok=False（本进程后续不再尝试 GPU）。
  - 每次结果 JSON 附加 engine/provider/gpu_device，供 Node 侧日志与测速。
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

# 模块级 GPU 运行态（进程内共享；由 get_rapid 在首次初始化时写入，供响应 JSON 附带）
_gpu_state_lock = threading.Lock()
_gpu_provider = "cpu"      # 实际推理 provider：cuda | dml | cpu（openvino 亦归入非 cpu）
_gpu_device = None         # 实际使用的设备号：int 或 None（None=默认/auto）
_gpu_ok = True             # GPU 是否可用；False=已回退 CPU，本进程后续不再尝试 GPU
_gpu_patched = False       # 是否已对 OrtInferSession._get_ep_list 做 monkeypatch（只 patch 一次）

# provider 名 → onnxruntime EP 名字典
_EP_NAME = {
    "cuda": "CUDAExecutionProvider",
    "dml": "DmlExecutionProvider",
    "openvino": "OpenVINOExecutionProvider",
}


def get_paddle(timeout_ms=None):
    """懒加载 PaddleOCR——首次调用初始化约 2.25s（已实测），之后常驻。"""
    engine = _engines.get("paddle")
    if engine is None:
        with _lock:
            engine = _engines.get("paddle")
            if engine is None:
                # mkldnn 关闭（PIR+oneDNN 不兼容，开启会抛 NotImplementedError——保护性）
                from paddleocr import PaddleOCR
                kwargs = dict(
                    lang="ch",
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                    enable_mkldnn=False,
                )
                # v0.2.0：检测侧调参（密集小字/手写更宽容，环境变量可配）
                if os.environ.get("DSH_PADDLE_DET_LIMIT"):
                    try:
                        kwargs["text_det_limit_side_len"] = int(os.environ["DSH_PADDLE_DET_LIMIT"])
                    except Exception:
                        pass
                if os.environ.get("DSH_PADDLE_DET_THRESH"):
                    try:
                        kwargs["text_det_thresh"] = float(os.environ["DSH_PADDLE_DET_THRESH"])
                    except Exception:
                        pass
                # v0.2.0：DSH_OCR_MODEL=server → 高精度识别模型 PP-OCRv4_server_rec
                # （首次自动下载几十 MB；失败自动回退默认模型并记录）
                model_env = (os.environ.get("DSH_OCR_MODEL") or "default").strip().lower()
                if model_env in ("server", "v4server"):
                    try:
                        kwargs["text_recognition_model_name"] = "PP-OCRv4_server_rec"
                        engine = PaddleOCR(**kwargs)
                        _engines["paddle"] = engine
                        return engine
                    except Exception as e:
                        print(f"[ocr-worker] Paddle server 模型不可用，回退默认：{str(e)[:120]}", file=sys.stderr)
                        engine = None
                engine = PaddleOCR(**kwargs)
                _engines["paddle"] = engine
    return engine


# ---------------------------------------------------------------------------
# GPU 相关辅助（v0.4.0）
# ---------------------------------------------------------------------------

def _resolve_gpu_provider():
    """根据环境变量 DSH_OCR_GPU_PROVIDER 与 onnxruntime 实际可用 provider 解析最终 EP。

    取值：
      - auto（默认）：优先 cuda（若 available Providers 含 CUDAExecutionProvider）
        → 否则 dml（含 DmlExecutionProvider）→ 否则 openvino → 否则 cpu。
      - cuda / dml / openvino：显式指定；若该 EP 不在 available 中则回退 cpu。
      - off：强制 cpu。
    返回值：('cuda'|'dml'|'openvino'|'cpu', 是否GPU 布尔)
    """
    raw = (os.environ.get("DSH_OCR_GPU_PROVIDER") or "auto").strip().lower()
    try:
        from onnxruntime import get_available_providers
        avail = set(get_available_providers() or [])
    except Exception:
        avail = set()
    if raw == "off":
        return "cpu", False
    if raw in _EP_NAME:
        if _EP_NAME[raw] in avail:
            return raw, True
        # 显式指定的 provider 未编译进当前运行库 → 回退 cpu
        return "cpu", False
    # auto
    if "CUDAExecutionProvider" in avail:
        return "cuda", True
    if "DmlExecutionProvider" in avail:
        return "dml", True
    if "OpenVINOExecutionProvider" in avail:
        return "openvino", True
    return "cpu", False


def _resolve_gpu_device():
    """解析 DSH_OCR_GPU_DEVICE（auto/索引）。auto → 0（DML 默认适配器 / CUDA 默认 GPU）。

    注意：DML 的 device_id 即 D3D12 适配器索引；0 为默认适配器（本机可能为 Intel 核显而非
    NVIDIA），符合方案「auto 设备：DML 默认适配器（不要硬选 NVIDIA）」的要求。
    """
    raw = (os.environ.get("DSH_OCR_GPU_DEVICE") or "auto").strip().lower()
    if raw in ("", "auto", "default"):
        return 0
    try:
        d = int(raw)
        return max(0, d)
    except Exception:
        return 0


def _gpu_get_ep_list(self):
    """被 monkeypatch 到 rapidocr_onnxruntime.utils.infer_engine.OrtInferSession 的 _get_ep_list。

    RapidOCR 内置 _get_ep_list 只能靠 use_cuda/use_dml 布尔切换，且无法指定 device_id
    （DML 默认适配器可能是 Intel 核显而非 NVIDIA）。这里按 worker 全局 _gpu_provider /
    _gpu_device 动态构造 provider 列表 = [首选 EP(含 device_id), CPUExecutionProvider]，
    从而支持「多设备 + 显式指定 + CPU 兜底」。

    注意：原 _verify_providers() 会读取 self.use_cuda / self.use_directml，因此本方法
    必须为这两个实例属性赋值，否则构造 InferenceSession 后 _verify_providers() 抛
    AttributeError 导致初始化失败。
    """
    from rapidocr_onnxruntime.utils.infer_engine import EP
    # 设置 _verify_providers() 需要的属性（cuda/dml 用了哪个 EP，就标记哪个为 True）
    self.use_cuda = (_gpu_provider == "cuda")
    self.use_directml = (_gpu_provider == "dml")

    # CPU 兜底始终保留在列表末尾
    cpu_opts = {"arena_extend_strategy": "kSameAsRequested"}
    elist = [(EP.CPU_EP.value, cpu_opts)]

    if _gpu_provider == "cuda":
        # CUDA 的 device_id 即 GPU 索引（0 为默认 GPU）
        elist.insert(0, (EP.CUDA_EP.value, {"device_id": _gpu_device}))
    elif _gpu_provider == "dml":
        # DirectML 的 device_id 即 D3D12 适配器索引（0 为默认适配器，勿硬选 NVIDIA）
        elist.insert(0, (EP.DIRECTML_EP.value, {"device_id": _gpu_device}))
    elif _gpu_provider == "openvino":
        # OpenVINO 无需 device_id（默认走第一个推理设备）
        elist.insert(0, ("OpenVINOExecutionProvider", {}))
    return elist


def _ensure_gpu_patch():
    """确保对 OrtInferSession._get_ep_list 做 monkeypatch（只 patch 一次，幂等）。"""
    global _gpu_patched
    if _gpu_patched:
        return
    try:
        from rapidocr_onnxruntime.utils.infer_engine import OrtInferSession
        if getattr(OrtInferSession, "_orig_get_ep_list", None) is None:
            # 保留原方法（便于诊断/恢复，尽管本插件不恢复）
            OrtInferSession._orig_get_ep_list = OrtInferSession._get_ep_list
        OrtInferSession._get_ep_list = _gpu_get_ep_list
        _gpu_patched = True
    except Exception as e:
        # patch 失败（版本变更导致结构不同）→ 按非 GPU 处理，不阻断
        print(f"[ocr-worker] monkeypatch _get_ep_list 失败（将视为 CPU）：{str(e)[:120]}", file=sys.stderr)
        _gpu_patched = True  # 标记已尝试，避免重复刷屏


def _make_warm_img():
    """构造一张带文字的合成图，用于 GPU warmup（迫使 det→cls→rec 三 Session 编译）。

    若只用纯白/纯黑图，检测会找不到文字框而跳过 rec，导致 rec 的 DML graph 未编译；
    因此画上多行文字。返回 uint8 3 通道 ndarray。
    """
    import numpy as np
    import cv2
    img = np.full((640, 640, 3), 255, dtype=np.uint8)
    cv2.putText(img, "Hello World 123", (20, 70), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 3)
    cv2.putText(img, "OCR GPU warmup", (20, 140), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (0, 0, 0), 3)
    cv2.putText(img, "vision-exp-tile", (20, 210), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 0), 3)
    cv2.putText(img, "1234567890", (20, 280), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 3)
    cv2.line(img, (30, 330), (610, 330), (0, 0, 0), 4)
    cv2.line(img, (30, 350), (420, 350), (0, 0, 0), 4)
    return img


def _gpu_warmup(engine, timeout_s=30.0):
    """在指定引擎上跑一次 warmup（带超时）。

    返回 (ok: bool, err: str|None, elapsed_ms: int|None)。线程内执行并把结果写回，
    主线程 join 超时即视为超时（GPU 首次 graph 编译可能 >30s，超时则触发回退）。
    """
    import time as _t
    res = {"ok": False, "err": None, "elapsed": None}
    def _run():
        try:
            t0 = _t.perf_counter()
            engine(_make_warm_img())
            res["elapsed"] = int((_t.perf_counter() - t0) * 1000)
            res["ok"] = True
        except Exception as e:
            res["ok"] = False
            res["err"] = str(e)[:200]
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout_s)
    return res.get("ok"), res.get("err"), res.get("elapsed")


def get_rapid_gpu_timeout_ms():
    """GPU 路径 warmup 超时（秒），默认 30s，可用 DSH_OCR_GPU_WARMUP_TIMEOUT 覆盖（调试）。"""
    raw = (os.environ.get("DSH_OCR_GPU_WARMUP_TIMEOUT") or "30").strip()
    try:
        v = int(raw)
        return max(5.0, float(v)) if v > 0 else 30.0
    except Exception:
        return 30.0


def get_rapid(timeout_ms=None):
    """懒加载 RapidOCR——首次加载约 0.55s（已实测），之后常驻。

    v0.4.0（GPU 分支）：按 DSH_OCR_GPU_PROVIDER 决定是否走 GPU。GPU 流程为：
      解析 provider/device → monkeypatch _get_ep_list → 构造 RapidOCR →
      warmup（带超时）→ 成功则常驻 GPU；失败/超时且 DSH_OCR_GPU_FALLBACK=1
      → 回退 CPU RapidOCR 并缓存 _gpu_ok=False。
    返回时同步更新模块级 _gpu_provider/_gpu_device（供响应 JSON 附带）。
    """
    global _gpu_provider, _gpu_device, _gpu_ok
    engine = _engines.get("rapid")
    if engine is not None:
        # 已初始化：直接复用手头引擎（CPU 或 GPU）。
        return engine
    with _lock:
        engine = _engines.get("rapid")
        if engine is None:
            from rapidocr_onnxruntime import RapidOCR

            gpu_fallback = (os.environ.get("DSH_OCR_GPU_FALLBACK") or "1").strip() != "0"
            provider, want_gpu = _resolve_gpu_provider()
            device = _resolve_gpu_device()

            if want_gpu and provider != "cpu":
                # —— GPU 路径 ——
                _ensure_gpu_patch()
                try:
                    # 构造成员：以 monkeypatch 的 _get_ep_list 接管 EP 列表（含 device_id）
                    gpu_engine = RapidOCR(intra_op_num_threads=RAPID_THREADS)
                    # 先做一次安全 warmup（吸收 DML graph 编译 / CUDA kernel JIT 一次性开销）
                    ok, err, wms = _gpu_warmup(gpu_engine, get_rapid_gpu_timeout_ms())
                    if ok:
                        _gpu_provider = provider
                        _gpu_device = device
                        _gpu_ok = True
                        _engines["rapid"] = gpu_engine
                        if wms is not None:
                            print(f"[ocr-worker] GPU warmup 完成（{provider}, device={device}, {wms}ms）", file=sys.stderr)
                        return gpu_engine
                    # warmup 失败/超时 → 回退（若允许）
                    print(f"[ocr-worker] GPU warmup 失败（{provider}）：{err or 'timeout'}，准备回退", file=sys.stderr)
                    if not gpu_fallback:
                        raise RuntimeError(f"GPU warmup 失败且禁止回退：{err or 'timeout'}")
                except Exception as e:
                    # 构造失败（如 DML 设备缺失 / OOM / provider 加载失败）
                    print(f"[ocr-worker] GPU 引擎构造失败（{provider}）：{str(e)[:200]}", file=sys.stderr)
                    if not gpu_fallback:
                        raise
                # —— 回退 CPU ——
                engine = RapidOCR(intra_op_num_threads=RAPID_THREADS)
                _gpu_provider = "cpu"
                _gpu_device = None
                _gpu_ok = False
                _engines["rapid"] = engine
                return engine
            else:
                # —— CPU 路径（off / 无可用 GPU provider / explicit 不可用）——
                engine = RapidOCR(intra_op_num_threads=RAPID_THREADS)
                _gpu_provider = "cpu"
                _gpu_device = None
                _gpu_ok = True
                _engines["rapid"] = engine
                return engine
    return engine


def _run_engine(engine, path):
    """执行推理并统一输出词汇行（结构兼容 ocr-local.js 的旧解析）。

    返回 (lines, meta)；meta 含 engine/provider/gpu_device（供 Node 日志/测速）。
    注意：RapidOCR 首次调用（GPU 冷启动）可能较慢，Node 侧重在首次放宽超时。
    """
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
        return lines, {"engine": "paddle", "provider": "cpu", "gpu_device": None}
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
        return lines, {"engine": "rapid", "provider": _gpu_provider, "gpu_device": _gpu_device}


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
            lines, meta = _run_engine(engine, path)
            sys.stdout.write(json.dumps({
                "id": rid,
                "ok": True,
                "lines": lines,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
                "engine": meta["engine"],
                "provider": meta["provider"],
                "gpu_device": meta["gpu_device"],
            }, ensure_ascii=False) + "\n")
        except Exception as e:
            sys.stdout.write(json.dumps({"id": rid, "ok": False, "error": str(e)[:500]}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

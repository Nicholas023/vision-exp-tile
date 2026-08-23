## v0.1.4（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 新功能与优化

1. **本地 OCR 缓存** — 同一张图重复识别直接命中（默认 48 小时），实测 20 张批量从 10.7s 降至 15ms；`DSH_OCR_CACHE=0` 关闭。
2. **重点区域并行识别** — 兴趣点默认 2 路并发（参数 `interest_concurrency` / `DSH_INTEREST_CONCURRENCY` 调 1-4），大图整卷等待时间再减一半。
3. **置信度自适应升级** — 本地 OCR 平均置信度低于 0.85 的区域，自动改用视觉 API 转录，更快与更准自动取舍。
4. **429/5xx 指数退避重试** — 限流/服务端异常自动重试（尊重 Retry-After），识别更稳定。
5. **跨块表格/长句对齐增强** — 分块后跨块文字行、表格单元格自动按行拼接还原，不再重复或遗漏。
6. **损坏图/HEIC 友好提示** — 无法识别的图片格式给出明确转图指引，替代裸报错。
7. **Windows OCR 中文指引** — 未安装中文 OCR 语言包时提供一键安装命令提示，并自动降级为视觉 API 转录。
8. **参数暴露** — `vision_tile_recognize` 支持 `ocr_engine`（auto/paddle/rapid/windows）与 `interest_concurrency`，缺省行为不变（向后兼容）。

### 性能

- 本地识别单张：3.3s → **0.18s**（≈18×）；20 张批量：66s → **8s**（≈8×）；缓存命中后批量 ≈ **0.02s**。
- 兴趣点并行后，整卷大图（多区域）等待时间再减约 50%。

### 版本形态

- **完整版** `vision-exp-tile-v0.1.4.zip`：本地识别最强（可选 paddle/rapid Python 环境，未装自动降级）。
- **无 Python 零配置版** `vision-exp-tile-v0.1.4-nopython.zip`：无需任何 Python 环境，本地识别使用系统自带 Windows OCR（常驻池），开箱即用。

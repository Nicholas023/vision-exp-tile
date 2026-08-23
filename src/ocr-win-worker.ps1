# ocr-win-worker.ps1 — Windows OCR（WinRT Windows.Media.Ocr）常驻工作进程
#
# 设计（与 src/ocr-worker.py 同款行协议，供 OcrPool 使用）：
#   1) 启动一次即加载 WinRT 类型与 OCR 引擎（消除旧实现"每张图 spawn PowerShell + 重新
#      实例化 WinRT"约 1-2s 的开销）——venv 缺失（免配置场景）时的本地识别核心；
#   2) stdin/stdout 行协议：in  {"id":N,"engine":"windows","path":"<png>"}
#                    out {"id":N,"ok":true,"lines":[{text,x,y,width,height}]}
#   3) 仅依赖 Windows 10+ 内置组件，零安装、零网络。
#
# 用法（由 OcrPool spawn）：powershell -NoProfile -ExecutionPolicy Bypass -File ocr-win-worker.ps1

$ErrorActionPreference = 'Stop'
# 统一 UTF-8 管线（防中文乱码）
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# WinRT 类型与 Await 工具（与旧 runWindowsOcr 相同实现）
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
Function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

# 引擎仅创建一次（常驻核心）
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

function Invoke-Ocr($pngPath) {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pngPath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
        $words = @()
        foreach ($w in $line.Words) {
            $words += [PSCustomObject]@{ Text = $w.Text; X = [int]$w.BoundingRect.X; Y = [int]$w.BoundingRect.Y; W = [int]$w.BoundingRect.Width; H = [int]$w.BoundingRect.Height }
        }
        $lines += [PSCustomObject]@{ Text = $line.Text; X = [int]$line.BoundingRect.X; Y = [int]$line.BoundingRect.Y; W = [int]$line.BoundingRect.Width; H = [int]$line.BoundingRect.Height; Words = $words }
    }
    return [PSCustomObject]@{ Width = $decoder.PixelWidth; Height = $decoder.PixelHeight; Lines = $lines }
}

# 主循环：逐行命令 → 逐行结果（flush 保证实时性）
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $resp = $null
    try {
        $req = $line | ConvertFrom-Json
        if ($engine -eq $null) {
            $resp = [PSCustomObject]@{ id = $req.id; ok = $false; error = 'no OCR engine for the requested language' }
        } else {
            $r = Invoke-Ocr $req.path
            $outLines = @()
            foreach ($l in $r.Lines) {
                $outLines += [PSCustomObject]@{ text = $l.Text; x = [int]$l.X; y = [int]$l.Y; width = [int]$l.W; height = [int]$l.H }
            }
            $resp = [PSCustomObject]@{ id = $req.id; ok = $true; lines = $outLines }
        }
    } catch {
        $resp = [PSCustomObject]@{ id = -1; ok = $false; error = $_.Exception.Message }
    }
    # PS5.1 兼容：方法调用不能作管道下游——先转字符串再输出
    $out = $resp | ConvertTo-Json -Depth 4 -Compress
    [Console]::Out.WriteLine($out)
    [Console]::Out.Flush()
}

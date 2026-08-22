# release-pack.ps1 — 生成 GitHub Release 资产（zip 包）
#
# 打包内容：源代码 + 测试 + 脚本 + 文档 + 许可证（不含 node_modules）
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\release-pack.ps1
# 输出：dist/vision-exp-tile-v<版本>.zip
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 读取版本号（显式 UTF8：PS 5.1 默认按 ANSI 读会乱码；package.json 不能加 BOM，npm 不接受）
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
if (-not $ver) { throw 'package.json 缺少 version 字段' }
Write-Host "[1] 版本：v$ver" -ForegroundColor Cyan

# 准备打包目录（临时 staging）
$distDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$stage = Join-Path $distDir "vision-exp-tile-$ver"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$include = @('src', 'tests', 'scripts', 'README.md', 'LICENSE', 'package.json', '.gitignore', 'cordis.patch.yml')
foreach ($item in $include) {
  $src = Join-Path $root $item
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $stage $item) -Recurse -Force
    Write-Host "  + $item"
  } else {
    Write-Host "  ! 跳过（不存在）：$item" -ForegroundColor Yellow
  }
}

# 打包 zip
$zip = Join-Path $distDir "vision-exp-tile-v$ver.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Remove-Item $stage -Recurse -Force

Write-Host ""
Write-Host "[2] 完成：$zip" -ForegroundColor Green
Get-Item $zip | Select-Object FullName, @{ n = 'Size(MB)'; e = { [math]::Round($_.Length / 1MB, 2) } } | Format-List
Write-Host "将 zip 上传到 GitHub Releases 作为 v$ver 的资产，即可供用户下载安装。"

# install-to-web-profile.ps1 — 测试通过后，把 vision-exp-tile 正式挂载到 web profile
#
# 说明：本脚本默认【只准备不执行】（-Apply 参数才真正修改正式 profile）。
#   1) 备份 profiles/web/package.json → package.json.bak-vision-exp-tile
#   2) 在 dsh.profile.bundles 中追加 "vision-exp-tile"（若不存在）
#   3) 在 dependencies 中追加 link: 依赖（若不存在）
#   4) 创建 profiles/web/node_modules/vision-exp-tile junction
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-to-web-profile.ps1            # 预览
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-to-web-profile.ps1 -Apply      # 执行
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-to-web-profile.ps1 -Rollback   # 回滚
# ---------------------------------------------------------------------------

param(
    [switch]$Apply,
    [switch]$Rollback,
    [switch]$NoDeviceTune   # 跳过安装时的设备探测与慢机自动调优（用户建议③）
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dshHome     = Join-Path $env:USERPROFILE '.dsh'
$webPkg      = Join-Path $dshHome 'profiles\web\package.json'
$bakPkg      = "$webPkg.bak-vision-exp-tile"
$pluginJunction = Join-Path $dshHome 'plugins\vision-exp-tile'

function Get-WebProfile() {
    if (-not (Test-Path $webPkg)) { throw "未找到 $webPkg" }
    Get-Content $webPkg -Raw | ConvertFrom-Json
}

# —— 设备探测 + 慢机自动调优（用户建议③：安装时自动识别设备）——
# 说明：探测调用 node scripts/probe-device.mjs（输出 JSON），再按 src/device.js 的
# classifyTier 规则判定档位；slow 档把推荐键写入 settings.yaml 的 vision-exp-tile 分区
# （仅未显式设置的键，幂等，写入前备份到同目录 .bak-时间戳）。不引入第三方 YAML 解析，
# 用文本行匹配；找不到分区则提示、不创建（不越权改其他文件）。

function Get-DeviceProbe {
    # 运行 probe-device.mjs 并解析 JSON 对象；失败返回 $null（不阻断安装）。
    $probeScript = Join-Path $projectRoot 'scripts\probe-device.mjs'
    if (-not (Test-Path $probeScript)) {
        Write-Host "[DEV][WARN] 未找到 scripts\probe-device.mjs，跳过设备探测" -ForegroundColor Yellow
        return $null
    }
    try {
        $out = (& node $probeScript 2>&1 | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($out)) { return $null }
        return ($out | ConvertFrom-Json)
    } catch {
        Write-Host "[DEV][WARN] 设备探测失败（node 是否在 PATH？）：$($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

function Get-DeviceTier($probe) {
    # 镜像 src/device.js 的 classifyTier 规则：cpuCores<=4 或 内存<8GiB→slow；
    # cpuCores>=8 且 内存>=16GiB 且有 GPU→fast；其余 normal。
    $cpu = [int]$probe.cpuCores
    $memGiB = [double]$probe.totalMemBytes / 1073741824.0
    $hasGpu = -not [string]::IsNullOrWhiteSpace([string]$probe.gpuName)
    if ($cpu -le 4 -or $memGiB -lt 8) { return 'slow' }
    if ($cpu -ge 8 -and $memGiB -ge 16 -and $hasGpu) { return 'fast' }
    return 'normal'
}

function Get-SlowTuningKeys {
    # slow 档推荐（对应 src/device.js applyTierRecommendations('slow')），键名用设置页 snake_case。
    # 数值键写字面整数，字符串键加引号（off 不加引号会被 YAML 1.1 解析成布尔 false）。
    return [ordered]@{
        'ocr_pool_timeout_ms' = '240000'
        'ocr_pool'            = '2'
        'gpu_provider'        = "'off'"
        'test_timeout_factor' = '4'
    }
}

function Add-SettingsTuning {
    param([string]$SettingsPath, $tuneMap)
    if (-not (Test-Path $SettingsPath)) {
        Write-Host "[DEV][WARN] 未找到 $SettingsPath，跳过写入（如尚未运行过 DSH，可稍后在设置页手动开启）" -ForegroundColor Yellow
        return
    }
    # 备份到同目录 .bak-时间戳
    $bak = "$SettingsPath.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item $SettingsPath $bak -Force
    Write-Host "[DEV][OK] 已备份 settings.yaml -> $bak" -ForegroundColor Green

    # 找 vision-exp-tile 分区行（缩进不定，键缩进更深）
    $all = @(Get-Content $SettingsPath -Encoding UTF8)
    $pidx = -1; $pindent = 0
    for ($i=0; $i -lt $all.Count; $i++) {
        if ($all[$i] -match '^\s*vision-exp-tile:\s*$') {
            $pidx = $i
            $pindent = ([regex]::Match($all[$i], '^\s*').Length)
            break
        }
    }
    if ($pidx -lt 0) {
        Write-Host "[DEV][WARN] settings.yaml 未找到 vision-exp-tile 分区，跳过写入（不越权创建其他内容）" -ForegroundColor Yellow
        return
    }

    # 收集该分区已有键，并找块结束位置（第一个非键行或文件尾）
    $existing = @{}
    $blockEnd = $pidx + 1
    while ($blockEnd -lt $all.Count) {
        $line = $all[$blockEnd]
        if ([string]::IsNullOrWhiteSpace($line)) { $blockEnd++; continue }
        $indent = ([regex]::Match($line, '^\s*').Length)
        if ($indent -le $pindent) { break }
        if ($line -match '^\s*([A-Za-z0-9_]+):') { $existing[$Matches[1].ToLower()] = $true }
        $blockEnd++
    }

    # 取出缺失的调优键（幂等：已有键不覆盖）
    $missing = @()
    foreach ($k in @($tuneMap.Keys)) {
        if (-not $existing.ContainsKey($k.ToLower())) { $missing += $k }
    }
    if ($missing.Count -eq 0) {
        Write-Host "[DEV][OK] 调优键均已存在于 settings.yaml（幂等，未改动）" -ForegroundColor Green
        return
    }

    # 在分区块末尾追加缺失键（键缩进 = 分区缩进 + 2 空格）
    $keyIndent = (' ' * ($pindent + 2))
    $lines = New-Object System.Collections.Generic.List[string]
    $inserted = $false
    for ($i=0; $i -lt $all.Count; $i++) {
        if ($i -eq $blockEnd) {
            foreach ($k in $missing) { $lines.Add($keyIndent + $k + ': ' + $tuneMap[$k]) }
            $inserted = $true
        }
        $lines.Add($all[$i])
    }
    if (-not $inserted) {
        foreach ($k in $missing) { $lines.Add($keyIndent + $k + ': ' + $tuneMap[$k]) }
    }

    # 写回（UTF8）
    $lines | Set-Content -Path $SettingsPath -Encoding UTF8
    Write-Host "[DEV][OK] 已写入调优键：" ($missing -join ', ') -ForegroundColor Green
}

if ($Rollback) {
    # —— 回滚：从备份还原 package.json 并删除 junction ——
    if (Test-Path $bakPkg) {
        Copy-Item $bakPkg $webPkg -Force
        Write-Host "[OK] 已从备份还原 package.json" -ForegroundColor Green
    } else {
        Write-Host "[WARN] 无备份文件，未还原 package.json" -ForegroundColor Yellow
    }
    $nmLink = Join-Path (Join-Path $dshHome 'profiles\web\node_modules') 'vision-exp-tile'
    if (Test-Path $nmLink) { Remove-Item $nmLink -Recurse -Force; Write-Host "[OK] 已删除 node_modules\vision-exp-tile" }
    Write-Host "回滚完成。请重启 DSH 生效。"
    exit 0
}

$profile = Get-WebProfile
$bundles = @($profile.dsh.profile.bundles)
$deps = @{}
$profile.dependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value }
$changed = $false

if ($bundles -notcontains 'vision-exp-tile') {
    $bundles += 'vision-exp-tile'
    Write-Host "[预览] bundles 将追加 vision-exp-tile" -ForegroundColor Cyan
    $changed = $true
} else { Write-Host "[OK] bundles 已包含 vision-exp-tile" }

if (-not $deps.ContainsKey('vision-exp-tile')) {
    $deps['vision-exp-tile'] = 'link:C:/Users/HP/.dsh/plugins/vision-exp-tile'
    Write-Host "[预览] dependencies 将追加 vision-exp-tile -> link:C:/Users/HP/.dsh/plugins/vision-exp-tile" -ForegroundColor Cyan
    $changed = $true
} else { Write-Host "[OK] dependencies 已包含 vision-exp-tile" }

if (-not (Test-Path $pluginJunction)) {
    Write-Host "[预览] 将创建插件 junction: $pluginJunction" -ForegroundColor Cyan
}

# —— 设备探测 + 慢机自动调优（建议③）：探测打印画像/档位；写入仅在 -Apply 且 slow 时进行 ——
$probeObj = $null
$tierEffective = 'unknown'
try {
    $probeObj = Get-DeviceProbe
    if ($probeObj) {
        $tierEffective = Get-DeviceTier $probeObj
        $memGiB = [math]::Round(([double]$probeObj.totalMemBytes / 1073741824.0), 1)
        $gpuName = if ([string]::IsNullOrWhiteSpace([string]$probeObj.gpuName)) { '无' } else { $probeObj.gpuName }
        Write-Host ("[DEV] 设备画像：CPU {0}核 / 内存 {1}GB / GPU {2} → 档位 {3}" -f $probeObj.cpuCores, $memGiB, $gpuName, $tierEffective) -ForegroundColor Cyan
        if ($tierEffective -eq 'slow') {
            Write-Host ("[DEV] 机型较差（slow）→ 将自动写入调优键：{0}（未显式设置的键才写入）" -f ((Get-SlowTuningKeys).Keys -join ', ')) -ForegroundColor Cyan
        } else {
            Write-Host ("[DEV] 机型性能足够（{0}）→ 保持默认，无需自动调优" -f $tierEffective) -ForegroundColor Cyan
        }
    } else {
        Write-Host "[DEV][WARN] 设备探测失败，跳过自动调优（不影响安装）" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[DEV][WARN] 设备探测异常：$($_.Exception.Message)" -ForegroundColor Yellow
}

if (-not $Apply) {
    Write-Host "`n（预览模式：加 -Apply 执行；加 -Rollback 回滚）"
    exit 0
}

# —— 执行 ——
Copy-Item $webPkg $bakPkg -Force
$newPkg = [ordered]@{
    name = $profile.name
    private = $profile.private
    dsh = [ordered]@{ profile = [ordered]@{ bundles = $bundles } }
    dependencies = $deps
}
$newPkg | ConvertTo-Json -Depth 10 | Set-Content $webPkg -Encoding UTF8
Write-Host "[OK] 已备份原 package.json -> $bakPkg"
Write-Host "[OK] 已写入新 package.json"

if (-not (Test-Path $pluginJunction)) {
    New-Item -ItemType Junction -Path $pluginJunction -Target $projectRoot | Out-Null
    Write-Host "[OK] 插件 junction 已创建"
}
New-Item -ItemType Directory -Path (Join-Path $dshHome 'profiles\web\node_modules') -Force | Out-Null
$nmLink = Join-Path (Join-Path $dshHome 'profiles\web\node_modules') 'vision-exp-tile'
if (-not (Test-Path $nmLink)) {
    New-Item -ItemType Junction -Path $nmLink -Target $projectRoot | Out-Null
    Write-Host "[OK] node_modules\vision-exp-tile junction 已创建"
}

# —— 设备调优写入（仅 -Apply；slow 且未 -NoDeviceTune）——
if ($NoDeviceTune) {
    Write-Host "[DEV][OK] 已指定 -NoDeviceTune，跳过自动调优" -ForegroundColor Yellow
} elseif ($probeObj -and $tierEffective -eq 'slow') {
    $settingsPath = Join-Path $dshHome 'settings.yaml'
    Write-Host "[DEV] 应用 slow 档自动调优到 $settingsPath 的 vision-exp-tile 分区（未显式键才写入）：" -ForegroundColor Cyan
    Add-SettingsTuning -SettingsPath $settingsPath -tuneMap (Get-SlowTuningKeys)
} elseif ($probeObj) {
    Write-Host "[DEV] 机型性能足够（$tierEffective），未写入调优键" -ForegroundColor Cyan
} else {
    Write-Host "[DEV] 设备探测失败，未进行自动调优" -ForegroundColor Yellow
}

Write-Host "`n完成。重启 DSH 后生效。回滚：-Rollback"

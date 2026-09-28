# 同步共享内核 / 报价引擎到 Worker
#
# 为什么需要这一步
# ----------------
# 线上 Worker（Pyodide）只能加载自己 src/ 目录下的模块 + 已安装依赖，
# 无法引用仓库里的任意路径。与其"手写第二份"（历史做法，已造成 80 个接口漂移），
# 不如把唯一源**自动复制**进去 —— 复制是幂等的、无人工判断的。
#
# 两段镜像
# --------
# 1) backend/kaas_common/
#                      -> backend/worker/src/kaas_common/
# 2) backend/orchestrator/app/services/export_quote/**（报价引擎 · 纯标准库）
#                      -> backend/worker/src/kaas_common/export_quote/
#
# 关于第 2 段：引擎包内**全部是相对导入**（from .x / from ..x），
# 所以复制过去即可，无需改写 import。前提是引擎的模块级依赖必须是纯标准库
# （Pyodide 装不了 C 扩展）—— 这一点由 rates.py 的 yaml 惰性导入 +
# rate_sets/*.json 保证。税务档案只放 .json：线上没有 PyYAML，而报价单要求
# "逐分复现"，不允许开发端与线上读到两份可能分歧的数据。
#
# 用法
#   pwsh scripts/sync-shared.ps1          # 同步
#   pwsh scripts/sync-shared.ps1 -Check   # 只校验是否一致（不一致则退出码 1）
[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

# 每段镜像：源目录、目标目录、允许的文件名模式、要排除的路径片段
$stages = @(
    @{
        Label   = "共享内核"
        Source  = Join-Path $repoRoot "backend/kaas_common"
        Target  = Join-Path $repoRoot "backend/worker/src/kaas_common"
        Filters = @("*.py")
        # export_quote 是第 2 段的镜像，**嵌套在本目标目录内**：
        # 不计入本段，否则 -Check 会把引擎的 16 个文件算成"内核多了文件"而永远报不一致。
        Exclude = @("__pycache__", "export_quote")
    },
    @{
        Label   = "报价引擎"
        Source  = Join-Path $repoRoot "backend/orchestrator/app/services/export_quote"
        Target  = Join-Path $repoRoot "backend/worker/src/kaas_common/export_quote"
        Filters = @("*.py", "*.json")
        Exclude = @("__pycache__", "examples")
    }
)

function Test-Excluded {
    param($Path, $Stage)
    $relative = $Path.FullName.Substring($Stage.Source.Length)
    foreach ($pattern in $Stage.Exclude) {
        if ($relative -match [regex]::Escape($pattern)) { return $true }
    }
    return $false
}

$exitCode = 0

foreach ($stage in $stages) {
    if (-not (Test-Path $stage.Source)) {
        Write-Error "$($stage.Label) 源目录不存在: $($stage.Source)"
        exit 1
    }

    $sourceFiles = @(Get-ChildItem -Path $stage.Source -Recurse -File -Include $stage.Filters |
        Where-Object { -not (Test-Excluded -Path $_ -Stage $stage) })

    if ($Check) {
        $differences = @()
        foreach ($file in $sourceFiles) {
            $relative = $file.FullName.Substring($stage.Source.Length).TrimStart('\', '/')
            $mirror   = Join-Path $stage.Target $relative
            if (-not (Test-Path $mirror)) {
                $differences += "缺失: $relative"
                continue
            }
            $a = (Get-FileHash $file.FullName   -Algorithm SHA256).Hash
            $b = (Get-FileHash $mirror          -Algorithm SHA256).Hash
            if ($a -ne $b) { $differences += "内容不一致: $relative" }
        }
        $mirrorCount = @(Get-ChildItem -Path $stage.Target -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $relative = $_.FullName.Substring($stage.Target.Length)
                $skip = $false
                foreach ($pattern in $stage.Exclude) {
                    if ($relative -match [regex]::Escape($pattern)) { $skip = $true }
                }
                -not $skip
            }).Count
        if ($mirrorCount -ne $sourceFiles.Count) {
            $differences += "文件数不一致: 源 $($sourceFiles.Count) / 镜像 $mirrorCount"
        }

        if ($differences.Count -gt 0) {
            Write-Host "$($stage.Label) 未同步（请运行 pwsh scripts/sync-shared.ps1）:" -ForegroundColor Red
            $differences | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
            $exitCode = 1
        }
        else {
            Write-Host "$($stage.Label) 一致（$($sourceFiles.Count) 个文件）" -ForegroundColor Green
        }
        continue
    }

    # ── 执行同步：先清空镜像目录，避免源里删掉的文件在镜像里残留 ──
    if (Test-Path $stage.Target) {
        Get-ChildItem -Path $stage.Target -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $stage.Target -Recurse -Force
    }
    New-Item -ItemType Directory -Path $stage.Target -Force | Out-Null

    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($stage.Source.Length).TrimStart('\', '/')
        $destination = Join-Path $stage.Target $relative
        $destinationDir = Split-Path -Parent $destination
        if (-not (Test-Path $destinationDir)) {
            New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
        }
        Copy-Item -Path $file.FullName -Destination $destination -Force
    }

    $displayTarget = $stage.Target.Replace($repoRoot + '\', '')
    Write-Host "$($stage.Label) 已同步: $($sourceFiles.Count) 个文件 -> $displayTarget" -ForegroundColor Green
}

exit $exitCode

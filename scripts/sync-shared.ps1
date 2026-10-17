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
        Exclude = @("__pycache__", "export_quote", "domain")
    },
    @{
        Label   = "报价引擎"
        Source  = Join-Path $repoRoot "backend/orchestrator/app/services/export_quote"
        Target  = Join-Path $repoRoot "backend/worker/src/kaas_common/export_quote"
        Filters = @("*.py", "*.json")
        # _manifest.json 是构建期生成的（见下方），不是源码；比较时排除、另行校验新鲜度
        Exclude = @("__pycache__", "examples", "_manifest.json")
    },
    @{
        # 业务枚举字典：真源是 orchestrator 的 app/domain/enums.py（由
        # scripts/contracts-check.ts 的 R2 规则与 shared/contracts 对齐校验）。
        # Worker 的 GET /api/v1/enums 必须回**同一份**常量，绝不能手抄第二份 ——
        # 前端下拉/标签全靠它，抄错就是「线上选项少一个」这种无声故障。
        Label   = "业务枚举字典"
        Source  = Join-Path $repoRoot "backend/orchestrator/app/domain"
        Target  = Join-Path $repoRoot "backend/worker/src/kaas_common/domain"
        Filters = @("enums.py")
        Exclude = @("__pycache__")
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

        # 报价引擎：校验构建期 rate_sets 清单是否与源目录一致
        # （Pyodide 无目录列举能力时，rates.py 靠它找到税务档案）
        if ($stage.Label -eq "报价引擎") {
            $rateSource = Join-Path $stage.Source "rate_sets"
            $expected = @(Get-ChildItem -Path $rateSource -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Extension -in @(".json", ".yaml", ".yml") -and $_.Name -ne "_manifest.json" } |
                Select-Object -ExpandProperty Name | Sort-Object)
            $manifestPath = Join-Path $stage.Target "rate_sets/_manifest.json"
            $actual = @()
            if (Test-Path $manifestPath) {
                $parsed = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
                foreach ($n in $parsed) { $actual += [string]$n }
                $actual = @($actual | Sort-Object)
            }
            if (($actual -join "|") -ne ($expected -join "|")) {
                $differences += "rate_sets/_manifest.json 缺失或过期（期望 $($expected.Count) 项）"
            }
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

# ── 构建期生成 rate_sets 清单（Worker/Pyodide 可能不支持目录列举）──
# 只有文件名，无业务数据；-Check 模式不写盘（由上面的一致性校验负责）。
if (-not $Check) {
    $rateTarget = Join-Path $repoRoot "backend/worker/src/kaas_common/export_quote/rate_sets"
    if (Test-Path $rateTarget) {
        $names = @(Get-ChildItem -Path $rateTarget -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in @(".json", ".yaml", ".yml") -and $_.Name -ne "_manifest.json" } |
            Select-Object -ExpandProperty Name | Sort-Object)
        $json = if ($names.Count -eq 0) { "[]" } else { ConvertTo-Json -InputObject $names -Compress }
        # 必须 UTF-8 无 BOM：Pyodide 里 json.loads 遇到 BOM 会直接抛错
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText((Join-Path $rateTarget "_manifest.json"), $json, $utf8NoBom)
        Write-Host "rate_sets 清单已生成: $($names.Count) 个档案" -ForegroundColor Green
    }
}

exit $exitCode

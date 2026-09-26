# 同步共享内核到 Worker：backend/kaas_common/ → backend/worker/src/kaas_common/
#
# 为什么需要这一步
# ----------------
# 线上 Worker（Pyodide）只能加载自己 src/ 目录下的模块 + 已安装依赖，
# 无法引用仓库里的任意路径。与其"手写第二份"（历史做法，已造成 80 个接口漂移），
# 不如把唯一源**自动复制**进去 —— 复制是幂等的、无人工判断的。
#
# 用法
#   pwsh scripts/sync-shared.ps1          # 同步
#   pwsh scripts/sync-shared.ps1 -Check   # 只校验是否一致（CI 用，不一致则退出码 1）
[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$source   = Join-Path $repoRoot "backend/kaas_common"
$target   = Join-Path $repoRoot "backend/worker/src/kaas_common"

if (-not (Test-Path $source)) {
    Write-Error "共享内核源目录不存在: $source"
    exit 1
}

# 只同步 .py，排除缓存产物
$sourceFiles = Get-ChildItem -Path $source -Recurse -File -Filter *.py |
    Where-Object { $_.FullName -notmatch '__pycache__' }

if ($Check) {
    $differences = @()
    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($source.Length).TrimStart('\', '/')
        $mirror   = Join-Path $target $relative
        if (-not (Test-Path $mirror)) {
            $differences += "缺失: $relative"
            continue
        }
        $a = (Get-FileHash $file.FullName   -Algorithm SHA256).Hash
        $b = (Get-FileHash $mirror          -Algorithm SHA256).Hash
        if ($a -ne $b) { $differences += "内容不一致: $relative" }
    }
    $mirrorCount = @(Get-ChildItem -Path $target -Recurse -File -Filter *.py -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '__pycache__' }).Count
    if ($mirrorCount -ne $sourceFiles.Count) {
        $differences += "文件数不一致: 源 $($sourceFiles.Count) / 镜像 $mirrorCount"
    }

    if ($differences.Count -gt 0) {
        Write-Host "共享内核未同步（请运行 pwsh scripts/sync-shared.ps1）:" -ForegroundColor Red
        $differences | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        exit 1
    }
    Write-Host "共享内核一致（$($sourceFiles.Count) 个文件）" -ForegroundColor Green
    exit 0
}

# ── 执行同步：先清空镜像目录，避免源里删掉的文件在镜像里残留 ──
if (Test-Path $target) {
    Get-ChildItem -Path $target -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $target -Recurse -Force
}
New-Item -ItemType Directory -Path $target -Force | Out-Null

foreach ($file in $sourceFiles) {
    $relative = $file.FullName.Substring($source.Length).TrimStart('\', '/')
    $destination = Join-Path $target $relative
    $destinationDir = Split-Path -Parent $destination
    if (-not (Test-Path $destinationDir)) {
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    }
    Copy-Item -Path $file.FullName -Destination $destination -Force
}

Write-Host "已同步共享内核: $($sourceFiles.Count) 个文件 -> backend/worker/src/kaas_common/" -ForegroundColor Green

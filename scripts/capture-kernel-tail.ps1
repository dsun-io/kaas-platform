# 内核失败样本抓取（工单 A1 补齐工具）
#
# 何时用：当内核再次出现 502 / scriptThrewException 时，立刻跑本脚本，
#        它会抓含 rayId/colo/eventTimestamp/scriptVersion 的原始 JSONL 并筛出失败行。
#
# 用法（PowerShell，需要 CLOUDFLARE_API_TOKEN）：
#   powershell -ExecutionPolicy Bypass -File scripts/capture-kernel-tail.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/capture-kernel-tail.ps1 -Seconds 300
#
# 产物：docs/ticket-2026-10-24/A1_tail_<UTC时间>.jsonl（失败行单独一份 _failures.jsonl）
param(
  [int]$Seconds = 180,
  [string]$OutDir = "docs/ticket-2026-10-24",
  [string]$Script = "kaas"
)

$ErrorActionPreference = "Stop"
if (-not $env:CLOUDFLARE_API_TOKEN) {
  $p = Join-Path $env:USERPROFILE ".dsh\secrets\cloudflare-api-token.txt"
  if (Test-Path $p) { $env:CLOUDFLARE_API_TOKEN = (Get-Content $p -Raw).Trim() }
}
if (-not $env:CLOUDFLARE_API_TOKEN) { throw "缺少 CLOUDFLARE_API_TOKEN" }
if (-not $env:HTTPS_PROXY) {
  # workers.dev / tail WebSocket 在本机需要系统代理（实测）
  $env:HTTPS_PROXY = "http://127.0.0.1:7897"; $env:HTTP_PROXY = "http://127.0.0.1:7897"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$raw = Join-Path $OutDir ("A1_tail_" + $stamp + ".jsonl")
$fail = Join-Path $OutDir ("A1_tail_" + $stamp + "_failures.jsonl")

Write-Host "抓取 $Script tail，持续 $Seconds 秒 -> $raw"
$job = Start-Job -ScriptBlock {
  param($token, $scriptName, $path)
  $env:CLOUDFLARE_API_TOKEN = $token
  $env:HTTPS_PROXY = $env:HTTPS_PROXY; $env:HTTP_PROXY = $env:HTTP_PROXY
  & "$env:USERPROFILE\AppData\Roaming\npm\wrangler.cmd" tail $scriptName --format json 2>&1 |
    Out-File -FilePath $path -Encoding utf8
} -ArgumentList $env:CLOUDFLARE_API_TOKEN, $Script, $raw

# 抓取期间打一点真实流量（有 JWT 更好；这里给最小提示）
Write-Host "提示：抓取期间请用带 JWT 的请求打内核路径（如 quotes/trade-docs 相关），或让它自然接 cron/业务流量。"
Start-Sleep -Seconds $Seconds
Stop-Job $job -ErrorAction SilentlyContinue
Remove-Job $job -Force -ErrorAction SilentlyContinue

if (Test-Path $raw) {
  $lines = Get-Content $raw | Where-Object { $_ -match '"outcome":\s*"exception"' -or $_ -match "initPyInstance" -or $_ -match "scriptThrewException" }
  $lines | Set-Content $fail -Encoding utf8
  Write-Host ("总行数: " + (Get-Content $raw | Measure-Object -Line).Lines + " | 失败/异常行: " + ($lines | Measure-Object).Count)
  Write-Host "失败样本 -> $fail"
} else {
  Write-Host "未抓到数据（可能 tail 需要代理，或该时段无流量）"
}

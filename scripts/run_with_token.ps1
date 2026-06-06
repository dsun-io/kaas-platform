# PowerShell 脚本：使用 Token 创建 Notion 任务
# 使用方法: .\scripts\run_with_token.ps1 -Token "secret_xxxxx"

param(
    [Parameter(Mandatory=$false)]
    [string]$Token = ""
)

# 如果没有提供 Token，尝试从环境变量获取
if (-not $Token) {
    $Token = $env:NOTION_TOKEN
    if (-not $Token) {
        Write-Host "=" -ForegroundColor Red
        Write-Host "错误: 未提供 Token" -ForegroundColor Red
        Write-Host "=" -ForegroundColor Red
        Write-Host ""
        Write-Host "使用方式:"
        Write-Host "  .\scripts\run_with_token.ps1 -Token 'secret_xxxxx'" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "或者先设置环境变量:"
        Write-Host "  $env:NOTION_TOKEN = 'secret_xxxxx'" -ForegroundColor Yellow
        Write-Host "  .\scripts\run_with_token.ps1" -ForegroundColor Yellow
        exit 1
    }
}

# 设置环境变量
$env:NOTION_TOKEN = $Token

Write-Host "=" -ForegroundColor Cyan
Write-Host "使用 Token 创建 Notion 任务" -ForegroundColor Cyan
Write-Host "=" -ForegroundColor Cyan
Write-Host ""
Write-Host "Token: $($Token.Substring(0, [Math]::Min(10, $Token.Length)))...$($Token.Substring($Token.Length - 4))" -ForegroundColor Green
Write-Host ""

# 运行 Python 脚本
cd d:\MyProject\kaas-platform
python scripts\create_task_direct.py

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✓ 任务创建成功!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "✗ 任务创建失败，请查看错误信息" -ForegroundColor Red
}

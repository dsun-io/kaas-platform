# 用本机 Excel 把目录下所有 xlsx 批量导出为 PDF（沿用报价单/PI 的导出方式）
param([Parameter(Mandatory=$true)][string]$Dir)

$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  Get-ChildItem -Path $Dir -Filter *.xlsx | ForEach-Object {
    $src = $_.FullName
    $pdf = [System.IO.Path]::ChangeExtension($src, '.pdf')
    if (Test-Path $pdf) { Remove-Item $pdf -Force }
    $wb = $excel.Workbooks.Open($src)
    try {
      $wb.ExportAsFixedFormat(0, $pdf)   # 0 = xlTypePDF
      Write-Host "pdf -> $pdf"
    } finally {
      $wb.Close($false)
    }
  }
} finally {
  $excel.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}

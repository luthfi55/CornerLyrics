$ErrorActionPreference = 'SilentlyContinue'
$mine = Get-CimInstance Win32_Process -Filter "Name='CornerLyrics.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port' }
foreach ($p in $mine) {
  Write-Output ("killing " + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force
}
Start-Sleep 2
Get-CimInstance Win32_Process -Filter "Name='CornerLyrics.exe'" | ForEach-Object {
  $port = if ($_.CommandLine -match 'remote-debugging-port=(\d+)') { $Matches[1] } else { 'none' }
  Write-Output ($_.ProcessId.ToString() + " debug-port=" + $port)
}

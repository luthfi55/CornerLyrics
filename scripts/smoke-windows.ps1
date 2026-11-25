param(
  [Parameter(Mandatory = $true)]
  [string]$Workspace,
  [Parameter(Mandatory = $true)]
  [string]$RunRoot
)

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$distPath = Join-Path $workspacePath 'dist'
$artifactsPath = Join-Path $workspacePath 'artifacts'
$smokeScript = Join-Path $workspacePath 'scripts\smoke-cdp.cjs'

if (Test-Path -LiteralPath $RunRoot) {
  throw "Smoke root already exists: $RunRoot"
}
New-Item -ItemType Directory -Path $RunRoot -Force | Out-Null
$RunRoot = (Resolve-Path -LiteralPath $RunRoot).Path

function Test-ProcessPath {
  param([string]$ExecutablePath, [string[]]$Roots)
  foreach ($root in $Roots) {
    if ($ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Start-SmokeApp {
  param(
    [string]$Executable,
    [int]$Port,
    [string]$DataDirectory,
    [string]$TempDirectory,
    [string]$Label,
    [string]$ExpectedTheme
  )

  New-Item -ItemType Directory -Path $TempDirectory -Force | Out-Null
  $stdoutPath = Join-Path $RunRoot "$Label.stdout.log"
  $stderrPath = Join-Path $RunRoot "$Label.stderr.log"
  $oldPortableDirectory = $env:PORTABLE_EXECUTABLE_DIR
  $oldTemp = $env:TEMP
  $oldTmp = $env:TMP
  $launcher = $null

  try {
    if ($DataDirectory) {
      $env:PORTABLE_EXECUTABLE_DIR = $DataDirectory
    } else {
      Remove-Item Env:PORTABLE_EXECUTABLE_DIR -ErrorAction SilentlyContinue
    }
    $env:TEMP = $TempDirectory
    $env:TMP = $TempDirectory

    $launcher = Start-Process -FilePath $Executable -ArgumentList "--remote-debugging-port=$Port" -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $deadline = (Get-Date).AddSeconds(30)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 1
        if ($response.StatusCode -eq 200) {
          $ready = $true
          break
        }
      } catch {
        Start-Sleep -Milliseconds 250
      }
    }
    if (-not $ready) {
      throw "CDP endpoint did not become ready for $Label"
    }

    $arguments = @($smokeScript, $Port, $Label)
    if ($ExpectedTheme) {
      $arguments += $ExpectedTheme
    }
    & node @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Renderer smoke test failed for $Label"
    }

    $processRoots = @(
      [IO.Path]::GetFullPath($TempDirectory),
      [IO.Path]::GetFullPath((Split-Path -Parent $Executable))
    )
    $deadline = (Get-Date).AddSeconds(20)
    do {
      $running = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and (Test-ProcessPath -ExecutablePath $_.ExecutablePath -Roots $processRoots)
      })
      if ($running.Count -eq 0) { break }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if ($running.Count -gt 0) {
      throw "App processes did not exit after $Label"
    }
  } finally {
    $env:PORTABLE_EXECUTABLE_DIR = $oldPortableDirectory
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp

    $processRoots = @(
      [IO.Path]::GetFullPath($TempDirectory),
      [IO.Path]::GetFullPath((Split-Path -Parent $Executable))
    )
    $remaining = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and (Test-ProcessPath -ExecutablePath $_.ExecutablePath -Roots $processRoots)
    })
    if ($launcher -and -not $launcher.HasExited) {
      Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
    }
    foreach ($process in $remaining) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Assert-PersistedTheme {
  param([string]$SettingsPath, [string]$ExpectedTheme)
  if (-not (Test-Path -LiteralPath $SettingsPath)) {
    throw "Theme settings were not created at $SettingsPath"
  }
  $settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
  if ($settings.theme -ne $ExpectedTheme) {
    throw "Expected persisted theme '$ExpectedTheme', found '$($settings.theme)' at $SettingsPath"
  }
  return [pscustomobject]@{ SettingsPath = $SettingsPath; Theme = $settings.theme }
}

$packagedExecutable = Join-Path $distPath 'win-unpacked\CornerLyrics.exe'
$packagedData = Join-Path $RunRoot 'packaged-data'
$packagedTemp = Join-Path $RunRoot 'packaged-temp'
Start-SmokeApp -Executable $packagedExecutable -Port 9333 -DataDirectory $packagedData -TempDirectory $packagedTemp -Label 'packaged'
$packagedSettings = Assert-PersistedTheme -SettingsPath (Join-Path $packagedData 'CornerLyrics Data\settings.json') -ExpectedTheme 'sunset'
Start-SmokeApp -Executable $packagedExecutable -Port 9333 -DataDirectory $packagedData -TempDirectory $packagedTemp -Label 'packaged-restart' -ExpectedTheme 'sunset'

$portableDirectory = Join-Path $RunRoot 'portable'
$portableTemp = Join-Path $RunRoot 'portable-temp'
New-Item -ItemType Directory -Path $portableDirectory -Force | Out-Null
$portableExecutable = Join-Path $portableDirectory 'CornerLyrics 1.0.3 Portable.exe'
Copy-Item -LiteralPath (Join-Path $distPath 'CornerLyrics 1.0.3 Portable.exe') -Destination $portableExecutable
Start-SmokeApp -Executable $portableExecutable -Port 9334 -DataDirectory $null -TempDirectory $portableTemp -Label 'portable'
$portableSettings = Assert-PersistedTheme -SettingsPath (Join-Path $portableDirectory 'CornerLyrics Data\settings.json') -ExpectedTheme 'sunset'
Start-SmokeApp -Executable $portableExecutable -Port 9334 -DataDirectory $null -TempDirectory $portableTemp -Label 'portable-restart' -ExpectedTheme 'sunset'

$summary = [pscustomobject]@{
  CheckedAt = Get-Date
  Workspace = $workspacePath
  RunRoot = $RunRoot
  Packaged = $packagedSettings
  Portable = $portableSettings
  Reports = @(
    (Join-Path $artifactsPath 'packaged-smoke.json'),
    (Join-Path $artifactsPath 'packaged-restart-smoke.json'),
    (Join-Path $artifactsPath 'portable-smoke.json'),
    (Join-Path $artifactsPath 'portable-restart-smoke.json')
  )
}
New-Item -ItemType Directory -Path $artifactsPath -Force | Out-Null
$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifactsPath 'windows-smoke-summary.json') -Encoding UTF8
$summary | ConvertTo-Json -Depth 4

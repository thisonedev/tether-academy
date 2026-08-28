#!/usr/bin/env pwsh
# Bootstraps `tether-academy` on a machine with nothing installed yet.
#
#   irm https://tetheracademy.cc/install.ps1 | iex
#
# Only job: get Node running against a checkout so apps/cli/src/install.js
# (the actual install logic) can take over from there. Windows counterpart
# of install.sh; keep both in sync.

$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:TETHER_ACADEMY_REPO) { $env:TETHER_ACADEMY_REPO } else { 'https://github.com/thisonedev/tether-academy.git' }
$Branch = if ($env:TETHER_ACADEMY_BRANCH) { $env:TETHER_ACADEMY_BRANCH } else { 'master' }

function Need($Command, $Hint) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    Write-Error "tether-academy install requires $Command ($Hint)"
    exit 1
  }
}

Need git 'https://git-scm.com'
Need node 'https://nodejs.org'

# npm ships with node, so pnpm is safe to self-heal; git/node stay hard
# requirements. npm.cmd, not bare npm: PowerShell resolves that to
# npm.ps1, which the default Restricted execution policy blocks.
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "-> Installing pnpm..."
  npm.cmd install -g pnpm
  # npm doesn't touch the registry PATH itself; it assumes the global prefix
  # is already on it, which only holds if something else put it there. Ask
  # npm directly where it just put pnpm's shim and prepend that instead.
  $npmPrefix = (npm.cmd config get prefix -g).Trim()
  if ($npmPrefix -and (Test-Path $npmPrefix) -and ($env:Path -notlike "*$npmPrefix*")) {
    $env:Path = "$npmPrefix;$env:Path"
  }
}

# Mic lessons spawn ffmpeg directly and it's never bundled, so self-heal it
# like pnpm above rather than a hard Need() (no install-ffmpeg.exe to point
# users at). Confined to the user's own profile: unlike provision.ps1, this
# script never runs elevated.
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "-> Installing ffmpeg..."
  $FfmpegDest = Join-Path $env:LOCALAPPDATA 'tether-academy\ffmpeg'
  try {
    $FfmpegWork = Join-Path ([System.IO.Path]::GetTempPath()) "tether-academy-ffmpeg-$([System.IO.Path]::GetRandomFileName())"
    New-Item -ItemType Directory -Path $FfmpegWork | Out-Null
    $FfZip = Join-Path $FfmpegWork 'ffmpeg.zip'
    Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $FfZip -UseBasicParsing
    Expand-Archive -Path $FfZip -DestinationPath $FfmpegWork -Force
    $FfBinSrc = Get-ChildItem -Path $FfmpegWork -Recurse -Directory -Filter 'bin' | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $FfmpegDest | Out-Null
    Copy-Item -Path (Join-Path $FfBinSrc.FullName '*') -Destination $FfmpegDest -Force
    Remove-Item -Recurse -Force $FfmpegWork -ErrorAction SilentlyContinue
    # Confirm the extracted binary actually runs before trusting it on PATH;
    # a truncated download or a zip layout change should fail loudly here,
    # not resurface later as a confusing mic-lesson error.
    & (Join-Path $FfmpegDest 'ffmpeg.exe') -version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg.exe -version exited $LASTEXITCODE" }
    $UserPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if ($UserPath -notlike "*$FfmpegDest*") {
      [System.Environment]::SetEnvironmentVariable('Path', "$UserPath;$FfmpegDest", 'User')
    }
    $env:Path = "$env:Path;$FfmpegDest"
  } catch {
    Write-Error "ffmpeg install failed: $($_.Exception.Message). Install it manually from https://www.gyan.dev/ffmpeg/builds/ (essentials build) and put it on PATH, then retry."
    exit 1
  }
}

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "tether-academy-bootstrap-$([System.IO.Path]::GetRandomFileName())"
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
  Write-Host "-> Fetching installer from $RepoUrl ($Branch)..."
  git clone --quiet --depth 1 --branch $Branch $RepoUrl $TmpDir

  # bootstrap-install.js skips cli.js/paparam (see that file for why).
  node (Join-Path $TmpDir 'apps\cli\bin\bootstrap-install.js')

  # install.js only prints a setx suggestion: setx persists to the registry
  # but can't reach this already-running session, and this is the one place
  # in the whole flow that runs in-process in the user's real shell (via iex)
  # instead of a child process, so it's the only place that actually can.
  $ShimDir = Join-Path $env:LOCALAPPDATA 'tether-academy\bin'
  $UserPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  if ($UserPath -notlike "*$ShimDir*") {
    [System.Environment]::SetEnvironmentVariable('Path', "$UserPath;$ShimDir", 'User')
  }
  if ($env:Path -notlike "*$ShimDir*") {
    $env:Path = "$env:Path;$ShimDir"
    Write-Host "-> Added $ShimDir to your PATH"
  }
} finally {
  Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

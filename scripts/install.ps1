# Installs the Episteme desktop program on Windows from the latest GitHub release.
#
#   irm https://raw.githubusercontent.com/Jiarong-Song233/Episteme/main/scripts/install.ps1 | iex
#
# It downloads the installer and SHA256SUMS from the same release, refuses to run an installer whose checksum does
# not match, and installs for the current user only (no administrator prompt). It changes nothing else: connecting
# an agent is a separate, explicit step (set EPISTEME_CONNECT=claude,codex before running, or use the program's
# "接入 Agent" page afterwards).
#
# EPISTEME_VERSION=v0.2.0 picks a release instead of the latest one.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'Jiarong-Song233/Episteme'
$mcp = 'http://127.0.0.1:4322/mcp'

function Say($text) { Write-Host "episteme: $text" }

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
  throw "episteme: only 64-bit x86 Windows has an installer so far (this is $env:PROCESSOR_ARCHITECTURE)."
}

$tag = $env:EPISTEME_VERSION
$api = if ($tag) { "https://api.github.com/repos/$repo/releases/tags/$tag" } else { "https://api.github.com/repos/$repo/releases/latest" }
try {
  $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'episteme-install' }
} catch {
  throw "episteme: no published release found at $api. Releases may not be published yet; see https://github.com/$repo/releases"
}

$installer = $release.assets | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1
$sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
if (-not $installer -or -not $sums) {
  throw "episteme: release $($release.tag_name) has no Windows installer or no SHA256SUMS."
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("episteme-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $exe = Join-Path $work $installer.name
  Say "downloading $($installer.name) from $($release.tag_name)"
  Invoke-WebRequest -Uri $installer.browser_download_url -OutFile $exe -UseBasicParsing
  $sumsText = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing).Content
  if ($sumsText -is [byte[]]) { $sumsText = [Text.Encoding]::UTF8.GetString($sumsText) }

  $expected = $null
  foreach ($line in $sumsText -split "`n") {
    $parts = $line.Trim() -split '\s+\*?', 2
    if ($parts.Count -eq 2 -and $parts[1] -eq $installer.name) { $expected = $parts[0].ToLowerInvariant() }
  }
  if (-not $expected) { throw "episteme: SHA256SUMS does not list $($installer.name)." }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "episteme: checksum mismatch for $($installer.name); nothing was installed." }
  Say 'checksum matches'

  Say 'installing (current user)'
  $process = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "episteme: the installer exited with $($process.ExitCode)." }
} finally {
  Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}

$program = Join-Path $env:LOCALAPPDATA 'Episteme\episteme-desktop.exe'
if (-not (Test-Path $program)) { $program = Join-Path $env:LOCALAPPDATA 'Programs\Episteme\episteme-desktop.exe' }
Say 'installed. Open "Episteme" from the Start menu; it keeps running in the tray when its window is closed.'

$connect = @()
if ($env:EPISTEME_CONNECT) { $connect = $env:EPISTEME_CONNECT -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } }
if ($connect -contains 'claude') {
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    & claude mcp add --transport http --scope user episteme $mcp
    Say 'connected Claude Code'
  } else { Say 'Claude Code (claude) is not on PATH; skipped' }
}
if ($connect -contains 'codex') {
  if (Get-Command codex -ErrorAction SilentlyContinue) {
    & codex mcp add episteme --url $mcp
    Say 'connected Codex'
  } else { Say 'Codex (codex) is not on PATH; skipped' }
}
if ($connect.Count -eq 0) {
  Say "to connect an agent later, open the program's 接入 Agent page, or run:"
  Write-Host "  claude mcp add --transport http --scope user episteme $mcp"
  Write-Host "  codex mcp add episteme --url $mcp"
}
if (Test-Path $program) {
  Start-Process -FilePath $program
  Say 'started Episteme'
}

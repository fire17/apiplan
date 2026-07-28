# apiplan installer — Windows (PowerShell 5.1+ / pwsh 7+).
#
# One line on a brand-new machine:
#   irm https://raw.githubusercontent.com/fire17/apiplan/main/install.ps1 | iex
#
# Or from a checkout:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Works both ways: piped from irm it clones itself to ~\.apiplan\src first.
# Re-running it updates in place. Installs one .cmd + .ps1 per command so the
# tools work from cmd.exe, PowerShell and Windows Terminal alike.
$ErrorActionPreference = "Stop"

$repo = if ($env:APIPLAN_REPO) { $env:APIPLAN_REPO } else { "https://github.com/fire17/apiplan.git" }
$src  = if ($env:APIPLAN_SRC)  { $env:APIPLAN_SRC }  else { Join-Path $HOME ".apiplan\src" }

# ---- find the source: this checkout, or clone/update one ---------------------
$root = $null
if ($PSCommandPath) {
  $here = Split-Path -Parent $PSCommandPath
  if ($here -and (Test-Path (Join-Path $here "bin\apiplan.ts"))) { $root = $here }
}
if (-not $root) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "apiplan: git is required to bootstrap. Install it, or clone the repo yourself."
    exit 1
  }
  if (Test-Path (Join-Path $src ".git")) {
    Write-Host "updating $src"
    git -C $src pull --ff-only -q 2>$null
  } else {
    Write-Host "fetching apiplan into $src"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $src) | Out-Null
    git clone -q --depth 1 $repo $src
  }
  $root = $src
}

# ---- runtime ----------------------------------------------------------------
$bun = $null
if (Get-Command bun -ErrorAction SilentlyContinue) { $bun = (Get-Command bun).Source }
elseif (Test-Path "$HOME\.bun\bin\bun.exe") { $bun = "$HOME\.bun\bin\bun.exe" }
if (-not $bun) {
  Write-Host "apiplan needs bun (one binary, no admin required)."
  $ok = $true
  if ([Environment]::UserInteractive -and $env:APIPLAN_ASSUME_YES -ne "1") {
    $a = Read-Host "install it now? [Y/n]"
    if ($a -match '^[Nn]') { $ok = $false }
  }
  if (-not $ok) { Write-Host "aborted - see https://bun.sh"; exit 1 }
  irm bun.sh/install.ps1 | iex
  $bun = "$HOME\.bun\bin\bun.exe"
  if (-not (Test-Path $bun)) { Write-Error "bun install failed; see https://bun.sh"; exit 1 }
}
Write-Host "runtime: bun $(& $bun --version) at $bun"

# ---- install the commands ---------------------------------------------------
& $bun (Join-Path $root "bin\apiplan.ts") install @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ---- PATH -------------------------------------------------------------------
# Ask the tool where it put things, so there is one source of truth.
$binLine = & $bun (Join-Path $root "bin\apiplan.ts") path
$binDir = ($binLine -replace '^\$env:PATH = "', '') -replace ';\$env:PATH"$', ''

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
  Write-Host ""
  Write-Host "$binDir is not on your PATH."
  $add = $true
  if ([Environment]::UserInteractive -and $env:APIPLAN_ASSUME_YES -ne "1") {
    $b = Read-Host "add it permanently for this user? [Y/n]"
    if ($b -match '^[Nn]') { $add = $false }
  }
  if ($add) {
    [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
    $env:PATH = "$binDir;$env:PATH"
    Write-Host "added — new terminals will see it, and this one already does."
  } else {
    Write-Host "skipped. Add it yourself with:"
    Write-Host "  `$env:PATH = `"$binDir;`$env:PATH`""
  }
}

Write-Host ""
Write-Host "Done. PowerShell and cmd.exe pass ? and * through literally, so a bare"
Write-Host "sentence needs no quotes:"
Write-Host ""
Write-Host "  opus explain monads in one sentence"
Write-Host "  apiplan            # dashboard: providers, models, commands"
Write-Host "  apiplan doctor     # check PATH, logins, daemon"
Write-Host "  apiplan update     # pull the latest and re-sync"
Write-Host ""
Write-Host "You need to be logged into 'claude' and/or 'codex' - apiplan never asks for a key."

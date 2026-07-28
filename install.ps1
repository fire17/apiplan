# apiplan installer — Windows (PowerShell 5.1+ / pwsh 7+).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Installs one .cmd + .ps1 per model command so they work from cmd.exe, PowerShell
# and Windows Terminal alike. Everything here is also `apiplan install` / `apiplan sync`.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- runtime ----------------------------------------------------------------
$bun = $null
if (Get-Command bun -ErrorAction SilentlyContinue) { $bun = (Get-Command bun).Source }
elseif (Test-Path "$HOME\.bun\bin\bun.exe") { $bun = "$HOME\.bun\bin\bun.exe" }
if (-not $bun) {
  Write-Host "apiplan needs bun (a single binary, no admin required)."
  $a = Read-Host "install it now? [Y/n]"
  if ($a -match '^[Nn]') { Write-Host "aborted - see https://bun.sh"; exit 1 }
  irm bun.sh/install.ps1 | iex
  $bun = "$HOME\.bun\bin\bun.exe"
  if (-not (Test-Path $bun)) { Write-Error "bun install failed; see https://bun.sh"; exit 1 }
}
Write-Host "runtime: $(& $bun --version) at $bun"

# ---- install commands -------------------------------------------------------
& $bun "$here\bin\apiplan.ts" install @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ---- PATH -------------------------------------------------------------------
# Read the bin dir from the tool itself so there is one source of truth.
$binLine = & $bun "$here\bin\apiplan.ts" path
$binDir = ($binLine -replace '^\$env:PATH = "', '') -replace ';\$env:PATH"$', ''

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
  Write-Host ""
  Write-Host "$binDir is not on your PATH."
  $b = Read-Host "add it permanently for this user? [Y/n]"
  if ($b -notmatch '^[Nn]') {
    [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
    $env:PATH = "$binDir;$env:PATH"
    Write-Host "added. New terminals will see it; this one already does."
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
Write-Host "  apiplan            # dashboard"
Write-Host "  apiplan doctor     # check everything"

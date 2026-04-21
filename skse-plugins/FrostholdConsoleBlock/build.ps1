# build.ps1 — Konfiguriert & kompiliert das FrostholdConsoleBlock-SKSE-Plugin
# und kopiert die fertige DLL optional ins Skyrim Data-Verzeichnis.
#
# Voraussetzungen:
#   - Visual Studio 2022 (MSVC v143) installiert.
#   - CMake ≥ 3.25 in PATH.
#   - Frosthold-eigenes vcpkg unter Frosthold\vcpkg (relativ zum Repo-Root).
#   - Skyrim SE AE 1.6.1170+ installiert; der Default-Pfad entspricht dem
#     Standard-Steam-Ordner. Mit -Deploy kopiert das Script die DLL dorthin.
#
# Beispiele:
#   .\build.ps1                      # baut Release, kein Auto-Deploy
#   .\build.ps1 -Deploy              # baut Release und kopiert DLL+TOML
#   .\build.ps1 -Deploy -Clean       # Clean-Build

[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Deploy,
    [string]$SkyrimData = "C:\Program Files (x86)\Steam\steamapps\common\Skyrim Special Edition\Data"
)

# CMake schreibt viele Fortschritts-Meldungen auf Stderr. Mit
# ErrorActionPreference=Stop würde PowerShell die als fatale Fehler
# interpretieren und den Build abbrechen, obwohl der Exit-Code 0 ist.
# Wir nutzen 'Continue' und prüfen $LASTEXITCODE explizit.
$ErrorActionPreference = 'Continue'

function Write-Step([string]$msg) {
    Write-Host "[build] $msg" -ForegroundColor Cyan
}

function Invoke-Native {
    param([Parameter(Mandatory, ValueFromRemainingArguments)] [string[]]$Args)
    & $Args[0] @($Args | Select-Object -Skip 1) 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $($Args -join ' ')"
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$vcpkgRoot = Join-Path $repoRoot 'Frosthold\vcpkg'

if (-not (Test-Path (Join-Path $vcpkgRoot 'vcpkg.exe'))) {
    Write-Error "vcpkg not found at $vcpkgRoot. Bootstrap it with `bootstrap-vcpkg.bat` first."
}

$env:VCPKG_ROOT = $vcpkgRoot
Write-Step "Using VCPKG_ROOT=$env:VCPKG_ROOT"

Push-Location $scriptDir
try {
    if ($Clean -and (Test-Path build)) {
        Write-Step "Clean: removing build/"
        Remove-Item -Recurse -Force build
    }

    $preset = if ($Deploy) { 'release-deploy' } else { 'release' }

    Write-Step "Configure ($preset)"
    $cfgArgs = @('--preset', $preset)
    if ($Deploy) {
        $cfgArgs += @('-DSKYRIM_DATA_DIR=' + $SkyrimData)
    }
    Invoke-Native 'cmake' @cfgArgs

    Write-Step "Build Release"
    Invoke-Native 'cmake' '--build' '--preset' $preset '--config' 'Release'

    $dll = Get-ChildItem -Path build\Release -Filter 'FrostholdConsoleBlock.dll' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $dll) {
        $dll = Get-ChildItem -Path build -Filter 'FrostholdConsoleBlock.dll' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $dll) { throw "Build produced no DLL." }
    Write-Step "Built: $($dll.FullName)  ($([math]::Round($dll.Length/1KB,1)) KB)"

    if ($Deploy) {
        $target = Join-Path $SkyrimData 'SKSE\Plugins'
        if (-not (Test-Path $target)) {
            New-Item -ItemType Directory -Force -Path $target | Out-Null
        }
        Write-Step "Deploying to $target"
        Copy-Item -Force $dll.FullName (Join-Path $target 'FrostholdConsoleBlock.dll')
        Copy-Item -Force (Join-Path $scriptDir 'FrostholdConsoleBlock.toml') (Join-Path $target 'FrostholdConsoleBlock.toml')
        Write-Step "Deployed."
    } else {
        Write-Step "Run with -Deploy to copy into Skyrim Data."
    }
}
finally {
    Pop-Location
}

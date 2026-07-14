[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$OutputDirectory = "src-tauri/target/release/bundle/store"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Resolve-MakeAppx {
    $sdkBin = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $candidates = @(Get-ChildItem -LiteralPath $sdkBin -Directory -ErrorAction Stop |
        ForEach-Object {
            $tool = Join-Path $_.FullName "x64\makeappx.exe"
            if (Test-Path -LiteralPath $tool) {
                [PSCustomObject]@{ Version = [version]$_.Name; Path = $tool }
            }
        } |
        Sort-Object Version -Descending)
    if ($candidates.Count -eq 0) {
        throw "makeappx.exe was not found. Install the Windows 10/11 SDK packaging tools."
    }
    return $candidates[0].Path
}

function Convert-ToStoreVersion {
    param([Parameter(Mandatory = $true)][string]$Version)

    if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        throw "Tauri version '$Version' must use major.minor.patch format."
    }

    # Store package versions cannot start with zero. Offset the SemVer major by
    # one so pre-1.0 releases remain ordered and a future 1.0.0 maps to 2.0.0.0.
    $parts = @(([int]$Matches[1] + 1), [int]$Matches[2], [int]$Matches[3], 0)
    foreach ($part in $parts) {
        if ($part -lt 0 -or $part -gt 65535) {
            throw "Store package version component '$part' is outside 0..65535."
        }
    }
    return ($parts -join '.')
}

$config = Get-Content -LiteralPath "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$storeVersion = Convert-ToStoreVersion -Version ([string]$config.version)
$makeAppx = Resolve-MakeAppx

if (-not $SkipBuild) {
    & npm run tauri -- build --no-bundle --ci -- --locked
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri release build failed with exit code $LASTEXITCODE."
    }
}

$releaseRoot = Join-Path $repoRoot "src-tauri\target\release"
$exeSource = Join-Path $releaseRoot "onyx.exe"
$nativeRoot = Join-Path $repoRoot "src-tauri\lib"
$manifestTemplate = Join-Path $repoRoot "store\AppxManifest.xml"
$stagingRoot = Join-Path $repoRoot "src-tauri\target\store-staging"
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))

foreach ($required in @(
    $exeSource,
    (Join-Path $nativeRoot "libmpv-2.dll"),
    (Join-Path $nativeRoot "libmpv-wrapper.dll"),
    $manifestTemplate
)) {
    $item = Get-Item -LiteralPath $required -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -le 0) {
        throw "Required Store payload file is empty: $required"
    }
}

if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot "lib") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot "Assets") | Out-Null
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

Copy-Item -LiteralPath $exeSource -Destination (Join-Path $stagingRoot "Onyx.exe")
Copy-Item -LiteralPath (Join-Path $nativeRoot "libmpv-2.dll") -Destination (Join-Path $stagingRoot "lib\libmpv-2.dll")
Copy-Item -LiteralPath (Join-Path $nativeRoot "libmpv-wrapper.dll") -Destination (Join-Path $stagingRoot "lib\libmpv-wrapper.dll")

foreach ($asset in @("StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png")) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "src-tauri\icons\$asset") -Destination (Join-Path $stagingRoot "Assets\$asset")
}

$manifest = (Get-Content -LiteralPath $manifestTemplate -Raw).Replace("__PACKAGE_VERSION__", $storeVersion)
$manifestPath = Join-Path $stagingRoot "AppxManifest.xml"
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))

$msixName = "Onyx-IPTV_$($storeVersion)_x64.msix"
$msixPath = Join-Path $outputRoot $msixName
if (Test-Path -LiteralPath $msixPath) {
    Remove-Item -LiteralPath $msixPath -Force
}

& $makeAppx pack /d $stagingRoot /p $msixPath /o /v
if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx failed with exit code $LASTEXITCODE."
}

$msix = Get-Item -LiteralPath $msixPath
if ($msix.Length -le 0) {
    throw "Store package was created but is empty."
}

$hash = (Get-FileHash -LiteralPath $msixPath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = Join-Path $outputRoot "SHA256SUMS"
[System.IO.File]::WriteAllText($checksumPath, "$hash  $msixName`n", [System.Text.UTF8Encoding]::new($false))

Write-Host "Store MSIX created successfully."
Write-Host "App version: $($config.version)"
Write-Host "Store package version: $storeVersion"
Write-Host "Package: $msixPath"
Write-Host "SHA256: $hash"

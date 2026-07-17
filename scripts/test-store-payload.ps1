[CmdletBinding()]
param(
    [string]$StagingRoot = "src-tauri/target/store-staging"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$stage = if ([System.IO.Path]::IsPathRooted($StagingRoot)) {
    [System.IO.Path]::GetFullPath($StagingRoot)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repoRoot $StagingRoot))
}
$manifestPath = Join-Path $stage "AppxManifest.xml"

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Store staging manifest is missing: $manifestPath"
}

foreach ($name in @("Onyx.exe", "libmpv-wrapper.dll", "libmpv-2.dll", "vulkan-1.dll")) {
    $path = Join-Path $stage $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Store payload must place $name beside Onyx.exe so packaged native dependency loading is self-contained."
    }
    if ((Get-Item -LiteralPath $path).Length -le 0) {
        throw "Store payload contains an empty $name."
    }
}

$nestedNativeDlls = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
    $_.DirectoryName -ne $stage -and $_.Name -in @("libmpv-wrapper.dll", "libmpv-2.dll", "vulkan-1.dll")
})
if ($nestedNativeDlls.Count -gt 0) {
    throw "Store native playback DLLs must not be nested below the executable directory."
}

[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$dependencies = @($manifest.Package.Dependencies.PackageDependency)
$vcRuntime = @($dependencies | Where-Object { $_.Name -eq "Microsoft.VCLibs.140.00.UWPDesktop" })
if ($vcRuntime.Count -ne 1) {
    throw "Store manifest must declare exactly one Microsoft.VCLibs.140.00.UWPDesktop dependency."
}
if ([string]::IsNullOrWhiteSpace([string]$vcRuntime[0].Publisher) -or [string]::IsNullOrWhiteSpace([string]$vcRuntime[0].MinVersion)) {
    throw "The Microsoft Visual C++ runtime dependency must pin its publisher and minimum version."
}

$legacyTauriTileHashes = @{
    "StoreLogo.png" = "91a54024dd47230991546088f2e75d3e3199b3ccc9fe40f3f6b7d3bf1cbf7776"
    "Square44x44Logo.png" = "10be9840e58fb018eb9029601d42008e16c0c9cfa66b8f9467fee94f600160d4"
    "Square150x150Logo.png" = "65fb570cb0e61ffce02ad67784cb200a0bf058400300980a46fa0d0c8f43a77a"
}
foreach ($entry in $legacyTauriTileHashes.GetEnumerator()) {
    $sourceLogo = Join-Path $repoRoot "src-tauri\icons\$($entry.Key)"
    $stagedLogo = Join-Path $stage "Assets\$($entry.Key)"
    foreach ($logo in @($sourceLogo, $stagedLogo)) {
        if (-not (Test-Path -LiteralPath $logo -PathType Leaf) -or (Get-Item -LiteralPath $logo).Length -le 0) {
            throw "Store payload icon is missing or empty: $logo"
        }
    }

    $sourceHash = (Get-FileHash -LiteralPath $sourceLogo -Algorithm SHA256).Hash.ToLowerInvariant()
    $stagedHash = (Get-FileHash -LiteralPath $stagedLogo -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHash -ne $stagedHash) {
        throw "Store payload icon does not match the reviewed Onyx source asset: $($entry.Key)"
    }
    if ($stagedHash -eq $entry.Value) {
        throw "Store payload still contains the rejected default Tauri tile asset: $($entry.Key)"
    }
}

Write-Host "Store payload native dependency and original-icon regression checks passed."

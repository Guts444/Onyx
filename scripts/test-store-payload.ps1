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

Write-Host "Store payload native dependency regression check passed."

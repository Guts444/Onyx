[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )

    Write-Host "`n==> $Label"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

function Get-SingleArtifact {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Filter,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $files = @(Get-ChildItem -LiteralPath $Directory -Filter $Filter -File -Recurse -ErrorAction Stop)
    if ($files.Count -ne 1) {
        throw "Expected exactly one $Label artifact in '$Directory', found $($files.Count)."
    }
    if ($files[0].Length -le 0) {
        throw "$Label artifact '$($files[0].FullName)' is empty."
    }
    return $files[0]
}

$package = Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json
$version = [string]$package.version
Invoke-Checked "Verify release metadata for $version" {
    python scripts/verify-release-version.py $version
}

& (Join-Path $PSScriptRoot "check-toolchain.ps1")
& (Join-Path $PSScriptRoot "verify-native-deps.ps1")

$bundleRoot = Join-Path $repoRoot "src-tauri\target\release\bundle"
foreach ($directory in @("msi", "nsis", "store")) {
    $path = Join-Path $bundleRoot $directory
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

Invoke-Checked "Build locked MSI and NSIS installers" {
    npm run tauri -- build --bundles msi,nsis --ci -- --locked
}

Write-Host "`n==> Build Microsoft Store MSIX"
& (Join-Path $PSScriptRoot "build-store-msix.ps1") -SkipBuild
& (Join-Path $PSScriptRoot "test-store-payload.ps1")

$msi = Get-SingleArtifact -Directory (Join-Path $bundleRoot "msi") -Filter "*.msi" -Label "MSI"
$nsis = Get-SingleArtifact -Directory (Join-Path $bundleRoot "nsis") -Filter "*.exe" -Label "NSIS"
$msix = Get-SingleArtifact -Directory (Join-Path $bundleRoot "store") -Filter "*.msix" -Label "Store MSIX"

# The public GitHub checksum manifest covers the two public standalone
# installers. The Store helper writes a separate checksum beside the unsigned
# Partner Center MSIX so GitHub never advertises a checksum for an absent asset.
$checksumPath = Join-Path $bundleRoot "SHA256SUMS"
$checksumLines = foreach ($file in @($msi, $nsis) | Sort-Object Name) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($file.Name)"
}
[System.IO.File]::WriteAllText(
    $checksumPath,
    (($checksumLines -join "`n") + "`n"),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "`nOnyx $version release artifacts created successfully:"
Write-Host "  MSI:   $($msi.FullName)"
Write-Host "  NSIS:  $($nsis.FullName)"
Write-Host "  MSIX:  $($msix.FullName)"
Write-Host "  SHA256: $checksumPath"

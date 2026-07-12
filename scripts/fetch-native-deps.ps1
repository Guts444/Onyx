[CmdletBinding()]
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = Split-Path -Parent $PSScriptRoot
$libDir = Join-Path $repoRoot "src-tauri\lib"
$sourcesPath = Join-Path $libDir "SOURCES.md"
$sumsPath = Join-Path $libDir "SHA256SUMS"
$verifierPath = Join-Path $PSScriptRoot "verify-native-deps.ps1"

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Description) {
    if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Invalid pinned SHA-256 for $Description."
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "$Description failed SHA-256 verification (expected $Expected, got $actual)."
    }
}

function Assert-PeX64([string]$Path, [string]$Description) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $reader = New-Object IO.BinaryReader($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "$Description is missing the PE MZ header." }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        if ($peOffset -gt ($stream.Length - 6)) { throw "$Description has an invalid PE header offset." }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "$Description has an invalid PE signature." }
        if ($reader.ReadUInt16() -ne 0x8664) { throw "$Description is not Windows x86-64 (PE machine 0x8664)." }
    } finally {
        $stream.Dispose()
    }
}

function Get-Manifest {
    $manifest = @{}
    foreach ($line in Get-Content -LiteralPath $sumsPath) {
        if ($line -match '^([0-9a-fA-F]{64})\s+([^\s]+)$') {
            $manifest[$Matches[2]] = $Matches[1].ToLowerInvariant()
        } elseif ($line.Trim()) {
            throw "Malformed SHA256SUMS line."
        }
    }
    if ($manifest.Count -ne 2 -or -not $manifest.ContainsKey("libmpv-2.dll") -or -not $manifest.ContainsKey("libmpv-wrapper.dll")) {
        throw "SHA256SUMS must pin exactly libmpv-2.dll and libmpv-wrapper.dll."
    }
    return $manifest
}

function Find-OneDll([string]$Root, [string]$Name) {
    $matches = @(Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object { $_.Name -ieq $Name })
    if ($matches.Count -ne 1) {
        throw "Expected exactly one $Name after extraction; found $($matches.Count)."
    }
    return $matches[0].FullName
}

if (-not (Test-Path -LiteralPath $sourcesPath -PathType Leaf) -or -not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) {
    throw "Native dependency provenance manifests are missing."
}

$manifest = Get-Manifest
if (-not $Force) {
    $allValid = $true
    foreach ($name in $manifest.Keys) {
        $path = Join-Path $libDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $allValid = $false; break }
        try {
            Assert-Sha256 $path $manifest[$name] $name
            Assert-PeX64 $path $name
        } catch {
            $allValid = $false
            break
        }
    }
    if ($allValid) {
        Write-Host "Pinned native DLLs are already installed and verified; no download needed."
        & $verifierPath
        exit 0
    }
}

$sources = Get-Content -LiteralPath $sourcesPath -Raw
$archiveHashes = [Regex]::Matches($sources, '(?m)^- Upstream archive SHA-256: `([0-9a-fA-F]{64})`$')
if ($archiveHashes.Count -ne 2) { throw "SOURCES.md must contain exactly two upstream archive hashes." }
$wrapperArchiveHash = $archiveHashes[0].Groups[1].Value

# The second fixed URL belongs to mpv. Parse all fixed URLs to avoid accepting a moving endpoint.
$urlMatches = [Regex]::Matches($sources, '(?m)^- Fixed release URL: <(https://[^>]+)>$')
if ($urlMatches.Count -ne 2) { throw "SOURCES.md must contain exactly two fixed HTTPS release URLs." }
$wrapperUrl = $urlMatches[0].Groups[1].Value
$mpvUrl = $urlMatches[1].Groups[1].Value
$mpvArchiveHash = $archiveHashes[1].Groups[1].Value
foreach ($url in @($wrapperUrl, $mpvUrl)) {
    if ($url -notmatch '^https://github\.com/[^/]+/[^/]+/releases/download/[^/]+/[^/?#]+$' -or $url -match '/latest/') {
        throw "Native source is not an immutable GitHub release asset URL: $url"
    }
}

$sevenZip = Get-Command "7z.exe" -ErrorAction SilentlyContinue
if (-not $sevenZip) { $sevenZip = Get-Command "7z" -ErrorAction SilentlyContinue }
if (-not $sevenZip -and (Test-Path -LiteralPath "C:\Program Files\7-Zip\7z.exe")) {
    $sevenZip = Get-Item -LiteralPath "C:\Program Files\7-Zip\7z.exe"
}
if (-not $sevenZip) {
    throw "7-Zip is required to extract the pinned mpv .7z archive. Install 7-Zip or use a GitHub Windows runner where 7z is preinstalled."
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("onyx-native-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    $wrapperArchive = Join-Path $tempRoot "libmpv-wrapper.zip"
    $mpvArchive = Join-Path $tempRoot "mpv.7z"
    Invoke-WebRequest -Uri $wrapperUrl -OutFile $wrapperArchive -MaximumRedirection 5 -TimeoutSec 180 -UseBasicParsing
    Invoke-WebRequest -Uri $mpvUrl -OutFile $mpvArchive -MaximumRedirection 5 -TimeoutSec 180 -UseBasicParsing
    Assert-Sha256 $wrapperArchive $wrapperArchiveHash "libmpv-wrapper archive"
    Assert-Sha256 $mpvArchive $mpvArchiveHash "mpv archive"

    $wrapperExtract = Join-Path $tempRoot "wrapper"
    $mpvExtract = Join-Path $tempRoot "mpv"
    Expand-Archive -LiteralPath $wrapperArchive -DestinationPath $wrapperExtract
    New-Item -ItemType Directory -Path $mpvExtract | Out-Null
    & $sevenZip.Source x $mpvArchive "-o$mpvExtract" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7-Zip extraction failed with exit code $LASTEXITCODE." }

    $candidates = @{
        "libmpv-wrapper.dll" = Find-OneDll $wrapperExtract "libmpv-wrapper.dll"
        "libmpv-2.dll" = Find-OneDll $mpvExtract "libmpv-2.dll"
    }
    foreach ($name in $candidates.Keys) {
        Assert-Sha256 $candidates[$name] $manifest[$name] "extracted $name"
        Assert-PeX64 $candidates[$name] "extracted $name"
    }

    New-Item -ItemType Directory -Force -Path $libDir | Out-Null
    foreach ($name in @("libmpv-2.dll", "libmpv-wrapper.dll")) {
        $incoming = Join-Path $libDir (".$name.incoming." + [Guid]::NewGuid().ToString("N"))
        Copy-Item -LiteralPath $candidates[$name] -Destination $incoming
        try {
            Move-Item -LiteralPath $incoming -Destination (Join-Path $libDir $name) -Force
        } finally {
            Remove-Item -LiteralPath $incoming -Force -ErrorAction SilentlyContinue
        }
    }
    & $verifierPath
    Write-Host "Fetched and atomically installed pinned native dependencies."
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

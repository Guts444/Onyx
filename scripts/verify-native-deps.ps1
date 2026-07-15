[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$libDir = Join-Path $repoRoot "src-tauri\lib"
$sumFile = Join-Path $libDir "SHA256SUMS"

if (-not (Test-Path -LiteralPath $sumFile -PathType Leaf)) {
    throw "Native dependency manifest is missing: $sumFile"
}

$expectedNames = @("libmpv-2.dll", "libmpv-wrapper.dll", "vulkan-1.dll")
$manifest = @{}
foreach ($line in Get-Content -LiteralPath $sumFile) {
    if ($line -match '^([0-9a-fA-F]{64})\s+(.+)$') {
        $manifest[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
    } elseif ($line.Trim()) {
        throw "Malformed SHA256SUMS line: $line"
    }
}

if ($manifest.Count -ne $expectedNames.Count) {
    throw "SHA256SUMS must contain exactly the three packaged native DLLs."
}

foreach ($name in $expectedNames) {
    if (-not $manifest.ContainsKey($name)) {
        throw "SHA256SUMS does not contain $name."
    }

    $path = Join-Path $libDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required native dependency is missing: $path"
    }

    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $manifest[$name]) {
        throw "$name failed SHA-256 verification. Expected $($manifest[$name]), got $actualHash."
    }

    $stream = [System.IO.File]::OpenRead($path)
    try {
        $reader = New-Object System.IO.BinaryReader($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "$name is not a PE file (missing MZ header)." }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "$name is not a valid PE file." }
        $machine = $reader.ReadUInt16()
        if ($machine -ne 0x8664) {
            throw "$name has PE machine 0x$($machine.ToString('X4')); x86-64 (0x8664) is required."
        }
    } finally {
        $stream.Dispose()
    }

    Write-Host "Verified $name ($actualHash, PE x86-64)."
}

Write-Host "Native dependency verification passed. See src-tauri/lib/SOURCES.md for provenance and release-blocker status."

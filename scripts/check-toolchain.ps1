[CmdletBinding()]
param(
    [switch]$Dev
)

$ErrorActionPreference = "Stop"

function Get-CommandVersion([string]$Command, [string[]]$Arguments) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Command was not found in PATH."
    }
    return ((& $Command @Arguments 2>&1 | Select-Object -First 1) -as [string]).Trim()
}

function Assert-Version {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    if ($Actual -match $Pattern) {
        return
    }

    $message = "$Label $Expected is required; found $Actual."
    if ($Dev) {
        # Releases are built in CI with the exact pinned toolchain; a developer
        # machine that drifts should be told, not blocked from starting the app.
        Write-Warning "$message Development mode continues with the found version."
        return
    }
    throw $message
}

function Assert-OptionalTool([string]$Command, [string[]]$Arguments) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        $message = "$Command was not found in PATH."
        if ($Dev) {
            Write-Warning "$message Development mode continues; release gates still require it."
            return
        }
        throw $message
    }
    & $Command @Arguments | Select-Object -First 1 | Out-Null
}

$nodeVersion = (Get-CommandVersion "node" @("--version")).TrimStart("v")
Assert-Version -Label "Node.js" -Actual $nodeVersion -Pattern '^24\.18\.\d+$' -Expected "24.18.x (use .nvmrc, 24.18.0)"

$npmVersion = Get-CommandVersion "npm" @("--version")
Assert-Version -Label "npm" -Actual $npmVersion -Pattern '^11\.16\.\d+$' -Expected "11.16.x (packageManager pins 11.16.0)"

$rustVersion = Get-CommandVersion "rustc" @("--version")
Assert-Version -Label "Rust" -Actual $rustVersion -Pattern '^rustc 1\.95\.\d+ ' -Expected "1.95.x (rust-toolchain.toml pins 1.95.0)"

$cargoVersion = Get-CommandVersion "cargo" @("--version")
Assert-Version -Label "Cargo" -Actual $cargoVersion -Pattern '^cargo 1\.95\.\d+ ' -Expected "1.95.x"

$installedTargets = (& rustup target list --installed) -join "`n"
if ($installedTargets -notmatch '(?m)^x86_64-pc-windows-msvc$') {
    # The app cannot be built without this target in either mode.
    throw "The x86_64-pc-windows-msvc Rust target is required."
}

Assert-OptionalTool "rustfmt" @("--version")
Assert-OptionalTool "cargo-clippy" @("--version")

Write-Host "Toolchain verified: Node $nodeVersion, npm $npmVersion, Rust/Cargo 1.95.x, x86_64-pc-windows-msvc."

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Get-CommandVersion([string]$Command, [string[]]$Arguments) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Command was not found in PATH."
    }
    return ((& $Command @Arguments 2>&1 | Select-Object -First 1) -as [string]).Trim()
}

$nodeVersion = (Get-CommandVersion "node" @("--version")).TrimStart("v")
if ($nodeVersion -notmatch '^24\.18\.\d+$') {
    throw "Node.js 24.18.x is required; found $nodeVersion. Use .nvmrc (24.18.0)."
}

$npmVersion = Get-CommandVersion "npm" @("--version")
if ($npmVersion -notmatch '^11\.16\.\d+$') {
    throw "npm 11.16.x is required; found $npmVersion. packageManager pins npm 11.16.0."
}

$rustVersion = Get-CommandVersion "rustc" @("--version")
if ($rustVersion -notmatch '^rustc 1\.95\.\d+ ') {
    throw "Rust 1.95.x is required; found $rustVersion. rust-toolchain.toml pins 1.95.0."
}

$cargoVersion = Get-CommandVersion "cargo" @("--version")
if ($cargoVersion -notmatch '^cargo 1\.95\.\d+ ') {
    throw "Cargo 1.95.x is required; found $cargoVersion."
}

$installedTargets = (& rustup target list --installed) -join "`n"
if ($installedTargets -notmatch '(?m)^x86_64-pc-windows-msvc$') {
    throw "The x86_64-pc-windows-msvc Rust target is required."
}

Get-CommandVersion "rustfmt" @("--version") | Out-Null
Get-CommandVersion "cargo-clippy" @("--version") | Out-Null

Write-Host "Toolchain verified: Node $nodeVersion, npm $npmVersion, Rust/Cargo 1.95.x, x86_64-pc-windows-msvc."

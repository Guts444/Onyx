[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$MsiPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$NsisPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SecretScannerPath,

    [string]$WorkRoot = $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }),

    [ValidateRange(1, 120)]
    [int]$WindowTimeoutSeconds = 45,

    [ValidateRange(1, 30)]
    [int]$StabilitySeconds = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RequiredFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][string]$Extension
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -and $item.Length -gt 0 -and $item.Extension -ieq $Extension) {
        return $item.FullName
    }
    throw "$Description must be a nonempty $Extension file."
}

function Assert-PackagedPayload {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$PackageKind
    )

    foreach ($name in @("Onyx.exe", "libmpv-2.dll", "libmpv-wrapper.dll")) {
        $matches = @(Get-ChildItem -LiteralPath $Root -Filter $name -File -Recurse -Force -ErrorAction Stop)
        if ($matches.Count -ne 1) {
            throw "$PackageKind payload must contain exactly one nonempty $name; found $($matches.Count)."
        }
        if ($matches[0].Length -le 0) {
            throw "$PackageKind payload contains an empty $name."
        }
    }

    return (Get-ChildItem -LiteralPath $Root -Filter "Onyx.exe" -File -Recurse -Force -ErrorAction Stop).FullName
}

function Invoke-Installer {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $process.WaitForExit()
        return $process.ExitCode
    } finally {
        $process.Dispose()
    }
}

function Remove-ExactProcessTree {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

    $Process.Refresh()
    if ($Process.HasExited) {
        throw "Onyx exited before the smoke test could terminate it."
    }

    & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to terminate the isolated Onyx process tree."
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        if (-not (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "The isolated Onyx process remained alive after tree termination."
}

$msi = Resolve-RequiredFile -Path $MsiPath -Description "MSI artifact" -Extension ".msi"
$nsis = Resolve-RequiredFile -Path $NsisPath -Description "NSIS artifact" -Extension ".exe"
$scanner = Resolve-RequiredFile -Path $SecretScannerPath -Description "Secret scanner" -Extension ".py"

$rootParent = [System.IO.Path]::GetFullPath($WorkRoot)
[System.IO.Directory]::CreateDirectory($rootParent) | Out-Null
$smokeRoot = Join-Path $rootParent ("onyx-packaged-smoke-" + [Guid]::NewGuid().ToString("N"))
$msiExtract = Join-Path $smokeRoot "msi-extracted"
$nsisInstall = Join-Path $smokeRoot "nsis-installed"
$failures = [System.Collections.Generic.List[string]]::new()
$onyxProcess = $null

try {
    [System.IO.Directory]::CreateDirectory($msiExtract) | Out-Null
    Write-Host "Administratively extracting the MSI into an isolated temporary directory."
    $msiExitCode = Invoke-Installer -FilePath "msiexec.exe" -Arguments @("/a", $msi, "/qn", "/norestart", "TARGETDIR=$msiExtract")
    if ($msiExitCode -ne 0) {
        throw "Administrative MSI extraction failed with exit code $msiExitCode."
    }
    $null = Assert-PackagedPayload -Root $msiExtract -PackageKind "MSI"

    [System.IO.Directory]::CreateDirectory($nsisInstall) | Out-Null
    Write-Host "Silently installing NSIS into an isolated temporary directory."
    # NSIS requires /D=install-path to be the final argument; ArgumentList preserves it as one argument even with spaces.
    $nsisExitCode = Invoke-Installer -FilePath $nsis -Arguments @("/S", "/D=$nsisInstall")
    if ($nsisExitCode -ne 0) {
        throw "Silent NSIS installation failed with exit code $nsisExitCode."
    }
    $installedExe = Assert-PackagedPayload -Root $nsisInstall -PackageKind "NSIS"

    Write-Host "Launching the isolated NSIS-installed Onyx executable."
    $onyxProcess = Start-Process -FilePath $installedExe -WorkingDirectory (Split-Path -Parent $installedExe) -PassThru
    $windowDeadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $onyxProcess.Refresh()
        if ($onyxProcess.HasExited) {
            throw "Onyx exited before creating its production main window."
        }
        if ($onyxProcess.MainWindowHandle -ne [IntPtr]::Zero) { break }
    } while ([DateTime]::UtcNow -lt $windowDeadline)

    if ($onyxProcess.MainWindowHandle -eq [IntPtr]::Zero) {
        throw "Onyx did not create a main window before the bounded timeout."
    }
    if ($onyxProcess.MainWindowTitle -cne "Onyx") {
        throw "Onyx main window did not have the exact production title."
    }

    Write-Host "Verifying that the production window remains stable."
    $stabilityDeadline = [DateTime]::UtcNow.AddSeconds($StabilitySeconds)
    do {
        Start-Sleep -Milliseconds 250
        $onyxProcess.Refresh()
        if ($onyxProcess.HasExited) { throw "Onyx exited during the stability window." }
        if ($onyxProcess.MainWindowHandle -eq [IntPtr]::Zero) { throw "Onyx lost its main window during the stability window." }
        if ($onyxProcess.MainWindowTitle -cne "Onyx") { throw "Onyx main window title changed during the stability window." }
    } while ([DateTime]::UtcNow -lt $stabilityDeadline)

    Write-Host "Scanning extracted and installed payloads for secrets."
    & python $scanner $msiExtract $nsisInstall
    if ($LASTEXITCODE -ne 0) {
        throw "Secret scanning of packaged payloads failed."
    }
} catch {
    $failures.Add($_.Exception.Message)
} finally {
    if ($null -ne $onyxProcess) {
        try { Remove-ExactProcessTree -Process $onyxProcess } catch { $failures.Add($_.Exception.Message) }
        $onyxProcess.Dispose()
    }

    if (Test-Path -LiteralPath $smokeRoot) {
        try {
            Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $smokeRoot) {
                throw "The isolated smoke-test directory still exists after cleanup."
            }
        } catch {
            $failures.Add("Failed to clean the isolated smoke-test directory: $($_.Exception.Message)")
        }
    }
}

if ($failures.Count -gt 0) {
    throw ("Packaged application smoke test failed: " + ($failures -join " | "))
}

Write-Host "Packaged Windows application smoke test passed; isolated paths were cleaned."

# Deploy from PowerShell: runs infra/deploy/deploy.sh in Git Bash (plain `bash` in PowerShell is
# WSL's, which has no Linux installed here). SSH goes straight through the physical network card,
# so a VPN tunnel (Happ / xray) that breaks port 22 to the server does not get in the way.
#
#   .\infra\deploy\deploy.ps1
#   .\infra\deploy\deploy.ps1 -Server 1.2.3.4 -SiteHost map.example.ru

param(
    [string]$Server = "217.144.184.43",
    [string]$SiteHost = "",
    [string]$Bind = ""
)

$ErrorActionPreference = "Stop"

$bash = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LocalAppData\Programs\Git\bin\bash.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) { throw "Git Bash не найден: установите Git for Windows (git-scm.com)" }

if (-not $Bind) {
    # The IPv4 of the network card that carries the default route, ignoring VPN / virtual adapters.
    $Bind = Get-NetIPConfiguration |
        Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" -and
            $_.InterfaceDescription -notmatch "Tunnel|VPN|Hyper-V|WireGuard|TAP|Wintun" } |
        ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1
}

$env:HOST = $Server
if ($SiteHost) { $env:SITE_HOST = $SiteHost }
if ($Bind) { $env:SSH_BIND = $Bind; Write-Host "SSH через $Bind (в обход VPN)" }

$root = git rev-parse --show-toplevel
# docker prints its progress to stderr; with "Stop", redirected output (*> log) would turn the
# first such line into a terminating error. Success is the script's exit code.
$ErrorActionPreference = "Continue"
& $bash -lc "cd '$root' && bash infra/deploy/deploy.sh"
exit $LASTEXITCODE

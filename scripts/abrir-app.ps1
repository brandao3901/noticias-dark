# Abre o app numa janela propria (sem abas) quando o servidor responder.
param(
  [string]$Url = 'http://localhost:3000',
  [int]$TimeoutSec = 90
)

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$statusUrl = "$Url/api/config/status"

while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri $statusUrl -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) { break }
  } catch {
    Start-Sleep -Milliseconds 700
  }
}

function Start-AppWindow {
  param([string[]]$Candidates)

  foreach ($exe in $Candidates) {
    if ($exe -and (Test-Path $exe)) {
      Start-Process -FilePath $exe -ArgumentList @("--app=$Url", '--window-size=1400,950') -ErrorAction SilentlyContinue
      return $true
    }
  }
  return $false
}

$edges = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$chromes = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

if (Start-AppWindow -Candidates $edges) { return }
if (Start-AppWindow -Candidates $chromes) { return }

# Sem Edge/Chrome: abre no navegador padrao.
Start-Process $Url

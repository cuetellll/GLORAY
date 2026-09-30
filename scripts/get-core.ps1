# Downloads the latest sing-box for Windows into .\bin so it gets bundled into the build.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
$bin  = Join-Path $root 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null
$rel   = Invoke-RestMethod 'https://api.github.com/repos/SagerNet/sing-box/releases/latest' -Headers @{ 'User-Agent' = 'GlowRay' }
$asset = $rel.assets | Where-Object { $_.name -match '^sing-box-[\d.]+-windows-amd64\.zip$' } | Select-Object -First 1
if (-not $asset) { throw 'windows-amd64 asset not found' }
$zip = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name) ..."
Invoke-WebRequest $asset.browser_download_url -OutFile $zip
$tmp = Join-Path $env:TEMP ('sb_' + [guid]::NewGuid())
Expand-Archive $zip $tmp -Force
$exe = Get-ChildItem $tmp -Recurse -Filter 'sing-box.exe' | Select-Object -First 1
Copy-Item $exe.FullName (Join-Path $bin 'sing-box.exe') -Force
Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force
Write-Host "OK: sing-box $($rel.tag_name) -> bin\sing-box.exe" -ForegroundColor Green

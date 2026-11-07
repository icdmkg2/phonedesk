# Builds dist\PhoneDesk-Setup-<version>.exe
#   powershell -ExecutionPolicy Bypass -File build\build.ps1
# Needs only what's already on Windows (.NET Framework C# compiler) plus Node.js (copied in as the runtime).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc" }
$node = (Get-Command node -ErrorAction Stop).Source

$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
Write-Host "Building PhoneDesk $version"

# ---- clean
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# ---- app files
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Force -Path $app | Out-Null
Copy-Item server, public -Destination $app -Recurse
Copy-Item package.json, package-lock.json -Destination $app
Push-Location $app
& npm ci --omit=dev --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
Pop-Location

# ---- runtime (a private copy of Node, so users don't need Node installed)
$runtime = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item $node -Destination (Join-Path $runtime 'node.exe')

# ---- WebView2 SDK (the app window). Pinned version, downloaded once into build\.cache.
$wv2Version = '1.0.4258.31'
$wv2 = Join-Path $PSScriptRoot ".cache\webview2-$wv2Version"
if (-not (Test-Path "$wv2\lib\net462\Microsoft.Web.WebView2.WinForms.dll")) {
  Write-Host "Downloading WebView2 SDK $wv2Version from nuget.org"
  New-Item -ItemType Directory -Force -Path $wv2 | Out-Null
  $pkg = "$wv2.nupkg"
  Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$wv2Version/microsoft.web.webview2.$wv2Version.nupkg" -OutFile $pkg
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($pkg, $wv2)
  Remove-Item $pkg
}
$wvCore = "$wv2\lib\net462\Microsoft.Web.WebView2.Core.dll"
$wvForms = "$wv2\lib\net462\Microsoft.Web.WebView2.WinForms.dll"
Copy-Item $wvCore, $wvForms, "$wv2\runtimes\win-x64\native\WebView2Loader.dll" -Destination $stage

# ---- tray app + window
$common = @('/nologo', '/optimize+', "/win32icon:installer\phonedesk.ico", '/win32manifest:installer\app.manifest',
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll')
& $csc @common /platform:x64 /target:winexe "/out:$stage\PhoneDesk.exe" "/r:$wvCore" "/r:$wvForms" `
  installer\Tray.cs installer\Window.cs installer\Common.cs
if ($LASTEXITCODE -ne 0) { throw 'compiling PhoneDesk.exe failed' }

# ---- payload zip
$zip = Join-Path $dist 'payload.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# ---- installer
$setup = Join-Path $dist "PhoneDesk-Setup-$version.exe"
& $csc @common /platform:anycpu /target:winexe "/out:$setup" "/resource:$zip,payload.zip" `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll installer\Setup.cs installer\Common.cs
if ($LASTEXITCODE -ne 0) { throw 'compiling setup failed' }
Remove-Item $zip

$mb = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host "Done: $setup ($mb MB)"

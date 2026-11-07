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

# ---- tray app
$common = @('/nologo', '/optimize+', '/platform:anycpu', "/win32icon:installer\phonedesk.ico", '/win32manifest:installer\app.manifest',
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll')
& $csc @common /target:winexe "/out:$stage\PhoneDesk.exe" installer\Tray.cs installer\Common.cs
if ($LASTEXITCODE -ne 0) { throw 'compiling PhoneDesk.exe failed' }

# ---- payload zip
$zip = Join-Path $dist 'payload.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# ---- installer
$setup = Join-Path $dist "PhoneDesk-Setup-$version.exe"
& $csc @common /target:winexe "/out:$setup" "/resource:$zip,payload.zip" `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll installer\Setup.cs installer\Common.cs
if ($LASTEXITCODE -ne 0) { throw 'compiling setup failed' }
Remove-Item $zip

$mb = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host "Done: $setup ($mb MB)"

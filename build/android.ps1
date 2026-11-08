# Builds the phone app: public\phone\PhoneDesk.apk (served by PhoneDesk at /phone/PhoneDesk.apk)
#   powershell -ExecutionPolicy Bypass -File build\android.ps1
# Needs a JDK plus Android build-tools and platform (no Gradle, no Android Studio).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$bt = Get-ChildItem "$sdk\build-tools" -ErrorAction Stop | Sort-Object Name -Descending | Select-Object -First 1
$plat = Get-ChildItem "$sdk\platforms" -ErrorAction Stop | Sort-Object Name -Descending | Select-Object -First 1
$androidJar = Join-Path $plat.FullName 'android.jar'
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Split-Path -Parent (Split-Path -Parent (Get-Command javac).Source) }
$javac = "$jdk\bin\javac.exe"; $keytool = "$jdk\bin\keytool.exe"

# Version name/code from package.json (1.8.0 -> 10800), so a newer app installs over an older one.
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$vp = $version.Split('.') | ForEach-Object { [int]$_ }
$versionCode = $vp[0] * 10000 + $vp[1] * 100 + $vp[2]

$out = Join-Path $root 'build\.cache\android'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$out\classes", "$out\res\mipmap-xxhdpi" | Out-Null
Copy-Item public\phone\icon-192.png "$out\res\mipmap-xxhdpi\ic_launcher.png"

# 1. Java -> classes -> dex
$src = Get-ChildItem android\src -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$ErrorActionPreference = 'Continue'
& $javac -encoding UTF-8 -source 8 -target 8 -Xlint:-options -classpath $androidJar -d "$out\classes" @src 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }
$ErrorActionPreference = 'Stop'
# (class names contain a $, which batch wrappers mangle, so hand d8 one jar)
& "$jdk\bin\jar.exe" cf "$out\classes.jar" -C "$out\classes" .
$d8 = if (Test-Path "$sdk\cmdline-tools\latest\bin\d8.bat") { "$sdk\cmdline-tools\latest\bin\d8.bat" } else { "$($bt.FullName)\d8.bat" }  # (build-tools' own d8 8.2 crashes on inner classes)
& $d8 --min-api 24 --lib $androidJar --output $out "$out\classes.jar"
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

# 2. resources + manifest + assets -> apk
& "$($bt.FullName)\aapt2.exe" compile --dir "$out\res" -o "$out\res.zip"
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }
& "$($bt.FullName)\aapt2.exe" link -o "$out\base.apk" --manifest android\AndroidManifest.xml -I $androidJar -A android\assets `
  --min-sdk-version 24 --target-sdk-version 33 --version-code $versionCode --version-name $version "$out\res.zip"
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

# 3. add classes.dex
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\base.apk", 'Update')
[void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\classes.dex", 'classes.dex')
$zip.Dispose()

# 4. align + sign (a fixed key kept in build\.cache, so updates install over older versions;
#    the release workflow passes the same key in PHONEDESK_KEYSTORE)
$ks = if ($env:PHONEDESK_KEYSTORE) { $env:PHONEDESK_KEYSTORE } else { Join-Path $root 'build\.cache\phonedesk.keystore' }
if (-not (Test-Path $ks)) {
  $ErrorActionPreference = 'Continue'
  & $keytool -genkeypair -keystore $ks -storepass phonedesk -keypass phonedesk -alias phonedesk -keyalg RSA -keysize 2048 `
    -validity 10000 -dname 'CN=PhoneDesk' 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
}
& "$($bt.FullName)\zipalign.exe" -f 4 "$out\base.apk" "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }
& "$($bt.FullName)\apksigner.bat" sign --ks $ks --ks-pass pass:phonedesk --key-pass pass:phonedesk --out "$out\PhoneDesk.apk" "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

Copy-Item "$out\PhoneDesk.apk" public\phone\PhoneDesk.apk -Force
$kb = [math]::Round((Get-Item public\phone\PhoneDesk.apk).Length / 1KB)
Write-Host "Done: public\phone\PhoneDesk.apk ($kb KB)"

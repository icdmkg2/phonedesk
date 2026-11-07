# PhoneDesk Windows bridge.
# Long-running helper: reads Windows media (SMTC) + master volume, prints JSON lines to stdout,
# accepts commands on stdin. Runs as a separate process so a WinRT hiccup can never crash the server.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public static class PdAudio {
  static IAudioEndpointVolume Vol() {
    var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv));
    return epv;
  }
  public static float GetVolume() { float v = 0; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void SetVolume(float v) { if (v < 0) v = 0; if (v > 1) v = 1; Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
  public static bool GetMute() { bool m = false; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}

public static class PdKeys {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Combo(byte[] vks) {
    foreach (var k in vks) keybd_event(k, 0, 0, UIntPtr.Zero);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event(vks[i], 0, 2, UIntPtr.Zero);
  }
}
'@

# A program's icon as PNG, at a good size and with transparency (the shell's own icon renderer).
Add-Type -ReferencedAssemblies System.Drawing -Language CSharp -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class PdIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItemImageFactory item);
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int size, ref BITMAP bm);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

  public static byte[] Png(string path, int size) {
    Bitmap bmp = null;
    try {
      IShellItemImageFactory f;
      SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
      IntPtr hbm;
      SIZE s; s.cx = size; s.cy = size;
      if (f.GetImage(s, 0x4 /* icon only */, out hbm) == 0) {
        try {
          BITMAP bm = new BITMAP();
          GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), ref bm);
          if (bm.bmBitsPixel == 32 && bm.bmBits != IntPtr.Zero) {
            // A bottom-up DIB with premultiplied alpha: read it from the last row upward.
            IntPtr last = new IntPtr(bm.bmBits.ToInt64() + (long)bm.bmWidthBytes * (bm.bmHeight - 1));
            using (Bitmap tmp = new Bitmap(bm.bmWidth, bm.bmHeight, -bm.bmWidthBytes, PixelFormat.Format32bppPArgb, last))
              bmp = new Bitmap(tmp);
          } else {
            bmp = Image.FromHbitmap(hbm);
          }
        } finally { DeleteObject(hbm); }
      }
    } catch { }
    if (bmp == null) {
      try { using (Icon ic = Icon.ExtractAssociatedIcon(path)) bmp = ic.ToBitmap(); } catch { return null; }
    }
    using (bmp) using (MemoryStream ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
  }
}
'@

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$type, [int]$timeoutMs = 3000) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait($timeoutMs)) { throw "WinRT call timed out" }
  return $task.Result
}

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$MgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$PropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$StreamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

$mgr = Await ($MgrType::RequestAsync()) $MgrType 10000

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
function Log($msg) { Emit @{ t = 'log'; msg = "$msg" } }

$VK = @{
  ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; meta = 0x5B
  enter = 0x0D; esc = 0x1B; escape = 0x1B; tab = 0x09; space = 0x20; backspace = 0x08; delete = 0x2E
  up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22
  printscreen = 0x2C; insert = 0x2D
  volumeup = 0xAF; volumedown = 0xAE; volumemute = 0xAD; mediaplay = 0xB3; medianext = 0xB0; mediaprev = 0xB1
}
for ($i = 1; $i -le 12; $i++) { $VK["f$i"] = 0x6F + $i }

function Send-Combo([string]$combo) {
  $codes = New-Object System.Collections.Generic.List[byte]
  foreach ($part in ($combo.ToLower() -split '\+')) {
    $p = $part.Trim()
    if ($p -eq '') { continue }
    if ($VK.ContainsKey($p)) { $codes.Add([byte]$VK[$p]) }
    elseif ($p.Length -eq 1 -and $p -match '[a-z0-9]') { $codes.Add([byte][char]$p.ToUpper()) }
    else { throw "Unknown key '$p'" }
  }
  if ($codes.Count -gt 0) { [PdKeys]::Combo($codes.ToArray()) }
}

# Apps that register with Windows media controls but aren't music (voice chat). Set by the server.
$script:Ignored = @('discord')
function Test-Ignored($s) {
  $id = ("" + $s.SourceAppUserModelId).ToLower()
  foreach ($b in $script:Ignored) { if ($b -and $id.Contains($b)) { return $true } }
  return $false
}

# Windows' "current" session, unless it's an ignored app; then the best other one
# (something playing first, else the first non-ignored session).
function Get-Session {
  $cur = $mgr.GetCurrentSession()
  if ($cur -and -not (Test-Ignored $cur)) { return $cur }
  $fallback = $null
  foreach ($s in $mgr.GetSessions()) {
    if (Test-Ignored $s) { continue }
    if (([string]$s.GetPlaybackInfo().PlaybackStatus) -eq 'Playing') { return $s }
    if ($null -eq $fallback) { $fallback = $s }
  }
  return $fallback
}

# ---------------------------------------------------------------- the playing app's icon + name
$GameDirs = '\\steamapps\\common\\|\\Epic Games\\|\\GOG Galaxy\\Games\\|\\GOG Games\\|\\XboxGames\\|\\Riot Games\\|\\Battle\.net\\|\\EA Games\\|\\Ubisoft Game Launcher\\games\\|\\Rockstar Games\\'
$KnownAumid = @{ 'chrome' = 'chrome'; 'msedge' = 'msedge'; '308046b0af4a39cb' = 'firefox'; '6f193ccc56814779' = 'firefox'; 'opera' = 'opera'; 'brave' = 'brave' }
$IconSent = @{}

function Find-AppInfo([string]$aumid) {
  try {
    if ($aumid -match '!') {
      # Store app: Family_Publisher!App -> package logo
      $name = $aumid.Split('!')[0].Split('_')[0]
      $pkg = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $pkg) { return $null }
      [xml]$man = Get-Content -LiteralPath (Join-Path $pkg.InstallLocation 'AppxManifest.xml') -Raw
      $display = "" + $man.Package.Properties.DisplayName
      if ($display -like 'ms-resource:*') { $display = '' }
      $logo = Join-Path $pkg.InstallLocation ("" + $man.Package.Properties.Logo)
      $dir = Split-Path $logo; $stem = [IO.Path]::GetFileNameWithoutExtension($logo); $ext = [IO.Path]::GetExtension($logo)
      $best = Get-ChildItem -LiteralPath $dir -Filter "$stem*$ext" -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
      $file = if ($best) { $best.FullName } elseif (Test-Path -LiteralPath $logo) { $logo } else { $null }
      if (-not $file) { return $null }
      return @{ png = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file)); name = $display; game = $false }
    }
    $proc = $aumid -replace '\.exe$', ''
    $key = $proc.ToLower()
    if ($KnownAumid.ContainsKey($key)) { $proc = $KnownAumid[$key] }
    $p = Get-Process -Name $proc -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
    if (-not $p) { return $null }
    $png = [PdIcon]::Png($p.Path, 96)
    if (-not $png) { return $null }
    $desc = ""
    try { $desc = "" + [Diagnostics.FileVersionInfo]::GetVersionInfo($p.Path).FileDescription } catch { }
    return @{ png = [Convert]::ToBase64String($png); name = $desc.Trim(); game = ($p.Path -match $GameDirs) }
  } catch { Log "icon lookup failed for ${aumid}: $($_.Exception.Message)"; return $null }
}

function Send-AppIcon([string]$aumid) {
  if (-not $aumid -or $IconSent.ContainsKey($aumid)) { return }
  $IconSent[$aumid] = $true
  $info = Find-AppInfo $aumid
  if ($info) { Emit @{ t = 'appicon'; app = $aumid; png = $info.png; name = $info.name; game = $info.game } }
}

function Invoke-Cmd([string]$line) {
  $parts = $line.Split(' ', 2)
  $cmd = $parts[0]
  $arg = if ($parts.Count -gt 1) { $parts[1] } else { '' }
  switch ($cmd) {
    'ping' { Emit @{ t = 'pong' }; return }
    'volume' { [PdAudio]::SetVolume([float]::Parse($arg, [Globalization.CultureInfo]::InvariantCulture)); $script:forceVol = $true; return }
    'mute' { [PdAudio]::SetMute(-not [PdAudio]::GetMute()); $script:forceVol = $true; return }
    'keys' { Send-Combo $arg; return }
    'ignore' { $script:Ignored = @($arg.ToLower().Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }); $script:forceMedia = $true; return }
  }
  $s = Get-Session
  if ($null -eq $s) {
    # No session: fall back to media keys so play still works for apps without SMTC.
    switch ($cmd) { 'toggle' { Send-Combo 'mediaplay' } 'next' { Send-Combo 'medianext' } 'prev' { Send-Combo 'mediaprev' } }
    return
  }
  $b = [bool]
  switch ($cmd) {
    'toggle' { [void](Await ($s.TryTogglePlayPauseAsync()) $b) }
    'play'   { [void](Await ($s.TryPlayAsync()) $b) }
    'pause'  { [void](Await ($s.TryPauseAsync()) $b) }
    'next'   { [void](Await ($s.TrySkipNextAsync()) $b) }
    'prev'   { [void](Await ($s.TrySkipPreviousAsync()) $b) }
    'seek'   { $ticks = [long]([double]::Parse($arg, [Globalization.CultureInfo]::InvariantCulture) * 10000000); [void](Await ($s.TryChangePlaybackPositionAsync($ticks)) $b) }
    'shuffle' { $pi = $s.GetPlaybackInfo(); $cur = $pi.IsShuffleActive; [void](Await ($s.TryChangeShuffleActiveAsync(-not $cur)) $b) }
    'repeat' {
      $pi = $s.GetPlaybackInfo(); $r = [int]$pi.AutoRepeatMode
      $next = ($r + 1) % 3
      [void](Await ($s.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]$next)) $b)
    }
    default { Log "unknown command $cmd" }
  }
  $script:forceMedia = $true
  $script:fastUntil = [DateTime]::UtcNow.AddSeconds(2)
}

function Read-Art($props) {
  if ($null -eq $props.Thumbnail) { return $null }
  try {
    $stream = Await ($props.Thumbnail.OpenReadAsync()) $StreamType
    # PowerShell can't pick this overload by itself for a WinRT stream (it silently failed before),
    # so call it through reflection, which does the interface cast at runtime.
    $net = $AsStreamForRead.Invoke($null, @($stream))
    $ms = New-Object System.IO.MemoryStream
    $net.CopyTo($ms)
    $net.Dispose()
    return [Convert]::ToBase64String($ms.ToArray())
  } catch { return $null }
}

[void][Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$AsStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

$lastMediaKey = ''
$lastTrackKey = ''
$lastVolKey = ''
$artTrack = ''
$artTries = 0
$script:forceMedia = $true
$script:forceVol = $true
# [Console]::In.ReadLineAsync is secretly synchronous on .NET Framework; use a raw stream reader instead.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$readTask = $stdin.ReadLineAsync()
$tick = 0

Emit @{ t = 'ready' }

while ($true) {
  # --- commands (non-blocking) ---
  while ($readTask.IsCompleted) {
    $line = $readTask.Result
    if ($null -eq $line) { exit 0 }  # server went away
    $line = $line.Trim()
    if ($line -ne '') {
      try { Invoke-Cmd $line } catch { Log "command '$line' failed: $($_.Exception.Message)" }
    }
    $readTask = $stdin.ReadLineAsync()
  }

  # --- media state, every ~500ms (or right after a command) ---
  if ($script:forceMedia -or ($tick % 2 -eq 0) -or ([DateTime]::UtcNow -lt $script:fastUntil)) {
    try {
      $s = Get-Session
      if ($null -eq $s) {
        $key = 'none'
        if ($key -ne $lastMediaKey -or $script:forceMedia) { Emit @{ t = 'media'; active = $false }; $lastMediaKey = $key; $lastTrackKey = '' }
      } else {
        Send-AppIcon $s.SourceAppUserModelId
        $pi = $s.GetPlaybackInfo()
        $tl = $s.GetTimelineProperties()
        $status = [string]$pi.PlaybackStatus
        $pos = $tl.Position.TotalSeconds
        $dur = ($tl.EndTime - $tl.StartTime).TotalSeconds
        $upd = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
        $props = $null
        try { $props = Await ($s.TryGetMediaPropertiesAsync()) $PropsType } catch { }
        $title = if ($props) { $props.Title } else { '' }
        $artist = if ($props) { $props.Artist } else { '' }
        $album = if ($props) { $props.AlbumTitle } else { '' }
        $trackKey = "$($s.SourceAppUserModelId)|$title|$artist|$album"
        $key = "$trackKey|$status|$([math]::Round($pos,1))|$upd|$([math]::Round($dur))|$($pi.IsShuffleActive)|$($pi.AutoRepeatMode)"
        $needArt = ($trackKey -ne $lastTrackKey) -and ($artTries -lt 8)
        if ($trackKey -ne $artTrack) { $artTrack = $trackKey; $artTries = 0; $needArt = $true }
        if ($key -ne $lastMediaKey -or $script:forceMedia -or $needArt) {
          $msg = @{
            t = 'media'; active = $true; app = $s.SourceAppUserModelId
            title = $title; artist = $artist; album = $album
            status = $status; position = $pos; duration = $dur; updated = $upd
            shuffle = $pi.IsShuffleActive; repeat = [int]$pi.AutoRepeatMode
          }
          if ($needArt -and $props) {
            if ($null -eq $props.Thumbnail -and $artTries -ge 2) {
              # The app gives no picture at all (e.g. YouTube in a browser): say so right away so
              # the server can look one up instead of waiting.
              $msg.art = ''; $lastTrackKey = $trackKey
            } else {
              $art = Read-Art $props
              # Thumbnails can arrive a beat after the title; retry next poll if missing.
              $artTries++
              if ($art) { $msg.art = $art; $lastTrackKey = $trackKey }
              elseif ($artTries -ge 8) { $msg.art = ''; $lastTrackKey = $trackKey }
            }
            if ($null -eq $props.Thumbnail) { $artTries++ }
          }
          Emit $msg
          $lastMediaKey = $key
        }
      }
    } catch { Log "media poll failed: $($_.Exception.Message)" }
    $script:forceMedia = $false
  }

  # --- volume, every ~250ms ---
  try {
    $v = [math]::Round([PdAudio]::GetVolume(), 3)
    $m = [PdAudio]::GetMute()
    $volKey = "$v|$m"
    if ($volKey -ne $lastVolKey -or $script:forceVol) { Emit @{ t = 'volume'; level = $v; muted = $m }; $lastVolKey = $volKey }
  } catch { if ($tick % 40 -eq 0) { Log "volume read failed: $($_.Exception.Message)" } }
  $script:forceVol = $false

  $tick++
  Start-Sleep -Milliseconds 250
}

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
    // Created by CLSID each time; a plain `new ... as` cast fails now and then with "Unable to cast ... MMDeviceEnumeratorComObject".
    var en = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
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
  [StructLayout(LayoutKind.Sequential)] struct BIH { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPels, biYPels, biClrUsed, biClrImportant; }
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, byte[] bits, ref BIH bi, uint usage);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] static extern int SHLoadIndirectString(string src, System.Text.StringBuilder outBuf, int cch, IntPtr reserved);

  public static string Resource(string indirect) {
    var sb = new System.Text.StringBuilder(512);
    return SHLoadIndirectString(indirect, sb, sb.Capacity, IntPtr.Zero) == 0 ? sb.ToString() : "";
  }

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
          // Always ask GDI for top-down 32-bit rows, so the picture is never upside down or mirrored,
          // whichever way the source bitmap is stored.
          if (bm.bmWidth > 0 && bm.bmHeight > 0) {
            BIH bi = new BIH(); bi.biSize = 40; bi.biWidth = bm.bmWidth; bi.biHeight = -bm.bmHeight; bi.biPlanes = 1; bi.biBitCount = 32;
            byte[] buf = new byte[bm.bmWidth * bm.bmHeight * 4];
            IntPtr dc = GetDC(IntPtr.Zero);
            int n = GetDIBits(dc, hbm, 0, (uint)bm.bmHeight, buf, ref bi, 0);
            ReleaseDC(IntPtr.Zero, dc);
            if (n > 0) {
              GCHandle gh = GCHandle.Alloc(buf, GCHandleType.Pinned);
              try { using (Bitmap tmp = new Bitmap(bm.bmWidth, bm.bmHeight, bm.bmWidth * 4, PixelFormat.Format32bppPArgb, gh.AddrOfPinnedObject())) bmp = new Bitmap(tmp); }
              finally { gh.Free(); }
            }
          }
          if (bmp == null) bmp = Image.FromHbitmap(hbm);
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
      if ($display -like 'ms-resource:*') {
        # Localized name: ask Windows to resolve the package resource ("Snipping Tool", not "ScreenSketch").
        $res = $display.Substring(12)
        if ($res -notlike '//*') { $res = "//$($pkg.Name)/Resources/$($res.TrimStart('/'))" }
        $display = [PdIcon]::Resource('@{' + $pkg.PackageFullName + '?ms-resource:' + $res + '}')
      }
      $logo = Join-Path $pkg.InstallLocation ("" + $man.Package.Properties.Logo)
      $dir = Split-Path $logo; $stem = [IO.Path]::GetFileNameWithoutExtension($logo); $ext = [IO.Path]::GetExtension($logo)
      $best = Get-ChildItem -LiteralPath $dir -Filter "$stem*$ext" -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
      $file = if ($best) { $best.FullName } elseif (Test-Path -LiteralPath $logo) { $logo } else { $null }
      if (-not $file) { return $null }
      return @{ png = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file)); name = $display; game = $false }
    }
    # Ids can be a bare exe name, or a known-folder path like {GUID}\folder\app.exe: use the file name.
    $proc = [IO.Path]::GetFileNameWithoutExtension($aumid)
    $key = $proc.ToLower()
    if ($KnownAumid.ContainsKey($key)) { $proc = $KnownAumid[$key] }
    # Notification ids look like com.squirrel.Discord.Discord or Spotify.desktop.client: try the useful words in turn.
    $names = New-Object System.Collections.Generic.List[string]
    $names.Add($proc)
    foreach ($tok in ($proc -split '[._ -]')) {
      if ($tok.Length -lt 3 -or $tok -match '^(com|squirrel|electron|app|desktop|client|windows|microsoft|org|net|dev|exe)$') { continue }
      $names.Add($tok); if ($tok -match 'Desktop$') { $names.Add($tok -replace 'Desktop$', '') }
    }
    $path = $null
    foreach ($n in $names) {
      $p = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
      if ($p) { $path = $p.Path; break }
    }
    if (-not $path) {
      # Not running: look for a Start menu shortcut with that name and use its target.
      $menus = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")
      $lnks = Get-ChildItem -LiteralPath $menus -Filter *.lnk -Recurse -ErrorAction SilentlyContinue
      $sh = New-Object -ComObject WScript.Shell
      foreach ($n in $names) {
        if ($n.Length -lt 3) { continue }
        foreach ($l in ($lnks | Where-Object { $_.BaseName -like "*$n*" } | Select-Object -First 3)) {
          $t = $sh.CreateShortcut($l.FullName).TargetPath
          if ($t -and (Test-Path -LiteralPath $t) -and $t -notmatch 'Update\.exe$') { $path = $t; break }
        }
        if ($path) { break }
      }
    }
    if (-not $path) { return $null }
    $png = [PdIcon]::Png($path, 96)
    if (-not $png) { return $null }
    $desc = ""
    try { $desc = "" + [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileDescription } catch { }
    return @{ png = [Convert]::ToBase64String($png); name = $desc.Trim(); game = ($path -match $GameDirs) }
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
    'appvol' { $a = $arg.Split(' '); [PdMixer]::Set([uint32]$a[0], [float]::Parse($a[1], [Globalization.CultureInfo]::InvariantCulture), -1); $script:forceMixer = $true; return }
    'appmute' { [PdMixer]::Set([uint32]$arg, -1, 2); $script:forceMixer = $true; return }
    'icon' { Send-AppIcon $arg; return }
    'mixer' { $script:forceMixer = $true; $script:mixerForced = $true; return }
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

# ---------------------------------------------------------------- per-app volume + GPU sensors
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// Per-app volume: Windows' audio sessions on the default output device (what the Volume Mixer shows).
public static class PdMixer {
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int NotUsed(); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 { int A(); int B(); [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e); }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int n); [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s); }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    int GetDisplayName(); int SetDisplayName(); int GetIconPath(); int SetIconPath(); int GetGroupingParam(); int SetGroupingParam();
    int RegisterAudioSessionNotification(); int UnregisterAudioSessionNotification();
    int GetSessionIdentifier(); int GetSessionInstanceIdentifier();
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float v, ref Guid ctx); [PreserveSig] int GetMasterVolume(out float v);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid ctx); [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
  }
  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation { [PreserveSig] int GetPeakValue(out float peak); }

  public class Entry { public uint pid; public float level; public bool muted; public float peak; public bool system; }

  static List<IAudioSessionControl2> Sessions() {
    var list = new List<IAudioSessionControl2>();
    // Created by CLSID (not a [ComImport] class) so it can't clash with the master-volume code's type.
    var en = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
    IMMDevice dev;
    if (en.GetDefaultAudioEndpoint(0, 1, out dev) != 0) return list;
    Guid iid = typeof(IAudioSessionManager2).GUID;
    object o;
    if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return list;
    var mgr = (IAudioSessionManager2)o;
    IAudioSessionEnumerator e;
    if (mgr.GetSessionEnumerator(out e) != 0) return list;
    int n; e.GetCount(out n);
    for (int i = 0; i < n; i++) { IAudioSessionControl2 s; if (e.GetSession(i, out s) == 0 && s != null) list.Add(s); }
    return list;
  }

  public static Entry[] List() {
    var byPid = new Dictionary<uint, Entry>();
    foreach (var s in Sessions()) {
      try {
        int state; s.GetState(out state);
        if (state == 2) continue; // expired
        uint pid; s.GetProcessId(out pid);
        bool sys = s.IsSystemSoundsSession() == 0;
        var vol = (ISimpleAudioVolume)s; var meter = (IAudioMeterInformation)s;
        float lv; vol.GetMasterVolume(out lv); bool mu; vol.GetMute(out mu); float pk; meter.GetPeakValue(out pk);
        Entry ex;
        if (byPid.TryGetValue(pid, out ex)) { ex.peak = Math.Max(ex.peak, pk); continue; }
        byPid[pid] = new Entry { pid = pid, level = lv, muted = mu, peak = pk, system = sys };
      } catch { }
      finally { Marshal.ReleaseComObject(s); }
    }
    return new List<Entry>(byPid.Values).ToArray();
  }

  public static void Set(uint pid, float level, int mute) {
    Guid ctx = Guid.Empty;
    foreach (var s in Sessions()) {
      try {
        uint p; s.GetProcessId(out p);
        if (p != pid) continue;
        var vol = (ISimpleAudioVolume)s;
        if (level >= 0) vol.SetMasterVolume(Math.Max(0f, Math.Min(1f, level)), ref ctx);
        if (mute >= 0) { bool cur; vol.GetMute(out cur); vol.SetMute(mute == 2 ? !cur : mute == 1, ref ctx); }
      } catch { }
      finally { Marshal.ReleaseComObject(s); }
    }
  }
}

// AMD GPU sensors through the driver's own ADL library (no admin needed).
public static class PdGpu {
  delegate IntPtr Alloc(int size);
  static readonly Alloc alloc = (s) => Marshal.AllocHGlobal(s);
  [StructLayout(LayoutKind.Sequential)] struct Sensor { public int supported; public int value; }
  [StructLayout(LayoutKind.Sequential)] struct PMLog { public int size; [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)] public Sensor[] sensors; }
  [DllImport("atiadlxx.dll")] static extern int ADL2_Main_Control_Create(Alloc cb, int connected, out IntPtr ctx);
  [DllImport("atiadlxx.dll")] static extern int ADL2_Adapter_NumberOfAdapters_Get(IntPtr ctx, out int n);
  [DllImport("atiadlxx.dll")] static extern int ADL2_New_QueryPMLogData_Get(IntPtr ctx, int idx, ref PMLog data);
  [DllImport("atiadlxx.dll")] static extern int ADL2_Adapter_DedicatedVRAMUsage_Get(IntPtr ctx, int idx, out int mb);

  static IntPtr ctx = IntPtr.Zero;
  static int adapter = -1;
  static bool failed;

  // [load %, edge temp, hotspot temp, fan rpm, power W, vram used MB] or null
  public static int[] Read() {
    if (failed) return null;
    try {
      if (ctx == IntPtr.Zero) {
        if (ADL2_Main_Control_Create(alloc, 1, out ctx) != 0) { failed = true; return null; }
        int n; ADL2_Adapter_NumberOfAdapters_Get(ctx, out n);
        for (int i = 0; i < n && adapter < 0; i++) {
          var t = new PMLog(); t.sensors = new Sensor[256];
          if (ADL2_New_QueryPMLogData_Get(ctx, i, ref t) == 0 && t.sensors[8].supported != 0) adapter = i;
        }
        if (adapter < 0) { failed = true; return null; }
      }
      var d = new PMLog(); d.sensors = new Sensor[256];
      if (ADL2_New_QueryPMLogData_Get(ctx, adapter, ref d) != 0) return null;
      int vram = -1; try { ADL2_Adapter_DedicatedVRAMUsage_Get(ctx, adapter, out vram); } catch { }
      Func<int, int> v = (k) => d.sensors[k].supported != 0 ? d.sensors[k].value : -1;
      // ADL sensor ids: 19 GFX activity, 8 edge temp, 27 hotspot temp, 14 fan rpm, 23 ASIC power
      return new int[] { v(19), v(8), v(27), v(14), v(23), vram };
    } catch (DllNotFoundException) { failed = true; return null; }
    catch { return null; }
  }
}
'@

$ProcInfo = @{}
function Get-ProcInfo([uint32]$procId) {
  if ($procId -eq 0) { return @{ name = 'System sounds'; key = '' } }
  if ($ProcInfo.ContainsKey($procId)) { return $ProcInfo[$procId] }
  $info = @{ name = "App $procId"; key = '' }
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    $info.key = $p.ProcessName + '.exe'
    $desc = ''
    if ($p.Path) { try { $desc = ("" + [Diagnostics.FileVersionInfo]::GetVersionInfo($p.Path).FileDescription).Trim() } catch { } }
    $info.name = if ($desc -and $desc.Length -le 28) { $desc } else { $p.ProcessName }
  } catch { }
  $ProcInfo[$procId] = $info
  return $info
}

$lastMixerKey = ''
function Send-Mixer([bool]$force) {
  $items = @()
  foreach ($e in [PdMixer]::List()) {
    $pi2 = Get-ProcInfo $e.pid
    if ($pi2.key) { Send-AppIcon $pi2.key }
    $items += @{ pid = [int]$e.pid; name = $pi2.name; app = $pi2.key; level = [math]::Round($e.level, 2); muted = $e.muted; active = ($e.peak -gt 0.0005); system = $e.system }
  }
  $items = @($items | Sort-Object @{ e = { $_.system } }, @{ e = { -not $_.active } }, @{ e = { $_.name } })
  $key = ($items | ForEach-Object { "$($_.pid):$($_.level):$($_.muted):$($_.active)" }) -join ','
  if ($force -or $key -ne $script:lastMixerKey) { Emit @{ t = 'mixer'; items = $items }; $script:lastMixerKey = $key }
}

$nvsmi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
# Byte totals of the adapters that are up (no loopback/tunnels); the server turns them into speeds.
function Send-Net {
  $rx = [int64]0; $tx = [int64]0
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.OperationalStatus -ne 'Up') { continue }
    if ($n.NetworkInterfaceType -eq 'Loopback' -or $n.NetworkInterfaceType -eq 'Tunnel') { continue }
    try { $st = $n.GetIPStatistics(); $rx += $st.BytesReceived; $tx += $st.BytesSent } catch { }
  }
  Emit @{ t = 'net'; rx = $rx; tx = $tx }
}
function Send-Gpu {
  $g = [PdGpu]::Read()
  if ($g) { Emit @{ t = 'gpu'; load = $g[0]; temp = $g[1]; hotspot = $g[2]; fan = $g[3]; power = $g[4]; vram = $g[5] }; return }
  if ($nvsmi) {
    $o = & $nvsmi --query-gpu=utilization.gpu,temperature.gpu,fan.speed,power.draw,memory.used --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($o) { $v = $o.Split(',') | ForEach-Object { $_.Trim() }; Emit @{ t = 'gpu'; load = [int]$v[0]; temp = [int]$v[1]; hotspot = -1; fan = -1; fanPct = [int]$v[2]; power = [int][double]$v[3]; vram = [int]$v[4] } }
  }
}

# --- busiest apps and CPU temperature, every ~4s -------------------------------------------------
# CPU share = processor time each app used since the last look, over the time that passed times the number of cores.
# Processes with the same name (all of Chrome's) count as one app.
$ncpu = [Environment]::ProcessorCount
$script:procPrev = @{}
$script:procAt = $null
$script:tempSrc = ''
$script:tempRetry = [DateTime]::MinValue
function Get-CpuTemp {
  if ($script:tempSrc -eq 'none' -and [DateTime]::UtcNow -lt $script:tempRetry) { return -1 }
  if ($script:tempSrc -ne 'acpi') {
    # LibreHardwareMonitor (if it runs) knows the real package temperature
    try {
      $s = Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop |
        Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'CPU Package|Tctl|Tdie|Core \(Tctl' } | Select-Object -First 1
      if ($s) { $script:tempSrc = 'lhm'; return [int]$s.Value }
    } catch { }
  }
  if ($script:tempSrc -ne 'lhm') {
    # the ACPI thermal zone: not on every PC, and sometimes only for administrators
    try {
      $z = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 1
      if ($z -and $z.CurrentTemperature -gt 0) { $script:tempSrc = 'acpi'; return [int](($z.CurrentTemperature / 10) - 273.15) }
    } catch { }
  }
  $script:tempSrc = 'none'; $script:tempRetry = [DateTime]::UtcNow.AddMinutes(2)
  return -1
}
function Send-Sys {
  $now = [DateTime]::UtcNow
  $cur = @{}; $rows = @{}
  foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
    $name = $p.ProcessName
    if ($name -eq 'Idle' -or $name -eq 'System' -or $name -eq 'Memory Compression') { continue }
    $ms = -1
    try { $ms = $p.TotalProcessorTime.TotalMilliseconds } catch { }
    $cur[$p.Id] = $ms
    if (-not $rows.ContainsKey($name)) { $rows[$name] = @{ name = $name; cpu = 0.0; mem = [int64]0 } }
    try { $rows[$name].mem += [int64]$p.WorkingSet64 } catch { }
    if ($script:procAt -and $ms -ge 0 -and $script:procPrev.ContainsKey($p.Id)) {
      $d = $ms - $script:procPrev[$p.Id]
      if ($d -gt 0) { $rows[$name].cpu += $d }
    }
  }
  $byCpu = @(); $byMem = @()
  if ($script:procAt) {
    $span = ($now - $script:procAt).TotalMilliseconds * $ncpu
    if ($span -gt 0) {
      $list = @($rows.Values | ForEach-Object { @{ name = $_.name; cpu = [math]::Round($_.cpu / $span * 100, 1); mem = $_.mem } })
      $byCpu = @($list | Sort-Object { $_.cpu } -Descending | Select-Object -First 6)
      $byMem = @($list | Sort-Object { $_.mem } -Descending | Select-Object -First 6)
    }
  }
  $script:procPrev = $cur; $script:procAt = $now
  Emit @{ t = 'sys'; procs = $byCpu; procsMem = $byMem; cpuTemp = (Get-CpuTemp) }
}

# --- battery of Bluetooth devices (headphones, mice...), once a minute -----------------------------
# Reading device properties takes a second or two, so it runs on its own runspace and the loop only collects it.
$script:btPs = $null
$script:btAsync = $null
function Start-Bt {
  if ($script:btPs) { return }
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
    $key = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
    $seen = @{}
    foreach ($d in (Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'BTHENUM*' -or $_.InstanceId -like 'BTHLE*' })) {
      try {
        $v = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName $key -ErrorAction Stop).Data
        if ($null -ne $v -and [int]$v -ge 0 -and [int]$v -le 100 -and -not $seen.ContainsKey($d.FriendlyName)) {
          $seen[$d.FriendlyName] = 1
          [pscustomobject]@{ name = [string]$d.FriendlyName; level = [int]$v }
        }
      } catch { }
    }
  })
  $script:btPs = $ps
  $script:btAsync = $ps.BeginInvoke()
}
function Poll-Bt {
  if (-not $script:btPs -or -not $script:btAsync.IsCompleted) { return }
  try { $r = @($script:btPs.EndInvoke($script:btAsync)); Emit @{ t = 'bt'; items = @($r | ForEach-Object { @{ name = $_.name; level = $_.level } }) } } catch { }
  $script:btPs.Dispose(); $script:btPs = $null; $script:btAsync = $null
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
$script:forceMixer = $true
$script:mixerForced = $true
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

  # --- per-app volume, every ~1s (or right after a change) ---
  if ($script:forceMixer -or ($tick % 4 -eq 0)) {
    try { Send-Mixer ([bool]$script:mixerForced) } catch { if ($tick % 120 -eq 0) { Log "mixer failed: $($_.Exception.Message)" } }
    $script:forceMixer = $false; $script:mixerForced = $false
  }
  # --- GPU sensors, every ~2s ---
  if ($tick % 8 -eq 1) { try { Send-Gpu } catch { } }
  # --- network byte totals, every ~2s ---
  if ($tick % 8 -eq 5) { try { Send-Net } catch { } }
  # --- busiest apps and CPU temperature, every ~4s ---
  if ($tick % 16 -eq 3) { try { Send-Sys } catch { if ($tick % 480 -eq 3) { Log "app stats failed: $($_.Exception.Message)" } } }
  # --- Bluetooth batteries: start a read once a minute, collect it when it is done ---
  if ($tick % 240 -eq 9) { try { Start-Bt } catch { } }
  try { Poll-Bt } catch { }

  $tick++
  Start-Sleep -Milliseconds 250
}

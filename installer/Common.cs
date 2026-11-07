// Shared by PhoneDesk.exe (tray app + uninstaller) and PhoneDesk-Setup.exe.
// Written for the C# 5 compiler that ships with Windows (no string interpolation, no ?.).
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

static class Pd
{
    public const string Name = "PhoneDesk";
    public const string Version = "1.6.0";
    public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\PhoneDesk";
    public const string FirewallRule = "PhoneDesk";

    public static string DefaultInstallDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name); }
    }

    public static string DataDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Name); }
    }

    public static string StartMenuLink
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name + ".lnk"); }
    }

    public static string DesktopLink
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Name + ".lnk"); }
    }

    public static int Port()
    {
        try
        {
            string json = File.ReadAllText(Path.Combine(DataDir, "config.json"));
            Match m = Regex.Match(json, "\"port\"\\s*:\\s*(\\d+)");
            if (m.Success) return int.Parse(m.Groups[1].Value);
        }
        catch { }
        return 8765;
    }

    public static string DashboardUrl { get { return "http://localhost:" + Port(); } }

    public static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    // ------------------------------------------------------------ start with Windows
    public static bool StartsWithWindows
    {
        get
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
                return k != null && k.GetValue(Name) != null;
        }
    }

    public static void SetStartWithWindows(bool on, string exePath)
    {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (on) k.SetValue(Name, "\"" + exePath + "\" --background");
            else if (k.GetValue(Name) != null) k.DeleteValue(Name);
        }
    }

    // ------------------------------------------------------------ stopping a running copy
    public static void Post(string url, int timeoutMs)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.Proxy = null; // skip proxy auto-detection, which can hang for a long time
            req.Timeout = timeoutMs;
            req.ContentLength = 0;
            using (req.GetResponse()) { }
        }
        catch { }
    }

    /// Stops the tray app and server installed in `installDir` (used by setup when updating, and by uninstall).
    public static void StopRunning(string installDir)
    {
        Trace("asking running PhoneDesk to shut down");
        Post(DashboardUrl + "/api/shutdown", 1500);
        Trace("stopping processes");
        int me = Process.GetCurrentProcess().Id;
        foreach (Process p in Process.GetProcessesByName(Name))
        {
            if (p.Id == me) continue;
            try { p.Kill(); p.WaitForExit(3000); } catch { }
        }
        string root = Path.GetFullPath(installDir).TrimEnd('\\') + "\\";
        foreach (Process p in Process.GetProcessesByName("node"))
        {
            try
            {
                string file = p.MainModule.FileName;
                if (file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); }
            }
            catch { }
        }
        Thread.Sleep(300);
    }

    // ------------------------------------------------------------ firewall (needs one UAC prompt)
    public static bool FirewallRuleExists()
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("netsh", "advfirewall firewall show rule name=\"" + FirewallRule + "\"");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            using (Process p = Process.Start(psi))
            {
                p.StandardOutput.ReadToEnd();
                p.WaitForExit(5000);
                return p.ExitCode == 0;
            }
        }
        catch { return false; }
    }

    /// Runs a command elevated. Returns false if the user said no to the UAC prompt.
    public static bool RunElevated(string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/d /c " + args);
            psi.Verb = "runas";
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit(30000);
                return p.ExitCode == 0;
            }
        }
        catch { return false; }
    }

    /// True if phones can't get in: Windows auto-created "block" rules for our server (it does that
    /// when its "Allow access?" prompt is closed), or our allow rule is missing.
    public static bool FirewallNeedsFix(string nodeExe)
    {
        if (!FirewallRuleExists()) return true;
        try
        {
            string cmd = "@(Get-NetFirewallApplicationFilter -Program '" + nodeExe.Replace("'", "''") + "' -ErrorAction SilentlyContinue | " +
                "Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' -and $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' }).Count";
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command \"" + cmd + "\"");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            using (Process p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(15000);
                int n;
                return int.TryParse(output, out n) && n > 0;
            }
        }
        catch { return false; }
    }

    public static bool AddFirewallRule(string nodeExe)
    {
        string r = FirewallRule;
        // First clear any rules Windows made for this exe (including auto-created "block" rules,
        // which would otherwise override ours), then add one clean allow rule.
        return RunElevated("netsh advfirewall firewall delete rule name=all program=\"" + nodeExe + "\" >nul 2>&1 & " +
            "netsh advfirewall firewall delete rule name=\"" + r + "\" >nul 2>&1 & " +
            "netsh advfirewall firewall add rule name=\"" + r + "\" dir=in action=allow enable=yes profile=any " +
            "program=\"" + nodeExe + "\" description=\"Lets phones on your network reach PhoneDesk\"");
    }

    // ------------------------------------------------------------ shortcuts
    public static void CreateShortcut(string lnkPath, string target, string args, string description)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
        lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { args });
        lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(target) });
        lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
        lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { description });
        lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
    }

    public static string TraceFile;
    public static void Trace(string msg)
    {
        if (TraceFile == null) return;
        try { File.AppendAllText(TraceFile, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + msg + Environment.NewLine); } catch { }
    }

    public static void TryDelete(string file)
    {
        try { if (File.Exists(file)) File.Delete(file); } catch { }
    }
}

// PhoneDesk.exe: lives in the system tray, runs the server hidden, restarts it if it crashes.
//   PhoneDesk.exe               start (opens the dashboard), or open the dashboard if already running
//   PhoneDesk.exe --background  start quietly (used for "start with Windows")
//   PhoneDesk.exe --uninstall   remove PhoneDesk
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("PhoneDesk")]
[assembly: System.Reflection.AssemblyProduct("PhoneDesk")]
[assembly: System.Reflection.AssemblyDescription("PhoneDesk")]
[assembly: System.Reflection.AssemblyVersion("1.2.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.2.0.0")]

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (Array.IndexOf(args, "--uninstall") >= 0) return Uninstaller.Run(Array.IndexOf(args, "--quiet") >= 0);
        bool background = Array.IndexOf(args, "--background") >= 0;

        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\PhoneDesk.Tray", out created))
        {
            if (!created)
            {
                // Already running: launching it again brings its window forward.
                if (!background)
                {
                    try { using (EventWaitHandle show = EventWaitHandle.OpenExisting(TrayApp.ShowEventName)) show.Set(); }
                    catch { Pd.OpenUrl(Pd.DashboardUrl); }
                }
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp(!background));
            GC.KeepAlive(mutex);
        }
        return 0;
    }
}

/// Kill-on-close job: if the tray app dies for any reason, Windows also ends the server,
/// so there are never orphaned servers holding the port. Only the server itself is in the job
/// (silent breakaway), so apps started by shortcut buttons are never killed with it.
static class Job
{
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXTENDED { public BASIC Basic; public IO Io; public UIntPtr a; public UIntPtr b; public UIntPtr c; public UIntPtr d; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static IntPtr handle = IntPtr.Zero;

    public static void Add(Process p)
    {
        try
        {
            if (handle == IntPtr.Zero)
            {
                handle = CreateJobObject(IntPtr.Zero, null);
                EXTENDED info = new EXTENDED();
                info.Basic.LimitFlags = 0x2000 | 0x1000; // KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK
                SetInformationJobObject(handle, 9, ref info, (uint)Marshal.SizeOf(typeof(EXTENDED)));
            }
            AssignProcessToJobObject(handle, p.Handle);
        }
        catch { }
    }
}

class TrayApp : ApplicationContext
{
    readonly NotifyIcon tray;
    readonly Control ui; // for marshalling events back onto the UI thread
    readonly ToolStripMenuItem addressItem, phonesItem, startupItem, statusItem;
    ToolStripMenuItem firewallItem;
    bool firewallBalloon;
    readonly System.Windows.Forms.Timer poll;
    readonly string installDir, nodeExe, serverJs, logFile;

    Process server;
    bool quitting;
    int quickCrashes;
    DateTime startedAt;
    int backoffMs = 1000;
    string phoneUrl = "http://phonedesk.local";
    bool pollBusy;
    MainWindow window;
    int lastPhones = -1;
    public const string ShowEventName = "Local\\PhoneDesk.Show";

    public TrayApp(bool openDashboard)
    {
        ui = new Control();
        ui.CreateControl();
        IntPtr unused = ui.Handle;

        installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        nodeExe = Path.Combine(installDir, "runtime\\node.exe");
        serverJs = Path.Combine(installDir, "app\\server\\index.js");
        if (!File.Exists(serverJs))
        {
            // Running from a dev build in <repo>\dist\stage: fall back to the repo copy and system node.
            string repo = Path.GetFullPath(Path.Combine(installDir, "..\\..\\server\\index.js"));
            if (File.Exists(repo)) serverJs = repo;
        }
        if (!File.Exists(nodeExe)) nodeExe = "node.exe";
        Directory.CreateDirectory(Path.Combine(Pd.DataDir, "logs"));
        logFile = Path.Combine(Pd.DataDir, "logs\\server.log");

        statusItem = new ToolStripMenuItem("PhoneDesk · starting…") { Enabled = false };
        ToolStripMenuItem open = new ToolStripMenuItem("Open PhoneDesk", null, delegate { ShowWindow(); });
        open.Font = new Font(open.Font, FontStyle.Bold);
        addressItem = new ToolStripMenuItem("Copy phone address", null, delegate { CopyAddress(); });
        addressItem.ShortcutKeyDisplayString = "phonedesk.local";
        phonesItem = new ToolStripMenuItem("No phone connected") { Enabled = false };
        startupItem = new ToolStripMenuItem("Start with Windows", null, delegate { ToggleStartup(); });
        startupItem.Checked = Pd.StartsWithWindows;

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Renderer = new DarkMenuRenderer();
        menu.ShowImageMargin = false;
        menu.ShowCheckMargin = true;
        menu.Padding = new Padding(4);
        menu.Items.Add(statusItem);
        menu.Items.Add(phonesItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(open);
        menu.Items.Add(addressItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(startupItem);
        firewallItem = new ToolStripMenuItem("Let phones on Wi-Fi connect…", null, delegate { FixFirewall(); });
        firewallItem.Visible = false;
        menu.Items.Add(firewallItem);
        menu.Items.Add(new ToolStripMenuItem("Restart PhoneDesk", null, delegate { RestartServer(); }));
        menu.Items.Add(new ToolStripMenuItem("Open log folder", null, delegate { Pd.OpenUrl(Path.Combine(Pd.DataDir, "logs")); }));
        menu.Items.Add(new ToolStripSeparator());
        ToolStripMenuItem quit = new ToolStripMenuItem("Quit PhoneDesk", null, delegate { Quit(); });
        quit.ForeColor = Color.FromArgb(255, 138, 143);
        menu.Items.Add(quit);
        foreach (ToolStripItem it in menu.Items) { it.Padding = new Padding(6, 5, 6, 5); if (it != quit && it.ForeColor != Color.FromArgb(255, 138, 143)) it.ForeColor = Color.FromArgb(237, 239, 243); }
        menu.Opening += delegate { startupItem.Checked = Pd.StartsWithWindows; };

        tray = new NotifyIcon();
        try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { tray.Icon = SystemIcons.Application; }
        tray.Text = "PhoneDesk";
        tray.ContextMenuStrip = menu;
        tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowWindow(); };
        tray.BalloonTipClicked += delegate
        {
            if (firewallBalloon) { firewallBalloon = false; FixFirewall(); }
            else ShowWindow();
        };
        tray.Visible = true;

        StartServer();
        ListenForShow();
        if (openDashboard) ShowWindow(); // the window waits for the server by itself

        CheckFirewallLater();

        poll = new System.Windows.Forms.Timer();
        poll.Interval = 1000; // fast until the server answers, then every 5s
        poll.Tick += delegate { Poll(); };
        poll.Start();
    }

    // ------------------------------------------------------------ server process
    void StartServer()
    {
        if (quitting) return;
        RotateLog();
        ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "\"" + serverJs + "\"");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(serverJs));
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.EnvironmentVariables["PHONEDESK_DATA"] = Pd.DataDir;
        psi.EnvironmentVariables["PHONEDESK_EXE"] = Application.ExecutablePath;
        try
        {
            Process p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Log(e.Data); };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Log(e.Data); };
            p.Exited += delegate { ui.BeginInvoke((MethodInvoker)delegate { OnServerExit(p); }); };
            p.Start();
            Job.Add(p);
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            server = p;
            startedAt = DateTime.UtcNow;
            SetStatus("Starting…");
        }
        catch (Exception ex)
        {
            Log("could not start server: " + ex.Message);
            SetStatus("Could not start");
            tray.ShowBalloonTip(8000, "PhoneDesk couldn't start", ex.Message, ToolTipIcon.Error);
        }
    }

    void OnServerExit(Process p)
    {
        if (p != server) return;
        int code = 0;
        try { code = p.ExitCode; } catch { }
        server = null;
        if (quitting) return;
        if (code == 2)
        {
            SetStatus("Port in use");
            tray.ShowBalloonTip(10000, "PhoneDesk can't start",
                "Port " + Pd.Port() + " is already used by another program (maybe another copy of PhoneDesk). Quit it, then choose Restart PhoneDesk.",
                ToolTipIcon.Warning);
            return;
        }
        bool quick = (DateTime.UtcNow - startedAt).TotalSeconds < 30;
        quickCrashes = quick ? quickCrashes + 1 : 0;
        backoffMs = quick ? Math.Min(backoffMs * 2, 30000) : 1000;
        SetStatus("Restarting…");
        if (quickCrashes == 4)
            tray.ShowBalloonTip(8000, "PhoneDesk keeps stopping", "It will keep retrying. Click to see the logs.", ToolTipIcon.Warning);
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
        t.Interval = backoffMs;
        t.Tick += delegate { t.Stop(); t.Dispose(); if (server == null) StartServer(); };
        t.Start();
    }

    void RestartServer()
    {
        quickCrashes = 0;
        backoffMs = 1000;
        if (server == null) { StartServer(); return; }
        Process p = server;
        server = null; // so OnServerExit ignores this one
        StopProcess(p);
        StartServer();
    }

    void StopProcess(Process p)
    {
        Pd.Post(Pd.DashboardUrl + "/api/shutdown", 1500);
        try { if (!p.WaitForExit(2500)) p.Kill(); } catch { }
    }

    void Quit()
    {
        quitting = true;
        poll.Stop();
        tray.Visible = false;
        if (window != null) { try { window.Close(); } catch { } }
        if (server != null) StopProcess(server);
        tray.Dispose();
        ExitThread();
    }

    // ------------------------------------------------------------ status polling
    void Poll()
    {
        if (pollBusy || server == null) return;
        pollBusy = true;
        WebClient wc = new WebClient();
        wc.Encoding = Encoding.UTF8;
        wc.Proxy = null;
        wc.DownloadStringCompleted += delegate(object s, DownloadStringCompletedEventArgs e)
        {
            pollBusy = false;
            wc.Dispose();
            if (e.Error != null || e.Cancelled) { if (server != null && (DateTime.UtcNow - startedAt).TotalSeconds > 10) SetStatus("Not responding"); return; }
            string json = e.Result;
            poll.Interval = 5000;
            Match m = Regex.Match(json, "\"nameUrl\":\"([^\"]+)\"");
            if (m.Success && m.Groups[1].Value != phoneUrl)
            {
                phoneUrl = m.Groups[1].Value;
                addressItem.Text = "Phone address: " + phoneUrl;
            }
            int clientsAt = json.IndexOf("\"clients\":[");
            int phones = 0;
            if (clientsAt >= 0)
            {
                int end = json.IndexOf(']', clientsAt);
                phones = Regex.Matches(json.Substring(clientsAt, end - clientsAt), "\"via\":").Count;
            }
            Match dev = Regex.Match(json, "\"device\":\"([^\"]+)\",\"via\":\"([^\"]+)\"");
            string first = dev.Success ? dev.Groups[1].Value + " · " + dev.Groups[2].Value : "";
            phonesItem.Text = phones == 0 ? "No phone connected" : phones == 1 ? first : phones + " phones connected";
            SetStatus(phones == 0 ? "running" : phones == 1 ? "running · 1 phone" : "running · " + phones + " phones");
            tray.Text = "PhoneDesk: " + (phones == 0 ? "running" : phones == 1 ? "1 phone" : phones + " phones");
            if (lastPhones >= 0 && phones > lastPhones && dev.Success && (window == null || !window.ContainsFocus))
                tray.ShowBalloonTip(4000, "Phone connected", dev.Groups[1].Value + " over " + dev.Groups[2].Value + ".", ToolTipIcon.None);
            lastPhones = phones;
        };
        try { wc.DownloadStringAsync(new Uri(Pd.DashboardUrl + "/api/status")); }
        catch { pollBusy = false; }
    }

    // ------------------------------------------------------------ firewall
    void CheckFirewallLater()
    {
        if (!File.Exists(nodeExe)) return; // dev build using system node
        Thread t = new Thread(delegate ()
        {
            Thread.Sleep(8000);
            bool broken = Pd.FirewallNeedsFix(nodeExe);
            ui.BeginInvoke((MethodInvoker)delegate
            {
                firewallItem.Visible = broken;
                if (broken)
                {
                    firewallBalloon = true;
                    tray.ShowBalloonTip(15000, "Phones on Wi-Fi can't connect yet",
                        "Windows Firewall is blocking PhoneDesk. Click here to allow it (Windows will ask once). USB still works.", ToolTipIcon.Warning);
                }
            });
        });
        t.IsBackground = true;
        t.Start();
    }

    void FixFirewall()
    {
        Thread t = new Thread(delegate ()
        {
            Pd.AddFirewallRule(nodeExe);
            bool broken = Pd.FirewallNeedsFix(nodeExe);
            ui.BeginInvoke((MethodInvoker)delegate
            {
                firewallItem.Visible = broken;
                if (!broken) tray.ShowBalloonTip(4000, "Done", "Phones on your Wi-Fi can now connect to PhoneDesk.", ToolTipIcon.Info);
            });
        });
        t.IsBackground = true;
        t.Start();
    }

    void SetStatus(string s) { statusItem.Text = "PhoneDesk · " + s; }

    // ------------------------------------------------------------ window
    void ShowWindow()
    {
        if (quitting) return;
        if (window == null || window.IsDisposed)
        {
            window = new MainWindow();
            window.FormClosed += delegate { window = null; GC.Collect(); };
        }
        window.Reveal();
    }

    // A second launch of PhoneDesk.exe signals this event to bring the window forward.
    void ListenForShow()
    {
        EventWaitHandle ev = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        Thread t = new Thread(delegate ()
        {
            while (true)
            {
                ev.WaitOne();
                try { ui.BeginInvoke((MethodInvoker)delegate { ShowWindow(); }); } catch { }
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    void CopyAddress()
    {
        try { Clipboard.SetText(phoneUrl); tray.ShowBalloonTip(2500, "Copied", phoneUrl + "\nOpen it in your phone's browser.", ToolTipIcon.Info); } catch { }
    }

    void ToggleStartup()
    {
        bool on = !Pd.StartsWithWindows;
        try { Pd.SetStartWithWindows(on, Application.ExecutablePath); } catch { }
        startupItem.Checked = Pd.StartsWithWindows;
    }

    // ------------------------------------------------------------ logging
    readonly object logLock = new object();
    void Log(string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            try { File.AppendAllText(logFile, line + Environment.NewLine, Encoding.UTF8); } catch { }
        }
    }

    void RotateLog()
    {
        try
        {
            FileInfo f = new FileInfo(logFile);
            if (f.Exists && f.Length > 2 * 1024 * 1024)
            {
                string old = Path.Combine(f.DirectoryName, "server.old.log");
                if (File.Exists(old)) File.Delete(old);
                File.Move(logFile, old);
            }
        }
        catch { }
    }
}

static class Uninstaller
{
    /// quiet: no questions, keeps settings, never asks for admin (for scripts and tests).
    public static int Run(bool quiet)
    {
        if (!quiet && MessageBox.Show("Remove PhoneDesk from this PC?", "Uninstall PhoneDesk", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            return 1;
        string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        Pd.StopRunning(installDir);

        bool deleteSettings = !quiet && MessageBox.Show("Also delete your PhoneDesk settings and shortcut buttons?\n\nChoose No to keep them in case you install PhoneDesk again.",
            "Uninstall PhoneDesk", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;

        try { Pd.SetStartWithWindows(false, ""); } catch { }
        try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(Pd.UninstallKey, false); } catch { }
        Pd.TryDelete(Pd.StartMenuLink);
        Pd.TryDelete(Pd.DesktopLink);
        if (!quiet && Pd.FirewallRuleExists()) Pd.RunElevated("netsh advfirewall firewall delete rule name=\"" + Pd.FirewallRule + "\"");
        if (deleteSettings) { try { Directory.Delete(Pd.DataDir, true); } catch { } }

        // This exe lives in the folder being deleted, so finish the job after it exits.
        ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/d /c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + installDir + "\"");
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Path.GetTempPath();
        try { Process.Start(psi); } catch { }

        if (!quiet) MessageBox.Show("PhoneDesk was removed.", "Uninstall PhoneDesk", MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }
}

class DarkMenuColors : ProfessionalColorTable
{
    static readonly Color Bg = Color.FromArgb(20, 22, 27), Hover = Color.FromArgb(31, 37, 51), Line = Color.FromArgb(42, 46, 56);
    public override Color ToolStripDropDownBackground { get { return Bg; } }
    public override Color MenuBorder { get { return Line; } }
    public override Color MenuItemBorder { get { return Hover; } }
    public override Color MenuItemSelected { get { return Hover; } }
    public override Color MenuItemSelectedGradientBegin { get { return Hover; } }
    public override Color MenuItemSelectedGradientEnd { get { return Hover; } }
    public override Color ImageMarginGradientBegin { get { return Bg; } }
    public override Color ImageMarginGradientMiddle { get { return Bg; } }
    public override Color ImageMarginGradientEnd { get { return Bg; } }
    public override Color SeparatorDark { get { return Line; } }
    public override Color SeparatorLight { get { return Bg; } }
    public override Color CheckBackground { get { return Color.FromArgb(91, 140, 255); } }
    public override Color CheckSelectedBackground { get { return Color.FromArgb(91, 140, 255); } }
    public override Color CheckPressedBackground { get { return Color.FromArgb(91, 140, 255); } }
}

class DarkMenuRenderer : ToolStripProfessionalRenderer
{
    public DarkMenuRenderer() : base(new DarkMenuColors()) { RoundedEdges = false; }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        if (!e.Item.Enabled) e.TextColor = Color.FromArgb(154, 161, 174);
        else if (e.Item.ForeColor != Color.Empty) e.TextColor = e.Item.ForeColor;
        if (e.TextFormat.HasFlag(TextFormatFlags.Right)) e.TextColor = Color.FromArgb(124, 131, 144); // shortcut column
        base.OnRenderItemText(e);
    }

    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
    {
        // A simple check mark instead of the boxed default.
        Rectangle r = e.ImageRectangle;
        using (Pen p = new Pen(Color.FromArgb(91, 140, 255), 2f))
        {
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            e.Graphics.DrawLines(p, new[] { new Point(r.Left + 3, r.Top + r.Height / 2), new Point(r.Left + r.Width / 2 - 1, r.Bottom - 4), new Point(r.Right - 3, r.Top + 4) });
        }
    }
}

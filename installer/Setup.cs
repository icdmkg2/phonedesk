// PhoneDesk-Setup.exe: per-user installer. The app files ride along inside this exe as payload.zip.
// No admin needed; the only elevation is an optional, one-time firewall rule so phones can connect.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("PhoneDesk Setup")]
[assembly: AssemblyProduct("PhoneDesk")]
[assembly: AssemblyDescription("PhoneDesk Setup")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]

static class SetupProgram
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (Array.IndexOf(args, "/silent") >= 0)
        {
            // Unattended install: defaults, no firewall prompt, no launch.
            Installer.Install(Pd.DefaultInstallDir, true, false, false, null);
            return;
        }
        Application.Run(new SetupForm());
    }
}

static class Installer
{
    /// Returns null on success, or an error message. Reports progress 0..100.
    public static string Install(string dir, bool startup, bool desktop, bool firewall, Action<int, string> progress)
    {
        Pd.TraceFile = Path.Combine(Path.GetTempPath(), "PhoneDesk-Setup.log");
        Pd.Trace("install " + Pd.Version + " to " + dir);
        Action<int, string> report = progress;
        int lastPct = -1;
        progress = delegate (int pct, string step)
        {
            if (pct != lastPct) { lastPct = pct; Pd.Trace(pct + "% " + step.Replace("…", "...")); }
            if (report != null) report(pct, step);
        };
        try
        {
            progress(2, "Closing PhoneDesk if it's running…");
            Pd.StopRunning(dir);

            progress(5, "Removing the old version…");
            foreach (string sub in new[] { "app", "runtime" })
            {
                string p = Path.Combine(dir, sub);
                for (int i = 0; i < 10 && Directory.Exists(p); i++)
                {
                    try { Directory.Delete(p, true); } catch { Thread.Sleep(400); }
                }
            }
            Directory.CreateDirectory(dir);

            progress(8, "Copying files…");
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                long total = 0, done = 0;
                foreach (ZipArchiveEntry e in zip.Entries) total += e.Length;
                string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(dir, e.FullName));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                    if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    WriteEntry(e, target);
                    done += e.Length;
                    progress(8 + (int)(80 * done / Math.Max(1, total)), "Copying files…");
                }
            }

            string exe = Path.Combine(dir, "PhoneDesk.exe");
            progress(90, "Adding shortcuts…");
            Pd.CreateShortcut(Pd.StartMenuLink, exe, "", "Use your phone as a desk display for this PC");
            if (desktop) Pd.CreateShortcut(Pd.DesktopLink, exe, "", "Use your phone as a desk display for this PC");
            else Pd.TryDelete(Pd.DesktopLink);
            Pd.SetStartWithWindows(startup, exe);
            WriteUninstallEntry(dir, exe);

            if (firewall)
            {
                progress(94, "Asking Windows to let phones connect…");
                Pd.AddFirewallRule(Path.Combine(dir, "runtime\\node.exe"));
            }
            progress(100, "Done");
            return null;
        }
        catch (Exception ex)
        {
            Pd.Trace("FAILED: " + ex);
            return ex.Message;
        }
    }

    static void WriteEntry(ZipArchiveEntry e, string target)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                using (Stream src = e.Open())
                using (FileStream dst = new FileStream(target, FileMode.Create, FileAccess.Write))
                    src.CopyTo(dst);
                return;
            }
            catch (IOException)
            {
                if (attempt >= 8) throw;
                Thread.Sleep(500); // a file still locked by a process that is shutting down
            }
        }
    }

    static void WriteUninstallEntry(string dir, string exe)
    {
        long kb = 0;
        try { foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) kb += new FileInfo(f).Length / 1024; } catch { }
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Pd.UninstallKey))
        {
            k.SetValue("DisplayName", "PhoneDesk");
            k.SetValue("DisplayVersion", Pd.Version);
            k.SetValue("Publisher", "PhoneDesk");
            k.SetValue("DisplayIcon", exe + ",0");
            k.SetValue("InstallLocation", dir);
            k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
            k.SetValue("EstimatedSize", (int)kb, RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }
}

class SetupForm : Form
{
    readonly Panel options, working, finished;
    readonly CheckBox startup, desktop, firewall, launch;
    readonly ProgressBar bar;
    readonly Label stepLabel, doneText;
    readonly Button primary, cancel;
    readonly string dir = Pd.DefaultInstallDir;
    int stage; // 0 options, 1 installing, 2 done

    static readonly Color Accent = Color.FromArgb(59, 108, 246);
    static readonly Color Muted = Color.FromArgb(90, 96, 108);

    public SetupForm()
    {
        bool upgrading = File.Exists(Path.Combine(dir, "PhoneDesk.exe"));
        Text = "PhoneDesk Setup";
        Font = new Font("Segoe UI", 9.75f);
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96f, 96f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(520, 360);
        BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        // Header
        Panel header = new Panel { Dock = DockStyle.Top, Height = 92, BackColor = Color.FromArgb(14, 15, 18) };
        PictureBox logo = new PictureBox { Size = new Size(48, 48), Location = new Point(24, 22), SizeMode = PictureBoxSizeMode.Zoom };
        try { logo.Image = new Icon(Icon, 48, 48).ToBitmap(); } catch { }
        Label title = new Label { Text = upgrading ? "Update PhoneDesk" : "Install PhoneDesk", ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 15f), AutoSize = true, Location = new Point(84, 22) };
        Label sub = new Label { Text = "Version " + Pd.Version + " · Your phone as a desk display for this PC", ForeColor = Color.FromArgb(163, 168, 179), AutoSize = true, Location = new Point(86, 54) };
        header.Controls.AddRange(new Control[] { logo, title, sub });

        // Options page
        options = new Panel { Location = new Point(0, 92), Size = new Size(520, 210) };
        Label where = new Label { Text = "Installs for your Windows account only, no admin needed:\n" + dir, ForeColor = Muted, Location = new Point(24, 18), Size = new Size(472, 40) };
        startup = new CheckBox { Text = "Start PhoneDesk with Windows (runs quietly in the tray)", Checked = true, Location = new Point(26, 70), AutoSize = true };
        firewall = new CheckBox { Text = "Let phones on my Wi-Fi connect (Windows will ask once)", Checked = true, Location = new Point(26, 100), AutoSize = true };
        desktop = new CheckBox { Text = "Add a desktop shortcut", Checked = false, Location = new Point(26, 130), AutoSize = true };
        if (upgrading)
        {
            startup.Checked = Pd.StartsWithWindows;
            desktop.Checked = File.Exists(Pd.DesktopLink);
            firewall.Checked = Pd.FirewallNeedsFix(Path.Combine(dir, "runtime", "node.exe"));
            if (!firewall.Checked) firewall.Text = "Let phones on my Wi-Fi connect (already allowed)";
        }
        options.Controls.AddRange(new Control[] { where, startup, firewall, desktop });

        // Working page
        working = new Panel { Location = new Point(0, 92), Size = new Size(520, 210), Visible = false };
        stepLabel = new Label { Text = "Getting ready…", Location = new Point(24, 60), Size = new Size(472, 22) };
        bar = new ProgressBar { Location = new Point(24, 88), Size = new Size(472, 10), Maximum = 100, Style = ProgressBarStyle.Continuous };
        working.Controls.AddRange(new Control[] { stepLabel, bar });

        // Finished page
        finished = new Panel { Location = new Point(0, 92), Size = new Size(520, 210), Visible = false };
        Label doneTitle = new Label { Text = "PhoneDesk is installed", Font = new Font("Segoe UI Semibold", 12f), Location = new Point(24, 20), AutoSize = true };
        doneText = new Label { ForeColor = Muted, Location = new Point(24, 52), Size = new Size(472, 100),
            Text = "It runs in the background. Look for its icon in the tray, near the clock.\n\n" +
                   "On your phone, open  http://phonedesk.local  in the browser, or plug it in by USB with USB debugging turned on." };
        launch = new CheckBox { Text = "Open PhoneDesk now", Checked = true, Location = new Point(26, 160), AutoSize = true };
        finished.Controls.AddRange(new Control[] { doneTitle, doneText, launch });

        // Footer
        Panel footer = new Panel { Dock = DockStyle.Bottom, Height = 58, BackColor = Color.FromArgb(246, 247, 249) };
        primary = new Button { Text = upgrading ? "Update" : "Install", Size = new Size(110, 32), Location = new Point(392, 13), FlatStyle = FlatStyle.Flat, BackColor = Accent, ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 9.75f) };
        primary.FlatAppearance.BorderSize = 0;
        cancel = new Button { Text = "Cancel", Size = new Size(90, 32), Location = new Point(292, 13), FlatStyle = FlatStyle.System };
        primary.Click += delegate { OnPrimary(); };
        cancel.Click += delegate { Close(); };
        footer.Controls.AddRange(new Control[] { cancel, primary });

        Controls.AddRange(new Control[] { options, working, finished, footer, header });
        AcceptButton = primary;
    }

    void OnPrimary()
    {
        if (stage == 0) StartInstall();
        else if (stage == 2)
        {
            if (launch.Checked) { try { Process.Start(Path.Combine(dir, "PhoneDesk.exe")); } catch { } }
            Close();
        }
    }

    void StartInstall()
    {
        stage = 1;
        options.Visible = false;
        working.Visible = true;
        primary.Enabled = false;
        cancel.Enabled = false;
        bool s = startup.Checked, d = desktop.Checked, f = firewall.Checked;
        Thread t = new Thread(delegate ()
        {
            string err = Installer.Install(dir, s, d, f, delegate (int pct, string step)
            {
                BeginInvoke((MethodInvoker)delegate { bar.Value = Math.Min(100, pct); stepLabel.Text = step; });
            });
            BeginInvoke((MethodInvoker)delegate { Done(err); });
        });
        t.IsBackground = true;
        t.Start();
    }

    void Done(string err)
    {
        if (err != null)
        {
            MessageBox.Show(this, "Setup couldn't finish:\n\n" + err + "\n\nClose PhoneDesk if it's open and try again.", "PhoneDesk Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            stage = 0;
            working.Visible = false;
            options.Visible = true;
            primary.Enabled = true;
            cancel.Enabled = true;
            return;
        }
        stage = 2;
        working.Visible = false;
        finished.Visible = true;
        if (firewall.Checked && Pd.FirewallNeedsFix(Path.Combine(dir, "runtime", "node.exe")))
            doneText.Text += "\n\nWindows didn't add the firewall rule. If it asks later whether to allow PhoneDesk, choose Allow.";
        primary.Text = "Finish";
        primary.Enabled = true;
        cancel.Visible = false;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (stage == 1) { e.Cancel = true; return; } // don't leave a half-installed copy
        base.OnFormClosing(e);
    }
}

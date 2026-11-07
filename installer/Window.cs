// The PhoneDesk window: the dashboard in a real app window (WebView2, the Edge engine built into
// Windows), with a dark native title bar. Closing it frees its memory; PhoneDesk keeps running in
// the tray.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class MainWindow : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    readonly WebView2 web;
    readonly Label loading;
    readonly string boundsFile = Path.Combine(Pd.DataDir, "window.txt");
    readonly Timer retry = new Timer();
    string origin;

    public static readonly Color Bg = Color.FromArgb(11, 12, 15);

    public MainWindow()
    {
        Text = "PhoneDesk";
        BackColor = Bg;
        ForeColor = Color.FromArgb(237, 239, 243);
        Font = new Font("Segoe UI", 10f);
        MinimumSize = new Size(900, 620);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1240, 820);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        RestoreBounds_();

        loading = new Label();
        loading.Text = "Starting PhoneDesk…";
        loading.ForeColor = Color.FromArgb(154, 161, 174);
        loading.TextAlign = ContentAlignment.MiddleCenter;
        loading.Dock = DockStyle.Fill;
        Controls.Add(loading);

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Bg; // no white flash while loading
        web.Visible = false;
        Controls.Add(web);

        retry.Interval = 1000;
        retry.Tick += delegate { retry.Stop(); Go(); };

        InitWeb();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Dark title bar (Windows 10 2004+) and, on Windows 11, the exact app colors.
        Dwm(20, 1);                 // DWMWA_USE_IMMERSIVE_DARK_MODE
        Dwm(35, 0x000F0C0B);        // DWMWA_CAPTION_COLOR  #0B0C0F (BGR)
        Dwm(36, 0x00D8CEC9);        // DWMWA_TEXT_COLOR     #C9CED8
        Dwm(34, 0x0029211E);        // DWMWA_BORDER_COLOR   #1E2129
    }

    void Dwm(int attr, int value)
    {
        try { DwmSetWindowAttribute(Handle, attr, ref value, 4); } catch { }
    }

    async void InitWeb()
    {
        try
        {
            string dataDir = Path.Combine(Pd.DataDir, "webview");
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
            await web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            // Usually: the WebView2 runtime isn't installed (only on older Windows 10).
            Fallback(ex);
            return;
        }
        CoreWebView2Settings s = web.CoreWebView2.Settings;
        s.AreDevToolsEnabled = Environment.GetEnvironmentVariable("PHONEDESK_DEVTOOLS") == "1";
        s.IsStatusBarEnabled = false;
        s.AreDefaultContextMenusEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsGeneralAutofillEnabled = false;

        // Anything that isn't the dashboard opens in the normal browser.
        web.CoreWebView2.NewWindowRequested += delegate (object o, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            Pd.OpenUrl(e.Uri);
        };
        web.CoreWebView2.NavigationStarting += delegate (object o, CoreWebView2NavigationStartingEventArgs e)
        {
            if (origin != null && !e.Uri.StartsWith(origin, StringComparison.OrdinalIgnoreCase) && !e.Uri.StartsWith("data:"))
            {
                e.Cancel = true;
                Pd.OpenUrl(e.Uri);
            }
        };
        web.CoreWebView2.NavigationCompleted += delegate (object o, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                web.Visible = true;
                loading.Visible = false;
            }
            else
            {
                // Server still starting (or restarting): try again shortly.
                loading.Text = "Waiting for PhoneDesk to start…";
                loading.Visible = true;
                web.Visible = false;
                retry.Start();
            }
        };
        Go();
    }

    void Go()
    {
        if (web.CoreWebView2 == null) return;
        origin = Pd.DashboardUrl;
        web.CoreWebView2.Navigate(origin + "/dashboard?app=1");
    }

    void Fallback(Exception ex)
    {
        loading.Text = "PhoneDesk needs the Microsoft Edge WebView2 Runtime to show its window.\n\n" +
                       "Your dashboard is opening in the browser instead.";
        Pd.OpenUrl(Pd.DashboardUrl);
        if (ex is WebView2RuntimeNotFoundException)
        {
            if (MessageBox.Show(this, "PhoneDesk's window needs the Microsoft Edge WebView2 Runtime, which isn't installed.\n\nOpen the download page?",
                "PhoneDesk", MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                Pd.OpenUrl("https://developer.microsoft.com/microsoft-edge/webview2/");
        }
    }

    // ------------------------------------------------------------ remember size and position
    void RestoreBounds_()
    {
        try
        {
            string[] p = File.ReadAllText(boundsFile).Split(',');
            Rectangle r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
            // Only if it's still on a connected screen.
            foreach (Screen sc in Screen.AllScreens)
            {
                if (sc.WorkingArea.IntersectsWith(r))
                {
                    StartPosition = FormStartPosition.Manual;
                    Bounds = r;
                    if (p.Length > 4 && p[4] == "max") WindowState = FormWindowState.Maximized;
                    break;
                }
            }
        }
        catch { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        try
        {
            Rectangle r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(boundsFile, r.X + "," + r.Y + "," + r.Width + "," + r.Height + "," + (WindowState == FormWindowState.Maximized ? "max" : "normal"));
        }
        catch { }
        retry.Stop();
        base.OnFormClosing(e);
    }

    public void Reveal()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
        BringToFront();
    }
}

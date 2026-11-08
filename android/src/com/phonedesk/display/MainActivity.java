package com.phonedesk.display;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.os.BatteryManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * PhoneDesk for the phone: a full-screen, always-on window onto the PC's PhoneDesk page.
 * It finds the PC by itself (phonedesk.local or a saved address), keeps the screen awake, locks landscape,
 * and hands the battery level to the page, which browsers don't do over plain http.
 */
public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile String base = null;
    private volatile boolean running = true;
    private volatile boolean discovering = false;
    private volatile boolean down = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            // Draw behind the camera hole / notch instead of leaving a black bar next to it.
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        prefs = getSharedPreferences("phonedesk", MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " PhoneDeskApp/1");
        web.addJavascriptInterface(new Bridge(), "PhoneDeskApp");
        web.setWebViewClient(new Client());
        web.loadUrl("file:///android_asset/wait.html");
        startDiscovery();
        startWatchdog();
    }

    private class Client extends WebViewClient {
        @Override
        public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (r.isForMainFrame() && base != null) {
                base = null;
                web.loadUrl("file:///android_asset/wait.html");
                startDiscovery();
            }
        }
    }

    private void status(final String text) {
        ui.post(new Runnable() {
            public void run() {
                String safe = text.replace("\\", "").replace("'", "");
                web.evaluateJavascript("window.setStatus && setStatus('" + safe + "')", null);
            }
        });
    }

    private static String norm(String a) {
        a = a.trim();
        if (a.isEmpty()) return a;
        if (!a.startsWith("http://") && !a.startsWith("https://")) a = "http://" + a;
        while (a.endsWith("/")) a = a.substring(0, a.length() - 1);
        return a;
    }

    private boolean ok(String u) {
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(u + "/phone/icon.svg").openConnection();
            h.setConnectTimeout(2000);
            h.setReadTimeout(2000);
            return h.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (h != null) h.disconnect();
        }
    }

    private String find() {
        List<String> c = new ArrayList<String>();
        String saved = norm(prefs.getString("addr", ""));
        if (!saved.isEmpty()) c.add(saved);
        String ip = Mdns.resolve(this, "phonedesk.local");
        if (ip != null) { c.add("http://" + ip); c.add("http://" + ip + ":8765"); }
        c.add("http://phonedesk.local");
        for (String x : c) if (ok(x)) return x;
        return null;
    }

    private void startDiscovery() {
        if (discovering) return;
        discovering = true;
        new Thread(new Runnable() {
            public void run() {
                try {
                    while (running) {
                        status("Looking for PhoneDesk on your network…");
                        final String found = find();
                        if (found != null) {
                            base = found;
                            ui.post(new Runnable() { public void run() { web.loadUrl(found + "/phone"); } });
                            return;
                        }
                        status("PhoneDesk isn't running on your PC, or it's on another network. Retrying…");
                        try { Thread.sleep(3000); } catch (InterruptedException e) { return; }
                    }
                } finally {
                    discovering = false;
                }
            }
        }).start();
    }

    // If the PC comes back at a different address, follow it. A PC that is simply off is left alone, so the page's own
    // offline clock keeps showing.
    private void startWatchdog() {
        new Thread(new Runnable() {
            public void run() {
                while (running) {
                    try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
                    String cur = base;
                    if (cur != null && ok(cur)) {
                        if (down) {
                            down = false;
                            ui.post(new Runnable() { public void run() { web.evaluateJavascript("window.pdReconnect && pdReconnect()", null); } });
                        }
                        continue;
                    }
                    if (cur == null) continue;
                    down = true;
                    String ip = Mdns.resolve(MainActivity.this, "phonedesk.local");
                    if (ip == null) continue;
                    final String n = "http://" + ip;
                    if (!n.equals(cur) && ok(n)) {
                        base = n;
                        ui.post(new Runnable() { public void run() { web.loadUrl(n + "/phone"); } });
                    }
                }
            }
        }).start();
    }

    private Intent batteryIntent() {
        return registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    }

    /** What the page can call as window.PhoneDeskApp.* (same names as Fully Kiosk's interface). */
    private class Bridge {
        @JavascriptInterface
        public int getBatteryLevel() {
            Intent i = batteryIntent();
            if (i == null) return -1;
            int level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            return level < 0 ? -1 : Math.round(level * 100f / scale);
        }

        @JavascriptInterface
        public boolean isPlugged() {
            Intent i = batteryIntent();
            return i != null && i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
        }

        @JavascriptInterface
        public void setAddress(String a) {
            prefs.edit().putString("addr", a == null ? "" : a.trim()).apply();
            startDiscovery();
        }

        @JavascriptInterface
        public String version() { return "1"; }
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    public void onBackPressed() { /* kiosk: Back does nothing */ }

    @Override
    protected void onResume() { super.onResume(); web.onResume(); }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); }

    @Override
    protected void onDestroy() { running = false; super.onDestroy(); }
}

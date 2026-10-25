package com.reva.harness;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * REVA standalone app: the entire harness runs INSIDE the app via an embedded
 * Node.js runtime (nodejs-mobile). The WebView talks to 127.0.0.1:7463 — no
 * external server is needed. A "connect to remote" fallback is kept for
 * users who run REVA on a PC instead.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "reva";
    private static final String KEY_MODE = "mode";           // "standalone" | "remote"
    private static final String KEY_SERVER = "server_url";   // for remote mode
    private static final String LOCAL_URL = "http://127.0.0.1:7463";

    private SharedPreferences prefs;
    private WebView web;
    private ScrollView setupRoot;
    private LinearLayout setup;
    private EditText urlInput;
    private TextView status;
    private NodeRunner nodeRunner;
    private boolean nodeStarted = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        buildWebView();
        buildSetupUi();

        String mode = prefs.getString(KEY_MODE, "standalone");
        if ("remote".equals(mode)) {
            String saved = prefs.getString(KEY_SERVER, "");
            if (!saved.isEmpty()) {
                showWeb(saved);
                return;
            }
        }
        startStandalone();
    }

    // ---- standalone mode ----------------------------------------------------

    private void startStandalone() {
        showSetupStatus("Starting REVA on-device…");
        setContentView(setupRoot);
        try {
            copyAssetProject();
            if (!nodeStarted) {
                nodeRunner = new NodeRunner();
                nodeRunner.start(new File(getFilesDir(), "nodejs-project/standalone.js").getAbsolutePath());
                nodeStarted = true;
            }
            new Thread(() -> {
                if (waitUntilHealthy(60)) { // up to ~15s: first run initializes dirs
                    runOnUiThread(() -> showWeb(LOCAL_URL));
                } else {
                    runOnUiThread(() -> showSetup("Embedded REVA did not start. Retry, or connect to a server on your network."));
                }
            }, "reva-health").start();
        } catch (Exception e) {
            showSetup("Failed to start embedded REVA: " + e.getMessage());
        }
    }

    /** Copies the bundled REVA runtime from APK assets to app storage. */
    private void copyAssetProject() throws Exception {
        File target = new File(getFilesDir(), "nodejs-project");
        deleteRecursive(target);
        copyAssetDir("", target);
    }

    private void copyAssetDir(String assetPath, File toDir) throws Exception {
        toDir.mkdirs();
        String[] entries = getAssets().list(assetPath.isEmpty() ? "nodejs-project" : "nodejs-project/" + assetPath);
        if (entries == null) return;
        for (String entry : entries) {
            String childAsset = assetPath.isEmpty() ? entry : assetPath + "/" + entry;
            File childFile = new File(toDir, entry);
            if (getAssets().list("nodejs-project/" + childAsset).length == 0) {
                try (InputStream in = getAssets().open("nodejs-project/" + childAsset);
                     OutputStream out = new java.io.FileOutputStream(childFile)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
            } else {
                copyAssetDir(childAsset, childFile);
            }
        }
    }

    private static void deleteRecursive(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursive(c);
        f.delete();
    }

    /** Polls http://127.0.0.1:7463/health until it answers or attempts run out. */
    private boolean waitUntilHealthy(int attempts) {
        for (int i = 0; i < attempts; i++) {
            try {
                HttpURLConnection conn = (HttpURLConnection)
                        new URL(LOCAL_URL + "/health").openConnection();
                conn.setConnectTimeout(500);
                conn.setReadTimeout(500);
                int code = conn.getResponseCode();
                conn.disconnect();
                if (code == 200) return true;
            } catch (Exception ignored) {
            }
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                return false;
            }
        }
        return false;
    }

    // ---- remote mode (fallback) ----------------------------------------------

    private void connectRemote() {
        String url = normalize(urlInput.getText().toString());
        if (url == null) {
            status.setText("Enter a valid address, e.g. http://192.168.1.20:7463");
            return;
        }
        prefs.edit().putString(KEY_MODE, "remote").putString(KEY_SERVER, url).apply();
        showWeb(url);
    }

    // ---- shared UI -----------------------------------------------------------

    private void buildWebView() {
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // REVA PWA stores its session token here
        web.setBackgroundColor(Color.BLACK);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    String mode = prefs.getString(KEY_MODE, "standalone");
                    if ("standalone".equals(mode)) {
                        // The embedded server died (device reboot clears the
                        // process but not the activity stack) — restart it.
                        startStandalone();
                    } else {
                        showSetup("Server unreachable — check the address and that 'reva serve' is running.");
                    }
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                String currentHost = prefs.getString(KEY_MODE, "standalone").equals("remote")
                        ? Uri.parse(prefs.getString(KEY_SERVER, "")).getHost()
                        : "127.0.0.1";
                String host = uri.getHost();
                if (host == null || currentHost == null || !host.equals(currentHost)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return false;
            }
        });
    }

    private void showWeb(String url) {
        setContentView(web);
        web.loadUrl(url);
    }

    private void buildSetupUi() {
        setup = new LinearLayout(this);
        setup.setOrientation(LinearLayout.VERTICAL);
        setup.setBackgroundColor(Color.BLACK);
        int pad = dp(24);
        setup.setPadding(pad, pad * 3, pad, pad);

        TextView title = new TextView(this);
        title.setText("REVA");
        title.setTextColor(Color.WHITE);
        title.setTextSize(30);
        title.setLetterSpacing(0.25f);
        setup.addView(title);

        TextView tagline = new TextView(this);
        tagline.setText("AGENT HARNESS — STANDALONE");
        tagline.setTextColor(0xFF8A8A8A);
        tagline.setTextSize(11);
        tagline.setLetterSpacing(0.3f);
        tagline.setPadding(0, dp(2), 0, dp(20));
        setup.addView(tagline);

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(14);
        status.setLineSpacing(dp(2), 1f);
        status.setPadding(0, 0, 0, dp(20));
        setup.addView(status);

        Button retry = new Button(this);
        retry.setText("START ON-DEVICE");
        retry.setTextColor(Color.BLACK);
        retry.setBackgroundColor(Color.WHITE);
        retry.setOnClickListener(v -> {
            prefs.edit().putString(KEY_MODE, "standalone").apply();
            startStandalone();
        });
        setup.addView(retry);

        TextView or = new TextView(this);
        or.setText("— or connect to a server on your network —");
        or.setTextColor(0xFF8A8A8A);
        or.setTextSize(12);
        or.setPadding(0, dp(20), 0, dp(12));
        setup.addView(or);

        urlInput = new EditText(this);
        urlInput.setHint("http://192.168.1.20:7463");
        urlInput.setTextColor(Color.WHITE);
        urlInput.setHintTextColor(0xFF555555);
        urlInput.setSingleLine(true);
        urlInput.setTextSize(15);
        setup.addView(urlInput);

        Button remote = new Button(this);
        remote.setText("CONNECT TO REMOTE");
        remote.setTextColor(Color.WHITE);
        remote.setBackgroundColor(0xFF1A1A1A);
        remote.setOnClickListener(v -> connectRemote());
        setup.addView(remote);

        ScrollView scroller = new ScrollView(this);
        scroller.addView(setup);
        setupRoot = scroller;
    }

    private void showSetup(String message) {
        web.stopLoading();
        if (message != null) status.setText(message);
        setContentView(setupRoot);
    }

    private void showSetupStatus(String message) {
        if (message != null) status.setText(message);
    }

    private String normalize(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return null;
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u.matches("https?://[^\\s]+") ? u : null;
    }

    @Override
    public void onBackPressed() {
        if (web.getVisibility() == View.VISIBLE && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}

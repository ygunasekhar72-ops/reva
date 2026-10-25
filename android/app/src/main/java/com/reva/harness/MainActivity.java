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

import java.net.URL;

/**
 * REVA Android shell: a minimal WebView over a REVA server (your own machine,
 * a LAN box, or REVA running in Termux on this same phone at 127.0.0.1).
 * First run asks for the server URL; the choice is remembered locally.
 * Zero third-party dependencies.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "reva";
    private static final String KEY_SERVER = "server_url";

    private SharedPreferences prefs;
    private WebView web;
    private ScrollView setupRoot;
    private LinearLayout setup;
    private EditText urlInput;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        buildWebView();
        buildSetupUi();
        String saved = prefs.getString(KEY_SERVER, "");
        if (saved.isEmpty()) {
            showSetup(null);
        } else {
            openServer(saved);
        }
    }

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
                    showSetup("REVA server unreachable — check the address, make sure 'reva serve' is running, and that the phone is on the same network.");
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                String serverHost = Uri.parse(prefs.getString(KEY_SERVER, "")).getHost();
                String host = uri.getHost();
                if (host == null || serverHost == null || !host.equals(serverHost)) {
                    // External link (e.g. docs opened from the PWA) → system browser
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
        tagline.setText("AGENT HARNESS");
        tagline.setTextColor(0xFF8A8A8A);
        tagline.setTextSize(11);
        tagline.setLetterSpacing(0.3f);
        tagline.setPadding(0, dp(2), 0, dp(20));
        setup.addView(tagline);

        TextView hint = new TextView(this);
        String text = "Connect to your REVA server.\n\n"
                + "• PC on the same Wi-Fi:  http://192.168.x.x:7463\n"
                + "• REVA in Termux on this phone:  http://127.0.0.1:7463\n"
                + "• Public server:  https://your-domain";
        hint.setText(text);
        hint.setTextColor(0xFF8A8A8A);
        hint.setTextSize(13);
        hint.setLineSpacing(dp(2), 1f);
        hint.setPadding(0, 0, 0, dp(20));
        setup.addView(hint);

        urlInput = new EditText(this);
        urlInput.setHint("http://192.168.1.20:7463");
        urlInput.setTextColor(Color.WHITE);
        urlInput.setHintTextColor(0xFF555555);
        urlInput.setSingleLine(true);
        urlInput.setTextSize(15);
        setup.addView(urlInput);

        Button connect = new Button(this);
        connect.setText("CONNECT");
        connect.setTextColor(Color.BLACK);
        connect.setBackgroundColor(Color.WHITE);
        connect.setOnClickListener(v -> openServer(urlInput.getText().toString()));
        setup.addView(connect);

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(13);
        status.setPadding(0, dp(16), 0, 0);
        setup.addView(status);

        ScrollView scroller = new ScrollView(this);
        scroller.addView(setup);
        setupRoot = scroller;
    }

    private void showSetup(String message) {
        web.stopLoading();
        if (message != null) status.setText(message);
        setContentView(setupRoot);
    }

    private void openServer(String raw) {
        String url = normalize(raw);
        if (url == null) {
            status.setText("Enter a valid address, e.g. http://192.168.1.20:7463");
            return;
        }
        prefs.edit().putString(KEY_SERVER, url).apply();
        setContentView(web);
        web.loadUrl(url);
    }

    private String normalize(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return null;
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        try {
            new URL(u);
        } catch (Exception e) {
            return null;
        }
        return u;
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

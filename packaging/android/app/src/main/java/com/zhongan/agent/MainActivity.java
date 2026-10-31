package com.zhongan.agent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

public class MainActivity extends Activity {
    private WebView webView;
    private String serverUrl;
    private boolean errorDialogShown = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#C4142A"));
        getWindow().setNavigationBarColor(Color.parseColor("#F2F0EB"));
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 7);
        }

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " ZhonganAgentApp/1.0");
        if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(false);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean audio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
                }
                String host = request.getOrigin() == null ? "" : request.getOrigin().getHost();
                String allowedHost = Uri.parse(serverUrl).getHost();
                if (audio && host != null && host.equals(allowedHost)) request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                else request.deny();
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                String allowedHost = Uri.parse(serverUrl).getHost();
                if (host != null && host.equals(allowedHost)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !errorDialogShown) showServerDialog();
            }
        });

        webView.setOnLongClickListener(v -> {
            showServerDialog();
            return true;
        });

        SharedPreferences prefs = getSharedPreferences("zhongan", MODE_PRIVATE);
        serverUrl = prefs.getString("server_url", getString(R.string.server_url));
        loadServer();
    }

    private void loadServer() {
        errorDialogShown = false;
        webView.loadUrl(serverUrl);
    }

    private void showServerDialog() {
        errorDialogShown = true;
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(serverUrl);
        input.setSelection(input.getText().length());
        new AlertDialog.Builder(this)
            .setTitle("服务器地址")
            .setMessage("填写众安 Agent 的 HTTPS 地址；离线版请使用桌面客户端。")
            .setView(input)
            .setPositiveButton("打开", (dialog, which) -> {
                String value = input.getText().toString().trim();
                if (value.isEmpty()) return;
                if (!value.startsWith("https://") && !value.startsWith("http://")) value = "https://" + value;
                serverUrl = value.replaceAll("/+$", "");
                getSharedPreferences("zhongan", MODE_PRIVATE).edit().putString("server_url", serverUrl).apply();
                loadServer();
            })
            .setNegativeButton("取消", null)
            .show();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
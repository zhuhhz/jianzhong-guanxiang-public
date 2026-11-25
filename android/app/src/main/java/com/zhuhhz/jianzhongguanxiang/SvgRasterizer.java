package com.zhuhhz.jianzhongguanxiang;

import android.os.Handler;
import android.util.Base64;
import android.webkit.WebView;

import java.util.Locale;
import java.util.function.Consumer;

/** Renders validated SVG as an image in an offline WebView without a JavaScript bridge. */
final class SvgRasterizer {
    private static final int MAX_SIDE = 1365;
    private final WebView view;
    private final Handler handler;
    private int request;
    private Runnable pendingPoll;

    SvgRasterizer(WebView view, Handler handler) {
        this.view = view;
        this.handler = handler;
    }

    void render(byte[] svg, int width, int height, Consumer<String> result) {
        cancel();
        if (width < 1 || height < 1) {
            result.accept(null);
            return;
        }
        int outputWidth = scaledSide(width, height);
        int outputHeight = scaledSide(height, width);
        int id = request;
        String nonce = "jzg-svg-" + id;
        // SVG enters the document only as a base64 image, not as executable DOM.
        String html = String.format(Locale.ROOT, """
            <!doctype html><meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'nonce-%s'; base-uri 'none'; form-action 'none'">
            <script nonce="%s">
            window.jzgSvgId = %d;
            const image = new Image();
            image.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = %d;
                    canvas.height = %d;
                    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                    window.jzgSvgPng = canvas.toDataURL('image/png').split(',')[1] || false;
                } catch (_) {
                    window.jzgSvgPng = false;
                }
            };
            image.onerror = () => { window.jzgSvgPng = false; };
            image.src = 'data:image/svg+xml;base64,%s';
            </script>
            """, nonce, nonce, id, outputWidth, outputHeight, Base64.encodeToString(svg, Base64.NO_WRAP));
        view.getSettings().setJavaScriptEnabled(true);
        view.loadDataWithBaseURL("about:blank", html, "text/html", "UTF-8", null);
        schedulePoll(id, 0, result);
    }

    static int scaledSide(int side, int otherSide) {
        double scale = Math.min(1, MAX_SIDE / (double) Math.max(side, otherSide));
        return Math.max(1, (int) Math.round(side * scale));
    }

    private void schedulePoll(int id, int attempt, Consumer<String> result) {
        pendingPoll = () -> {
            pendingPoll = null;
            if (id != request) return;
            view.evaluateJavascript("window.jzgSvgId === " + id + " && window.jzgSvgPng !== undefined ? window.jzgSvgPng : null", value -> {
                if (id != request) return;
                if (value != null && value.length() > 2 && value.charAt(0) == '"') {
                    resetPage();
                    result.accept(value.substring(1, value.length() - 1));
                } else if ("false".equals(value) || attempt >= 39) {
                    resetPage();
                    result.accept(null);
                } else {
                    schedulePoll(id, attempt + 1, result);
                }
            });
        };
        handler.postDelayed(pendingPoll, 100);
    }

    private void resetPage() {
        view.getSettings().setJavaScriptEnabled(false);
        view.loadUrl("about:blank");
    }

    void cancel() {
        request++;
        if (pendingPoll != null) handler.removeCallbacks(pendingPoll);
        pendingPoll = null;
    }
}

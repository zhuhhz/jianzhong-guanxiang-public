package com.zhuhhz.jianzhongguanxiang;

import android.os.Handler;
import android.os.SystemClock;
import android.webkit.WebView;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.Locale;
import java.util.function.Consumer;

/** Presents length-bounded canonical frames in the isolated no-bridge SVG view. */
final class SvgPlayback {
    enum State { READY, PLAYING, PAUSED, ENDED, FAILED }
    interface Frames {
        void read(double seconds, Consumer<String> result);
    }

    private static final int FRAME_INTERVAL_MS = 50;
    private static final int DECODE_TIMEOUT_MS = 8000;
    private static final int MAX_BASE64_LENGTH = (256 * 1024 + 2) / 3 * 4;
    private final WebView view;
    private final Handler main;
    private final int sourceWidth, sourceHeight;
    private final double duration;
    private final Frames frames;
    private final Runnable onFrame;
    private final Consumer<State> onState;
    private State state = State.READY;
    private Runnable pending, timeout;
    private boolean loaded, disposed, presented;
    private long started, request;
    private double seconds;

    SvgPlayback(WebView view, Handler main, int width, int height, double duration, Frames frames,
                Runnable onFrame, Consumer<State> onState) {
        this.view = view;
        this.main = main;
        this.sourceWidth = width;
        this.sourceHeight = height;
        this.duration = duration;
        this.frames = frames;
        this.onFrame = onFrame;
        this.onState = onState;
    }

    void toggle() {
        if (state == State.PLAYING) pause();
        else if (state == State.ENDED) restart();
        else play();
    }

    void restart() {
        if (disposed || state == State.FAILED) return;
        pause();
        seconds = 0;
        play();
    }

    void pause() {
        if (state != State.PLAYING) return;
        cancelPending();
        view.evaluateJavascript("if (window.jzgSvgCancelFrame) window.jzgSvgCancelFrame()", null);
        updateState(State.PAUSED);
    }

    void dispose() {
        disposed = true;
        cancelPending();
        if (loaded || state == State.PLAYING || state == State.PAUSED) {
            view.getSettings().setJavaScriptEnabled(false);
        }
    }

    private void play() {
        if (disposed || state == State.FAILED || state == State.PLAYING) return;
        updateState(State.PLAYING);
        if (!loaded) {
            loadPage();
            final long id = ++request;
            startTimeout(id);
            pollPage(id);
        } else {
            started = SystemClock.uptimeMillis() - Math.round(seconds * 1000);
            drawFrame();
        }
    }

    private void updateState(State next) {
        state = next;
        onState.accept(next);
    }

    private void cancelPending() {
        request++;
        if (pending != null) main.removeCallbacks(pending);
        pending = null;
        stopTimeout();
    }

    private void startTimeout(long id) {
        stopTimeout();
        timeout = () -> { if (active(id)) fail(); };
        main.postDelayed(timeout, DECODE_TIMEOUT_MS);
    }

    private void stopTimeout() {
        if (timeout != null) main.removeCallbacks(timeout);
        timeout = null;
    }

    private void schedule(Runnable action, long delay) {
        pending = () -> {
            pending = null;
            action.run();
        };
        main.postDelayed(pending, delay);
    }

    private boolean active(long id) {
        return !disposed && state == State.PLAYING && id == request;
    }

    private void pollPage(long id) {
        if (!active(id)) return;
        view.evaluateJavascript("typeof window.jzgSvgDrawFrame === 'function'", result -> {
            if (!active(id)) return;
            if ("true".equals(result)) {
                loaded = true;
                started = SystemClock.uptimeMillis() - Math.round(seconds * 1000);
                drawFrame();
            } else schedule(() -> pollPage(id), FRAME_INTERVAL_MS);
        });
    }

    private void drawFrame() {
        final long now = SystemClock.uptimeMillis();
        final double position = Math.min(duration, (now - started) / 1000.0);
        final long id = ++request;
        // Include both WebViews in the timeout in case a renderer callback is lost.
        startTimeout(id);
        frames.read(position, encoded -> {
            if (!active(id)) return;
            if (encoded == null || encoded.length() < 3 || encoded.length() > MAX_BASE64_LENGTH + 2
                    || encoded.charAt(0) != '"' || encoded.charAt(encoded.length() - 1) != '"') {
                fail();
                return;
            }
            // Re-quote the data at the receiving boundary. Only a string can reach the display.
            try {
                Object frame = new JSONTokener(encoded).nextValue();
                if (!(frame instanceof String)) { fail(); return; }
                view.evaluateJavascript("window.jzgSvgDrawFrame(" + id + ","
                    + JSONObject.quote((String) frame) + ")", null);
            } catch (Exception error) {
                fail();
                return;
            }
            schedule(() -> pollFrame(id, position, now), FRAME_INTERVAL_MS);
        });
    }

    private void pollFrame(long id, double position, long since) {
        if (!active(id)) return;
        view.evaluateJavascript("window.jzgSvgFrameResult", result -> {
            if (!active(id)) return;
            if (Long.toString(id).equals(result)) {
                stopTimeout();
                seconds = position;
                if (!presented) {
                    presented = true;
                    view.postVisualStateCallback(id, new WebView.VisualStateCallback() {
                        @Override public void onComplete(long requestId) {
                            if (!disposed && state != State.FAILED) onFrame.run();
                        }
                    });
                }
                if (seconds >= duration) updateState(State.ENDED);
                else schedule(this::drawFrame, Math.max(0, FRAME_INTERVAL_MS - (SystemClock.uptimeMillis() - since)));
            } else if (Long.toString(-id).equals(result)) {
                fail();
            } else schedule(() -> pollFrame(id, position, since), FRAME_INTERVAL_MS);
        });
    }

    private void fail() {
        cancelPending();
        view.getSettings().setJavaScriptEnabled(false);
        view.loadUrl("about:blank");
        updateState(State.FAILED);
    }

    private void loadPage() {
        int width = SvgRasterizer.scaledSide(sourceWidth, sourceHeight);
        int height = SvgRasterizer.scaledSide(sourceHeight, sourceWidth);
        String html = String.format(Locale.ROOT, """
            <!doctype html><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-jzg'; script-src 'nonce-jzg'; base-uri 'none'; form-action 'none'">
            <style nonce="jzg">html,body,canvas{margin:0;width:100%%;height:100%%;display:block}</style>
            <canvas width="%d" height="%d"></canvas>
            <script nonce="jzg">
            const canvas = document.querySelector('canvas');
            const ctx = canvas.getContext('2d');
            let pending;
            window.jzgSvgCancelFrame = () => {
                if (pending) {
                    pending.onload = pending.onerror = null;
                    pending = null;
                }
            };
            window.jzgSvgDrawFrame = (id, frame) => {
                window.jzgSvgCancelFrame();
                window.jzgSvgFrameResult = 0;
                const image = pending = new Image();
                image.onload = () => {
                    if (pending !== image) return;
                    try {
                        ctx.globalCompositeOperation = 'copy';
                        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                        window.jzgSvgFrameResult = id;
                    } catch (_) {
                        window.jzgSvgFrameResult = -id;
                    }
                    pending = null;
                };
                image.onerror = () => {
                    if (pending === image) { pending = null; window.jzgSvgFrameResult = -id; }
                };
                image.src = 'data:image/svg+xml;base64,' + frame;
            };
            </script>
            """, width, height);
        view.getSettings().setJavaScriptEnabled(true);
        view.loadDataWithBaseURL("about:blank", html, "text/html", "UTF-8", null);
    }
}

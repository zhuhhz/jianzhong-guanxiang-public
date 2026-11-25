package com.zhuhhz.jianzhongguanxiang;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.pdf.PdfRenderer;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native document I/O and display; format parsing stays in the shared TypeScript core. */
public class MainActivity extends Activity {
    private static final int PICK = 101, SAVE = 102;
    private static final int MAX_IMAGE_SIDE = 1600, MAX_CORE_SIDE = 1365;
    private static final int MAX_READ_BYTES = 1024 * 1024;
    private static final int MAX_JPEG_BYTES = 8 * 1024 * 1024;
    private static final int MAX_SVG_BYTES = 2 * 1024 * 1024;
    private static final long MAX_SAFE_OFFSET = 9007199254740991L;
    private static final String CORE_HTML = "file:///android_asset/core.html";
    private static final String CORE_SCRIPT = "file:///android_asset/core.js";
    private NativeUi ui;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Object sourceLock = new Object();
    private TextView status, details;
    private WebView coreView, svgView;
    private Button pickButton, saveButton;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Bitmap currentPreview, currentDetail;
    private byte[] cameraJpeg;
    private int sourceWidth, sourceHeight;
    private boolean regionAvailable, originalPng, fullSizeBitmap;
    private Uri lastUri;
    private String fileName;
    private PreviewExport pendingExport;
    private volatile StreamExport streamExport;
    private volatile int regionRequest;
    private Runnable pendingRegion;
    private float detailLeft, detailTop, detailRight, detailBottom;

    private static final class StreamExport {
        final int token, request;
        final PreviewExport plan;
        final PreviewExport.PngOutput output;
        final Uri destination;

        StreamExport(int token, int request, PreviewExport plan, PreviewExport.PngOutput output, Uri destination) {
            this.token = token;
            this.request = request;
            this.plan = plan;
            this.output = output;
            this.destination = destination;
        }
    }

    private int exportRequest;
    private SvgRasterizer svgRasterizer;
    private SvgPlayback svgPlayback;
    private volatile int selectionToken;
    private volatile boolean destroyed;
    private volatile SourceFile activeFile;
    private boolean coreReady, busy, saving;

    private static final class SourceFile implements AutoCloseable {
        final int token;
        final Uri uri;
        final String name;
        final ParcelFileDescriptor descriptor;
        final FileInputStream stream;
        final FileChannel channel;
        final long size;
        final AtomicBoolean delivered = new AtomicBoolean();
        volatile boolean closed;

        SourceFile(int token, Uri uri, String name, ParcelFileDescriptor descriptor) throws IOException {
            this.token = token; this.uri = uri; this.name = name; this.descriptor = descriptor;
            stream = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
            channel = stream.getChannel();
            try {
                size = channel.size();
                if (size < 1 || size > MAX_SAFE_OFFSET) throw new IOException("文件大小无效或超过安全偏移范围");
                // Reject pipes and providers without seekable local access rather than copying the source.
                if (channel.read(ByteBuffer.allocate(1), 0) != 1) throw new IOException("文件读取不完整");
            } catch (IOException | RuntimeException error) {
                try { stream.close(); } catch (IOException ignored) { }
                throw error;
            }
        }
        @Override public void close() {
            closed = true;
            try { stream.close(); } catch (IOException ignored) { }
            try { descriptor.close(); } catch (IOException ignored) { }
        }
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        svgView = new WebView(this);
        svgRasterizer = new SvgRasterizer(svgView, main);
        restrictWebView(svgView, false);
        svgView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return blocked(); }
        });
        ui = new NativeUi(this, svgView, this::selectFile, this::exportPreview, () -> {
            invalidateSelection();
            status.setText("已取消处理。");
            enableRetry();
        }, this::backToHome);
        status = ui.status; details = ui.details;
        ui.setViewportListener(this::requestRegion);
        pickButton = ui.pick; saveButton = ui.save;

        coreView = new WebView(this);
        restrictWebView(coreView, true);
        coreView.setVisibility(View.INVISIBLE);
        coreView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        coreView.addJavascriptInterface(new CoreBridge(), "AndroidBridge");
        coreView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                return CORE_HTML.equals(url) || CORE_SCRIPT.equals(url) ? null : blocked();
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!destroyed && CORE_HTML.equals(url) && !coreReady) {
                    // Check the loaded entry point, since a missing script can still finish the HTML page.
                    coreView.evaluateJavascript("typeof window.JzgCore === 'object' && typeof window.JzgCore.start === 'function'", result -> {
                        if (destroyed) return;
                        coreReady = "true".equals(result);
                        pickButton.setEnabled(coreReady && !busy && !saving);
                        status.setText(coreReady ? "请选择文件。全部在设备本地处理。" : "本地解析内核加载失败，请重新安装测试 APK。");
                    });
                }
            }
        });
        ui.root.addView(coreView, new android.widget.FrameLayout.LayoutParams(1, 1));
        setContentView(ui.root);
        ui.configurationChanged();
        coreView.loadUrl(CORE_HTML);
    }

    @SuppressWarnings("deprecation")
    private static void restrictWebView(WebView view, boolean trustedScript) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(trustedScript);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkLoads(true);
        settings.setBlockNetworkImage(true);
        settings.setDomStorageEnabled(false);
        settings.setDatabaseEnabled(false);
        settings.setGeolocationEnabled(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    }
    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
    }
    private void setBusy(boolean value) {
        busy = value;
        pickButton.setEnabled(coreReady && !value && !saving);
        ui.setBusy(value);
        saveButton.setEnabled(!value && !saving && currentPreview != null && pendingExport == null);
    }
    private void closeSource(SourceFile source) {
        if (source == null) return;
        source.close();
        synchronized (sourceLock) { if (activeFile == source) activeFile = null; }
    }
    private void invalidateSelection() {
        if (coreReady && !destroyed) coreView.evaluateJavascript("window.JzgCore.clear(" + selectionToken + ")", null);
        selectionToken++;
        cancelRegion();
        clearDetail();
        svgRasterizer.cancel();
        if (svgPlayback != null) {
            svgPlayback.dispose();
            svgPlayback = null;
        }
        closeSource(activeFile);
        setBusy(false);
    }
    private boolean tokenCurrent(int token) { return !destroyed && token == selectionToken; }
    private void clearPreview() {
        svgView.setVisibility(View.GONE); svgView.loadUrl("about:blank");
        ui.clearPreview();
        ui.image.setImageDrawable(null);
        recycle(currentPreview); currentPreview = null;
        cameraJpeg = null;
        regionAvailable = originalPng = fullSizeBitmap = false;
        sourceWidth = sourceHeight = 0;
        saveButton.setEnabled(false);
        ui.setOutput(null, "");
    }
    private static void recycle(Bitmap bitmap) { if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle(); }

    private void selectFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(intent, PICK); }
        catch (Exception error) { status.setText("无法打开文件选择器：" + safeMessage(error)); }
    }
    private void exportPreview() {
        if (currentPreview == null || saving || pendingExport != null) return;
        try {
            if (cameraJpeg != null) {
                pendingExport = PreviewExport.cameraJpeg(fileName, cameraJpeg, sourceWidth, sourceHeight);
            } else if (originalPng) {
                pendingExport = PreviewExport.originalPng(fileName, sourceWidth, sourceHeight);
            } else {
                Bitmap snapshot = currentPreview.copy(Bitmap.Config.ARGB_8888, false);
                if (snapshot == null) throw new IOException("无法准备 PNG 导出");
                pendingExport = PreviewExport.png(fileName, snapshot, fullSizeBitmap);
            }
            setBusy(false);
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(pendingExport.mime);
            intent.putExtra(Intent.EXTRA_TITLE, pendingExport.title);
            startActivityForResult(intent, SAVE);
        } catch (Exception | OutOfMemoryError error) {
            if (pendingExport != null) pendingExport.close();
            pendingExport = null;
            setBusy(false);
            status.setText("无法准备保存：" + safeMessage(error));
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        if (requestCode == SAVE) {
            PreviewExport plan = pendingExport;
            pendingExport = null;
            if (plan == null) return;
            if (uri == null) {
                plan.close();
                setBusy(busy);
                status.setText("已取消保存。");
                return;
            }
            saveDocument(plan, uri);
        } else if (requestCode == PICK) {
            if (uri != null) openPreview(uri);
            else if (!ui.isPreview()) status.setText("已取消选择文件。");
        }
    }

    private void saveDocument(PreviewExport plan, Uri uri) {
        saving = true;
        cancelRegion();
        setBusy(false);
        status.setText("正在" + plan.label + "…");
        int token = selectionToken;
        worker.execute(() -> {
            if (!plan.streamsPng()) {
                try { plan.write(getContentResolver(), uri, () -> tokenCurrent(token)); showExportResult(plan, null); }
                catch (Exception | OutOfMemoryError error) { showExportResult(plan, safeMessage(error)); }
                finally { plan.close(); }
                return;
            }
            try {
                PreviewExport.PngOutput output = plan.openPng(getCacheDir());
                runOnUiThread(() -> {
                    if (!tokenCurrent(token)) {
                        output.close();
                        return;
                    }
                    int request = ++exportRequest;
                    streamExport = new StreamExport(token, request, plan, output, uri);
                    coreView.evaluateJavascript("(()=>{const core=window.JzgCore;if(!core)return false;core.exportPng("
                        + token + "," + request + ");return true})()", result -> {
                        if (!"true".equals(result) && streamExport != null && streamExport.request == request) {
                            completeExport(streamExport, "本地 PNG 导出不可用");
                        }
                    });
                });
            } catch (Exception | OutOfMemoryError error) { showExportResult(plan, safeMessage(error)); }
        });
    }

    private void showExportResult(PreviewExport plan, String error) {
        runOnUiThread(() -> {
            if (destroyed) return;
            saving = false;
            setBusy(busy);
            status.setText(error == null ? plan.label.substring(2) + " 已保存 · " + dimensions(plan.width, plan.height)
                : "保存失败：" + error);
        });
    }

    private void openPreview(Uri uri) {
        invalidateSelection();
        clearPreview();
        lastUri = uri;
        ui.beginFile();
        ui.setRetry(null);
        int token = selectionToken;
        setBusy(true);
        status.setText("正在打开本地文件…");
        details.setText("");
        worker.execute(() -> openSource(token, uri));
    }

    private void enableRetry() {
        ui.setRetry(lastUri == null ? null : () -> openPreview(lastUri));
    }

    private void previewFailed(int token, String message) {
        if (!tokenCurrent(token)) return;
        status.setText(message);
        setBusy(false);
        enableRetry();
    }

    private String displayName(Uri uri) {
        String name = "所选文件";
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0 && !cursor.isNull(index)) name = cursor.getString(index);
            }
        } catch (Exception ignored) { }
        if (name == null || name.isEmpty()) name = "所选文件";
        // Keep the suffix for format identification. This is also safely JSON-quoted below.
        if (name.length() > 4096) name = name.substring(0, 2000) + "…" + name.substring(name.length() - 2000);
        return name.replace('\n', ' ').replace('\r', ' ');
    }
    private void openSource(int token, Uri uri) {
        SourceFile source = null;
        ParcelFileDescriptor descriptor = null;
        try {
            if (!tokenCurrent(token)) return;
            String name = displayName(uri);
            descriptor = getContentResolver().openFileDescriptor(uri, "r");
            if (descriptor == null) throw new IOException("无法取得本地文件描述符");
            source = new SourceFile(token, uri, name, descriptor);
            if (!tokenCurrent(token)) { source.close(); return; }
            final SourceFile ready = source;
            runOnUiThread(() -> {
                if (!tokenCurrent(token)) { ready.close(); return; }
                synchronized (sourceLock) { activeFile = ready; }
                ui.setFile(ready.name, ready.size);
                status.setText("正在读取受支持的预览内容…");
                coreView.evaluateJavascript("window.JzgCore.start(" + token + "," + JSONObject.quote(ready.name) + "," + ready.size + ")", null);
            });
        } catch (Exception error) {
            if (source != null) source.close();
            else if (descriptor != null) try { descriptor.close(); } catch (IOException ignored) { }
            final String message = "无法读取：" + safeMessage(error) + "。需由文件提供方提供可定位的本地文件。";
            runOnUiThread(() -> previewFailed(token, message));
        }
    }

    /** Exposed only to our fixed local JS bundle, never to user SVG or remote content. */
    public final class CoreBridge {
        @JavascriptInterface public boolean isCurrent(int token) {
            SourceFile source = activeFile;
            return tokenCurrent(token) && source != null && source.token == token && !source.closed;
        }
        @JavascriptInterface public String read(int token, double offset, int length) {
            try {
                SourceFile source = activeFile;
                if (!isCurrent(token) || source == null) throw new IOException("已取消处理");
                if (!Double.isFinite(offset) || offset != Math.floor(offset) || offset < 0 || offset > MAX_SAFE_OFFSET
                    || length < 1 || length > MAX_READ_BYTES || (long)offset > source.size - length) throw new IOException("文件读取范围无效");
                ByteBuffer data = ByteBuffer.allocate(length);
                long position = (long)offset;
                while (data.hasRemaining()) {
                    if (!isCurrent(token)) throw new IOException("已取消处理");
                    int count = source.channel.read(data, position);
                    if (count <= 0) throw new IOException("文件读取不完整");
                    position += count;
                }
                if (!isCurrent(token)) throw new IOException("已取消处理");
                return new JSONObject().put("base64", Base64.encodeToString(data.array(), Base64.NO_WRAP)).toString();
            } catch (Exception error) {
                return "{\"error\":" + JSONObject.quote(safeMessage(error)) + "}";
            }
        }
        @JavascriptInterface public void complete(int token, String metadataJson, String payload) {
            SourceFile source = activeFile;
            if (!isCurrent(token) || source == null || !source.delivered.compareAndSet(false, true)) return;
            try { worker.execute(() -> finishPreview(source, metadataJson, payload)); }
            catch (RejectedExecutionException ignored) { closeSource(source); }
        }
        @JavascriptInterface public boolean isRegionCurrent(int token, int request) {
            return request == regionRequest && isCurrent(token);
        }

        @JavascriptInterface public void completeRegion(int token, int request, int width, int height, String base64) {
            if (!isRegionCurrent(token, request)) return;
            try {
                worker.execute(() -> {
                    if (!isRegionCurrent(token, request)) return;
                    try {
                        Bitmap detail = decodeRgba(width, height, base64, token);
                        runOnUiThread(() -> applyDetail(token, request, detail));
                    } catch (Exception | OutOfMemoryError error) {
                        failRegion(token, request, safeMessage(error));
                    }
                });
            } catch (RejectedExecutionException ignored) { }
        }

        @JavascriptInterface public void failRegion(int token, int request, String message) {
            runOnUiThread(() -> {
                if (isRegionCurrent(token, request)) {
                    ui.setDetailLoading(false);
                    status.setText("局部高清读取失败：" + limited(message, 150));
                }
            });
        }

        @JavascriptInterface public boolean exportCurrent(int token, int request) {
            StreamExport active = streamExport;
            return active != null && active.token == token && active.request == request && isCurrent(token);
        }

        @JavascriptInterface public boolean writePng(int token, int request, String base64) {
            StreamExport active = streamExport;
            if (active == null || active.token != token || active.request != request || !isCurrent(token)) return false;
            try {
                active.output.write(base64);
                return true;
            } catch (Exception | OutOfMemoryError error) {
                runOnUiThread(() -> completeExport(active, safeMessage(error)));
                return false;
            }
        }

        @JavascriptInterface public void exportComplete(int token, int request, String message) {
            StreamExport active = streamExport;
            if (active != null && active.token == token && active.request == request) {
                runOnUiThread(() -> completeExport(active, message));
            }
        }

        @JavascriptInterface public void fail(int token, String message) {
            SourceFile source = activeFile;
            if (!isCurrent(token) || source == null || !source.delivered.compareAndSet(false, true)) return;
            closeSource(source);
            final String text = limited(message, 400);
            runOnUiThread(() -> previewFailed(token, "预览失败：" + text));
        }
    }

    private void cancelRegion() {
        regionRequest++;
        if (pendingRegion != null) main.removeCallbacks(pendingRegion);
        pendingRegion = null;
        ui.setDetailLoading(false);
    }

    private void clearDetail() {
        ui.clearDetail();
        if (currentDetail != null && status.getText().toString().startsWith("局部高清")) {
            status.setText("已恢复概览。");
        }
        recycle(currentDetail);
        currentDetail = null;
    }

    private void requestRegion(PreviewViewport.Region viewport) {
        cancelRegion();
        if (!regionAvailable || saving || pendingExport != null || currentPreview == null || viewport == null
            || viewport.zoom() <= 1.01f) {
            clearDetail();
            return;
        }
        int x = Math.max(0, (int) Math.floor(viewport.left() * sourceWidth));
        int y = Math.max(0, (int) Math.floor(viewport.top() * sourceHeight));
        int right = Math.min(sourceWidth, (int) Math.ceil(viewport.right() * sourceWidth));
        int bottom = Math.min(sourceHeight, (int) Math.ceil(viewport.bottom() * sourceHeight));
        int width = right - x, height = bottom - y;
        if (width <= 0 || height <= 0) return;
        double ratio = Math.min(1, MAX_CORE_SIDE / (double) Math.max(width, height));
        ratio = Math.min(ratio, Math.max(viewport.screenWidth() / width, viewport.screenHeight() / height));
        int outWidth = Math.max(1, (int) Math.round(width * ratio));
        int outHeight = Math.max(1, (int) Math.round(height * ratio));
        double overviewScale = Math.max(currentPreview.getWidth() / (double) sourceWidth,
            currentPreview.getHeight() / (double) sourceHeight);
        if (ratio <= overviewScale * 1.05) {
            clearDetail();
            return;
        }
        int token = selectionToken;
        int request = regionRequest;
        detailLeft = x / (float) sourceWidth;
        detailTop = y / (float) sourceHeight;
        detailRight = right / (float) sourceWidth;
        detailBottom = bottom / (float) sourceHeight;
        pendingRegion = () -> {
            pendingRegion = null;
            if (!tokenCurrent(token) || request != regionRequest) return;
            ui.setDetailLoading(true);
            coreView.evaluateJavascript("window.JzgCore.region(" + token + "," + request + "," + x + "," + y
                + "," + width + "," + height + "," + outWidth + "," + outHeight + ")", null);
        };
        main.postDelayed(pendingRegion, 180);
    }

    private void applyDetail(int token, int request, Bitmap detail) {
        if (!tokenCurrent(token) || request != regionRequest) {
            recycle(detail);
            return;
        }
        Bitmap previous = currentDetail;
        currentDetail = detail;
        ui.showDetail(detail, detailLeft, detailTop, detailRight, detailBottom);
        ui.setDetailLoading(false);
        status.setText("局部高清已就绪 · " + dimensions(detail.getWidth(), detail.getHeight()));
        recycle(previous);
    }

    private void completeExport(StreamExport active, String message) {
        if (streamExport != active) return;
        streamExport = null;
        worker.execute(() -> {
            String error = message;
            try {
                if (message.isEmpty()) {
                    active.output.finish(getContentResolver(), active.destination, () -> tokenCurrent(active.token));
                }
            } catch (Exception | OutOfMemoryError failure) { error = safeMessage(failure); }
            finally { active.output.close(); active.plan.close(); }
            showExportResult(active.plan, error.isEmpty() ? null : error);
        });
    }

    private void finishPreview(SourceFile source, String metadataJson, String payload) {
        Bitmap bitmap = null;
        boolean keepSource = false;
        try {
            if (!tokenCurrent(source.token)) return;
            if (metadataJson == null || metadataJson.length() > 65536) throw new IOException("预览信息超过安全预算");
            JSONObject meta = new JSONObject(metadataJson);
            String kind = meta.getString("kind");
            String format = limited(meta.optString("format", "文件"), 32);
            String exportKind = meta.optString("exportKind");
            int width = meta.optInt("sourceWidth", meta.optInt("width"));
            int height = meta.optInt("sourceHeight", meta.optInt("height"));
            boolean hasDetail = meta.optBoolean("regionAvailable");
            boolean canExportOriginal = "nativePng".equals(exportKind);
            byte[] savedJpeg = null;
            boolean hasFullBitmap = false;
            switch (kind) {
                case "rgba":
                    bitmap = decodeRgba(meta.getInt("width"), meta.getInt("height"), payload, source.token);
                    hasFullBitmap = "bitmapPng".equals(exportKind)
                        && bitmap.getWidth() == width && bitmap.getHeight() == height;
                    break;
                case "jpeg": {
                    boolean camera = "cameraJpeg".equals(exportKind);
                    // The accepted RAW JPEG is still at most 8 MiB before canonical EXIF.
                    byte[] jpeg = payload(payload, MAX_JPEG_BYTES + (camera ? 36 : 0));
                    bitmap = decodeJpeg(jpeg, meta.optInt("orientation", 1));
                    if (camera) savedJpeg = jpeg;
                    break;
                }
                case "svg": {
                    byte[] svg = payload(payload, MAX_SVG_BYTES);
                    int svgWidth = width, svgHeight = height;
                    runOnUiThread(() -> showSvg(source, meta, svg, svgWidth, svgHeight));
                    return;
                }
                case "native": {
                    DecodedImage image = decodeImage(source.uri, format);
                    bitmap = image.bitmap;
                    width = image.width;
                    height = image.height;
                    hasFullBitmap = ("JPEG".equals(format) || "PNG".equals(format)) && image.fullSize;
                    break;
                }
                case "pdf":
                    bitmap = renderPdf(source.uri);
                    break;
                default: throw new IOException("未知预览结果");
            }
            if (bitmap == null) throw new IOException("设备无法解码该预览");
            int nativeWidth = width > 0 ? width : bitmap.getWidth();
            int nativeHeight = height > 0 ? height : bitmap.getHeight();
            Bitmap readyBitmap = bitmap;
            byte[] readyJpeg = savedJpeg;
            boolean fullBitmap = hasFullBitmap;
            keepSource = hasDetail || canExportOriginal;
            runOnUiThread(() -> showBitmap(source, meta, format, readyBitmap, nativeWidth, nativeHeight,
                hasDetail, canExportOriginal, fullBitmap, readyJpeg));
            bitmap = null;
        } catch (Exception | OutOfMemoryError error) {
            recycle(bitmap);
            String message = error instanceof OutOfMemoryError ? "设备内存不足，请尝试更小的文件" : safeMessage(error);
            runOnUiThread(() -> previewFailed(source.token, "预览失败：" + message));
        } finally {
            if (!keepSource || !tokenCurrent(source.token)) closeSource(source);
        }
    }

    private void showBitmap(SourceFile source, JSONObject meta, String format, Bitmap bitmap,
                            int width, int height, boolean hasDetail, boolean canExportOriginal,
                            boolean fullBitmap, byte[] jpeg) {
        if (!tokenCurrent(source.token)) { recycle(bitmap); return; }
        currentPreview = bitmap;
        regionAvailable = hasDetail;
        originalPng = canExportOriginal;
        fullSizeBitmap = fullBitmap;
        sourceWidth = width;
        sourceHeight = height;
        cameraJpeg = jpeg;
        fileName = source.name;
        String outputLabel;
        String outputNote;
        if (jpeg != null) {
            outputLabel = "保存相机 JPG";
            outputNote = "相机内嵌 JPEG · " + dimensions(width, height);
        } else if (canExportOriginal || fullBitmap) {
            outputLabel = "保存原尺寸 PNG";
            outputNote = "原尺寸 PNG · " + dimensions(width, height) + " · 8 位";
        } else {
            outputLabel = "保存预览 PNG";
            outputNote = (meta.has("svgDuration") ? "首帧 PNG · " : "预览 PNG · ")
                + dimensions(bitmap.getWidth(), bitmap.getHeight());
        }
        ui.setDetailAvailable(hasDetail);
        ui.setOutput(outputLabel, outputNote);
        ui.setFormat(format);
        ui.setDimensions(dimensions(width, height));
        details.setText(previewDetails(meta) + "\n预览像素：" + dimensions(bitmap.getWidth(), bitmap.getHeight()));
        status.setText(format + " 预览已就绪。");
        ui.image.setImageBitmap(bitmap);
        if (ui.image.getDrawable() instanceof BitmapDrawable drawable) {
            boolean tinyPhotoshop = ("PSD".equals(format) || "PSB".equals(format)) && width <= 32 && height <= 32;
            drawable.setFilterBitmap(!tinyPhotoshop);
        }
        ui.showImage(bitmap.getWidth(), bitmap.getHeight(),
            hasDetail ? width : bitmap.getWidth(), hasDetail ? height : bitmap.getHeight());
        setBusy(false);
    }

    private static String previewDetails(JSONObject meta) {
        StringBuilder label = new StringBuilder(limited(meta.optString("details", ""), 2048));
        JSONArray warnings = meta.optJSONArray("warnings");
        if (warnings != null) {
            for (int i = 0; i < Math.min(32, warnings.length()); i++) {
                label.append("\n• ").append(limited(warnings.optString(i), 1024));
            }
        }
        return label.toString();
    }

    private static String dimensions(int width, int height) { return width + "×" + height + " px"; }

    private void showSvg(SourceFile source, JSONObject meta, byte[] svg, int width, int height) {
        if (!tokenCurrent(source.token)) return;
        status.setText("正在栅格化安全 SVG…");
        svgRasterizer.render(svg, width, height, result -> {
            if (!tokenCurrent(source.token)) return;
            if (result == null) {
                showStaticSvg(source, meta, svg, width, height);
                return;
            }
            worker.execute(() -> {
                Bitmap bitmap;
                try {
                    byte[] png = payload(result, 9 * 1024 * 1024);
                    bitmap = BitmapFactory.decodeByteArray(png, 0, png.length);
                    if (bitmap == null) throw new IOException("无法解码 SVG 位图");
                } catch (Exception | OutOfMemoryError error) {
                    runOnUiThread(() -> showStaticSvg(source, meta, svg, width, height));
                    return;
                }
                runOnUiThread(() -> {
                    showBitmap(source, meta, "SVG", bitmap, width, height, false, false, false, null);
                    if (tokenCurrent(source.token) && meta.has("svgDuration")) {
                        prepareSvgPlayback(source.token, meta, width, height);
                    }
                });
            });
        });
    }

    private void prepareSvgPlayback(int token, JSONObject meta, int width, int height) {
        double duration = meta.isNull("svgDuration") ? Double.POSITIVE_INFINITY : meta.optDouble("svgDuration", 0);
        if (!(duration > 0)) return;
        ui.prepareSvgFrameView();
        svgPlayback = new SvgPlayback(svgView, main, width, height, duration,
            (seconds, result) -> coreView.evaluateJavascript("window.JzgCore.svgFrame("
                + token + "," + Double.toString(seconds) + ")", result::accept),
            () -> ui.showSvgFrame(true), this::setSvgPlaybackState);
        setSvgPlaybackState(SvgPlayback.State.READY);
    }

    private void setSvgPlaybackState(SvgPlayback.State state) {
        if (state == SvgPlayback.State.FAILED) {
            ui.showSvgFrame(false);
            ui.setSvgControls(null, false, null, null);
            status.setText("SVG 动画播放失败，已显示首帧。");
            return;
        }
        String label = switch (state) {
            case PLAYING -> "暂停";
            case PAUSED -> "继续";
            default -> "开始";
        };
        ui.setSvgControls(label, state != SvgPlayback.State.READY, svgPlayback::toggle, svgPlayback::restart);
    }

    private void showStaticSvg(SourceFile source, JSONObject meta, byte[] svg, int width, int height) {
        if (!tokenCurrent(source.token)) return;
        svgView.getSettings().setJavaScriptEnabled(false);
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'\">"
            + "<style>html,body{margin:0;width:100%;height:100%}body{display:flex;align-items:center;justify-content:center}svg{max-width:100%;max-height:100%;width:auto;height:auto;flex:none}</style></head><body>"
            + new String(svg, StandardCharsets.UTF_8) + "</body></html>";
        svgView.loadDataWithBaseURL("about:blank", html, "text/html", "UTF-8", null);
        ui.setFormat("SVG");
        ui.setDimensions(dimensions(width, height));
        ui.setOutput(null, "当前 WebView 无法栅格化，保留静态 SVG 预览。");
        details.setText(previewDetails(meta));
        ui.showSvg(width, height);
        status.setText(meta.has("svgDuration") ? "当前 WebView 仅显示 SVG 动画首帧。" : "SVG 静态预览已就绪。");
        setBusy(false);
    }

    private Bitmap decodeRgba(int width, int height, String encoded, int token) throws IOException {
        if (width < 1 || height < 1 || width > MAX_CORE_SIDE || height > MAX_CORE_SIDE) throw new IOException("预览像素超过安全预算");
        byte[] bytes = payload(encoded, width * height * 4);
        if (bytes.length != width * height * 4) throw new IOException("预览像素数据不完整");
        int[] argb = new int[width * height];
        for (int i = 0; i < argb.length; i++) {
            if ((i & 65535) == 0 && !tokenCurrent(token)) throw new IOException("已取消处理");
            int at = i * 4;
            argb[i] = ((bytes[at + 3] & 255) << 24) | ((bytes[at] & 255) << 16)
                | ((bytes[at + 1] & 255) << 8) | (bytes[at + 2] & 255);
        }
        return Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888);
    }

    private static byte[] payload(String base64, int maxBytes) throws IOException {
        if (base64 == null || base64.length() > ((maxBytes + 2L) / 3) * 4) throw new IOException("预览数据超过安全预算");
        byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
        if (bytes.length > maxBytes) throw new IOException("预览数据超过安全预算");
        return bytes;
    }
    private static String limited(String value, int max) {
        if (value == null) return "文件格式或访问方式暂不支持";
        return value.length() > max ? value.substring(0, max) + "…" : value;
    }
    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null ? "文件格式或访问方式暂不支持" : limited(message, 160);
    }
    private static BitmapFactory.Options sample(BitmapFactory.Options dimensions) throws IOException {
        if (dimensions.outWidth < 1 || dimensions.outHeight < 1) throw new IOException("图像尺寸无效");
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        options.inSampleSize = 1;
        while (Math.ceil(dimensions.outWidth / (double)options.inSampleSize) > MAX_IMAGE_SIDE
            || Math.ceil(dimensions.outHeight / (double)options.inSampleSize) > MAX_IMAGE_SIDE) {
            if (options.inSampleSize > (1 << 28)) throw new IOException("图像尺寸超过安全范围");
            options.inSampleSize *= 2;
        }
        return options;
    }
    private static final class DecodedImage {
        final Bitmap bitmap;
        final int width, height;
        final boolean fullSize;

        DecodedImage(Bitmap bitmap, int width, int height, boolean fullSize) {
            this.bitmap = bitmap;
            this.width = width;
            this.height = height;
            this.fullSize = fullSize;
        }
    }

    private DecodedImage decodeImage(Uri uri, String format) throws IOException {
        BitmapFactory.Options dimensions = new BitmapFactory.Options(); dimensions.inJustDecodeBounds = true;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("无法打开图片");
            BitmapFactory.decodeStream(input, null, dimensions);
        }
        BitmapFactory.Options options = sample(dimensions);
        int orientation = 1;
        if ("JPEG".equals(format)) {
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IOException("无法读取 JPEG 方向");
                int candidate = new ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1);
                if (candidate >= 1 && candidate <= 8) orientation = candidate;
            }
        }
        Bitmap bitmap;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("无法打开图片");
            bitmap = orientBitmap(BitmapFactory.decodeStream(input, null, options), orientation);
        }
        int width = orientation >= 5 ? dimensions.outHeight : dimensions.outWidth;
        int height = orientation >= 5 ? dimensions.outWidth : dimensions.outHeight;
        return new DecodedImage(bitmap, width, height, bitmap != null && options.inSampleSize == 1
            && bitmap.getWidth() == width && bitmap.getHeight() == height);
    }

    private Bitmap decodeJpeg(byte[] jpeg, int orientation) throws IOException {
        if (orientation < 1 || orientation > 8) throw new IOException("JPEG 方向无效");
        BitmapFactory.Options dimensions = new BitmapFactory.Options(); dimensions.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, dimensions);
        Bitmap bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, sample(dimensions));
        return orientBitmap(bitmap, orientation);
    }

    private static Bitmap orientBitmap(Bitmap bitmap, int orientation) {
        if (bitmap == null || orientation == 1) return bitmap;
        Matrix matrix = new Matrix();
        switch (orientation) {
            case 2: matrix.setScale(-1, 1); break;
            case 3: matrix.setRotate(180); break;
            case 4: matrix.setScale(1, -1); break;
            case 5: matrix.setRotate(90); matrix.postScale(-1, 1); break;
            case 6: matrix.setRotate(90); break;
            case 7: matrix.setRotate(-90); matrix.postScale(-1, 1); break;
            case 8: matrix.setRotate(-90); break;
        }
        try {
            Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            if (rotated != bitmap) recycle(bitmap);
            return rotated;
        } catch (RuntimeException | OutOfMemoryError error) { recycle(bitmap); throw error; }
    }
    private Bitmap renderPdf(Uri uri) throws IOException {
        try (ParcelFileDescriptor fd = getContentResolver().openFileDescriptor(uri, "r")) {
            if (fd == null) throw new IOException("无法取得 PDF 文件描述符");
            try (PdfRenderer renderer = new PdfRenderer(fd)) {
                if (renderer.getPageCount() == 0) throw new IOException("PDF 没有可用页面");
                try (PdfRenderer.Page page = renderer.openPage(0)) {
                    if (page.getWidth() < 1 || page.getHeight() < 1) throw new IOException("PDF 页面尺寸无效");
                    float scale = Math.min(1.5f, Math.min(MAX_IMAGE_SIDE / (float)page.getWidth(), MAX_IMAGE_SIDE / (float)page.getHeight()));
                    int width = Math.max(1, Math.round(page.getWidth() * scale));
                    int height = Math.max(1, Math.round(page.getHeight() * scale));
                    Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                    try {
                        bitmap.eraseColor(Color.WHITE);
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        return bitmap;
                    } catch (RuntimeException | OutOfMemoryError error) { recycle(bitmap); throw error; }
                }
            }
        }
    }
    private void backToHome() {
        if (saving || pendingExport != null) {
            status.setText("请先完成或取消当前保存。");
            return;
        }
        invalidateSelection(); clearPreview(); lastUri = null; ui.setRetry(null); ui.home();
        status.setText("请选择文件。全部在设备本地处理。");
    }
    @Override public void onBackPressed() {
        if (ui != null && ui.isPreview()) backToHome();
        else super.onBackPressed();
    }
    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (ui != null) ui.configurationChanged();
    }
    @Override protected void onPause() {
        if (svgPlayback != null) svgPlayback.pause();
        super.onPause();
    }
    @Override protected void onDestroy() {
        destroyed = true;
        invalidateSelection();
        StreamExport active = streamExport;
        streamExport = null;
        if (active != null) worker.execute(active.output::close);
        if (pendingExport != null) pendingExport.close();
        pendingExport = null;
        ui.clearPreview();
        ui.image.setImageDrawable(null);
        ui.dispose();
        recycle(currentPreview); currentPreview = null;
        if (coreView != null) { coreView.removeJavascriptInterface("AndroidBridge"); coreView.destroy(); }
        if (svgView != null) svgView.destroy();
        // Already-running native work disposes its own stale result/snapshot.
        worker.shutdown();
        super.onDestroy();
    }
}

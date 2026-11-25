package com.zhuhhz.jianzhongguanxiang;

import android.content.Context;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.widget.FrameLayout;

import java.util.function.Consumer;
import java.util.function.DoubleConsumer;

/** Fits, scales and pans a rendered preview. The source and export bitmap stay untouched. */
final class PreviewViewport extends FrameLayout {
    private static final float MAX_PREVIEW_ZOOM = 6f;
    private static final float MAX_DETAIL_ZOOM = 64f;
    record Region(float left, float top, float right, float bottom, float zoom,
                  float screenWidth, float screenHeight) {}
    private final ScaleGestureDetector pinch;
    private final GestureDetector gestures;
    private View content;
    private int sourceWidth, sourceHeight, rasterWidth, rasterHeight;
    private int previousWidth, previousHeight;
    private float zoom = 1f, maxZoom = MAX_PREVIEW_ZOOM, panX, panY, lastFocusX, lastFocusY;
    private float singleX, singleY;
    private boolean multiTouch;
    private boolean dragAfterPinch;
    private boolean detailAvailable;
    private DoubleConsumer zoomChanged = value -> {};
    private Consumer<Region> viewportChanged = region -> {};
    private Region lastRegion;

    PreviewViewport(Context context) {
        super(context);
        setClipChildren(true);
        pinch = new ScaleGestureDetector(context, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override public boolean onScaleBegin(ScaleGestureDetector detector) {
                lastFocusX = detector.getFocusX();
                lastFocusY = detector.getFocusY();
                return true;
            }

            @Override public boolean onScale(ScaleGestureDetector detector) {
                float x = detector.getFocusX(), y = detector.getFocusY();
                scaleAround(zoom * detector.getScaleFactor(), lastFocusX, lastFocusY, x, y);
                lastFocusX = x;
                lastFocusY = y;
                return true;
            }
        });
        pinch.setQuickScaleEnabled(false);
        gestures = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent event) { return true; }

            @Override public boolean onDoubleTap(MotionEvent event) {
                float target = Math.min(2f, maxZoom);
                if (zoom >= target - .05f) fit();
                else scaleAround(target, event.getX(), event.getY(), event.getX(), event.getY());
                return true;
            }

            @Override public boolean onScroll(MotionEvent start, MotionEvent end, float dx, float dy) {
                if (zoom <= 1f) return false;
                panX -= dx;
                panY -= dy;
                applyTransform();
                return true;
            }
        });
    }

    void setZoomListener(DoubleConsumer listener) { zoomChanged = listener; }
    void setViewportListener(Consumer<Region> listener) { viewportChanged = listener; }
    float maxZoom() { return maxZoom; }
    void setDetailAvailable(boolean available) { detailAvailable = available; }

    void show(View view, int width, int height, int bitmapWidth, int bitmapHeight) {
        content = view;
        sourceWidth = width;
        sourceHeight = height;
        rasterWidth = bitmapWidth;
        rasterHeight = bitmapHeight;
        previousWidth = previousHeight = 0;
        lastRegion = null;
        fit();
        requestLayout();
    }

    void clear() {
        content = null;
        lastRegion = null;
        maxZoom = MAX_PREVIEW_ZOOM;
        detailAvailable = false;
        fit();
    }

    boolean hasContent() { return content != null; }

    void step(float amount) {
        float x = getWidth() / 2f, y = getHeight() / 2f;
        scaleAround(Math.round((zoom + amount) * 100) / 100f, x, y, x, y);
    }

    void fit() {
        zoom = 1f;
        panX = 0;
        panY = 0;
        applyTransform();
        zoomChanged.accept(zoom);
    }

    void measureFitted(int widthLimit,int heightLimit) {
        int width=widthLimit, height=heightLimit;
        if (content!=null) {
            double fit=Math.min(widthLimit/(double)sourceWidth,heightLimit/(double)sourceHeight);
            width=Math.max(1,(int)Math.round(sourceWidth*fit));
            height=Math.max(1,(int)Math.round(sourceHeight*fit));
        }
        measure(MeasureSpec.makeMeasureSpec(width,MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height,MeasureSpec.EXACTLY));
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        super.onMeasure(widthSpec, heightSpec);
        if (content == null || sourceWidth <= 0 || sourceHeight <= 0) return;
        float fit = Math.min((float) getMeasuredWidth() / sourceWidth, (float) getMeasuredHeight() / sourceHeight);
        int width = Math.min(getMeasuredWidth(), Math.max(1, Math.round(sourceWidth * fit)));
        int height = Math.min(getMeasuredHeight(), Math.max(1, Math.round(sourceHeight * fit)));
        ((FrameLayout.LayoutParams) content.getLayoutParams()).gravity = Gravity.CENTER;
        content.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY));
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        super.onLayout(changed, left, top, right, bottom);
        if (content != null) {
            int width = content.getWidth(), height = content.getHeight();
            if (previousWidth > 0) panX *= (float) width / previousWidth;
            if (previousHeight > 0) panY *= (float) height / previousHeight;
            previousWidth = width;
            previousHeight = height;
            if (width > 0 && height > 0) {
                int pixelWidth = detailAvailable ? sourceWidth : rasterWidth;
                int pixelHeight = detailAvailable ? sourceHeight : rasterHeight;
                float actualPixels = Math.min((float) pixelWidth / width, (float) pixelHeight / height);
                float limit = detailAvailable ? MAX_DETAIL_ZOOM : MAX_PREVIEW_ZOOM;
                float nextMax = Math.max(2f, Math.min(limit, actualPixels));
                if (nextMax != maxZoom) {
                    maxZoom = nextMax;
                    if (zoom > maxZoom) {
                        panX *= maxZoom / zoom;
                        panY *= maxZoom / zoom;
                        zoom = maxZoom;
                    }
                    zoomChanged.accept(zoom);
                }
            }
        }
        applyTransform();
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        return content != null;
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        if (content == null) return super.onTouchEvent(event);
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            multiTouch = false;
            dragAfterPinch = false;
        }
        if (action == MotionEvent.ACTION_POINTER_DOWN && !multiTouch) {
            multiTouch = true;
            MotionEvent cancel = MotionEvent.obtain(event);
            cancel.setAction(MotionEvent.ACTION_CANCEL);
            gestures.onTouchEvent(cancel);
            cancel.recycle();
        }
        if (event.getPointerCount() > 1 || zoom > 1f) getParent().requestDisallowInterceptTouchEvent(true);
        pinch.onTouchEvent(event);
        if (!multiTouch) gestures.onTouchEvent(event);
        if (action == MotionEvent.ACTION_POINTER_UP && event.getPointerCount() == 2) {
            int index = 1 - event.getActionIndex();
            singleX = event.getX(index);
            singleY = event.getY(index);
            dragAfterPinch = true;
        }
        if (dragAfterPinch && action == MotionEvent.ACTION_MOVE && event.getPointerCount() == 1) {
            panX += event.getX() - singleX;
            panY += event.getY() - singleY;
            singleX = event.getX();
            singleY = event.getY();
            applyTransform();
        }
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            getParent().requestDisallowInterceptTouchEvent(false);
        }
        return true;
    }

    private void scaleAround(float target, float oldX, float oldY, float x, float y) {
        if (content == null || !Float.isFinite(target)) return;
        float next = Math.max(1f, Math.min(maxZoom, target));
        float ratio = next / zoom;
        float centerX = getWidth() / 2f, centerY = getHeight() / 2f;
        panX = x - centerX - (oldX - centerX - panX) * ratio;
        panY = y - centerY - (oldY - centerY - panY) * ratio;
        boolean changed = zoom != next;
        zoom = next;
        applyTransform();
        if (changed) zoomChanged.accept(zoom);
    }

    private void applyTransform() {
        if (content == null) return;
        panX = clampPan(panX, content.getWidth() * zoom, getWidth());
        panY = clampPan(panY, content.getHeight() * zoom, getHeight());
        content.setScaleX(zoom);
        content.setScaleY(zoom);
        content.setTranslationX(panX);
        content.setTranslationY(panY);
        publishRegion();
    }

    private void publishRegion() {
        float width = content.getWidth() * zoom, height = content.getHeight() * zoom;
        if (width <= 0 || height <= 0 || getWidth() <= 0 || getHeight() <= 0) return;
        float x = content.getLeft() + (content.getWidth() - width) / 2f + panX;
        float y = content.getTop() + (content.getHeight() - height) / 2f + panY;
        float left = Math.max(0f, -x / width), top = Math.max(0f, -y / height);
        float right = Math.min(1f, (getWidth() - x) / width), bottom = Math.min(1f, (getHeight() - y) / height);
        Region region = new Region(left, top, right, bottom, zoom, (right - left) * width, (bottom - top) * height);
        if (region.equals(lastRegion)) return;
        lastRegion = region;
        viewportChanged.accept(region);
    }

    private static float clampPan(float pan, float contentSize, int viewportSize) {
        float limit = Math.max(0f, (contentSize - viewportSize) / 2f);
        return Math.max(-limit, Math.min(limit, pan));
    }
}

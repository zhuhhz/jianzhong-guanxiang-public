package com.zhuhhz.jianzhongguanxiang;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;

/** Small native equivalent of the Mini Program's two soft shadows and pressed state. */
final class SoftSurface extends Drawable {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float density, radius;
    private final UiPalette palette;
    private final boolean primary;
    private boolean pressed;
    SoftSurface(float density, UiPalette palette, boolean primary, int radiusDp) {
        this.density=density; this.palette=palette; this.primary=primary; this.radius=radiusDp*density;
    }
    @Override public boolean isStateful() { return true; }
    @Override protected boolean onStateChange(int[] states) {
        boolean next = false;
        for (int state : states) if (state == android.R.attr.state_pressed) next = true;
        if (next == pressed) return false;
        pressed = next; invalidateSelf(); return true;
    }
    @Override public void draw(Canvas canvas) {
        RectF box = new RectF(getBounds());
        box.inset(5*density, 5*density);
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(primary ? palette.accent : palette.bg);
        paint.setShadowLayer(7*density, -3*density, -3*density, pressed ? palette.dark : palette.light);
        canvas.drawRoundRect(box, radius, radius, paint);
        paint.setShadowLayer(7*density, 3*density, 3*density, pressed ? palette.light : palette.dark);
        canvas.drawRoundRect(box, radius, radius, paint);
        paint.clearShadowLayer();
        if (pressed) { paint.setColor(primary ? 0x18000000 : 0x09000000); canvas.drawRoundRect(box,radius,radius,paint); }
        paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(density);
        paint.setColor(primary ? palette.accent : palette.border);
        canvas.drawRoundRect(box,radius,radius,paint);
    }
    @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); invalidateSelf(); }
    @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); invalidateSelf(); }
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}

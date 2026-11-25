package com.zhuhhz.jianzhongguanxiang;

import android.content.ContentResolver;
import android.graphics.Bitmap;
import android.net.Uri;
import android.util.Base64;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.function.BooleanSupplier;

/** One capability and its exact output dimensions, retained across the system save chooser. */
final class PreviewExport implements AutoCloseable {
    enum Kind { CAMERA_JPEG, ORIGINAL_PNG, PREVIEW_PNG }

    final Kind kind;
    final String title, mime, label;
    final int width, height;
    private final byte[] jpeg;
    private final Bitmap bitmap;

    static PreviewExport cameraJpeg(String filename, byte[] jpeg, int width, int height) {
        return new PreviewExport(Kind.CAMERA_JPEG, filename, width, height, jpeg, null);
    }

    static PreviewExport png(String filename, Bitmap snapshot, boolean originalSize) {
        return new PreviewExport(originalSize ? Kind.ORIGINAL_PNG : Kind.PREVIEW_PNG,
            filename, snapshot.getWidth(), snapshot.getHeight(), null, snapshot);
    }

    static PreviewExport originalPng(String filename, int width, int height) {
        return new PreviewExport(Kind.ORIGINAL_PNG, filename, width, height, null, null);
    }

    private PreviewExport(Kind kind, String filename, int width, int height, byte[] jpeg, Bitmap bitmap) {
        if (width < 1 || height < 1) throw new IllegalArgumentException("保存尺寸无效");
        this.kind = kind;
        this.width = width;
        this.height = height;
        this.jpeg = jpeg;
        this.bitmap = bitmap;
        String stem = filename == null ? "" : filename;
        int dot = stem.lastIndexOf('.');
        if (dot > 0) stem = stem.substring(0, dot);
        stem = stem.replace('/', '_').replace('\\', '_').replaceAll("\\p{Cntrl}", "_").trim();
        if (stem.isEmpty()) stem = "jianzhong";
        // Leave room for the suffix within the filesystem's UTF-8 name limit.
        if (stem.codePointCount(0, stem.length()) > 56) stem = stem.substring(0, stem.offsetByCodePoints(0, 56));
        switch (kind) {
            case CAMERA_JPEG:
                mime = "image/jpeg"; title = stem + "-camera.jpg"; label = "保存相机 JPG";
                break;
            case ORIGINAL_PNG:
                mime = "image/png"; title = stem + "-original.png"; label = "保存原尺寸 PNG";
                break;
            default:
                mime = "image/png"; title = stem + "-preview.png"; label = "保存预览 PNG";
        }
    }

    boolean streamsPng() {
        return kind == Kind.ORIGINAL_PNG && bitmap == null;
    }

    void write(ContentResolver resolver, Uri uri, BooleanSupplier current) throws IOException {
        if (streamsPng()) throw new IOException("原尺寸 PNG 需要分段导出");
        checkCurrent(current);
        try (OutputStream output = openDestination(resolver, uri)) {
            if (jpeg != null) {
                output.write(jpeg);
            } else if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                throw new IOException("无法编码 PNG");
            }
            checkCurrent(current);
            output.flush();
        }
    }

    PngOutput openPng(File cacheDir) throws IOException {
        if (!streamsPng()) throw new IOException("当前图片无需分段导出");
        return new PngOutput(cacheDir, width, height);
    }

    private static OutputStream openDestination(ContentResolver resolver, Uri uri) throws IOException {
        OutputStream output = resolver.openOutputStream(uri, "wt");
        if (output == null) throw new IOException("无法打开保存位置");
        return output;
    }

    private static void checkCurrent(BooleanSupplier current) throws IOException {
        if (!current.getAsBoolean()) throw new IOException("已取消保存");
    }

    @Override public void close() {
        if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
    }

    /** Bounded chunks from the shared PNG writer. Publish only an encoded, validated PNG. */
    static final class PngOutput implements AutoCloseable {
        private static final int MAX_CHUNK = 64 * 1024;
        private static final long PNG_SIGNATURE = 0x89504e470d0a1a0aL;
        private static final byte[] PNG_END = {0, 0, 0, 0, 73, 69, 78, 68, (byte)174, 66, 96, (byte)130};
        private final File staged;
        private final int width, height;
        private final long maxBytes;
        private FileOutputStream stream;
        private long length;

        PngOutput(File cacheDir, int width, int height) throws IOException {
            this.width = width;
            this.height = height;
            // Four channels and one filter byte per row, plus room for zlib and PNG framing.
            long rasterBytes = (width * 4L + 1) * height;
            maxBytes = rasterBytes + rasterBytes / 20 + 65536;
            staged = File.createTempFile("jzg-png-", ".tmp", cacheDir);
            try {
                stream = new FileOutputStream(staged);
            } catch (IOException error) {
                staged.delete();
                throw error;
            }
        }

        synchronized void write(String base64) throws IOException {
            if (stream == null) throw new IOException("原尺寸 PNG 已关闭");
            if (base64 == null || base64.isEmpty() || base64.length() > ((MAX_CHUNK + 2) / 3) * 4) {
                throw new IOException("原尺寸 PNG 写入块超过安全范围");
            }
            byte[] bytes;
            try {
                bytes = Base64.decode(base64, Base64.NO_WRAP);
            } catch (IllegalArgumentException error) {
                throw new IOException("原尺寸 PNG 写入块无效", error);
            }
            if (bytes.length == 0 || bytes.length > MAX_CHUNK || length > maxBytes - bytes.length) {
                throw new IOException("原尺寸 PNG 写入量超过安全范围");
            }
            stream.write(bytes);
            length += bytes.length;
        }

        private synchronized void seal() throws IOException {
            if (stream == null) throw new IOException("原尺寸 PNG 已关闭");
            FileOutputStream complete = stream;
            stream = null;
            complete.close();
            try (RandomAccessFile png = new RandomAccessFile(staged, "r")) {
                if (png.length() != length || length < 57 || png.readLong() != PNG_SIGNATURE
                    || png.readInt() != 13 || png.readInt() != 0x49484452
                    || png.readInt() != width || png.readInt() != height || png.readUnsignedByte() != 8) {
                    throw new IOException("原尺寸 PNG 文件头或尺寸验证失败");
                }
                int color = png.readUnsignedByte();
                if (color != 2 && color != 6) throw new IOException("原尺寸 PNG 色彩类型无效");
                png.seek(length - PNG_END.length);
                byte[] end = new byte[PNG_END.length];
                png.readFully(end);
                if (!Arrays.equals(end, PNG_END)) throw new IOException("原尺寸 PNG 文件不完整");
            }
        }

        void finish(ContentResolver resolver, Uri uri, BooleanSupplier current) throws IOException {
            checkCurrent(current);
            seal();
            checkCurrent(current);
            try (FileInputStream input = new FileInputStream(staged);
                 OutputStream output = openDestination(resolver, uri)) {
                byte[] buffer = new byte[MAX_CHUNK];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    checkCurrent(current);
                    output.write(buffer, 0, count);
                }
                checkCurrent(current);
                output.flush();
            }
        }

        @Override public synchronized void close() {
            if (stream != null) {
                try { stream.close(); } catch (IOException ignored) { }
                stream = null;
            }
            staged.delete();
        }
    }
}

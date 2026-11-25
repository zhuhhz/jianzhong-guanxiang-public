package com.zhuhhz.jianzhongguanxiang;

import android.app.Activity;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Locale;
import java.util.function.Consumer;

/** View-only adaptation of index.wxml/index.wxss. No file parsing or bitmap transformations. */
final class NativeUi {
    private static final String PROJECT = "https://github.com/zhuhhz/jianzhong-guanxiang-public";
    private static final String ISSUES = PROJECT + "/issues";
    static final String OUTPUT_NOTE = "根据文件和实际像素提供保存操作。";
    private final Activity activity;
    private UiPalette palette;
    final FrameLayout root;
    final TextView status, details;
    final ImageView image;
    final Button pick, cancel, save;
    private final ScrollView home;
    private final ScrollView previewHost;
    private final LinearLayout preview, footer;
    private final PreviewViewport stage;
    private final FrameLayout previewContent;
    private final ScrollView stageMessage;
    private final PreviewImage bitmapImage;
    private final HorizontalScrollView toolbar;
    private final ScrollView notes;
    private final LinearLayout notesCard, inlineTools, toolItems, previewHint;
    private final TextView gestureHint;
    private final Button toolsTrigger;
    private final Button playbackToggle, playbackRestart;
    private final TextView limitsBody;
    private final Button limitsToggle;
    private final Button themeButton;
    private final TextView unavailableSave;
    private final ProgressBar loading;
    private final WebView svg;
    private final TextView homeStatus, notice, filename, fileMeta, fileFormat, outputNote, zoomValue, detailLoading;
    private final Button background, zoomIn, zoomOut, fit, retry;
    private final View homeMark;
    private final ArrayList<TextView> normal = new ArrayList<>(), muted = new ArrayList<>(), controls = new ArrayList<>();
    private final ArrayList<View> surfaces = new ArrayList<>();
    private final ArrayList<Button> primary = new ArrayList<>();
    private final ArrayList<View> rules = new ArrayList<>();
    private boolean previewVisible;
    private boolean busy, compact, wideTools;
    private int backgroundMode;
    private String fileSizeText, dimensions, outputAction;
    private Runnable retryTask;
    private Dialog dialog;
    private PopupWindow toolsPopup;
    private boolean buildingDialog;

    NativeUi(Activity activity, WebView svg, Runnable choose, Runnable export, Runnable cancelTask, Runnable back) {
        this.activity=activity; this.svg=svg;
        palette = UiPalette.get(activity, activity.getPreferences(0).getString("ui-theme", "ink"));
        root = new FrameLayout(activity);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left=safe.left; top=safe.top; right=safe.right; bottom=safe.bottom;
            } else {
                left=insets.getSystemWindowInsetLeft(); top=insets.getSystemWindowInsetTop();
                right=insets.getSystemWindowInsetRight(); bottom=insets.getSystemWindowInsetBottom();
                if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                    left=Math.max(left,insets.getDisplayCutout().getSafeInsetLeft());
                    top=Math.max(top,insets.getDisplayCutout().getSafeInsetTop());
                    right=Math.max(right,insets.getDisplayCutout().getSafeInsetRight());
                    bottom=Math.max(bottom,insets.getDisplayCutout().getSafeInsetBottom());
                }
            }
            root.setPadding(left,top,right,bottom);
            return insets;
        });
        home = new ScrollView(activity);
        home.setFillViewport(true); home.setClipToPadding(false);
        root.addView(home, new FrameLayout.LayoutParams(-1,-1));
        FrameLayout homeCenter = new FrameLayout(activity);
        home.addView(homeCenter, new ScrollView.LayoutParams(-1,-2));
        LinearLayout content = new LinearLayout(activity) {
            @Override protected void onMeasure(int width, int height) {
                super.onMeasure(MeasureSpec.makeMeasureSpec(Math.min(MeasureSpec.getSize(width),dp(608)),MeasureSpec.EXACTLY),height);
            }
        };
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24),dp(35),dp(24),dp(20));
        content.setClipChildren(false);
        homeCenter.addView(content, new FrameLayout.LayoutParams(-1,-2,Gravity.TOP|Gravity.CENTER_HORIZONTAL));
        LinearLayout top = row();
        LinearLayout topLeft = column();
        TextView wordmark = text("DESIGN FILE PREVIEW",10,1);
        wordmark.setLetterSpacing(.14f); wordmark.setTypeface(null,1);
        topLeft.addView(wordmark);
        Button github = textButton("GitHub 项目 ↗",true);
        github.setMinHeight(dp(32)); github.setMinimumHeight(dp(32));
        github.setGravity(Gravity.START|Gravity.CENTER_VERTICAL);
        github.setTextSize(11); github.setContentDescription("打开 GitHub 项目");
        github.setOnClickListener(v -> openProject());
        topLeft.addView(github,new LinearLayout.LayoutParams(-2,-2));
        top.addView(topLeft,new LinearLayout.LayoutParams(0,-2,1));
        themeButton = toolButton("主题","选择界面主题",this::showThemes);
        themeButton.setPadding(dp(12),0,dp(12),0);
        themeButton.setCompoundDrawablePadding(dp(6));
        LinearLayout.LayoutParams themeParams = new LinearLayout.LayoutParams(-2,-2);
        themeParams.setMarginStart(dp(8)); top.addView(themeButton,themeParams);
        content.addView(top);

        homeMark = new HomeMark();
        homeMark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        homeMark.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(50),dp(56));
        markParams.topMargin = dp(33);
        markParams.bottomMargin = dp(14);
        content.addView(homeMark, markParams);
        TextView title = text("鉴中观象",32,0); title.setTypeface(null,1); content.addView(title);
        TextView subtitle = text("设计文件，打开就看。",15,1);
        add(content,subtitle,8);
        pick = button("选择本地文件",true);
        pick.setOnClickListener(v -> choose.run()); pick.setEnabled(false);
        add(content,pick,29);
        homeStatus = text("正在初始化本地解析内核…",12,1);
        homeStatus.setGravity(Gravity.CENTER);
        homeStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        add(content,homeStatus,4);

        LinearLayout formats = column();
        formats.setPadding(dp(18),dp(8),dp(18),dp(8));
        surfaces.add(formats);
        String[][] descriptions = {{"RAW","相机内嵌 JPEG · 可保存 JPG"},
            {"PSD","保存合成图 · 支持部分原尺寸 PNG"}, {"PSB","保存合成图 · 部分支持局部高清"},
            {"TIFF","第一页 · 支持部分 BigTIFF"}, {"AI","PDF 兼容内容 · 第一页"}, {"SVG","图形与基础动画 · PNG 保存（受限）"}};
        for (int i=0;i<descriptions.length;i++) {
            LinearLayout formatRow = row();
            formatRow.setPadding(0,dp(11),0,dp(11));
            TextView tag = text(descriptions[i][0],12,0); tag.setTypeface(null,1);
            formatRow.addView(tag,new LinearLayout.LayoutParams(dp(39),-2));
            TextView description = text(descriptions[i][1],12,1);
            formatRow.addView(description,new LinearLayout.LayoutParams(0,-2,1));
            formats.addView(formatRow);
            if (i<descriptions.length-1) {
                View rule = new View(activity); rules.add(rule);
                formats.addView(rule,new LinearLayout.LayoutParams(-1,dp(1)));
            }
        }
        add(content,formats,26);
        TextView privacy = text("本机解析 · 不修改原稿\n无需账号 · 不上传设计文件",12,1);
        privacy.setGravity(Gravity.CENTER); add(content,privacy,12);
        Button feedback = textButton("反馈建议 ↗",false);
        feedback.setOnClickListener(v -> openLink(ISSUES,"反馈建议")); add(content,feedback,2);
        limitsToggle = textButton("支持范围与限制 ⌄",false);
        limitsToggle.setOnClickListener(v -> toggleLimits()); add(content,limitsToggle,4);
        limitsBody = text(limitsText(),12,1);
        limitsBody.setVisibility(View.GONE);
        limitsBody.setPadding(dp(4),0,dp(4),dp(8));
        add(content,limitsBody,4);
        preview = column(); preview.setPadding(dp(12),dp(8),dp(12),dp(8));
        preview.setVisibility(View.GONE);
        root.addView(preview,new FrameLayout.LayoutParams(-1,-1));
        LinearLayout header = row();
        Button backButton = textButton("‹",false); backButton.setTextSize(36);
        backButton.setContentDescription("返回首页"); backButton.setOnClickListener(v -> back.run());
        header.addView(backButton,new LinearLayout.LayoutParams(dp(44),-2));
        LinearLayout info = column(); info.setPadding(dp(8),dp(4),dp(8),dp(4));
        info.setMinimumHeight(dp(44)); info.setClickable(true); info.setFocusable(true);
        info.setContentDescription("查看文件详情"); info.setOnClickListener(v -> showDetails()); surfaces.add(info);
        LinearLayout nameRow = row();
        fileFormat=text("文件",10,2); fileFormat.setTypeface(null,1);
        fileFormat.setPadding(dp(4),dp(2),dp(4),dp(2));
        nameRow.addView(fileFormat,new LinearLayout.LayoutParams(-2,-2));
        filename=text("正在打开…",14,0); filename.setTypeface(null,1); filename.setSingleLine(); filename.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(0,-2,1);
        nameParams.leftMargin=dp(7); nameParams.rightMargin=dp(5); nameRow.addView(filename,nameParams);
        nameRow.addView(text("详情⌄",12,2)); info.addView(nameRow);
        fileMeta=text("仅在本地处理",12,1); fileMeta.setSingleLine(); fileMeta.setEllipsize(TextUtils.TruncateAt.END);
        add(info,fileMeta,2);
        LinearLayout.LayoutParams infoParams = new LinearLayout.LayoutParams(0,-2,1);
        infoParams.setMarginStart(dp(8)); header.addView(info,infoParams); preview.addView(header);

        // The canvas and tools can scroll together only if a short screen cannot fit
        // their minimum height. The header and save action stay outside that scroll.
        previewHost = new ScrollView(activity);
        previewHost.setFillViewport(true);
        previewHost.setVerticalScrollBarEnabled(false);
        preview.addView(previewHost,new LinearLayout.LayoutParams(-1,0,1));
        stage = new PreviewViewport(activity);
        stage.setClipToOutline(true);
        stage.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline outline) { outline.setRoundRect(0,0,v.getWidth(),v.getHeight(),dp(12)); }
        });
        bitmapImage = new PreviewImage();
        image = bitmapImage; image.setScaleType(ImageView.ScaleType.FIT_XY);
        image.setContentDescription("文件位图预览，完整适屏"); image.setVisibility(View.GONE);
        previewContent = new FrameLayout(activity);
        stage.addView(previewContent,new FrameLayout.LayoutParams(-1,-1));
        previewContent.addView(image,new FrameLayout.LayoutParams(-1,-1));
        svg.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        svg.setVisibility(View.GONE); previewContent.addView(svg,new FrameLayout.LayoutParams(-1,-1));
        stageMessage = new ScrollView(activity); stageMessage.setFillViewport(true);
        LinearLayout state = column();
        state.setGravity(Gravity.CENTER);
        state.setPadding(dp(14),dp(8),dp(14),dp(8));
        loading = new ProgressBar(activity);
        loading.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        loading.setVisibility(View.GONE);
        state.addView(loading,new LinearLayout.LayoutParams(dp(28),dp(28)));
        status=text("正在打开本地文件…",14,0); status.setGravity(Gravity.CENTER);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        add(state,status,8);
        retry=button("重试",false);
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> { if (retryTask!=null) retryTask.run(); });
        state.addView(retry,new LinearLayout.LayoutParams(-2,-2));
        stageMessage.addView(state,new ScrollView.LayoutParams(-1,-2));
        stage.addView(stageMessage,new FrameLayout.LayoutParams(-1,-1));
        detailLoading=text("正在加载高清细节",12,0);
        detailLoading.setPadding(dp(8),dp(6),dp(8),dp(6));
        detailLoading.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        detailLoading.setVisibility(View.GONE);
        surfaces.add(detailLoading);
        FrameLayout.LayoutParams detailLoadingParams = new FrameLayout.LayoutParams(-2,-2,Gravity.TOP|Gravity.END);
        detailLoadingParams.topMargin=dp(8); detailLoadingParams.setMarginEnd(dp(8));
        stage.addView(detailLoading,detailLoadingParams);

        gestureHint = text("双击 / 双指缩放 · 拖动查看",12,1);
        gestureHint.setGravity(Gravity.CENTER);
        previewHint = row();
        playbackToggle = toolButton("开始",null,() -> {});
        playbackRestart = toolButton("重播",null,() -> {});
        playbackToggle.setVisibility(View.GONE);
        playbackRestart.setVisibility(View.GONE);
        previewHint.addView(playbackToggle,new LinearLayout.LayoutParams(-2,-2));
        LinearLayout.LayoutParams playbackParams = new LinearLayout.LayoutParams(-2,-2);
        playbackParams.setMarginStart(dp(6));
        previewHint.addView(playbackRestart,playbackParams);
        previewHint.addView(gestureHint,new LinearLayout.LayoutParams(0,-2,1));

        toolbar = new HorizontalScrollView(activity);
        toolbar.setFillViewport(true);
        toolbar.setHorizontalScrollBarEnabled(false);
        LinearLayout tools = row();
        fit=toolButton("适屏","适应屏幕",stage::fit);
        tools.addView(fit,new LinearLayout.LayoutParams(dp(44),-2));

        LinearLayout zoomGroup = new LinearLayout(activity) {
            @Override protected void onMeasure(int width,int height) {
                int available=MeasureSpec.getMode(width)==MeasureSpec.UNSPECIFIED ? dp(137) : MeasureSpec.getSize(width);
                super.onMeasure(MeasureSpec.makeMeasureSpec(Math.min(available,dp(240)),MeasureSpec.EXACTLY),height);
            }
        };
        zoomGroup.setGravity(Gravity.CENTER);
        zoomGroup.setMinimumWidth(dp(137));
        surfaces.add(zoomGroup);
        zoomOut=textButton("−",false);
        zoomIn=textButton("＋",false);
        zoomOut.setContentDescription("缩小");
        zoomIn.setContentDescription("放大");
        zoomOut.setOnClickListener(v -> stage.step(-.25f));
        zoomIn.setOnClickListener(v -> stage.step(.25f));
        zoomOut.setTextSize(22); zoomIn.setTextSize(22);
        zoomValue=text("100%",12,1);
        zoomValue.setGravity(Gravity.CENTER);
        zoomValue.setMinWidth(dp(49));
        zoomValue.setSingleLine();
        zoomGroup.addView(zoomOut,new LinearLayout.LayoutParams(dp(44),-2));
        zoomGroup.addView(zoomValue,new LinearLayout.LayoutParams(0,-2,1));
        zoomGroup.addView(zoomIn,new LinearLayout.LayoutParams(dp(44),-2));

        FrameLayout zoomSlot = new FrameLayout(activity);
        zoomSlot.setMinimumWidth(dp(153));
        zoomSlot.setPadding(dp(8),0,dp(8),0);
        zoomSlot.addView(zoomGroup,new FrameLayout.LayoutParams(-1,-2,Gravity.CENTER));
        tools.setMinimumWidth(dp(253));
        tools.addView(zoomSlot,new LinearLayout.LayoutParams(0,-2,1));

        toolsTrigger=toolButton("工具⌄","预览工具",this::openTools);
        tools.addView(toolsTrigger,new LinearLayout.LayoutParams(-2,-2));
        inlineTools = row();
        toolItems = row();
        background=toolButton("背景：棋盘",null,() -> { backgroundMode=(backgroundMode+1)%3; updateBackground(); });
        toolItems.addView(background);
        Button reset=toolButton("重置","重置预览",() -> { stage.fit(); closeTools(); });
        LinearLayout.LayoutParams resetParams=new LinearLayout.LayoutParams(-2,-2);
        resetParams.setMarginStart(dp(6)); toolItems.addView(reset,resetParams);
        inlineTools.addView(toolItems);
        tools.addView(inlineTools);
        stage.setZoomListener(this::updateZoom);
        toolbar.addView(tools,new HorizontalScrollView.LayoutParams(-1,-2));

        details=text("",14,0); // Full metadata belongs to a scrollable sheet.
        notes=new ScrollView(activity);
        notes.setVerticalScrollBarEnabled(false);
        notesCard=column();
        notesCard.setPadding(dp(10),dp(4),dp(8),dp(4));
        notesCard.setOnClickListener(v -> showDetails());
        notesCard.setFocusable(false);
        outputNote=text("",12,1);
        add(notesCard,outputNote,0);
        notice=text("",12,1);
        notice.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        notice.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        add(notesCard,notice,2);
        notes.addView(notesCard,new ScrollView.LayoutParams(-1,-2));

        PreviewBody body=new PreviewBody();
        body.addView(stage);
        body.addView(previewHint);
        body.addView(toolbar);
        body.addView(notes);
        previewHost.addView(body,new ScrollView.LayoutParams(-1,-2));

        footer=column();
        preview.addView(footer);
        cancel=toolButton("取消处理",null,cancelTask);
        add(footer,cancel,8);
        save=button("保存预览 PNG",true);
        save.setTextSize(14);
        save.setEnabled(false);
        save.setOnClickListener(v -> export.run());
        add(footer,save,8);
        unavailableSave=text("当前文件暂不能保存图片",12,1);
        unavailableSave.setGravity(Gravity.CENTER);
        unavailableSave.setMinHeight(dp(44));
        add(footer,unavailableSave,8);
        status.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s,int start,int count,int after) { }
            @Override public void onTextChanged(CharSequence s,int start,int before,int count) {
                homeStatus.setText(s); notice.setText(s);
                String message=s.toString();
                boolean error=isError(message);
                homeStatus.setVisibility(message.startsWith("请选择文件。") ? View.GONE : View.VISIBLE);
                notice.setVisibility(message.endsWith("预览已就绪。") && outputNote.length()>0 ? View.GONE : View.VISIBLE);
                status.setTextColor(error?palette.errorText:palette.text);
                notice.setTextColor(error?palette.errorText:palette.muted);
                stageMessage.setBackgroundColor(error?palette.errorBg:palette.bg);
                styleNotes(error);
            }
            @Override public void afterTextChanged(Editable e) { }
        });
        applyPalette();
        configurationChanged();
        refresh();
    }

    void beginFile() {
        previewVisible=true;
        home.setVisibility(View.GONE);
        preview.setVisibility(View.VISIBLE);
        previewHost.scrollTo(0,0);
        notes.scrollTo(0,0);
        fileFormat.setText("文件");
        filename.setText("正在打开…");
        fileSizeText="仅在本地处理";
        setDimensions(null);
        refresh();
    }
    void setFile(String name,long bytes) {
        filename.setText(name);
        if (bytes>=1024L*1024*1024) {
            fileSizeText=String.format(Locale.ROOT,"%.2f GiB · %d 字节",bytes/1073741824.0,bytes);
        } else {
            fileSizeText=bytes>=1024*1024?String.format(Locale.ROOT,"%.1f MiB · %d 字节",bytes/1048576.0,bytes):bytes+" 字节";
        }
        setDimensions(dimensions);
    }
    void setFormat(String format) {
        fileFormat.setText(format);
        gestureHint.setText("RAW".equals(format) ? "相机内嵌 JPG · 双击 / 双指缩放" : "双击 / 双指缩放 · 拖动查看");
    }
    void setDimensions(String value) {
        dimensions=value;
        fileMeta.setText(dimensions==null || dimensions.isEmpty()?fileSizeText:dimensions+" · "+fileSizeText);
    }
    void setOutput(String action,String note) {
        outputAction=action;
        if (action!=null) save.setText(action);
        outputNote.setText(note==null?"":note);
        refresh();
    }
    void setRetry(Runnable task) { retryTask=task; refresh(); }
    void setViewportListener(Consumer<PreviewViewport.Region> listener) { stage.setViewportListener(listener); }
    void setDetailAvailable(boolean available) { stage.setDetailAvailable(available); }
    void setDetailLoading(boolean visible) { detailLoading.setVisibility(visible?View.VISIBLE:View.GONE); }
    void showDetail(Bitmap bitmap,float left,float top,float right,float bottom) {
        bitmapImage.setDetail(bitmap,left,top,right,bottom);
    }
    void clearDetail() { bitmapImage.setDetail(null,0,0,0,0); setDetailLoading(false); }
    void showImage(int previewWidth,int previewHeight,int sourceWidth,int sourceHeight) {
        setSvgDescription(null);
        image.setVisibility(View.VISIBLE);
        svg.setVisibility(View.GONE);
        stage.show(previewContent,sourceWidth>0?sourceWidth:previewWidth,sourceHeight>0?sourceHeight:previewHeight,previewWidth,previewHeight);
        refresh();
    }
    void showSvg(int width,int height) {
        image.setVisibility(View.GONE);
        setSvgDescription("SVG 静态预览");
        svg.setVisibility(View.VISIBLE);
        stage.show(previewContent,Math.max(1,width),Math.max(1,height),Math.max(1,width),Math.max(1,height));
        refresh();
    }
    void showSvgFrame(boolean visible) {
        setSvgDescription(visible?"SVG 动画预览":null);
        image.setVisibility(visible?View.GONE:View.VISIBLE);
        svg.setVisibility(visible?View.VISIBLE:View.GONE);
    }
    void prepareSvgFrameView() {
        // An attached invisible view can confirm its first compositor frame while
        // the initial PNG remains visible underneath it.
        svg.setVisibility(View.INVISIBLE);
    }
    private void setSvgDescription(String description) {
        previewContent.setImportantForAccessibility(description==null?View.IMPORTANT_FOR_ACCESSIBILITY_AUTO:View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        previewContent.setContentDescription(description);
    }
    void setSvgControls(String label,boolean replay,Runnable toggleTask,Runnable replayTask) {
        boolean available=label!=null;
        playbackToggle.setVisibility(available?View.VISIBLE:View.GONE);
        playbackRestart.setVisibility(available?View.VISIBLE:View.GONE);
        if (available) playbackToggle.setText(label);
        playbackToggle.setEnabled(available && !busy);
        playbackRestart.setEnabled(replay && !busy);
        playbackToggle.setOnClickListener(available?v -> toggleTask.run():null);
        playbackRestart.setOnClickListener(replay?v -> replayTask.run():null);
    }
    void clearPreview() {
        closeTools();
        stage.clear();
        clearDetail();
        setSvgDescription(null);
        image.setVisibility(View.GONE);
        svg.setVisibility(View.GONE);
        setSvgControls(null,false,null,null);
        retryTask=null;
        setOutput(null,null);
    }
    void home() {
        closeTools();
        previewVisible=false;
        preview.setVisibility(View.GONE);
        home.setVisibility(View.VISIBLE);
    }
    boolean isPreview() { return previewVisible; }
    void setBusy(boolean busy) { this.busy=busy; refresh(); }
    void refresh() {
        boolean ready=stage.hasContent();
        stageMessage.setVisibility(ready?View.GONE:View.VISIBLE);
        toolbar.setVisibility(ready?View.VISIBLE:View.GONE);
        previewHint.setVisibility(ready?View.VISIBLE:View.GONE);
        notes.setVisibility(ready?View.VISIBLE:View.GONE);
        loading.setVisibility(busy && !ready?View.VISIBLE:View.GONE);
        retry.setVisibility(!busy && retryTask!=null?View.VISIBLE:View.GONE);
        cancel.setVisibility(busy?View.VISIBLE:View.GONE);
        save.setVisibility(outputAction!=null?View.VISIBLE:View.GONE);
        outputNote.setVisibility(outputNote.length()>0?View.VISIBLE:View.GONE);
        unavailableSave.setVisibility(ready && !busy && outputAction==null ? View.VISIBLE : View.GONE);
        footer.setVisibility(ready || busy || outputAction!=null ? View.VISIBLE : View.GONE);
        updateZoomLabelEnabled();
    }
    void configurationChanged() {
        closeTools();
        android.content.res.Configuration config=activity.getResources().getConfiguration();
        compact=config.screenHeightDp<=500;
        wideTools=config.screenWidthDp>640;
        toolsTrigger.setVisibility(wideTools ? View.GONE : View.VISIBLE);
        inlineTools.setVisibility(wideTools ? View.VISIBLE : View.GONE);
        preview.setPadding(dp(12),dp(compact?4:8),dp(12),dp(8));
        refresh();
        root.requestApplyInsets();
    }
    void dispose() {
        closeTools();
        if (dialog!=null) dialog.dismiss();
    }

    private void openTools() {
        if (toolsPopup!=null || wideTools || !stage.hasContent()) return;
        inlineTools.removeView(toolItems);
        FrameLayout panel=new FrameLayout(activity);
        panel.setPadding(dp(6),dp(4),dp(6),dp(4));
        panel.setBackground(shape(palette.bg,palette.control,12));
        panel.addView(toolItems,new FrameLayout.LayoutParams(-2,-2));
        panel.measure(View.MeasureSpec.UNSPECIFIED,View.MeasureSpec.UNSPECIFIED);
        PopupWindow popup=new PopupWindow(panel,panel.getMeasuredWidth(),panel.getMeasuredHeight(),true);
        toolsPopup=popup;
        popup.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        popup.setElevation(dp(8));
        popup.setOutsideTouchable(true);
        popup.setOnDismissListener(() -> {
            panel.removeView(toolItems);
            inlineTools.addView(toolItems);
            toolsPopup=null;
        });
        popup.showAsDropDown(toolsTrigger,0,-toolsTrigger.getHeight()-panel.getMeasuredHeight()-dp(8),Gravity.END);
    }
    private void closeTools() {
        if (toolsPopup!=null) toolsPopup.dismiss();
    }
    private void toggleLimits() {
        boolean expanded=limitsBody.getVisibility()!=View.VISIBLE;
        limitsBody.setVisibility(expanded?View.VISIBLE:View.GONE);
        limitsToggle.setText(expanded?"支持范围与限制 ⌃":"支持范围与限制 ⌄");
    }
    private static boolean isError(String message) {
        return message.contains("失败") || message.contains("无法") || message.contains("内存不足");
    }
    private void styleNotes(boolean error) {
        notesCard.setBackground(shape(error?palette.errorBg:palette.bg,error?palette.errorText:palette.border,6));
    }
    private GradientDrawable shape(int fill,int stroke,int radius) {
        GradientDrawable background=new GradientDrawable();
        background.setColor(fill);
        background.setCornerRadius(dp(radius));
        if (stroke!=Color.TRANSPARENT) background.setStroke(dp(1),stroke);
        return background;
    }
    private Button textButton(String label,boolean subdued) {
        Button b=button(label,false);
        surfaces.remove(b);
        if (subdued && controls.remove(b)) muted.add(b);
        b.setBackground(new ColorDrawable(Color.TRANSPARENT));
        b.setMinHeight(dp(44)); b.setMinimumHeight(dp(44));
        b.setMinWidth(dp(44)); b.setMinimumWidth(dp(44));
        b.setTextSize(12);
        b.setPadding(dp(4),0,dp(4),0);
        return b;
    }

    private LinearLayout row() { LinearLayout l=new LinearLayout(activity); l.setOrientation(LinearLayout.HORIZONTAL); l.setGravity(Gravity.CENTER_VERTICAL); return l; }
    private LinearLayout column() { LinearLayout l=new LinearLayout(activity); l.setOrientation(LinearLayout.VERTICAL); return l; }
    private int dp(int value) { return Math.round(value*activity.getResources().getDisplayMetrics().density); }
    private TextView text(String value,int sp,int role) {
        TextView t=new TextView(activity); t.setText(value); t.setTextSize(sp); t.setIncludeFontPadding(false); t.setLineSpacing(dp(3),1);
        if (!buildingDialog) (role==0?normal:role==1?muted:controls).add(t);
        else t.setTextColor(role==0?palette.text:role==1?palette.muted:palette.control);
        return t;
    }
    private Button button(String label,boolean main) {
        Button b=new Button(activity); b.setText(label); b.setTextSize(14); b.setAllCaps(false);
        b.setMinimumHeight(dp(48)); b.setMinHeight(dp(48)); b.setMinimumWidth(dp(48)); b.setMinWidth(dp(48));
        b.setPadding(dp(15),dp(12),dp(15),dp(12)); b.setStateListAnimator(null);
        b.setBackgroundTintList(null); b.setTypeface(null,main?1:0);
        if (!buildingDialog) { if (main) primary.add(b); else { controls.add(b); surfaces.add(b); } }
        else {
            b.setTextColor(main?palette.onAccent:palette.control); b.setLayerType(View.LAYER_TYPE_SOFTWARE,null);
            b.setBackground(new SoftSurface(activity.getResources().getDisplayMetrics().density,palette,main,12));
        }
        return b;
    }
    private Button toolButton(String label,String description,Runnable action) {
        Button button=button(label,false);
        button.setTextSize(12);
        button.setMinHeight(dp(44)); button.setMinimumHeight(dp(44));
        button.setMinWidth(dp(44)); button.setMinimumWidth(dp(44));
        button.setPadding(dp(8),dp(4),dp(8),dp(4));
        button.setSingleLine();
        if (description!=null) button.setContentDescription(description);
        button.setOnClickListener(v -> action.run());
        return button;
    }
    private double zoom=1;
    private void updateZoom(double value) {
        zoom=value;
        zoomValue.setText(Math.round(100*zoom)+"%");
        updateZoomLabelEnabled();
    }
    private void updateZoomLabelEnabled() {
        zoomOut.setEnabled(zoom>1);
        zoomIn.setEnabled(zoom<stage.maxZoom());
        fit.setEnabled(stage.hasContent());
    }
    private void add(LinearLayout parent,View child,int top) {
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2); p.topMargin=dp(top); parent.addView(child,p);
    }
    private void applyPalette() {
        root.setBackgroundColor(palette.bg); activity.getWindow().setBackgroundDrawable(new ColorDrawable(palette.bg));
        homeMark.invalidate();
        Drawable paletteIcon=new PaletteIcon();
        paletteIcon.setBounds(0,0,dp(18),dp(18));
        themeButton.setCompoundDrawablesRelative(paletteIcon,null,null,null);
        for (TextView t:normal) t.setTextColor(palette.text);
        for (TextView t:muted) t.setTextColor(palette.muted);
        for (TextView t:controls) t.setTextColor(new ColorStateList(new int[][]{{-android.R.attr.state_enabled},{}},
            new int[]{withAlpha(palette.control,130),palette.control}));
        float density=activity.getResources().getDisplayMetrics().density;
        for (View v:surfaces) { v.setLayerType(View.LAYER_TYPE_SOFTWARE,null); v.setBackground(new SoftSurface(density,palette,false,12)); }
        themeButton.setBackground(new SoftSurface(density,palette,false,999));
        fileFormat.setBackground(shape(palette.border,Color.TRANSPARENT,5));
        styleNotes(isError(status.getText().toString()));
        for (Button b:primary) {
            b.setLayerType(View.LAYER_TYPE_SOFTWARE,null); b.setBackground(new SoftSurface(density,palette,true,12));
            b.setTextColor(new ColorStateList(new int[][]{{-android.R.attr.state_enabled},{}},new int[]{withAlpha(palette.onAccent,130),palette.onAccent}));
        }
        for (View rule:rules) rule.setBackgroundColor(palette.border);
        stageMessage.setBackgroundColor(palette.bg);
        loading.setIndeterminateTintList(ColorStateList.valueOf(palette.accent));
        int flags=View.SYSTEM_UI_FLAG_LAYOUT_STABLE|View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN|View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        if (!palette.key.equals("night")) flags|=View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        activity.getWindow().getDecorView().setSystemUiVisibility(flags);
        activity.getWindow().setStatusBarColor(Color.TRANSPARENT); activity.getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT>=30) activity.getWindow().setDecorFitsSystemWindows(false);
        updateBackground(); root.requestApplyInsets();
    }
    private static int withAlpha(int color,int alpha) { return (color&0x00ffffff)|(alpha<<24); }
    private void updateBackground() {
        background.setText(new String[]{"背景：棋盘","背景：白","背景：黑"}[backgroundMode]);
        background.setContentDescription(background.getText()+"，点此切换");
        stage.setBackground(new Checker(backgroundMode,dp(12)));
        // CSS-transparent sanitized SVG shares the same native preview backdrop.
        svg.setBackgroundColor(Color.TRANSPARENT);
    }
    private void showThemes() {
        LinearLayout panel=dialogPanel("界面主题");
        add(panel,text("选择喜欢的界面颜色",12,1),4);
        ScrollView scroll=new ScrollView(activity);
        LinearLayout options=column(); scroll.addView(options);
        panel.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        for (String key:new String[]{"ink","paper","night"}) {
            UiPalette option=UiPalette.get(activity,key);
            boolean selected=key.equals(palette.key);
            Button b=button(option.name,false);
            b.setContentDescription(option.name+(selected?"，已选中":""));
            b.setSelected(selected);
            b.setTextColor(palette.text);
            b.setGravity(Gravity.START|Gravity.CENTER_VERTICAL);
            b.setPadding(dp(14),0,dp(14),0);
            b.setCompoundDrawablePadding(dp(10));
            GradientDrawable swatch=new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{option.bg,option.bg,option.accent,option.accent});
            swatch.setBounds(0,0,dp(24),dp(24));
            swatch.setCornerRadius(dp(6));
            swatch.setStroke(dp(1),palette.border);
            b.setCompoundDrawablesRelative(swatch,null,null,null);
            b.setOnClickListener(v -> {
                palette=option; activity.getPreferences(0).edit().putString("ui-theme",key).apply();
                dialog.dismiss(); applyPalette();
            });
            if (selected) b.setBackground(shape(palette.bg,palette.control,9));
            add(options,b,7);
        }
        showPanel(panel,Gravity.CENTER,292);
    }
    private void showDetails() {
        LinearLayout panel=dialogPanel("文件详情");
        ScrollView scroll=new ScrollView(activity);
        LinearLayout content=column();
        TextView name=text(filename.getText().toString(),14,0);
        name.setTypeface(null,1);
        name.setTextIsSelectable(true);
        add(content,name,12);
        addFact(content,"格式",fileFormat.getText());
        addFact(content,"文件大小",fileSizeText);
        addFact(content,"图像尺寸",dimensions);
        addFact(content,"本次保存",outputNote.getText());
        TextView metadata=text(details.getText().toString(),12,1);
        metadata.setTextIsSelectable(true);
        add(content,metadata,10);
        if (!status.getText().toString().endsWith("预览已就绪。")) add(content,text(status.getText().toString(),12,0),6);
        scroll.addView(content);
        panel.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        showPanel(panel,Gravity.BOTTOM,520);
    }
    private void addFact(LinearLayout content,String label,CharSequence value) {
        if (TextUtils.isEmpty(value)) return;
        LinearLayout fact=row();
        fact.setPadding(0,dp(8),0,dp(8));
        fact.addView(text(label,12,1),new LinearLayout.LayoutParams(dp(105),-2));
        TextView factValue=text(value.toString(),12,0);
        factValue.setTextIsSelectable(true);
        fact.addView(factValue,new LinearLayout.LayoutParams(0,-2,1));
        content.addView(fact);
        View divider=new View(activity);
        divider.setBackgroundColor(palette.border);
        content.addView(divider,new LinearLayout.LayoutParams(-1,dp(1)));
    }
    private String limitsText() {
        return "RAW：提取受支持 ARW、CR2、CR3、NEF、RAF、DNG 的内嵌 JPEG，不进行传感器显影。\n\n"
            +"PSD／PSB：支持部分保存合成图的分段概览、局部高清和原尺寸 PNG；不重绘图层。未支持的合成类型仅在存在有效缩略图时回退。\n\n"
            +"TIFF／BigTIFF：支持标准方向、未压缩条带、8／16 位 RGB 或灰度的第一页与局部高清。经典 TIFF 的压缩路径保留 32 MiB 文件上限。\n\n"
            +"AI：须含有效 PDF 兼容内容，仅显示第一页。\n\nSVG：最多 1 MiB，支持白名单内的静态图形和基础旋转、位移、缩放、数值或结构一致的路径动画。动画的预览 PNG 保存首帧。\n\n"
            +OUTPUT_NOTE+"\n\n大文件使用 64 位偏移分段读取。可读范围取决于格式布局与系统文件提供方。\n\n本地处理，无账号、服务器或原稿上传。";
    }
    private LinearLayout dialogPanel(String title) {
        if (dialog!=null) dialog.dismiss();
        buildingDialog=true;
        dialog=new Dialog(activity);
        LinearLayout panel=column(); panel.setPadding(dp(12),dp(8),dp(12),dp(12));
        panel.setBackground(shape(palette.bg,palette.border,16));
        LinearLayout header=row(); TextView heading=text(title,16,0); heading.setTypeface(null,1); heading.setTextColor(palette.text);
        header.addView(heading,new LinearLayout.LayoutParams(0,-2,1));
        Button close=textButton("×",false);
        close.setTextSize(24);
        close.setContentDescription("关闭");
        close.setOnClickListener(v -> dialog.dismiss());
        header.addView(close); panel.addView(header);
        return panel;
    }
    private void showPanel(LinearLayout panel,int gravity,int maxHeightDp) {
        buildingDialog=false;
        dialog.setContentView(panel); dialog.show();
        if (dialog.getWindow()!=null) {
            dialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            dialog.getWindow().setDimAmount(.36f); dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            int width=Math.min(activity.getResources().getDisplayMetrics().widthPixels-dp(24),
                dp(gravity==Gravity.BOTTOM?640:360));
            int available=activity.getResources().getDisplayMetrics().heightPixels;
            float heightFraction=gravity==Gravity.BOTTOM ? .65f : .80f;
            int height=maxHeightDp>0 ? Math.min(Math.round(available*heightFraction),dp(maxHeightDp)) : -2;
            dialog.getWindow().setLayout(width,height);
            dialog.getWindow().setGravity(gravity|Gravity.CENTER_HORIZONTAL);
            if (gravity==Gravity.BOTTOM) {
                WindowManager.LayoutParams params=dialog.getWindow().getAttributes();
                params.y=dp(12);
                dialog.getWindow().setAttributes(params);
            }
        }
    }
    private void openProject() {
        openLink(PROJECT,"GitHub 项目");
    }
    private void openLink(String url,String name) {
        try { activity.startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url))); }
        catch (RuntimeException unavailable) {
            LinearLayout panel=dialogPanel(name);
            TextView link=text(url,13,0); link.setTextColor(palette.text); link.setTextIsSelectable(true); add(panel,link,8);
            Button copy=button("复制链接",true); copy.setTextColor(palette.onAccent); copy.setBackgroundColor(palette.accent);
            copy.setOnClickListener(v -> {
                ClipboardManager clipboard=(ClipboardManager)activity.getSystemService(Activity.CLIPBOARD_SERVICE);
                if (clipboard!=null) { clipboard.setPrimaryClip(ClipData.newPlainText(name,url)); homeStatus.setText("链接已复制。"); }
                dialog.dismiss();
            }); add(panel,copy,12); showPanel(panel,Gravity.CENTER,-2);
        }
    }
    /** Fits the image first, then gives the space below the toolbar to the scrollable notes. */
    private final class PreviewBody extends ViewGroup {
        PreviewBody() { super(activity); }

        @Override protected void onMeasure(int widthSpec,int heightSpec) {
            int width=MeasureSpec.getSize(widthSpec);
            int exactWidth=MeasureSpec.makeMeasureSpec(width,MeasureSpec.EXACTLY);
            int wrap=MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED);
            boolean ready=stage.hasContent();
            int top=dp(compact?4:8), gap=dp(compact?4:8);
            int below=0;
            if (ready) {
                previewHint.measure(exactWidth,wrap);
                toolbar.measure(exactWidth,wrap);
                below=dp(4)+previewHint.getMeasuredHeight()+gap+toolbar.getMeasuredHeight()+gap;
            }
            int reserve=ready ? dp(compact?36:44) : 0;
            boolean bounded=MeasureSpec.getMode(heightSpec)!=MeasureSpec.UNSPECIFIED;
            int canvasLimit=bounded ? MeasureSpec.getSize(heightSpec)-top-below-reserve : dp(compact?90:144);
            stage.measureFitted(width,Math.max(1,canvasLimit));
            int used=top+stage.getMeasuredHeight()+below;
            int height=resolveSize(used+reserve,heightSpec);
            if (ready) notes.measure(exactWidth,MeasureSpec.makeMeasureSpec(Math.max(0,height-used),MeasureSpec.EXACTLY));
            setMeasuredDimension(width,height);
        }

        @Override protected void onLayout(boolean changed,int left,int top,int right,int bottom) {
            int width=right-left;
            int y=dp(compact?4:8);
            int stageLeft=(width-stage.getMeasuredWidth())/2;
            stage.layout(stageLeft,y,stageLeft+stage.getMeasuredWidth(),y+stage.getMeasuredHeight());
            if (!stage.hasContent()) return;

            y+=stage.getMeasuredHeight()+dp(4);
            previewHint.layout(0,y,width,y+previewHint.getMeasuredHeight());
            int gap=dp(compact?4:8);
            y+=previewHint.getMeasuredHeight()+gap;
            toolbar.layout(0,y,width,y+toolbar.getMeasuredHeight());
            y+=toolbar.getMeasuredHeight()+gap;
            notes.layout(0,y,width,y+notes.getMeasuredHeight());
        }
    }

    private final class PaletteIcon extends Drawable {
        private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);

        @Override public void draw(Canvas canvas) {
            Rect bounds=getBounds();
            int state=canvas.save();
            canvas.translate(bounds.left,bounds.top);
            canvas.scale(bounds.width()/18f,bounds.height()/18f);
            canvas.rotate(-18,9,9);
            paint.setColor(palette.control);
            paint.setStrokeWidth(1.4f);
            paint.setStyle(Paint.Style.STROKE);
            canvas.drawOval(1,1,17,16,paint);
            paint.setStyle(Paint.Style.FILL);
            canvas.drawCircle(5,6,1.25f,paint);
            canvas.drawCircle(9,4.25f,1.25f,paint);
            canvas.drawCircle(13,6.5f,1.25f,paint);
            paint.setColor(palette.bg);
            canvas.drawCircle(14.5f,13.5f,3.25f,paint);
            canvas.restoreToCount(state);
        }

        @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
        @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    private final class PreviewImage extends ImageView {
        private final Paint filter = new Paint(Paint.FILTER_BITMAP_FLAG);
        private final RectF region = new RectF(), destination = new RectF();
        private Bitmap detail;

        PreviewImage() { super(activity); }

        void setDetail(Bitmap bitmap,float left,float top,float right,float bottom) {
            detail=bitmap;
            region.set(left,top,right,bottom);
            invalidate();
        }

        @Override protected void onDraw(Canvas canvas) {
            if (detail==null || detail.isRecycled()) {
                super.onDraw(canvas);
                return;
            }
            destination.set(region.left*getWidth(),region.top*getHeight(),region.right*getWidth(),region.bottom*getHeight());
            int state=canvas.save();
            canvas.clipOutRect(destination);
            super.onDraw(canvas);
            canvas.restoreToCount(state);
            canvas.drawBitmap(detail,null,destination,filter);
        }
    }
    /** The Mini Program's 86 × 100 rpx home mark, drawn with the selected palette. */
    private final class HomeMark extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF paper = new RectF(3, 2, 46, 52);
        private final Path page = new Path();
        private final Path fold = new Path();

        HomeMark() {
            super(activity);
            page.addRoundRect(paper, 8, 8, Path.Direction.CW);
            fold.addRoundRect(new RectF(33, 2, 46, 15), new float[]{0,0,0,0,0,0,4,4}, Path.Direction.CW);
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float density = getResources().getDisplayMetrics().density;
            canvas.save();
            canvas.scale(density, density);
            paint.setColor(palette.accent);
            paint.setShadowLayer(6, 1, 3, palette.dark);
            canvas.drawPath(page, paint);
            paint.clearShadowLayer();
            canvas.clipPath(page);
            paint.setColor("night".equals(palette.key) ? 0xffd2efe4 : 0xff8cdbc3);
            canvas.drawPath(fold, paint);
            paint.setColor(withAlpha(palette.onAccent, 230));
            canvas.drawRoundRect(13.5f, 29.5f, 32.5f, 31, 1, 1, paint);
            canvas.drawRoundRect(13.5f, 36.5f, 26.5f, 38, 1, 1, paint);
            canvas.restore();
        }
    }
    private static final class Checker extends Drawable {
        private final Paint paint=new Paint(); private final int mode,step;
        Checker(int mode,int step) { this.mode=mode; this.step=Math.max(step,1); }
        @Override public void draw(Canvas canvas) {
            canvas.drawColor(mode==2?0xff111111:Color.WHITE);
            if (mode==0) {
                paint.setColor(0xffedf0f2); Rect b=getBounds();
                for(int y=b.top;y<b.bottom;y+=step) for(int x=b.left;x<b.right;x+=step)
                    if (((x/step+y/step)&1)==0) canvas.drawRect(x,y,Math.min(x+step,b.right),Math.min(y+step,b.bottom),paint);
            }
        }
        @Override public void setAlpha(int alpha) { }
        @Override public void setColorFilter(ColorFilter filter) { }
        @Override public int getOpacity() { return PixelFormat.OPAQUE; }
    }
}

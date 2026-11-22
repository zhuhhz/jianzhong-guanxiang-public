import { chooseDesignFile, preparePreview, openAiDocument, sharePdfDocument, savePng, saveNativePng, previewRawJpeg, saveRawJpeg, cleanupPreview, discardGeneratedPng, type ChosenFile, type PhotoshopDetail, type PreparedPreview, type ImportSource } from '../../platform/wechat';
import { LIMITS, QuickViewError } from '../../core/shared';
import { photoshopViewport, rawPixelZoom, type ViewRect } from './photoshop-viewport';

const sizeLabel = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
const pixelLabel = (size?: { width?: number; height?: number }): string => size?.width && size.height ? `${size.width} × ${size.height} px` : '';
const SOURCE_LABELS: Record<NonNullable<ChosenFile['source']>, string> = { 'chat-file': '微信聊天文件', 'chat-image': '微信聊天图片', 'chat-all': '微信聊天', 'chat-open': '聊天直接打开', album: '相册' };
const PICKER_DIAGNOSTIC = /^source=(chat-file|chat-image|chat-all|album);list=(array|missing|other);count=(0|1|many|unknown);path=(missing|empty|string|other);tempFilePath=(missing|empty|string|other)$/;
const isPickerError = (code: string) => code === 'NO_FILE_EMPTY_LIST' || code === 'NO_FILE_PATH_MISSING';
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '处理失败，请重新选择文件。';
const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNEXPECTED_ERROR';
};
// Source diagnostics and successful color checks stay available in file details.
// Unknown warnings remain visible, including color, compatibility and decode failures.
const previewRisks = (warnings: string[]): string[] => [...new Set(warnings.filter(warning =>
  !/^(来源[：:]|(?:预算|预览)内最高有效 JPEG[：:]|相机原预览[：:]|传感器显影概览[：:]|原尺寸 PNG 为有效画面(?:[：:]|\s)|降采样概览|合成图概览|已核实 sRGB 矩阵\/TRC)/.test(warning)))];
const THEME_KEY = 'yijian-theme';
const SHARE_TITLE = '鉴中观象 · 设计文件，打开就看';
const THEME_COLORS = {
  ink: { background: '#f6f7f9', front: '#000000' },
  paper: { background: '#faf6ee', front: '#000000' },
  night: { background: '#171e24', front: '#ffffff' },
} as const;
type Theme = keyof typeof THEME_COLORS;
type ExportMode = '' | 'preview' | 'native' | 'delivery';
type PreviewTouchEvent = WechatMiniprogram.TouchEvent | WechatMiniprogram.TouchCanvas;
type PreviewPoint = { identifier: number; x: number; y: number; space: 'client' | 'canvas' };
const previewPoint = (touch?: WechatMiniprogram.TouchDetail | WechatMiniprogram.TouchCanvasDetail): PreviewPoint | undefined => {
  if (!touch) return;
  const x = 'clientX' in touch ? touch.clientX : touch.x, y = 'clientY' in touch ? touch.clientY : touch.y;
  if ([touch.identifier, x, y].every(Number.isFinite)) return { identifier: touch.identifier, x, y, space: 'clientX' in touch ? 'client' : 'canvas' };
};
const isTheme = (value: unknown): value is Theme => value === 'ink' || value === 'paper' || value === 'night';

Page({
  data: {
    theme: 'ink' as Theme,
    themePickerOpen: false,
    limitsOpen: false,
    canCopyDiagnostic: false,
    previewDetailsOpen: false,
    previewToolsOpen: false,
    canGuardPreview: false,
    previewBackSessions: [] as number[],
    hasFile: false,
    busy: false,
    busyText: '',
    busyHint: '',
    exportMode: '' as ExportMode,
    filename: '',
    filesize: '',
    format: '',
    dimensions: '',
    colorInfo: '',
    fileFacts: [] as { label: string; value: string }[],
    previewPath: '',
    stageStyle: '',
    previewBackground: 'checker' as 'checker' | 'white' | 'black',
    originalImage: '',
    rawAutoAvailable: false,
    rawAutoEnabled: false,
    canRawPixels: false,
    canRawJpeg: false,
    canViewRawJpeg: false,
    rawJpegSize: '',
    rawJpegInline: false,
    pixelPreview: false,
    viewportMounted: true,
    detailPath: '',
    detailStyle: '',
    detailLoading: false,
    isDocument: false,
    canShareDocument: false,
    canSave: false,
    previewAtOriginalSize: false,
    canNative: false,
    nativeState: 'IDLE',
    nativeProgress: 0,
    errorMessage: '',
    errorCode: '',
    pickerDiagnostic: '',
    canRetryChatFile: false,
    memoryNotice: '',
    warnings: [] as string[],
    importantWarnings: [] as string[],
    zoom: 1,
    zoomCommand: 1,
    zoomMax: 6,
    zoomLabel: '100%',
  },
  // Geometry uses live native readback; data.zoom is only the throttled toolbar value.
  viewportZoom: 1,
  zoomTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  pixelRatio: undefined as number | undefined,
  tapStart: undefined as (PreviewPoint & { time: number; canvas: boolean }) | undefined,
  lastTap: undefined as { x: number; y: number; time: number; canvas: boolean; space: 'client' | 'canvas' } | undefined,
  tapVersion: 0,
  pixelDisplayVersion: 0,
  previewFrame: undefined as { path: string; width: number; height: number } | undefined,
  frameVersion: 0,
  memoryListener: undefined as (() => void) | undefined,
  memoryRecovery: undefined as Promise<void> | undefined,
  detailSuspended: false,
  screenAwake: false,
  canvas: undefined as WechatMiniprogram.Canvas | undefined,
  exportPath: '',
  documentPath: '',
  rawOriginalPath: '',
  rawAutoPath: '',
  rawJpegPath: '',
  rawInlinePath: '',
  setRawAuto: undefined as PreparedPreview['setRawAuto'],
  rawExpiredPngModes: undefined as Partial<Record<'base' | 'optimized', true>> | undefined,
  jobId: 0,
  disposed: false,
  hidden: false,
  prepareTask: undefined as Promise<PreparedPreview> | undefined,
  prepareExport: undefined as PreparedPreview['prepareExport'],
  exportTask: undefined as Promise<string> | undefined,
  prepareNative: undefined as PreparedPreview['prepareNative'],
  nativeTask: undefined as Promise<string> | undefined,
  nativePath: '',
  nativeVersion: 0,
  nativeHeight: 0,
  detail: undefined as PhotoshopDetail | undefined,
  detailVersion: 0,
  detailTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  detailTask: undefined as Promise<void> | undefined,
  cancelDetailBounds: undefined as (() => void) | undefined,
  detailPending: false,
  detailKey: '',
  pixelSource: undefined as { path: string; width: number; height: number; jobId: number } | undefined,

  onLoad() {
    this.getPixelRatio();
    let canGuardPreview = false;
    try { canGuardPreview = !!wx.canIUse?.('page-container'); } catch { /* Older clients retain the visible back button. */ }
    this.setData({ canCopyDiagnostic: typeof wx.setClipboardData === 'function', canGuardPreview });
    if (!this.memoryListener && typeof wx.onMemoryWarning === 'function') {
      this.memoryListener = () => { void this.handleMemoryWarning(); };
      wx.onMemoryWarning(this.memoryListener);
    }
    let stored: unknown;
    try { stored = wx.getStorageSync(THEME_KEY); } catch { /* Use the default if local storage is unavailable. */ }
    this.applyTheme(isTheme(stored) ? stored : 'ink');
    wx.showShareMenu?.({ menus: ['shareAppMessage', 'shareTimeline'], fail: () => {} });
  },

  getPixelRatio(): number {
    if (this.pixelRatio !== undefined) return this.pixelRatio;
    let ratio: number | undefined;
    try { ratio = wx.getWindowInfo?.().pixelRatio; } catch { /* Fall back on older clients. */ }
    if (!ratio || !Number.isFinite(ratio) || ratio <= 0) {
      try { ratio = wx.getSystemInfoSync?.().pixelRatio; } catch { /* Use CSS pixel density. */ }
    }
    return this.pixelRatio = ratio && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  },

  onShareAppMessage() {
    return {
      title: SHARE_TITLE,
      path: '/pages/index/index',
      imageUrl: '/assets/share-cover.png',
    };
  },

  onShareTimeline() {
    return { title: SHARE_TITLE, query: '' };
  },

  openThemePicker() { this.setData({ themePickerOpen: true }); },
  closeThemePicker() { this.setData({ themePickerOpen: false }); },
  keepThemePickerOpen() {},
  toggleLimits() { this.setData({ limitsOpen: !this.data.limitsOpen }); },
  togglePreviewDetails() { this.resetPreviewTap(); this.setData({ previewDetailsOpen: !this.data.previewDetailsOpen, previewToolsOpen: false }); },
  closePreviewDetails() { this.resetPreviewTap(); this.setData({ previewDetailsOpen: false }); },
  togglePreviewTools() { this.resetPreviewTap(); this.setData({ previewToolsOpen: !this.data.previewToolsOpen }); },
  closePreviewTools() { this.resetPreviewTap(); this.setData({ previewToolsOpen: false }); },

  offerUpdate() {
    if (typeof getApp === 'function') getApp<{ offerUpdate?: () => void }>().offerUpdate?.();
  },

  reportError(error: unknown) {
    const code = errorCode(error), details = (error as { pickerDiagnostic?: unknown } | null)?.pickerDiagnostic;
    const pickerDiagnostic = isPickerError(code) && typeof details === 'string' && PICKER_DIAGNOSTIC.exec(details)?.[0] === details ? details : '';
    this.setData({ errorMessage: errorMessage(error), errorCode: code, pickerDiagnostic,
      canRetryChatFile: pickerDiagnostic.startsWith('source=chat-all;') });
  },

  copyDiagnostic() {
    if (!this.data.canCopyDiagnostic) return;
    const version = (value: unknown) => typeof value === 'string' && /^[\w.+-]{1,40}$/.test(value) ? value : 'UNKNOWN';
    let appVersion = 'UNKNOWN', sdkVersion = 'UNKNOWN', clientVersion = 'UNKNOWN', environment = 'UNKNOWN';
    try {
      const account = wx.getAccountInfoSync?.().miniProgram;
      appVersion = version(account?.version);
      if (account?.envVersion === 'develop') environment = '开发版';
      if (account?.envVersion === 'trial') environment = '体验版';
      if (account?.envVersion === 'release') environment = '正式版';
    } catch { /* Older clients. */ }
    try { const base = wx.getAppBaseInfo?.(); sdkVersion = version(base?.SDKVersion); clientVersion = version(base?.version); } catch { /* Older clients. */ }
    const format = ['PSD', 'PSB', 'TIFF', 'RAW', 'AI', 'SVG', 'JPEG', 'PNG'].includes(this.data.format) ? this.data.format : 'UNKNOWN';
    const runtimeError = typeof getApp === 'function' && getApp<{ globalData?: { runtimeError?: boolean } }>().globalData?.runtimeError;
    const code = this.data.errorCode || (runtimeError ? 'UNCAUGHT_ERROR' : 'NONE');
    const picker = isPickerError(code) && PICKER_DIAGNOSTIC.exec(this.data.pickerDiagnostic)?.[0] === this.data.pickerDiagnostic
      ? `\n选择器 ${this.data.pickerDiagnostic}` : '';
    const data = `鉴中观象\n小程序版本 ${appVersion}\n运行版本 ${environment}\n微信版本 ${clientVersion}\n基础库 ${sdkVersion}\n格式 ${format}\n错误码 ${code}${picker}`;
    wx.setClipboardData({ data, success: () => wx.showToast({ title: '诊断信息已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }) });
  },

  updateScreenAwake() {
    const awake = !this.disposed && !this.hidden && this.data.busy && !!this.data.exportMode;
    if (awake === this.screenAwake || typeof wx.setKeepScreenOn !== 'function') return;
    this.screenAwake = awake;
    try { wx.setKeepScreenOn({ keepScreenOn: awake, fail: () => { if (this.screenAwake === awake) this.screenAwake = false; } }); }
    catch { this.screenAwake = false; }
  },

  handleMemoryWarning() {
    if (this.disposed || !this.data.hasFile) return Promise.resolve();
    if (this.memoryRecovery) return this.memoryRecovery;
    const jobId = this.jobId;
    this.detailSuspended = true;
    this.detailVersion++;
    this.cancelDetailBounds?.();
    clearTimeout(this.detailTimer);
    this.detailTimer = undefined;
    this.detailPending = false;
    if (this.data.nativeState === 'GENERATING') this.cancelNative();
    this.setData({ detailLoading: false, memoryNotice: '内存紧张，已暂停高清局部，正在释放临时图像。', errorCode: 'MEMORY_WARNING' });
    const tasks = [this.prepareTask, this.exportTask, this.nativeTask, this.detailTask];
    const recovery = Promise.all(tasks.map(task => task?.catch(() => {}))).then(async () => {
      if (this.disposed || jobId !== this.jobId) return;
      const path = this.data.detailPath;
      this.detailKey = '';
      this.setData({ detailPath: '', detailStyle: '', canRawPixels: false,
        memoryNotice: '内存紧张，已退回概览。可重新打开文件恢复高清查看。' });
      if (path && this.detail) await this.detail.release(path);
      if (this.disposed || jobId !== this.jobId) return;
      if (this.canvas) { this.canvas.width = 1; this.canvas.height = 1; }
      this.fitToScreen();
    }).catch(() => { /* Keep the overview even if a temporary image could not be released. */ }).finally(() => {
      if (this.memoryRecovery === recovery) this.memoryRecovery = undefined;
    });
    this.memoryRecovery = recovery;
    return recovery;
  },

  selectTheme(event: WechatMiniprogram.TouchEvent) {
    const theme: unknown = event.currentTarget.dataset.theme;
    if (!isTheme(theme)) return;
    this.applyTheme(theme);
    try { wx.setStorageSync(THEME_KEY, theme); }
    catch { wx.showToast({ title: '已切换，暂未能保存偏好', icon: 'none' }); }
  },

  applyTheme(theme: Theme) {
    const colors = THEME_COLORS[theme];
    this.setData({ theme, themePickerOpen: false });
    wx.setNavigationBarColor({ frontColor: colors.front, backgroundColor: colors.background, fail: () => {} });
    wx.setBackgroundColor({ backgroundColor: colors.background, backgroundColorTop: colors.background,
      backgroundColorBottom: colors.background, fail: () => {} });
  },

  onReady() {
    // Keep the Canvas2D node mounted: native canvas decoding/export needs a real node.
    this.getCanvas().catch(() => { /* A selection displays a useful error if initialization fails. */ });
  },

  onShow() {
    this.hidden = false;
    this.updateScreenAwake();
    const chatPsd = typeof getApp === 'function' && getApp<{ takeChatPsd?: () => ChosenFile | 'unavailable' | undefined }>().takeChatPsd?.();
    if (chatPsd) {
      if (this.data.busy) wx.showToast({ title: '请结束当前操作后重新打开 PSD', icon: 'none' });
      else if (chatPsd === 'unavailable') {
        this.reportError(new QuickViewError('CHAT_PSD_UNAVAILABLE', '微信未提供可读取的 PSD 文件，请在聊天中下载后重新打开。'));
      } else {
        void this.chooseFile(chatPsd);
        return;
      }
    }
    this.offerUpdate();
    this.publishZoom();
    this.scheduleDetail();
    this.fitPreviewFrame();
    // RAW resolves its mode-specific PNG at save time. exportPath may belong to the previous mode.
    const paths = [this.data.previewPath, this.data.format === 'RAW' ? '' : this.exportPath, this.documentPath]
      .filter(path => path && !path.startsWith('data:'));
    const jobId = this.jobId;
    const nativePath = this.nativePath;
    if (nativePath) wx.getFileSystemManager().access({ path: nativePath, fail: () => {
      if (this.disposed || jobId !== this.jobId || this.data.busy || nativePath !== this.nativePath) return;
      this.nativePath = '';
      this.setData({ nativeState: 'IDLE', nativeProgress: 0 });
    } });
    for (const path of paths) {
      wx.getFileSystemManager().access({
        path,
        fail: () => {
          if (this.disposed || this.data.busy || jobId !== this.jobId) return;
          if (this.data.format === 'RAW') {
            this.handlePreviewFailure(path);
            return;
          }
          void this.clearDetail();
          this.exportPath = '';
          this.prepareExport = undefined;
          this.documentPath = '';
          this.setData({ previewPath: '', stageStyle: '', pixelPreview: false, canSave: false, isDocument: false,
            canShareDocument: false,
            errorMessage: '临时预览已失效，请重新选择文件。', errorCode: 'FILE_EXPIRED' });
        },
      });
    }
  },

  onHide() {
    this.hidden = true;
    this.frameVersion++;
    this.resetPreviewTap();
    this.updateScreenAwake();
    clearTimeout(this.zoomTimer);
    this.zoomTimer = undefined;
    if (this.data.nativeState === 'GENERATING') this.cancelNative();
    this.detailVersion++;
    this.cancelDetailBounds?.();
    clearTimeout(this.detailTimer);
    this.detailTimer = undefined;
    this.detailPending = false;
    this.setData({ detailLoading: false });
  },

  onUnload() {
    this.disposed = true;
    this.frameVersion++;
    this.previewFrame = undefined;
    this.updateScreenAwake();
    if (this.memoryListener) wx.offMemoryWarning?.(this.memoryListener);
    this.memoryListener = undefined;
    this.resetViewportZoom();
    this.jobId += 1;
    this.nativeVersion++;
    this.prepareNative = undefined;
    this.nativePath = '';
    void this.clearDetail();
    this.canvas = undefined;
    this.pixelSource = undefined;
    this.exportPath = '';
    this.prepareExport = undefined;
    this.documentPath = '';
    this.rawOriginalPath = ''; this.rawAutoPath = ''; this.setRawAuto = undefined;
    this.rawInlinePath = ''; this.rawJpegPath = '';
    void cleanupPreview().catch(() => {});
  },

  getCanvas(): Promise<WechatMiniprogram.Canvas> {
    if (this.canvas) return Promise.resolve(this.canvas);
    return new Promise((resolve, reject) => {
      wx.nextTick(() => {
        if (this.disposed) return reject(new Error('页面已关闭。'));
        this.createSelectorQuery().select('#renderCanvas').fields({ node: true, size: true })
          .exec(results => {
            if (this.disposed) return reject(new Error('页面已关闭。'));
            const node = (results[0] as { node?: WechatMiniprogram.Canvas } | undefined)?.node;
            if (!node) return reject(new Error('无法初始化画布，请升级微信后重试。'));
            this.canvas = node;
            resolve(node);
          });
      });
    });
  },

  // Each button opens its native picker directly in the tap stack.
  chooseChatFile() { return this.chooseFile('chat-all'); },
  retryChatFile() { if (this.data.canRetryChatFile && isPickerError(this.data.errorCode)) return this.chooseFile('chat-file'); },
  chooseAlbum() { return this.chooseFile('album'); },

  async chooseFile(input: ImportSource | ChosenFile = 'chat-file') {
    if (this.data.busy || this.disposed) return;
    const fromPicker = typeof input === 'string';
    const jobId = ++this.jobId;
    this.setData({ busy: true, busyText: fromPicker ? '正在选择文件…' : '正在准备文件…', errorMessage: '', errorCode: '', pickerDiagnostic: '', canRetryChatFile: false });
    try {
      const file = fromPicker ? await chooseDesignFile(input) : input;
      if (this.disposed || jobId !== this.jobId) return;
      this.setData({ busyText: '正在准备文件…' });
      // A cancelled prepare can still own the shared native Canvas until its I/O settles.
      const previousTasks = [this.prepareTask, this.exportTask, this.nativeTask];
      await Promise.all([...previousTasks.map(task => task?.catch(() => {})), this.clearDetail()]);
      if (this.disposed || jobId !== this.jobId) return;
      this.exportPath = '';
      this.prepareExport = undefined;
      this.documentPath = '';
      this.rawOriginalPath = ''; this.rawAutoPath = ''; this.setRawAuto = undefined;
      this.rawExpiredPngModes = undefined;
      this.rawInlinePath = ''; this.rawJpegPath = '';
      this.prepareNative = undefined;
      this.nativePath = '';
      this.detailSuspended = false;
      this.previewFrame = undefined; this.frameVersion++;
      this.resetViewportZoom();
      await new Promise<void>(resolve => this.setData({ hasFile: true, previewBackSessions: [jobId], filename: file.name, filesize: file.size > 0 ? sizeLabel(file.size) : '',
        format: '', dimensions: '', colorInfo: '', fileFacts: [], previewPath: '', stageStyle: '', originalImage: '', rawAutoAvailable: false, rawAutoEnabled: false, canRawJpeg: false, canViewRawJpeg: false, rawJpegSize: '', rawJpegInline: false, pixelPreview: false, viewportMounted: true, isDocument: false, canShareDocument: false,
        canSave: false, previewAtOriginalSize: false, exportMode: '', canNative: false, nativeState: 'IDLE', nativeProgress: 0,
        warnings: [], importantWarnings: [], previewDetailsOpen: false, previewToolsOpen: false, memoryNotice: '', busyText: '正在本地解析…', busyHint: '正在生成设计稿预览',
        zoom: 1, zoomCommand: 1, zoomLabel: '100%' }, () => wx.nextTick(resolve)));
      if (this.disposed || jobId !== this.jobId) return;
      await cleanupPreview();
      const canvas = await this.getCanvas();
      if (this.disposed || jobId !== this.jobId) return;
      const task = preparePreview(file, canvas, (stage, overview, progress) => {
        if (this.disposed || jobId !== this.jobId) return;
        let busyText = stage === 'metadata' ? '正在读取文件信息…' : '正在本地解析…';
        let busyHint = stage === 'metadata' ? '正在检查文件头与大小' : stage === 'document' ? '正在准备 AI 的 PDF 文档' : '正在生成设计稿预览';
        if (stage === 'raw-engine') { busyText = '正在加载 RAW 引擎…'; busyHint = '正在初始化本地显影能力'; }
        if (stage === 'raw-metadata') { busyText = '正在读取传感器参数…'; busyHint = '正在检查受支持的 RAW 布局'; }
        if (stage === 'raw-overview') { busyText = `正在生成传感器概览 ${progress ?? 0}%`; busyHint = '按已完成读取条带计量，可返回取消'; }
        if (stage === 'raw-auto') { busyText = `正在自动显影 ${progress ?? 0}%`; busyHint = '统一曝光与明暗参数，保留原稿'; }
        if (stage === 'raw-png') { busyText = '正在生成预览 PNG…'; busyHint = '正在等待微信 Canvas 导出预览'; }
        this.setData({ busyText, busyHint });
        if (overview) this.setData({ previewPath: overview.path, format: 'RAW', busyHint: '相机概览已显示，正在准备传感器显示；两者的显影颜色可能不同' });
      }).then(async result => {
        // The next prepare waits for this cleanup too; never delete a newer job's files.
        if (this.disposed || jobId !== this.jobId) await cleanupPreview();
        return result;
      });
      this.prepareTask = task;
      let preview: PreparedPreview;
      try { preview = await task; }
      finally { if (this.prepareTask === task) this.prepareTask = undefined; }
      if (this.disposed || jobId !== this.jobId) return;
      const { info } = preview;
      const dimensions = pixelLabel(info), overview = pixelLabel(preview.exportSize), camera = pixelLabel(preview.rawJpeg);
      const colorInfo = [info.colorMode, info.bitDepth ? `${info.bitDepth} 位` : ''].filter(Boolean).join(' · ');
      const fileFacts = [
        { label: '识别格式', value: info.format },
        { label: '文件体积', value: `${sizeLabel(info.filesize)} · ${info.filesize} 字节` },
        { label: '导入来源', value: SOURCE_LABELS[file.source || (fromPicker ? input : 'chat-open')] },
        ...(dimensions ? [{ label: info.format === 'RAW' ? preview.detail ? '传感器有效画面' : preview.rawJpeg ? '相机内嵌 JPG' : '预览图像' : '图像画布', value: dimensions }] : []),
        ...(colorInfo ? [{ label: '颜色与位深', value: colorInfo }] : []),
        ...(overview && overview !== dimensions ? [{ label: '概览 PNG', value: overview }] : []),
        ...(camera && (preview.detail || camera !== dimensions) ? [{ label: '相机内嵌 JPG', value: camera }] : []),
      ];
      const canSaveToAlbum = typeof wx.saveImageToPhotosAlbum === 'function' && wx.canIUse('saveImageToPhotosAlbum');
      const canNative = !!preview.prepareNative && canSaveToAlbum;
      const previewAtOriginalSize = canSaveToAlbum && info.format !== 'RAW' && !!preview.exportSize
        && preview.exportSize.width === info.width && preview.exportSize.height === info.height;
      this.detail = preview.detail;
      this.exportPath = preview.exportPath || '';
      this.prepareExport = preview.prepareExport;
      this.prepareNative = preview.prepareNative;
      this.nativeHeight = info.height || 0;
      this.documentPath = preview.documentPath || '';
      this.rawOriginalPath = preview.rawOriginalPath || ''; this.rawAutoPath = preview.rawAutoPath || '';
      this.rawJpegPath = preview.rawJpeg?.path || '';
      // The native image component reads the real camera JPEG. The smaller Canvas
      // overview remains independent for auto tone/PNG; sensor detail stays intact.
      this.rawInlinePath = info.format === 'RAW' && !preview.detail ? this.rawJpegPath : '';
      if (this.rawInlinePath && !this.rawOriginalPath) this.rawOriginalPath = preview.previewPath || '';
      this.setRawAuto = preview.setRawAuto;
      if (this.rawInlinePath) this.setRawAuto?.(false);
      const pixelPreview = (info.format === 'PSD' || info.format === 'PSB')
        && !!preview.previewPath && !!info.width && !!info.height && info.width <= 32 && info.height <= 32;
      this.setData({ filename: info.filename, filesize: sizeLabel(info.filesize),
        format: info.format, dimensions, colorInfo, fileFacts,
        previewPath: this.rawInlinePath || preview.previewPath || '', rawAutoAvailable: !!preview.rawAutoPath && !!preview.rawOriginalPath,
        rawAutoEnabled: !!preview.rawAutoPath && !this.rawInlinePath, rawJpegInline: !!this.rawInlinePath, pixelPreview, isDocument: !!preview.documentPath,
        canRawPixels: info.format === 'RAW' && !!preview.detail && !this.detailSuspended,
        canRawJpeg: info.format === 'RAW' && !!preview.rawJpeg && canSaveToAlbum,
        canViewRawJpeg: !!preview.rawJpeg && typeof wx.previewImage === 'function' && wx.canIUse('previewImage'),
        rawJpegSize: preview.rawJpeg ? `${preview.rawJpeg.width} × ${preview.rawJpeg.height} px` : '',
        canShareDocument: !!preview.documentPath && typeof wx.shareFileMessage === 'function' && wx.canIUse('shareFileMessage'),
        zoomMax: preview.detail ? 64 : 6,
        canSave: info.exportSupported && !!preview.exportPath && (info.format !== 'RAW' || !!preview.exportSize && canSaveToAlbum),
        warnings: info.warnings, importantWarnings: previewRisks(info.warnings),
        originalImage: preview.originalImage || '',
        canNative, previewAtOriginalSize,
        busyText: preview.documentPath ? '正在打开文档…' : '' }, () => {
          const frame = this.rawInlinePath ? preview.rawJpeg : info;
          this.setPreviewFrame(this.data.previewPath, frame?.width, frame?.height);
          if (pixelPreview) this.drawPixelPreview(preview.previewPath!, info.width!, info.height!, jobId);
        });
      if (preview.documentPath) await openAiDocument(preview.documentPath);
    } catch (error) {
      if (!this.disposed && jobId === this.jobId && errorMessage(error) !== '已取消选择') {
        this.reportError(error);
      }
    } finally {
      if (!this.disposed && jobId === this.jobId) {
        this.setData({ busy: false, busyText: '', busyHint: '' });
        if (this.detailPending) this.scheduleDetail();
      }
    }
  },

  async clearDetail() {
    this.detailVersion++;
    this.cancelDetailBounds?.();
    clearTimeout(this.detailTimer);
    this.detailTimer = undefined;
    this.detailPending = false;
    this.detailKey = '';
    const detail = this.detail, path = this.data.detailPath;
    this.detail = undefined;
    if (!this.disposed) this.setData({ detailPath: '', detailStyle: '', detailLoading: false, canRawPixels: false, zoomMax: 6 });
    await Promise.all([path && detail ? detail.release(path) : undefined, this.detailTask]);
  },

  scheduleDetail() {
    if (!this.detail || this.disposed || this.hidden || this.detailSuspended) return;
    this.detailVersion++;
    this.cancelDetailBounds?.();
    clearTimeout(this.detailTimer);
    this.detailPending = false;
    if (this.data.detailLoading) this.setData({ detailLoading: false });
    if (this.viewportZoom <= 1) {
      const path = this.data.detailPath;
      this.detailKey = '';
      if (path || this.data.detailStyle) this.setData({ detailPath: '', detailStyle: '' });
      if (path) void this.detail.release(path);
      return;
    }
    this.detailTimer = setTimeout(() => { this.detailTimer = undefined; this.refreshDetail(); }, 180);
  },

  refreshDetail() {
    const detail = this.detail;
    if (!detail || this.disposed || this.hidden || this.detailSuspended || this.viewportZoom <= 1) return;
    if (this.data.busy) { this.detailPending = true; return; }
    if (this.detailTask) { this.detailPending = true; return; }
    const version = this.detailVersion;
    const current = () => !this.disposed && !this.hidden && detail === this.detail && version === this.detailVersion;
    this.detailTask = (async () => {
      const bounds = await new Promise<ViewRect[]>(resolve => {
        let settled = false;
        const complete = (value: ViewRect[]) => {
          if (settled) return;
          settled = true;
          if (this.cancelDetailBounds === cancel) this.cancelDetailBounds = undefined;
          resolve(value);
        };
        const cancel = () => complete([]);
        this.cancelDetailBounds = cancel;
        try { this.createSelectorQuery().select('.preview-area').boundingClientRect()
          .select('.preview-image-wrap').boundingClientRect().exec(complete); }
        catch (error) { if (this.cancelDetailBounds === cancel) this.cancelDetailBounds = undefined; throw error; }
      });
      if (!current()) return;
      const geometry = bounds[0] && bounds[1] && photoshopViewport(detail, bounds[0], bounds[1], this.getPixelRatio());
      if (!geometry) {
        const previous = this.data.detailPath;
        this.detailKey = '';
        this.setData({ detailPath: '', detailStyle: '' });
        if (previous) await detail.release(previous);
        return;
      }
      if (Math.abs(geometry.zoom - this.viewportZoom) > 0.05 * this.viewportZoom) throw new Error('当前微信未返回缩放后的视口坐标。');
      const key = JSON.stringify([geometry.rect, geometry.output]);
      if (key === this.detailKey && this.data.detailPath) return;
      this.setData({ detailLoading: true });
      const path = await detail.render(geometry.rect, geometry.output, current);
      if (!current()) { await detail.release(path); return; }
      const previous = this.data.detailPath;
      this.detailKey = key;
      // Keep the old image until the view layer has accepted the replacement.
      await new Promise<void>(resolve => this.setData({ detailPath: path, detailStyle: geometry.style }, resolve));
      if (previous) await detail.release(previous);
    })().catch(error => {
      if (current()) {
        const path = this.data.detailPath;
        this.detail = undefined;
        const warning = `高清局部暂不可用，继续显示概览。${errorMessage(error)}`;
        this.setData({ detailPath: '', detailStyle: '', detailLoading: false, canRawPixels: false,
          warnings: [...this.data.warnings, warning], importantWarnings: [...this.data.importantWarnings, warning] });
        if (path) void detail.release(path);
      }
    }).finally(() => {
      if (current()) this.setData({ detailLoading: false });
      this.detailTask = undefined;
      if (this.detailPending) { this.detailPending = false; this.refreshDetail(); }
    });
  },

  onDetailError(event: WechatMiniprogram.CustomEvent) {
    if (event.currentTarget.dataset.path !== this.data.detailPath) return;
    const path = this.data.detailPath;
    if (path) void this.detail?.release(path);
    this.detail = undefined;
    this.detailVersion++;
    const warning = '当前微信无法显示高清局部，保留概览及 PNG 保存。';
    this.setData({ detailPath: '', detailStyle: '', detailLoading: false,
      warnings: [...this.data.warnings, warning], importantWarnings: [...this.data.importantWarnings, warning] });
  },

  drawPixelPreview(path: string, width: number, height: number, jobId: number) {
    if (this.disposed || jobId !== this.jobId || path !== this.data.previewPath) return;
    const version = ++this.pixelDisplayVersion;
    const current = () => !this.disposed && jobId === this.jobId && path === this.data.previewPath && version === this.pixelDisplayVersion;
    const fallback = () => { if (current()) this.setData({ pixelPreview: false }); };
    if (!current()) return;
    this.pixelSource = { path, width, height, jobId };
    this.createSelectorQuery().select('#pixelPreviewCanvas').fields({ node: true, size: true }).exec(results => {
      if (!current()) return;
      try {
        const target = results[0] as { node?: WechatMiniprogram.Canvas; width: number; height: number } | undefined;
        if (!target?.node || !(target.width > 0 && target.height > 0)) return fallback();
        const canvas = target.node;
        // Display-only surface: keep the saved PNG and the export canvas untouched.
        const density = LIMITS.canvasSide / Math.max(target.width, target.height);
        canvas.width = Math.max(1, Math.round(target.width * density));
        canvas.height = Math.max(1, Math.round(target.height * density));
        const context = canvas.getContext('2d');
        if (typeof context.imageSmoothingEnabled !== 'boolean') return fallback();
        context.imageSmoothingEnabled = false;
        if (context.imageSmoothingEnabled !== false) return fallback();
        const image = canvas.createImage();
        image.onerror = fallback;
        image.onload = () => {
          if (!current()) return;
          try {
            const scale = Math.min(canvas.width / width, canvas.height / height);
            const w = width * scale, h = height * scale;
            context.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
          } catch { fallback(); }
        };
        image.src = path;
      } catch { fallback(); }
    });
  },

  backToHome() {
    this.previewFrame = undefined; this.frameVersion++;
    this.resetViewportZoom();
    this.detailSuspended = false;
    this.jobId += 1;
    this.nativeVersion++;
    this.prepareNative = undefined;
    this.nativePath = '';
    void this.clearDetail();
    this.exportPath = '';
    this.prepareExport = undefined;
    this.documentPath = '';
    this.rawJpegPath = '';
    this.rawInlinePath = '';
    this.rawOriginalPath = ''; this.rawAutoPath = ''; this.setRawAuto = undefined;
    this.rawExpiredPngModes = undefined;
    this.pixelSource = undefined;
    this.setData({ hasFile: false, previewBackSessions: [], rawAutoAvailable: false, rawAutoEnabled: false, busy: false, busyText: '', busyHint: '', exportMode: '', filename: '', filesize: '',
      format: '', dimensions: '', colorInfo: '', fileFacts: [], previewPath: '', stageStyle: '', originalImage: '', canRawJpeg: false, canViewRawJpeg: false, rawJpegSize: '', rawJpegInline: false, pixelPreview: false, viewportMounted: true, isDocument: false, canShareDocument: false,
      canSave: false, previewAtOriginalSize: false, canNative: false, nativeState: 'IDLE', nativeProgress: 0,
      errorMessage: '', errorCode: '', pickerDiagnostic: '', canRetryChatFile: false, memoryNotice: '', warnings: [], importantWarnings: [], previewDetailsOpen: false, previewToolsOpen: false,
      zoom: 1, zoomCommand: 1, zoomLabel: '100%' });
    this.updateScreenAwake();
    this.offerUpdate();
    void cleanupPreview().catch(() => {});
  },

  onPreviewBack(event: WechatMiniprogram.CustomEvent) {
    // A consumed or programmatically closed native container must not close a newer import.
    const session = Number(event.currentTarget.dataset.session);
    if (this.disposed || !this.data.canGuardPreview || !this.data.hasFile || session !== this.data.previewBackSessions[0]) return;
    this.backToHome();
  },

  cyclePreviewBackground() {
    // Display-only: alpha pixels and generated image files are left intact.
    const next = { checker: 'white', white: 'black', black: 'checker' } as const;
    this.setData({ previewBackground: next[this.data.previewBackground] });
  },

  async viewRawPixels() {
    const detail = this.detail, jobId = this.jobId;
    if (this.data.busy || this.data.format !== 'RAW' || !detail || !this.data.canRawPixels) return;
    this.resetPreviewTap();
    const bounds = await new Promise<ViewRect[]>(resolve => this.createSelectorQuery().select('.preview-area').boundingClientRect().exec(resolve));
    if (this.disposed || jobId !== this.jobId || detail !== this.detail) return;
    const zoom = bounds[0] && rawPixelZoom(detail, bounds[0], this.getPixelRatio());
    if (!zoom || zoom > this.data.zoomMax) {
      this.setData({ errorMessage: '当前视口过小，无法进入原像素查看，请扩大窗口或横屏后重试。', errorCode: 'VIEWPORT_TOO_SMALL' }); return;
    }
    this.viewportZoom = zoom;
    this.publishZoom(true);
    this.scheduleDetail();
  },

  viewCameraJpeg() { return this.cameraJpegOperation(true); },
  saveCameraJpeg() { return this.cameraJpegOperation(false); },
  async saveOriginalImage() {
    if (this.memoryRecovery) {
      const jobId = this.jobId;
      await this.memoryRecovery;
      if (this.disposed || jobId !== this.jobId) return;
    }
    if (this.data.canNative) return this.exportNative();
    if (this.data.format === 'RAW' && this.data.canRawJpeg) return this.saveCameraJpeg();
    if (this.data.canSave && this.data.previewAtOriginalSize) return this.saveImage();
  },
  async cameraJpegOperation(view: boolean) {
    if (this.disposed || this.data.busy || !this.rawJpegPath || !(view ? this.data.canViewRawJpeg : this.data.canRawJpeg)) return;
    const path = this.rawJpegPath, jobId = this.jobId;
    const current = () => !this.disposed && jobId === this.jobId;
    const shown = this.showExport('delivery', view ? '正在打开相机高清 JPEG…' : '正在保存相机高清 JPEG…');
    try {
      await shown; if (!current()) return;
      const task = (view ? previewRawJpeg(path, current) : saveRawJpeg(path, current)).then(() => path);
      this.nativeTask = task;
      try { await task; } finally { if (this.nativeTask === task) this.nativeTask = undefined; }
      if (current() && !view) wx.showToast({ title: '相机 JPEG 已保存', icon: 'success' });
    } catch (error) {
      if (current() && (error as { code?: string })?.code !== 'CANCELLED') {
        const code = (error as { code?: string })?.code;
        if (code === 'FILE_EXPIRED' || code === 'INVALID_JPEG_PATH') {
          this.rawJpegPath = '';
          this.setData({ canRawJpeg: false, canViewRawJpeg: false });
        }
        this.reportError(error);
      }
    }
    finally { if (current()) { this.setData({ busy: false, busyText: '', exportMode: '' }); this.updateScreenAwake(); if (this.detailPending) this.scheduleDetail(); } }
  },

  toggleRawAuto() {
    if (this.data.busy || this.data.format !== 'RAW' || !this.data.rawAutoAvailable || !this.rawOriginalPath || !this.rawAutoPath) return;
    this.applyRawAuto(!this.data.rawAutoEnabled);
  },

  applyRawAuto(enabled: boolean) {
    this.resetPreviewTap();
    this.setRawAuto?.(enabled);
    this.detailVersion++; this.detailKey = '';
    const oldDetail = this.data.detailPath;
    if (oldDetail && this.detail) void this.detail.release(oldDetail);
    if (this.nativePath) void discardGeneratedPng(this.nativePath);
    this.nativePath = ''; this.nativeVersion++;
    const expiredMode = this.rawExpiredPngModes?.[enabled ? 'optimized' : 'base'];
    this.setData({ rawAutoEnabled: enabled, rawJpegInline: !enabled && !!this.rawInlinePath,
      ...(this.rawExpiredPngModes ? { canSave: !expiredMode } : {}),
      previewPath: enabled ? this.rawAutoPath : this.rawInlinePath || this.rawOriginalPath });
    this.setData({ detailPath: '', detailStyle: '', nativeState: 'IDLE', nativeProgress: 0 });
    this.scheduleDetail();
  },

  async openDocument() {
    if (this.data.busy || !this.documentPath) return;
    const jobId = this.jobId;
    this.setData({ busy: true, busyText: '正在打开文档…', errorMessage: '', errorCode: '' });
    try { await openAiDocument(this.documentPath); }
    catch (error) { if (!this.disposed && jobId === this.jobId) this.reportError(error); }
    finally { if (!this.disposed && jobId === this.jobId) this.setData({ busy: false, busyText: '' }); }
  },

  async shareDocument() {
    if (this.data.busy || !this.data.canShareDocument || !this.documentPath) return;
    const jobId = this.jobId;
    const current = () => !this.disposed && jobId === this.jobId;
    try {
      // Keep this call in the TAP stack: no await, stat, nextTick or loading frame first.
      const sharing = sharePdfDocument(this.documentPath, this.data.filename, current);
      this.setData({ busy: true, busyText: '正在分享 PDF…', errorMessage: '', errorCode: '' });
      await sharing;
    } catch (error) {
      if (current() && (error as { code?: string })?.code !== 'SHARE_CANCELLED') this.reportError(error);
    } finally { if (current()) this.setData({ busy: false, busyText: '' }); }
  },

  async saveImage() {
    if (this.data.busy || !this.data.canSave || !this.exportPath) return;
    const jobId = this.jobId, raw = this.data.format === 'RAW';
    const rawMode = this.data.rawAutoEnabled ? 'optimized' : 'base';
    const current = () => !this.disposed && jobId === this.jobId;
    const busyText = this.data.originalImage ? `正在保存 ${this.data.originalImage} 图片…`
      : this.data.previewAtOriginalSize ? '正在保存原尺寸 PNG…' : '正在导出预览 PNG…';
    const shown = this.showExport('preview', busyText);
    try {
      if (this.prepareExport) {
        if (!raw) {
          this.detailVersion++;
          clearTimeout(this.detailTimer);
          this.detailTimer = undefined;
          this.detailPending = !!this.detail && this.viewportZoom > 1;
          this.setData({ detailLoading: false, busyText: '正在生成高质量预览 PNG…' });
          await this.detailTask;
        }
        await shown;
        if (!current()) return;
        const task = this.prepareExport(current);
        this.exportTask = task;
        let path: string;
        try { path = await task; }
        finally { if (this.exportTask === task) this.exportTask = undefined; }
        if (!current()) return;
        this.exportPath = path;
        if (!raw) this.prepareExport = undefined;
        this.setData({ busyText: '正在保存 PNG…' });
      }
      await shown;
      if (!current()) return;
      await savePng(this.exportPath, this.data.originalImage ? '图片' : 'PNG', raw, raw ? current : undefined);
      if (current()) wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (error) {
      if (current() && (!raw || errorCode(error) !== 'CANCELLED')) {
        if (raw && (error as { code?: string })?.code === 'FILE_EXPIRED') {
          this.rawExpiredPngModes = { ...this.rawExpiredPngModes, [rawMode]: true };
          this.setData({ canSave: false, errorMessage: '当前预览 PNG 已失效，请重新选择文件。', errorCode: 'FILE_EXPIRED' });
        } else this.reportError(error);
      }
    } finally {
      if (!this.disposed && jobId === this.jobId) {
        this.setData({ busy: false, busyText: '', exportMode: '' });
        this.updateScreenAwake();
        if (this.detailPending) this.scheduleDetail();
      }
    }
  },

  async exportNative() {
    if (this.data.busy || !this.data.canNative || (!this.prepareNative && !this.nativePath)) return;
    const jobId = this.jobId, version = ++this.nativeVersion;
    const raw = this.data.format === 'RAW';
    const current = () => !this.disposed && jobId === this.jobId && version === this.nativeVersion;
    const cached = !!this.nativePath;
    this.detailVersion++;
    clearTimeout(this.detailTimer);
    this.detailTimer = undefined;
    this.detailPending = !!this.detail && this.viewportZoom > 1;
    this.setData({ detailLoading: false, nativeState: cached ? 'DELIVERING' : 'GENERATING', nativeProgress: cached ? 100 : 0 });
    const shown = this.showExport(cached ? 'delivery' : 'native', cached ? '正在保存原尺寸 PNG…' : '正在导出原尺寸 PNG…');
    try {
      await this.detailTask;
      await shown;
      if (!current()) return;
      if (!cached) {
        let last = -1;
        const task = this.prepareNative!(current, rows => {
          if (!current()) return;
          const percent = Math.min(99, Math.floor(rows / this.nativeHeight * 100));
          if (percent > last) { last = percent; this.setData({ nativeProgress: percent }); }
        });
        this.nativeTask = task;
        let path: string;
        try { path = await task; }
        finally { if (this.nativeTask === task) this.nativeTask = undefined; }
        if (!current()) return;
        this.nativePath = path;
        this.setData({ nativeState: 'DELIVERING', nativeProgress: 100 });
        await this.showExport('delivery', '正在保存原尺寸 PNG…');
        if (!current()) return;
      }
      await saveNativePng(this.nativePath, current, raw);
      if (current()) {
        this.setData({ nativeState: 'READY' });
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      }
    } catch (error) {
      if (current()) {
        const code = (error as { code?: string })?.code;
        if (code === 'FILE_EXPIRED') this.nativePath = '';
        this.setData({ nativeState: this.nativePath ? 'READY' : 'FAILED', errorMessage: raw && code === 'CANCELLED' ? '' : errorMessage(error),
          errorCode: raw && code === 'CANCELLED' ? '' : errorCode(error) });
      }
    } finally {
      if (!this.disposed && jobId === this.jobId) {
        this.setData({ busy: false, busyText: '', exportMode: '' });
        this.updateScreenAwake();
        if (this.detailPending) this.scheduleDetail();
      }
    }
  },

  cancelNative() {
    if (this.data.nativeState !== 'GENERATING') return;
    this.nativeVersion++;
    // Keep busy until the in-flight read/write closes; preview and its cache stay intact.
    this.setData({ nativeState: 'CANCELLED', busyText: '正在取消原尺寸导出…' });
  },

  showExport(exportMode: ExportMode, busyText: string): Promise<void> {
    return new Promise(resolve => this.setData({ exportMode, busy: true, busyText, errorMessage: '', errorCode: '' }, () => {
      this.updateScreenAwake();
      wx.nextTick(resolve);
    }));
  },
  keepExportOpen() {},

  fitToScreen() {
    const jobId = this.jobId;
    this.resetViewportZoom();
    // Native gesture coordinates are readback only; remount to reset native pan reliably.
    this.setData({ viewportMounted: false, zoom: 1, zoomCommand: 1, zoomLabel: '100%' }, () => {
      if (this.disposed || jobId !== this.jobId) return;
      this.setData({ viewportMounted: true }, () => {
        const source = this.pixelSource;
        if (this.data.pixelPreview && source) this.drawPixelPreview(source.path, source.width, source.height, source.jobId);
      });
    });
    this.scheduleDetail();
  },
  zoomIn() {
    this.resetPreviewTap();
    this.viewportZoom = Math.min(this.data.zoomMax, Math.round((this.viewportZoom + 0.25) * 100) / 100);
    this.publishZoom(true);
    this.scheduleDetail();
  },
  zoomOut() {
    this.resetPreviewTap();
    this.viewportZoom = Math.max(1, Math.round((this.viewportZoom - 0.25) * 100) / 100);
    this.publishZoom(true);
    this.scheduleDetail();
  },
  onScale(event: WechatMiniprogram.CustomEvent<{ scale: number; x: number; y: number }>) {
    const scale = event.detail.scale;
    if (this.disposed || this.hidden || !this.data.viewportMounted || !Number.isFinite(scale) || scale < 1) return;
    if (Math.abs(scale - this.viewportZoom) > 0.001) this.resetPreviewTap();
    this.viewportZoom = scale;
    if (!this.zoomTimer) this.zoomTimer = setTimeout(() => this.publishZoom(), 100);
    this.scheduleDetail();
  },

  resetViewportZoom() {
    this.resetPreviewTap();
    clearTimeout(this.zoomTimer);
    this.zoomTimer = undefined;
    this.viewportZoom = 1;
  },

  publishZoom(command = false) {
    clearTimeout(this.zoomTimer);
    this.zoomTimer = undefined;
    if (this.disposed) return;
    const zoom = this.viewportZoom, zoomLabel = `${Math.round(zoom * 100)}%`;
    const update: { zoom?: number; zoomLabel?: string; zoomCommand?: number } = {};
    if (zoom !== this.data.zoom) update.zoom = zoom;
    if (zoomLabel !== this.data.zoomLabel) update.zoomLabel = zoomLabel;
    if (command && zoom !== this.data.zoomCommand) update.zoomCommand = zoom;
    if (Object.keys(update).length) this.setData(update);
  },

  // Animated scale readback must not become another native scale command.
  settleZoom() { this.publishZoom(true); this.scheduleDetail(); },
  onMove(event: WechatMiniprogram.CustomEvent<{ x: number; y: number; source: string }>) {
    if (!this.disposed && !this.hidden && this.data.viewportMounted && event.detail.source) {
      if (!this.tapStart || this.tapStart.canvas || event.detail.source !== 'touch') this.resetPreviewTap();
      this.scheduleDetail();
    }
  },

  resetPreviewTap() { this.tapStart = undefined; this.lastTap = undefined; this.tapVersion++; },

  onPreviewTouchStart(event: PreviewTouchEvent, canvas = false) {
    if (canvas !== this.data.pixelPreview) return;
    this.tapVersion++; this.tapStart = undefined;
    const point = event.touches.length === 1 ? previewPoint(event.touches[0]) : undefined;
    if (!point || !Number.isFinite(event.timeStamp) || this.disposed || this.hidden || this.data.busy
      || !this.data.viewportMounted || !this.data.previewPath || this.data.previewDetailsOpen || this.data.previewToolsOpen) {
      this.lastTap = undefined; return;
    }
    this.tapStart = { ...point, time: event.timeStamp, canvas };
  },

  onPreviewTouchMove(event: PreviewTouchEvent, canvas = false) {
    if (canvas !== this.data.pixelPreview) return;
    const point = event.touches.length === 1 ? previewPoint(event.touches[0]) : undefined, start = this.tapStart;
    if (!point || !start || start.canvas !== canvas || point.identifier !== start.identifier || point.space !== start.space
      || Math.hypot(point.x - start.x, point.y - start.y) > 8) this.resetPreviewTap();
  },

  onPreviewTouchEnd(event: PreviewTouchEvent, canvas = false) {
    if (canvas !== this.data.pixelPreview) return;
    this.settleZoom();
    const start = this.tapStart;
    this.tapStart = undefined;
    const point = event.changedTouches.length === 1 ? previewPoint(event.changedTouches[0]) : undefined;
    const duration = event.timeStamp - (start?.time ?? event.timeStamp);
    if (!start || !point || start.canvas !== canvas || event.touches.length || point.identifier !== start.identifier || point.space !== start.space || !Number.isFinite(duration)
      || duration < 0 || duration > 250 || Math.hypot(point.x - start.x, point.y - start.y) > 8
      || this.disposed || this.hidden || this.data.busy) { this.resetPreviewTap(); return; }
    const previous = this.lastTap, interval = event.timeStamp - (previous?.time ?? event.timeStamp);
    if (previous && previous.canvas === canvas && previous.space === point.space
      && interval >= 0 && interval <= 300 && Math.hypot(point.x - previous.x, point.y - previous.y) <= 24) {
      this.lastTap = undefined;
      void this.doubleTapZoom(++this.tapVersion);
    } else this.lastTap = { x: point.x, y: point.y, time: event.timeStamp, canvas, space: point.space };
  },

  onPreviewTouchCancel(event: PreviewTouchEvent, canvas = false) {
    if (canvas !== this.data.pixelPreview) return;
    this.resetPreviewTap(); this.settleZoom();
  },
  onPixelTouchStart(event: WechatMiniprogram.TouchCanvas) { this.onPreviewTouchStart(event, true); },
  onPixelTouchMove(event: WechatMiniprogram.TouchCanvas) { this.onPreviewTouchMove(event, true); },
  onPixelTouchEnd(event: WechatMiniprogram.TouchCanvas) { this.onPreviewTouchEnd(event, true); },
  onPixelTouchCancel(event: WechatMiniprogram.TouchCanvas) { this.onPreviewTouchCancel(event, true); },

  async doubleTapZoom(version: number) {
    const jobId = this.jobId, path = this.data.previewPath, zoom = this.viewportZoom;
    const current = () => !this.disposed && !this.hidden && !this.data.busy && jobId === this.jobId
      && version === this.tapVersion && path === this.data.previewPath;
    if (!current()) return;
    if (zoom < 1.95) {
      this.viewportZoom = Math.min(2, this.data.zoomMax); this.publishZoom(true); this.scheduleDetail(); return;
    }
    // Only an active source-pixel decoder can provide the third inspection level.
    const source = this.detail && !this.detailSuspended ? this.detail : undefined;
    if (source) {
      const bounds = await new Promise<ViewRect[]>(resolve => {
        const timer = setTimeout(() => resolve([]), 500);
        try { this.createSelectorQuery().select('.preview-area').boundingClientRect().exec(value => { clearTimeout(timer); resolve(value); }); }
        catch { clearTimeout(timer); resolve([]); }
      });
      if (!current() || this.detail !== source || this.detailSuspended) return;
      const pixels = bounds[0] && rawPixelZoom(source, bounds[0], this.getPixelRatio());
      if (pixels && pixels > 2.01 && pixels <= this.data.zoomMax && zoom < pixels - 0.01) {
        this.viewportZoom = pixels; this.publishZoom(true); this.scheduleDetail(); return;
      }
    }
    if (current()) this.fitToScreen();
  },

  onResize() {
    this.resetPreviewTap(); this.pixelRatio = undefined; this.scheduleDetail();
    this.fitPreviewFrame();
    if (this.data.previewToolsOpen) this.setData({ previewToolsOpen: false });
    const source = this.pixelSource;
    if (this.data.pixelPreview && source) {
      this.pixelDisplayVersion++;
      wx.nextTick(() => {
        if (!this.disposed && this.data.pixelPreview && this.data.viewportMounted && this.pixelSource === source) {
          this.drawPixelPreview(source.path, source.width, source.height, source.jobId);
        }
      });
    }
  },
  onPreviewLoad(event: WechatMiniprogram.CustomEvent<{ width: number; height: number }>) {
    const path = event.currentTarget.dataset.path;
    if (typeof path === 'string' && path === this.data.previewPath) this.setPreviewFrame(path, event.detail.width, event.detail.height);
  },

  setPreviewFrame(path: string, width?: number, height?: number) {
    if (!path || path !== this.data.previewPath || !width || !height
      || ![width, height].every(Number.isFinite) || Math.min(width, height) <= 0) return;
    // Native image load corrects orientation and mode switches without reading the file again.
    this.previewFrame = { path, width, height };
    this.fitPreviewFrame();
  },

  fitPreviewFrame() {
    const frame = this.previewFrame, jobId = this.jobId, version = ++this.frameVersion;
    if (!frame || frame.path !== this.data.previewPath || this.disposed || this.hidden) return;
    wx.nextTick(() => {
      const current = () => !this.disposed && !this.hidden && jobId === this.jobId
        && version === this.frameVersion && frame === this.previewFrame && frame.path === this.data.previewPath;
      if (!current()) return;
      try {
        this.createSelectorQuery().select('.preview-body').boundingClientRect()
          .select('.toolbar').boundingClientRect().select('.stage').boundingClientRect()
          .select('.preview-actions').fields({ size: true, computedStyle: ['min-height'] }).exec((bounds: (ViewRect & { 'min-height'?: string })[]) => {
            if (!current()) return;
            const [body, toolbar, stage, actions] = bounds;
            if (!body || !toolbar || !stage || !actions) return;
            const gap = Math.max(0, toolbar.top - stage.top - stage.height);
            // Reserve only the notes minimum; their elastic height consumes unused space below the fitted image.
            const minimum = parseFloat(actions['min-height'] || ''), notesReserve = Number.isFinite(minimum) && minimum > 0 ? minimum : 50;
            const available = body.height - toolbar.height - gap - notesReserve;
            if (![body.width, available, gap].every(Number.isFinite) || Math.min(body.width, available) <= 0) return;
            const scale = Math.min(body.width / frame.width, available / frame.height);
            const style = `flex:none;align-self:center;width:${(frame.width * scale).toFixed(3)}px;height:${(frame.height * scale).toFixed(3)}px;`;
            if (style === this.data.stageStyle) return;
            // Invalidate stale HD coordinates before changing the display-only frame.
            this.detailVersion++; this.cancelDetailBounds?.(); this.pixelDisplayVersion++;
            const oldPath = this.data.detailPath;
            this.detailKey = '';
            this.setData({ stageStyle: style, detailPath: '', detailStyle: '', detailLoading: false }, () => wx.nextTick(() => {
              if (!current()) return;
              this.scheduleDetail();
              const source = this.pixelSource;
              if (this.data.pixelPreview && source) this.drawPixelPreview(source.path, source.width, source.height, source.jobId);
            }));
            if (oldPath) void this.detail?.release(oldPath);
          });
      } catch { /* Keep the full elastic viewport if this client cannot measure it. */ }
    });
  },
  onPreviewError(event: WechatMiniprogram.CustomEvent<{ errMsg: string }>) {
    this.handlePreviewFailure(event.currentTarget.dataset.path);
  },

  handlePreviewFailure(path: unknown) {
    if (this.disposed || !this.data.previewPath || path !== this.data.previewPath) return;
    // A late native image event must not change the RAW mode during an export.
    if (this.data.format === 'RAW' && this.data.exportMode) return;
    if (this.data.rawJpegInline) {
      const fallback = this.rawOriginalPath !== this.rawInlinePath ? this.rawOriginalPath : '';
      this.rawInlinePath = ''; // Do not retry a failed native decode on every mode switch.
      this.setData({ previewPath: fallback, rawJpegInline: false,
        errorMessage: `当前微信无法在预览区显示相机高清 JPEG，${fallback ? '已回退概览；' : ''}可尝试全屏查看或保存相机 JPEG。`, errorCode: 'IMAGE_DISPLAY_FAILED' });
      return;
    }
    if (this.data.format === 'RAW' && this.data.rawAutoEnabled && this.rawOriginalPath) {
      this.applyRawAuto(false);
      this.setData({ rawAutoAvailable: false, errorMessage: '自动优化预览无法显示，已切回基础预览。', errorCode: 'IMAGE_DISPLAY_FAILED' });
      return;
    }
    void this.clearDetail();
    this.exportPath = '';
    this.prepareExport = undefined;
    this.setData({ previewPath: '', stageStyle: '', rawJpegInline: false, rawAutoAvailable: false, rawAutoEnabled: false, pixelPreview: false, canSave: false,
      errorMessage: '当前微信无法显示此图像。请检查文件，或升级微信后重试。', errorCode: 'IMAGE_DISPLAY_FAILED' });
  },
});

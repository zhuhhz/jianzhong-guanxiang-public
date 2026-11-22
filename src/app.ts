import type { ChosenFile } from './platform/wechat';

App({
  globalData: { runtimeError: false },
  updateManager: undefined as WechatMiniprogram.UpdateManager | undefined,
  updateReady: false,
  updatePrompted: false,
  foreground: false,
  pendingChatPsd: undefined as ChosenFile | 'unavailable' | undefined,

  onLaunch() {
    if (typeof wx.getUpdateManager !== 'function') return;
    try {
      this.updateManager = wx.getUpdateManager();
      this.updateManager.onUpdateReady(() => {
        this.updateReady = true;
        this.offerUpdate();
      });
    } catch { /* Updating is optional on older clients. */ }
  },

  onShow(options?: WechatMiniprogram.App.LaunchShowOption) {
    this.foreground = true;
    this.pendingChatPsd = undefined;
    if (options?.scene === 1173) {
      const material = options.forwardMaterials?.[0];
      const name = typeof material?.name === 'string' ? material.name.split(/[\\/]/).pop() : undefined;
      const path = material?.path;
      // The chat material callback may also carry URLs. Only use WeChat local file handles.
      if (name && /\.psd$/i.test(name) && typeof path === 'string' && /^(?:wxfile:\/\/|http:\/\/tmp\/)\S/.test(path)) {
        const size = Number.isSafeInteger(material.size) && material.size > 0 ? material.size : 0;
        this.pendingChatPsd = { name, path, size, source: 'chat-open' };
      } else this.pendingChatPsd = 'unavailable';
    }
    this.offerUpdate();
  },
  onHide() { this.foreground = false; },
  onError() { this.globalData.runtimeError = true; },

  takeChatPsd() {
    const file = this.pendingChatPsd;
    this.pendingChatPsd = undefined;
    return file;
  },

  canApplyUpdate() {
    if (!this.foreground || this.pendingChatPsd) return false;
    const pages = getCurrentPages(), page = pages[pages.length - 1];
    return !!page && !page.data.hasFile && !page.data.busy && !page.prepareTask && !page.exportTask
      && !page.nativeTask && !page.detailTask && !page.memoryRecovery;
  },

  offerUpdate() {
    if (!this.foreground || !this.updateReady || this.updatePrompted || typeof wx.showModal !== 'function') return;
    if (!this.canApplyUpdate()) return;
    this.updatePrompted = true;
    try { wx.showModal({ title: '发现新版本', content: '新版本已准备好，是否重新打开小程序？', confirmText: '立即更新', cancelText: '稍后',
      success: result => {
        // The user may have started selecting a file while the dialog was open.
        if (result.confirm && this.canApplyUpdate()) this.updateManager?.applyUpdate();
        else if (result.confirm) this.updatePrompted = false;
      },
      fail: () => { this.updatePrompted = false; },
    }); } catch { this.updatePrompted = false; }
  },
});

# 开源复用与许可证

项目当前版本的原创代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)。此前以 MIT 公开的版本继续适用其发布时的许可，已授予的权利不因本次切换而撤销。第三方依赖和复用代码继续适用各自的许可证。运行依赖均锁定版本，随构建保留完整许可于 `dist/licenses/`；未引入服务器转换、遥测、自动资源加载或更新检查。

| 实际运行依赖 | 许可证 / 来源 | 使用范围 |
| --- | --- | --- |
| ag-psd 31.0.3 | [MIT 原文及例外](https://github.com/Agamnentzar/ag-psd/blob/04d927df87130ad6d765bc63d51ade0a98d66c14/LICENSE)；`licenses/ag-psd.txt` | 真实 PSD/PSB 合成像素解码。只传经过边界校验的合成区封装，不修改库，不解析任意图层元数据。以本地 ImageData 工厂替代 DOM Canvas。 |
| base64-js 1.5.1 | MIT；`licenses/base64-js.txt` | ag-psd 的传递依赖。 |
| pako 2.1.0 | MIT AND Zlib；`licenses/pako.txt`、`licenses/pako-zlib.txt` | 复用已有版本并声明为直接依赖，用于原尺寸 PNG 的流式 Deflate；仍拒绝 ZIP 合成图和任意元数据解压。 |
| saxes 6.0.0 | [ISC，包含历史声明](https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE)；`licenses/saxes.txt` | 无 DOM 的严格 XML 解析；事件中执行允许列表、深度/数量及尺寸检查，重建 SVG。其 npm 包没有 LICENSE，已从对应版本上游补齐全文。 |
| xmlchars 2.2.0 | MIT；`licenses/xmlchars.txt` | saxes 的传递依赖。 |
| tiff 7.1.3 | [MIT](https://github.com/image-js/tiff)；`licenses/tiff.txt` | TIFF白名单数值标签与有界小图像素解码。大型Raw TIFF复用文件分段读取，生成第一页概览及原尺寸8位PNG；不执行EXIF/GPS递归或读取Photoshop图层。 |
| iobuffer 6.0.1 | MIT；`licenses/iobuffer.txt` | tiff的传递依赖。微信构建禁用其无需使用的文本I/O，避免初始化TextEncoder；数值读写保持原库实现。 |
| fflate 0.8.3 | MIT；`licenses/fflate.txt` | tiff的传递依赖；Deflate条带先用现有pako有界验证解压长度，再交给库解码。 |

实际必要审查过的候选如下；未为比较继续添加替代引擎。

| 候选源码版本 | 许可证 | 结论 |
| --- | --- | --- |
| [ag-psd @04d927d](https://github.com/Agamnentzar/ag-psd/tree/04d927df87130ad6d765bc63d51ade0a98d66c14) | 代码 MIT，仓库图片/笔刷被明确排除 | 采用已安装 31.0.3 的 API。README 的 PSB 限制与当前源码不一致，范围以实际源码和样本为准。普通入口带 Canvas/DOM 辅助路径，当前实现只使用合成图 ImageData 分支。 |
| [webtoon/psd @d1a9a32](https://github.com/webtoon/psd/tree/d1a9a32ad38ff17c16f94562fc2dd47018338e78)，包声明 0.4.0 | MIT | PSD/PSB 候选，像素解码使用 WASM；没有直接作为微信依赖或引入兼容层。 |
| [file-viewer @1ffa8b6](https://github.com/flyfish-dev/file-viewer/tree/1ffa8b6f99fe4df352c64ff0bd8f8003b4dd87de)，包声明 3.2.2 | Apache-2.0 | 浏览器/Vue 多格式框架，未移植进原生小程序；仅使用其公开 AI 测试文件，保留来源及完整许可证。 |
| [ps-mobile @ceccc05](https://github.com/JustRin/ps-mobile/tree/ceccc052aaa44ffd6585f8679edf2d8c72a45b4e) | Apache-2.0 | Kotlin/Android 的定位读取、行索引、瓦片参考；未复制实现，未引入 Android SDK，未宣称本项目已有分块能力。 |
| [pdf.js @d64cd36](https://github.com/mozilla/pdf.js/tree/d64cd36b3510c91a6001381e85965a9c2d855276) | Apache-2.0 | 浏览器 PDF 渲染、Worker/Canvas 路线体积和范围不必要；采用微信官方 `openDocument`，未安装或打包 pdf.js。 |

开发依赖：TypeScript 5.9.3（Apache-2.0）、esbuild 0.28.2（MIT）、tsx 4.23.15（MIT）、miniprogram-api-typings 5.2.3（MIT，微信官方类型）、@types/node 24.10.1（MIT）、pdf-lib 1.17.1（MIT，仅测试 PDF 容器与上游 AI 页数）、pngjs 7.0.0（MIT，仅 Node PNG 验证）。它们及锁文件中的开发传递依赖不进入微信运行包。

## 样本权利边界

ag-psd LICENSE 明示其图片/笔刷不在 MIT 授权内。下载过的公开 PSD/PSB/参考 PNG 只作为本机验证材料，重新分发授权为 **UNKNOWN**，保存在 Git 忽略的 `.local-fixtures/photoshop/`，不进入 `dist/` 或开源样本目录。样本存在、可以访问、成功解码均不代表再分发授权。

`tests/fixtures/photoshop/` 仅分发项目生成的真实二进制文件；`tests/fixtures/svg/` 是项目自制 SVG。第三方 AI 样本同样仅留本地、不提交 Git；file-viewer 仓库声明的 Apache-2.0 许可及样本哈希记录仍保存在 `tests/fixtures/ai/`。其 PDF Producer 标注 pdf-lib，不声称未经修改的 Illustrator 原始导出。第三方样本各自适用原有许可条款。

## 一次性官方接口核实

官方网页通过 PowerShell HTTPS 读取；web 浏览工具对部分微信文档返回不可访问，没有以搜索摘要代替结论。未从文档推导真机 PASS。

- [wx.chooseMessageFile](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html)：接口 2.5.0、extension 2.6.0；使用文件选取 count=1。
- [FileSystemManager.readFile](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFile.html)：position/length 2.10.0，以字节计，省略 encoding 返回 ArrayBuffer。[stat](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.stat.html)、[mkdir](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.mkdir.html)、[writeFile](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.writeFile.html)、[unlink](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.unlink.html) 的本地参数已核实。
- [Canvas 2D 组件](https://developers.weixin.qq.com/miniprogram/dev/component/canvas.html)：显式设置宽高，最大1365×1365，避免安卓过大画布风险。[官方示例](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/canvas.html)直接绘制后使用[canvasToTempFilePath](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.canvasToTempFilePath.html)，无需旧版 draw 回调。
- [image](https://developers.weixin.qq.com/miniprogram/dev/component/image.html) 支持 SVG，但不支持 style 和百分比几何；[Canvas Image](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/Image.html) 的 base64 Data URI 需2.11.0。SVG Canvas 双端栅格化仍须真实设备确认。
- 安装的官方类型 `miniprogram-api-typings/types/wx/lib.wx.component.d.ts` 明示单次 setData 不能超过1024kB；安全 SVG 另设512KiB输出上限，为 base64 扩张及页面信息预留空间。
- [saveImageToPhotosAlbum](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.saveImageToPhotosAlbum.html)：本地图片路径、相册写权限；[openDocument](https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.openDocument.html)：本地路径及内部 PDF fileType，showMenu需2.11.0。[canIUse](https://developers.weixin.qq.com/miniprogram/dev/api/base/wx.canIUse.html)用于接口能力判断；[getAppBaseInfo](https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getAppBaseInfo.html)需2.20.1，低版本仅回退已有系统信息接口读取SDKVersion。
- [隐私接口映射](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html)和[官方隐私弹窗](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html)：后台声明文件选择与相册写入；不自建授权框架。区分112接口声明禁用、103/104隐私拒绝和普通相册授权拒绝。

没有发现可据此宣称 Android/iOS 已完成预览的证据。官方支持、代码实现、Node 桩测试、微信编译与真机验收始终单独记录。

## Camera RAW embedded preview adaptation

`src/core/camera-raw.ts` adapts the TIFF IFD traversal and JPEG candidate selection from [extract-raw-preview](https://github.com/radenkovic/extract-raw-preview), specifically `src/ifd.ts` and `src/formats/shared.ts`. `src/core/raw-containers.ts` also adapts `src/formats/cr3.ts`, `src/formats/raf.ts`, `src/bmff.ts` and `src/jpeg.ts` for bounded RAF/CR3 JPEG extraction. Reviewed at commit `d9de38c369e9122a756dc0741d560bbae3ea67f0` on 2026-11-10. Copyright (c) 2026 Dan Radenkovic, MIT; full text in `licenses/extract-raw-preview.txt` (also copied into `dist/licenses/`). The adapter replaces whole-buffer input with bounded asynchronous WeChat file reads and project safety limits. The embedded-preview parser itself has no runtime dependency; sensor development separately reuses FlashRaw below. No native SDK, network client or analytics is added. The existing project JPEG validator and native image component are reused; EXIF orientation is carried into the temporary JPEG without re-encoding scan data. Private ARW samples and derivatives stay outside Git.

## FlashRaw sensor decoding

The bounded Sony ARW sensor adapter reuses [FlashRaw](https://github.com/ybouane/flashraw), official npm `flashraw@0.1.0` (MIT OR Apache-2.0). Full licenses are in `licenses/flashraw.txt` and `licenses/flashraw-apache.txt` and copied into dist. `src/vendor/flashraw.js` adapts the package's wasm-bindgen glue for local WXWebAssembly initialization and UTF-8 shims, both native WASM instance return shapes, and retry after failed initialization; it does not use the upstream browser Worker/fetch/GPU loaders. Only the scalar engine is shipped, losslessly Brotli-compressed as `src/raw-engine/flashraw.wasm.br` (756,668 bytes). The asset-only `raw-engine` subpackage totals 756,773 bytes; no uncompressed duplicate is distributed. Decompression reproduces the original 2,918,514-byte WASM exactly, SHA256 `45a7f332c880fa012d152f8c744ac40f82e99a52a5ccf0fa37b347f84d1109de`. The loader uses the WeChat-native `.wasm.br` code-package path; Node-only tests use built-in zlib to emulate decompression. Source package: https://registry.npmjs.org/flashraw/-/flashraw-0.1.0.tgz . The application constructs bounded TIFF envelopes around actual source Bayer rows and retains metadata for white balance/color conversion; no full-size RAW input or full-frame RGBA is passed to WASM. Private samples, full-file reference tools and generated evidence are not distributed.

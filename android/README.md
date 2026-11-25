# 鉴中观象 Android v1.0.0

Android 8.0（API 26）及以上。通过系统文件选择器打开文件，完全在设备本地解码，无需登录。用户选择保存位置后生成副本。GitHub 正式版使用持续维护的 Android 应用签名。调试预览包使用独立签名，Android 覆盖安装要求证书一致。

首页保留青墨、宣纸和夜墨三套主题、折角文件标识、GitHub 入口和支持范围。预览使用可适屏、缩放和平移的画布；底部保存操作固定在安全区域，完整文件详情在可滚动底部面板。画布按图片比例居中，下方依次为手势提示、缩放控件和可滚动的保存说明。窄屏从「工具」打开背景与重置，宽屏直接显示。支持双指缩放、双击、缩放按钮、适屏复位和棋盘／白／黑背景。受支持的 SVG 动画可开始、暂停、继续及重播，PNG 保存输出首帧。双边均不超过 32 px 的 PSD/PSB 使用最近邻显示，保留原始色块。

## 微信功能对照

| 微信功能 | Android 路径 | 复用代码 | 边界 |
| --- | --- | --- | --- |
| 聊天文件／相册选择与保存 | 系统 Open Document 和 Create Document，支持取消及重试 | 原生入口、现有页面主题 | PLATFORM_DIFFERENCE |
| PSD/PSB 概览、局部高清和原尺寸 PNG | 按需读取保存合成图；受支持布局开放原尺寸 PNG | Photoshop 分段读、ICC 转换和 PNG 流式写入 | RGB8 三通道 Raw/RLE、受支持 PSD RGB16 Raw；有界 RGB8 四通道只在解码预算内显示保存合成图 |
| TIFF 概览、局部高清和原尺寸 PNG | 经典 TIFF 继续走原路径；Android 新增未压缩条带 BigTIFF 第一页、局部高清和原尺寸 PNG 行流 | TIFF 分段及原尺寸 PNG 行源 | BigTIFF 限标准方向、交错未压缩条带，RGB／灰度 8／16 位；分块 TIFF 暂不支持，压缩经典 TIFF 保留 32 MiB 文件上限 |
| RAW 内嵌 JPEG | 选择预算内最高有效内嵌 JPEG，应用 EXIF，保存其压缩数据 | RAW 容器及 JPEG 校验 | 单张源 JPEG ≤8 MiB；必要时修补 EXIF，保留 JPEG 扫描数据 |
| Sony ARW 传感器显影、自动优化及原尺寸 PNG | 回退到相机内嵌 JPEG | 通用 RAW 解析 | PARTIAL。微信 FlashRaw 依赖 WXWebAssembly 与压缩分包，Android 尚未接入传感器显影 |
| PDF 兼容 AI | PdfRenderer 第一页和当前位图预览 PNG | AI 有界结构检查及现有原生 PDF 路径 | PLATFORM_DIFFERENCE。多页查看与微信侧 PDF 分享有差异 |
| SVG 安全预览、基础动画及 PNG | 复用白名单重建与受限动画轨道，隔离 WebView 渲染，按首帧保存预览 PNG | parseSvg、svgAnimationTrack | 输入最多 1 MiB，栅格长边 ≤1365 px；基础旋转、平移、缩放、受支持数值及同结构路径；复杂动画及脚本拒绝 |
| PNG/JPEG | Android 位图解码，JPEG 应用 EXIF；按实际像素提供原尺寸或预览 PNG | 原生解码 | PLATFORM_DIFFERENCE |
| 反馈与来源 | 系统浏览器打开项目及 Issues | 原生链接 | PLATFORM_DIFFERENCE |

PSD/PSB 不重绘图层；仅当合成类型明确不支持且存在有效 1036 JPEG 缩略图时回退。显示的文件尺寸、预览尺寸和可保存的尺寸分别说明。「保存相机 JPG」「保存原尺寸 PNG」「保存预览 PNG」由实际能力决定。

## 大文件和输出预算

使用可定位文件描述符及 FileChannel 长整型偏移；JS 以安全整数表示偏移，单次跨桥读取不超过 1 MiB。分段区域输出长边最多 1365 px，仅在缩放需要更高分辨率时请求，返回后叠加在对应源区域。原尺寸 PNG 使用已有逐行编码器，跨桥写入最多 64 KiB 一块，临时文件校验尺寸和文件结束后再复制到用户选择的位置。不可定位的提供方会显示错误。大文件可读范围取决于格式、布局及文件提供方。Android 对受支持的 BigTIFF 使用 64 位 IFD 和条带偏移，单行限制 512 KiB。大文件验收只覆盖报告列明的样本及操作。

## 构建与验收

在仓库根目录运行 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm check` 和 `pnpm build:android-core`。使用 Java 17、Android SDK 35、Gradle 8.10.2，在 `android/` 中运行 `gradle :app:assembleRelease --no-daemon`。

未签名 APK 位于 `android/app/build/outputs/apk/release/app-release-unsigned.apk`。维护者使用 Android SDK Build Tools 的 apksigner 和本项目正式密钥签名，并执行签名校验和 SHA-256。GitHub 预构建验收使用临时签名，发布使用正式签名。构建、Node 解析、模拟器操作和实体设备分别报告。发布文件与安装说明见[公开 Android Releases](https://github.com/zhuhhz/jianzhong-guanxiang-public/releases)。

项目许可、品牌限制与第三方授权见[仓库说明](../README.md)和[第三方声明](../THIRD_PARTY_NOTICES.md)。私有仓库是唯一开发源，公开仓库保留独立快照历史。

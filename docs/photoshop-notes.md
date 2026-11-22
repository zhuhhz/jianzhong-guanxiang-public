# PSD / PSB implementation notes

These notes retain the RGB8 baseline and historical experiments. Current PSD RGB16
RAW integration and its Node-only validation are described in README.md; earlier
16-bit exclusions and test totals below are not the current project-wide status.

`src/core/photoshop.ts` reuses `ag-psd@31.0.3` (MIT for code) for pixel decoding. **Its license expressly excludes repository image/brush assets.** The upstream image references used during local testing have UNKNOWN redistribution rights and are kept only in gitignored `.local-fixtures/photoshop/`, excluded from distributed fixtures. Installed dependencies are `pako@2.1.0` and `base64-js@1.5.1`; the lockfile fixes package integrity. Its actual `dist/psdReader.js` accepts version 2, reads PSB 64-bit section lengths, and uses 32-bit RLE row lengths. The repository README still says no PSB support; the exercised implementation and binary PSB observations provide narrower direct evidence.

## RGB8 baseline compatibility

- PSD signature `8BPS`, version 1; PSB signature `8BPS`, version 2.
- The retained full-buffer path supports RGB8, 3 or 4 channels, Raw/RLE saved composites within its original 32 MiB, pixel and memory budgets.
- On that path, a negative layer count marks merged transparency and Photoshop's white matte is removed. An unmarked fourth channel is treated as an extra/spot channel and output is opaque; VersionInfo denying a real merged image is rejected.
- Over-budget documents can use bounded RGB8, three-channel Raw/RLE scanline previews. PSB remains experimental; generated 36 MiB Raw PSD/PSB evidence is Node-only, not an all-PSB claim.
- A validated resource 1036 JPEG is a low-resolution fallback when composite preview fails; PNG export is disabled for this fallback. Legacy 1033 BGR thumbnails are explicitly unsupported.
- Composite decoding still rejects CMYK, Lab, indexed/grayscale/bitmap, 16/32-bit and ZIP. The scanline path also rejects alpha/extra channels. A usable 1036 thumbnail may still be shown independently. There is no layer rendering, editing, ICC color management or arbitrary-size/GB-file guarantee.

Before full-buffer decoding, the original checks remain: 26-byte header, 32 MiB file size, side 4096, 4,194,304 pixels and the shared 96 MiB estimate. Sections and PSB uint64 lengths are checked against the actual buffer; a nonzero high word cannot fit that path. RLE packets must cover every scanline exactly. ZIP is rejected before inflation. The WeChat adapter retains the stricter Canvas side limit of 1365 for this path; exceeding these budgets now selects the bounded alternatives below instead of reading the whole source.

The full-buffer adapter still supplies ag-psd with the original header, empty metadata sections and a bounded composite copy. `skipLayerImageData` alone parses unrelated metadata; this envelope avoids it. Typed-array ImageData avoids DOM/Canvas in the decoder, with no Worker or WASM. Its original three-file-copy plus pixel/rendering estimate and 96 MiB constant are unchanged; neither is a measured device peak.

`src/core/photoshop-preview.ts` reads selected Raw/PackBits rows through the existing range reader. Its reusable session builds the complete RLE index once in 64 KiB chunks, with an 8 MiB table limit and 1 MiB compressed-row limit. The overview's longest edge remains within the existing 1365 Canvas limit; up to 2×2 stratified samples reduce aliasing without decoding every source row. Region requests reuse the index, keep only two temporary single-channel rows and one bounded output RGBA, and stop when their viewport is superseded. No original-size RGBA, ICC transform or layer reconstruction is added; unsampled row packets are not claimed valid.

The preview page maps actual transformed component bounds to source pixels, waits 180 ms after viewport changes, and permits one region render at a time. One native-image tile moves inside the existing movable-view; replacement releases the previous tile. The existing Canvas/PNG path renders that local derivative, while `exportPath` remains the original overview PNG. Saving never promises original-resolution output. Small-file decoding, alpha and SVG/AI paths remain separate.

`src/core/photoshop-thumbnail.ts` skips unknown resource payloads and reads only the resource directory and selected JPEG. It caps the directory at 4096 resources and JPEG at 2 MiB, validates header dimensions/row size/lengths and JPEG frame markers, and rejects 1033 BGR rather than misrepresent its colors. Resource 1036 can provide a visibly labeled low-resolution fallback, without PNG export.

The [official readFile documentation](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFile.html) notes a 100M single-file restriction. A successful range read in Developer Tools, or this particular Android sample, does not establish arbitrary file sizes on every device; real-device checks remain necessary. This is a bounded overview plus one viewport tile, not a complete huge-PSB renderer.

## Requested alternatives inspected

Inspection used real public source and licenses, not repository names alone.

| Project | Source inspected | License | Decision |
| --- | --- | --- | --- |
| ag-psd | npm 31.0.3 installed reader/writer; [repository commit 04d927d](https://github.com/Agamnentzar/ag-psd/tree/04d927df87130ad6d765bc63d51ade0a98d66c14) | MIT | Reuse the decoder; adapt only its composite input and ImageData allocation. |
| @webtoon/psd | [commit d1a9a32](https://github.com/webtoon/psd/tree/d1a9a32ad38ff17c16f94562fc2dd47018338e78), packages/psd/package.json (0.4.0), packages/psd/LICENSE, packages/decoder/index.ts | MIT, Copyright 2021-present NAVER WEBTOON | Has PSD/PSB support but image decoding uses a generated Rust/WASM module and initialization promise. Not integrated: it needs a separate WeChat WASM loading adaptation and device verification. No claim that it cannot ever run in WeChat. |
| ps-mobile | [commit ceccc05](https://github.com/JustRin/ps-mobile/tree/ceccc052aaa44ffd6585f8679edf2d8c72a45b4e), LICENSE, psdcore RowReader.kt and SeekableSource.kt | Apache-2.0 | Kotlin/Java FileChannel and positioned reads support on-demand scanline/tile rendering. Reference only, not a JavaScript Mini Program dependency. No source copied; the current bounded scanline module is separate. |

## Verification evidence

See `tests/photoshop.test.ts` and `tests/fixtures/photoshop/README.md` for generated fixture origin, code license, public reference provenance, asset-rights restrictions, SHA-256 and expected pixel comparisons. Mandatory tests use project-generated binary files and exercise real decoding, transparent composites, both PSB/PSD RLE tables, header errors, ZIP rejection, truncated sections, unsafe uint64 lengths, row packet errors, memory limits, missing real merged data and isolation from invalid unused layer metadata. Optional tests use local-only public references when present; they skip on a clean distributed checkout. In the local run, the upstream 413 × 413 PSB matched all expected pixels. The upstream alpha PSD had a documented one-level PNG red-channel rounding difference. These observations are not a license or redistribution authorization for those source images.

The earlier large-file implementation passed 13 thumbnail, 13 scanline-preview and 24 platform tests (50 total); TypeScript and build also passed. This is a historical batch, not the current test total. Tests use real filesystem ranges and complete generated 36 MiB Raw PSD/PSB composites, not padded-size placeholders. Generated files are not represented as Adobe-saved originals and have Node evidence only.

Local `test-results/wechat-large-photoshop/real-psd-node.json` records a user-provided 112,459,862-byte PSD (19056×15276) producing 1152×923 through 2807 ranges: 2,444,984 bytes total, largest read 65,536 bytes. `real-psd-devtools.json` records actual WeChat file selection and Canvas rendering; `real-psd-devtools-pixels.json` confirms all 4,253,184 output RGBA bytes match Node. The user-returned PNG in `user-saved-preview.json` was explicitly from Developer Tools, not Android's album.

`android-results.json` records the user's Android large-PSD preview screenshot (OPPO Find X7, WeChat 8.0.79, OS version unknown). This supports preview success for that file; the returned 1152×923 JPEG may be chat-transcoded and alone is not an exact-PNG or album-API claim. The user separately confirmed save and zoom work on this 1152 version (PASS); dragging was not explicitly confirmed. iOS remains NOT_RUN. Node/simulator evidence never establishes device peak memory, calibrated display color or complete PSD/PSB compatibility. No exact 25% zoom-step claim is made from native gesture events.

Private originals remain outside source/dist; all derived preview images and private evidence stay in gitignored local `test-results/` and are not public artifacts.

The current HD Node evidence in `test-results/wechat-hd-photoshop/node-hd-result.json` uses that same 112,459,862-byte PSD. The original-pixel region `(2600,8200,1365,1024)` is visibly sharper than an enlarged overview and matches the Photoshop reference's placement and glyph shapes; 18,367 of 1,397,760 pixels differ (maximum channel delta 21), so it is not an exact-color claim. Eight repeated region decodes reuse one index and yield consistent region hashes. Maximum individual RGBA is 5,973,240 bytes; no full-source read or full-resolution RGBA is used. Node memory snapshots are coarse and do not establish device memory behavior. Historical Android 1152×923 success does not validate this new HD path; Android/iOS HD remain NOT_RUN until separately exercised.

Actual Developer Tools output is recorded in `hd-large-center-hd.json`: an original region approximately 4037×3969 produces an 1183×1163 local PNG, exactly matching Node RGBA for that same floating-point region (`hd-native-region-pixels.json`). Native maximum concurrent region tasks is one; four obsolete reads were cancelled. This successful tile took about 30 seconds in this simulator; device latency is unmeasured. Only one successful tile was observed before the user resumed manual testing and stopped automation, so repeated native replacement/release and long-duration memory stability remain unverified. The user's `1.png` exactly matches the 1365×1094 overview file and is not an HD-region or original-size export. Temporary pass-through observation wrappers remain only in the current manually controlled runtime; a manual compile clears them without changing source code.

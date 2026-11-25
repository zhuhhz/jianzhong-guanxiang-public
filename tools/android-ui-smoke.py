#!/usr/bin/env python3
"""Exercise the installed app through real adb/SAF UI and retain emulator evidence.

Python standard library only. No screenshot synthesis, test-only app entry point,
private sample upload, or replacement parser is involved. A failure exits nonzero.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import sys
import time
import traceback
import xml.etree.ElementTree as ET
import zlib


PACKAGE = "com.zhuhhz.jianzhongguanxiang"
ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/photoshop/generated-rle.psb"
SVG_FIXTURES = ROOT / "tests/fixtures/svg"
JPEG_FIXTURE = ROOT / "tests/fixtures/photoshop-thumbnail/solid-rgb.jpg"
LONG_FILENAME = "jzg-portrait-and-landscape-long-file-name-for-small-screen-" + FIXTURE.name
REMOTE_XML = "/sdcard/jzg-ui-smoke.xml"
SAVE_ORIGINAL = "保存原尺寸 PNG"
SAVE_PREVIEW = "保存预览 PNG"
STAGE_DESCRIPTION = "文件位图预览，完整适屏"


class Smoke:
    def __init__(self, serial, output):
        self.adb = ["adb"] + (["-s", serial] if serial else [])
        self.output = output
        self.output.mkdir(parents=True, exist_ok=True)
        self.steps = []
        self.screenshots = []
        self.layout_checks = []
        self.exports = []
        self.interactions = []
        self.xml_number = 0

    def command(self, *arguments, binary=False, timeout=35):
        result = subprocess.run(self.adb + list(arguments), capture_output=True, timeout=timeout)
        if result.returncode:
            detail = (result.stderr + result.stdout).decode("utf-8", "replace")[-3000:]
            raise RuntimeError("adb %s failed: %s" % (" ".join(arguments), detail))
        return result.stdout if binary else result.stdout.decode("utf-8", "replace").strip()

    def step(self, message):
        print(message, flush=True)
        self.steps.append(message)

    def dump(self, label="state"):
        # DocumentsUI can briefly have no accessibility root while opening.
        # uiautomator sometimes returns exit 0 without writing the dump in that state.
        attempts = 7 if label == "system-saf" else 3
        for attempt in range(attempts):
            self.command("shell", "rm", "-f", REMOTE_XML)
            dump_result = self.command("shell", "uiautomator", "dump", "--compressed", REMOTE_XML, timeout=25)
            xml = self.command("shell", f"if [ -s {REMOTE_XML} ]; then cat {REMOTE_XML}; fi")
            try:
                root = ET.fromstring(xml)
                break
            except ET.ParseError:
                self.xml_number += 1
                (self.output / ("%03d-%s-transient.txt" % (self.xml_number, label))).write_text(
                    dump_result + "\n" + xml, encoding="utf-8")
                if attempt == attempts - 1:
                    if label.startswith("failure"):
                        return []
                    raise RuntimeError("No Android accessibility hierarchy for %s: %s" % (label, dump_result))
                time.sleep(0.5)
        self.xml_number += 1
        (self.output / ("%03d-%s.xml" % (self.xml_number, label))).write_text(xml, encoding="utf-8")
        # Leaf Element instances are falsy in ElementTree; plain attribute maps
        # keep successful TextView matches truthy throughout click/wait helpers.
        return [node.attrib for node in root.iter("node")]

    @staticmethod
    def find(nodes, text=None, description=None, contains=None):
        for node in nodes:
            if node.get("enabled", "true") != "true":
                continue
            if text is not None and node.get("text") != text:
                continue
            if description is not None and node.get("content-desc") != description:
                continue
            if contains is not None and contains not in (node.get("text", "") + " " + node.get("content-desc", "")):
                continue
            if re.fullmatch(r"\[\d+,\d+\]\[\d+,\d+\]", node.get("bounds", "")):
                return node
        return None

    def wait(self, predicate, label, timeout=25):
        deadline = time.monotonic() + timeout
        last = []
        while time.monotonic() < deadline:
            last = self.dump(label)
            result = predicate(last)
            if result:
                return result
            if any("内核加载失败" in node.get("text", "") for node in last):
                raise RuntimeError("The native WebView could not load its bundled parser")
            time.sleep(0.4)
        visible = [node.get("text") or node.get("content-desc") for node in last]
        raise RuntimeError("Timed out waiting for %s; visible=%r" % (label, [text for text in visible if text]))

    def tap(self, node):
        x1, y1, x2, y2 = self.bounds(node)
        if x2 <= x1 or y2 <= y1:
            raise RuntimeError("Cannot tap an empty UI bound")
        self.command("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))

    @staticmethod
    def bounds(node):
        return tuple(map(int, re.findall(r"\d+", node["bounds"])))

    def tap_back(self):
        self.command("shell", "input", "keyevent", "4")

    def tap_text(self, text, timeout=20):
        self.tap(self.wait(lambda nodes: self.find(nodes, text=text), "text", timeout))

    def tap_description(self, description, timeout=20):
        self.tap(self.wait(lambda nodes: self.find(nodes, description=description), "description", timeout))

    def screenshot(self, name, save_action=SAVE_ORIGINAL):
        # These are the emulator's actual pixels, streamed without text translation.
        png = self.command("exec-out", "screencap", "-p", binary=True)
        if not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) < 100:
            raise RuntimeError("adb did not return a real PNG screenshot")
        path = self.output / (name + ".png")
        path.write_bytes(png)
        self.screenshots.append({"file": path.name, "bytes": len(png), "sha256": hashlib.sha256(png).hexdigest()})
        nodes = self.dump(name)
        width, height = struct.unpack(">II", png[16:24])
        if "landscape" in name and width <= height:
            raise RuntimeError("Landscape rotation did not take effect")
        if "preview" in name and not name.startswith("failure"):
            for label, key, value in [
                ("bitmap stage", "description", STAGE_DESCRIPTION),
                ("preview save action", "text", save_action),
                ("preview back action", "description", "返回首页"),
            ]:
                node = self.find(nodes, **{key: value})
                if node is None:
                    raise RuntimeError("%s missing from %s" % (label, name))
                x1, y1, x2, y2 = map(int, re.findall(r"\d+", node["bounds"]))
                if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                    raise RuntimeError("%s exceeds actual screen bounds in %s: %s vs %dx%d" %
                                       (label, name, node["bounds"], width, height))
                self.layout_checks.append({"screenshot": name, "view": label, "bounds": node["bounds"],
                                           "screen": [width, height], "status": "PASS"})
            stage = self.bounds(self.find(nodes, description=STAGE_DESCRIPTION))
            save = self.bounds(self.find(nodes, text=save_action))
            hint = self.find(nodes, contains="双击 / 双指缩放")
            controls = self.find(nodes, description="适应屏幕")
            if not hint or not controls:
                raise RuntimeError("The fitted preview is missing the gesture hint or its toolbar")
            hint_box, controls_box = self.bounds(hint), self.bounds(controls)
            if not (stage[3] <= hint_box[1] < controls_box[1] < save[1]):
                raise RuntimeError("Expected the fitted canvas, gesture hint, toolbar and fixed save in that order")
        self.step("Captured actual Android display: " + path.name)

    def home(self):
        self.wait(lambda nodes: self.find(nodes, text="选择本地文件"), "home-ready", timeout=45)

    def launch(self):
        self.command("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        self.home()

    def set_theme(self, theme):
        self.tap_text("主题")
        self.tap_text(theme)
        self.home()
        self.step("Selected native theme: " + theme)

    def open_picker(self):
        self.tap_text("选择本地文件")
        self.wait(lambda nodes: any("documentsui" in node.get("package", "") for node in nodes), "system-saf", timeout=75)

    def push_fixture(self, path, filename=None):
        filename = filename or path.name
        destination = "/sdcard/Download/" + filename
        self.command("push", str(path), destination)
        self.command("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                     "-d", "file://" + destination)

    def select_fixture(self, filename):
        self.open_picker()
        model = self.command("shell", "getprop", "ro.product.model")
        # Later selections normally reopen Download, so avoid unnecessary navigation.
        nodes = self.dump("saf-current")
        item = self.find(nodes, text=filename)
        if item:
            self.tap(item)
        else:
            navigated = False
            used_targets = set()
            download_scrolls = {}
            storage_menu_tried = False
            for _ in range(20):
                nodes = self.dump("saf-navigation")
                item = self.find(nodes, text=filename)
                if item:
                    self.tap(item)
                    navigated = True
                    break
                folder = next((node.get("text") for node in nodes if node.get("resource-id", "").endswith(":id/header_title")
                               and node.get("text") in {"Files in Download", "Files in Downloads"}), None)
                grid = next((node for node in nodes if node.get("resource-id", "").endswith(":id/dir_list")
                             and node.get("scrollable") == "true"), None)
                if folder and grid is not None and download_scrolls.get(folder, 0) < 4:
                    x1, y1, x2, y2 = self.bounds(grid)
                    x = str((x1 + x2) // 2)
                    self.command("shell", "input", "swipe", x, str(y1 + (y2 - y1) * 4 // 5),
                                 x, str(y1 + (y2 - y1) * 2 // 5), "350")
                    download_scrolls[folder] = download_scrolls.get(folder, 0) + 1
                    continue
                # Prefer the real storage root when the drawer is already visible.
                item = next((self.find(nodes, text=text) for text in
                             [model, "Internal storage", "内部存储空间", "内部存储"]
                             if ("storage", text) not in used_targets and self.find(nodes, text=text)), None)
                if item:
                    used_targets.add(("storage", item.get("text")))
                    self.tap(item)
                    continue
                item = next((self.find(nodes, text=text) for text in ["Download", "Downloads", "下载"]
                             if ("download", text) not in used_targets and self.find(nodes, text=text)), None)
                if item:
                    used_targets.add(("download", item.get("text")))
                    self.tap(item)
                    continue
                # Enable a hidden storage root once, before opening the drawer. Tracking
                # attempted targets avoids repeatedly tapping a Download toolbar title.
                menu_button = self.find(nodes, description="More options") or self.find(nodes, description="更多选项")
                if menu_button and not storage_menu_tried:
                    storage_menu_tried = True
                    self.tap(menu_button)
                    menu = self.dump("saf-menu")
                    show = self.find(menu, text="Show internal storage") or self.find(menu, text="显示内部存储空间")
                    if show:
                        self.tap(show)
                    else:
                        self.command("shell", "input", "keyevent", "4")
                    continue
                item = next((self.find(nodes, description=text) for text in
                             ["Show roots", "显示根目录", "显示根文件夹", "Open navigation drawer"]
                             if self.find(nodes, description=text)), None)
                if item:
                    self.tap(item)
                    continue
                break
            if not navigated:
                raise RuntimeError("System SAF could not locate %s; inspect saf-navigation XML" % filename)
        self.wait(lambda nodes: self.find(nodes, description="查看文件详情"), "preview-screen", timeout=45)

    def open_fixture(self, filename=FIXTURE.name, file_format="PSB", dimensions=(3, 2), action=SAVE_ORIGINAL):
        self.select_fixture(filename)
        # The screen opens before parsing; wait for a real bitmap-ready control before
        # opening the snapshot details dialog so loading metadata cannot be mistaken for success.
        self.wait(lambda nodes: self.find(nodes, description=STAGE_DESCRIPTION)
                  and self.find(nodes, text=action), file_format.lower() + "-bitmap-ready", timeout=45)
        self.tap_description("查看文件详情")

        def parsed_details(nodes):
            text = " ".join(node.get("text", "") for node in nodes)
            width, height = dimensions
            return filename in text and file_format in text and re.search(rf"{width}\s*[×x]\s*{height}", text)

        self.wait(parsed_details, "parsed-" + file_format.lower() + "-details", timeout=30)
        self.tap_description("关闭")
        self.step("Actual SAF %s selection and parsed dimensions %s x %s confirmed" % (file_format, *dimensions))

    def percent(self, value):
        return self.wait(lambda nodes: self.find(nodes, text=value), "zoom-" + value.rstrip("%"))

    def stage_pixels(self, description=STAGE_DESCRIPTION):
        node = self.wait(lambda nodes: self.find(nodes, description=description), "canvas")
        x1, y1, x2, y2 = self.bounds(node)
        raw = self.command("exec-out", "screencap", binary=True)
        width, height, fmt = struct.unpack_from("<III", raw)
        header = len(raw) - width * height * 4
        if fmt not in (1, 2) or header not in (12, 16):
            raise RuntimeError("Unsupported Android raw screencap layout for canvas comparison")
        # Compare only the central area of the bitmap, away from system bars and UI text.
        digest = hashlib.sha256()
        for y in range(y1 + (y2 - y1) // 4, y2 - (y2 - y1) // 4):
            start = header + (y * width + x1 + (x2 - x1) // 4) * 4
            stop = start + (x2 - x1) // 2 * 4
            digest.update(raw[start:stop])
        return digest.hexdigest(), (x1, y1, x2, y2)

    def check_tiny_pixels(self):
        node = self.wait(lambda nodes: self.find(nodes, description=STAGE_DESCRIPTION), "tiny-bitmap")
        x1, y1, x2, y2 = self.bounds(node)
        raw = self.command("exec-out", "screencap", binary=True)
        width, height, fmt = struct.unpack_from("<III", raw)
        header = len(raw) - width * height * 4
        if fmt not in (1, 2) or header not in (12, 16):
            raise RuntimeError("Unsupported Android screencap for tiny bitmap color samples")
        y = y1 + (y2 - y1) * 3 // 8
        colors = []
        for fraction in (1, 5, 9):
            x = x1 + (x2 - x1) * fraction // 12
            index = header + (y * width + x) * 4
            colors.append(tuple(raw[index:index + 3]))
        if colors != [(255, 0, 0), (0, 255, 0), (0, 0, 255)]:
            raise RuntimeError("Tiny PSB should show exact source color blocks; sampled %r" % (colors,))
        self.interactions.append({"tiny_psb_rgb_samples": colors})
        self.step("Verified nearest-neighbor tiny PSB preview with exact display pixels")

    def check_viewport(self):
        self.percent("100%")
        self.check_tiny_pixels()
        self.tap_description("放大")
        self.percent("125%")
        self.tap_description("缩小")
        self.percent("100%")
        self.tap_description("预览工具")
        self.screenshot("06a-tools-open")
        self.tap_text("背景：棋盘")
        self.tap_text("背景：白")
        self.tap_text("背景：黑")
        self.wait(lambda nodes: self.find(nodes, text="背景：棋盘"), "checker-restored")
        self.tap_description("重置预览")
        self.wait(lambda nodes: self.find(nodes, description="预览工具"), "tools-dismissed")

        _, (x1, y1, x2, y2) = self.stage_pixels()
        x, y = (x1 + x2) // 2, (y1 + y2) // 2
        self.command("shell", f"cmd input tap {x} {y} && sleep 0.08 && cmd input tap {x} {y}")
        self.percent("200%")
        before, (x1, y1, x2, y2) = self.stage_pixels()
        y = (y1 + y2) // 2
        self.command("shell", "input", "swipe", str(x1 + (x2 - x1) * 3 // 4), str(y),
                     str(x1 + (x2 - x1) // 4), str(y), "380")
        self.percent("200%")
        after, _ = self.stage_pixels()
        if before == after:
            raise RuntimeError("Panning did not change bitmap pixels at fixed zoom")
        self.interactions.append({"zoom": "200%", "canvas_before_sha256": before, "canvas_after_sha256": after})
        self.step("Verified zoom controls, double-tap, three backgrounds and pan via actual canvas pixels")

    def save_picker(self, action):
        self.tap_text(action)
        self.wait(lambda nodes: any("documentsui" in node.get("package", "") for node in nodes),
                  "save-picker", timeout=45)

    def check_export(self, action=SAVE_ORIGINAL, expected_dimensions=(3, 2),
                     artifact="saved-psb-original.png", cancel=False):
        if cancel:
            self.save_picker(action)
            # DocumentsUI first moves from Download back to the storage root.
            for _ in range(3):
                nodes = self.dump("save-cancel-navigation")
                if not any("documentsui" in node.get("package", "") for node in nodes):
                    break
                self.tap_back()
            self.wait(lambda nodes: self.find(nodes, contains="已取消"), "cancelled-save")
        self.save_picker(action)
        nodes = self.dump("save-destination")
        folder = next((node for node in nodes if node.get("resource-id") == "android:id/title"
                       and node.get("text") in {"Download", "Downloads", "下载"}), None)
        if folder:
            self.tap(folder)
            nodes = self.dump("save-download")
        entry = next((node for node in nodes if node.get("class") == "android.widget.EditText"), None)
        filename = entry.get("text", "") if entry else ""
        if not re.fullmatch(r"[A-Za-z0-9_.-]+[.]png", filename):
            raise RuntimeError("Save picker did not expose the expected .png filename")
        self.tap(self.wait(lambda nodes: next((node for node in nodes
            if node.get("enabled") == "true" and
            (node.get("resource-id", "").endswith(":id/action_menu_save")
             or node.get("text", "").lower() in {"save", "保存"})), None), "save-confirm"))
        self.wait(lambda nodes: self.find(nodes, contains="已保存"), "save-complete", timeout=45)
        png = self.command("exec-out", "cat", "/sdcard/Download/" + filename, binary=True)
        if (len(png) < 57 or png[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
                or not png.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82")):
            raise RuntimeError("Save picker output is not a complete PNG")
        width, height = struct.unpack(">II", png[16:24])
        if (width, height) != expected_dimensions:
            raise RuntimeError("%s has incorrect dimensions: %sx%s" % (artifact, width, height))
        (self.output / artifact).write_bytes(png)
        self.exports.append({"file": artifact, "bytes": len(png), "width": width,
                             "height": height, "sha256": hashlib.sha256(png).hexdigest()})
        self.step("Verified Android SAF exported PNG bytes: " + artifact)
        return png

    def check_hd_psb(self):
        width, height = 2400, 240
        header = struct.pack(">4sH6xHIIHH", b"8BPS", 2, 3, height, width, 8, 3)
        row = bytes(value % 256 for value in range(width))
        bands = (row, row[::-1], bytes(width))
        fixture = self.output / "jzg-region-check.psb"
        fixture.write_bytes(header + struct.pack(">IIQH", 0, 0, 0, 0) + b"".join(band * height for band in bands))
        self.push_fixture(fixture)
        self.open_fixture(fixture.name, "PSB", (width, height))
        for _ in range(4):
            self.tap_description("放大")
        self.wait(lambda nodes: self.find(nodes, contains="局部高清已就绪"), "real-hd-tile", timeout=45)
        self.screenshot("14-preview-psb-hd")
        self.step("Verified Android applied a higher-resolution PSB source region after zoom")
        self.tap_description("返回首页")
        self.home()

    def check_bigtiff(self):
        width, rows, strips = 262144, 64, 129
        height = rows * strips
        strip_bytes = width * 2 * rows
        high_strip = 16 + (strips - 1) * strip_bytes
        ifd_offset = high_strip + strip_bytes
        offsets = [16 + i * strip_bytes for i in range(strips)]
        # Logical strip zero is physically after 4 GiB. Its nonzero samples must
        # appear in the on-screen overview, while all other strips are black.
        offsets[0], offsets[-1] = offsets[-1], offsets[0]
        index = ifd_offset + 240
        tags = [(256, 4, 1, width), (257, 4, 1, height), (258, 3, 1, 16), (259, 3, 1, 1),
                (262, 3, 1, 1), (273, 16, strips, index), (274, 3, 1, 1), (277, 3, 1, 1),
                (278, 3, 1, rows), (279, 16, strips, index + strips * 8), (284, 3, 1, 1)]
        header = struct.pack("<2sHHHQ", b"II", 43, 8, 0, ifd_offset)
        tail = struct.pack("<Q", len(tags)) + b"".join(struct.pack("<HHQQ", *tag) for tag in tags)
        tail += bytes(12)
        tail += struct.pack("<" + "Q" * strips, *offsets)
        tail += struct.pack("<" + "Q" * strips, *([strip_bytes] * strips))
        filename = "jzg-bigtiff-over-4gib.tif"
        remote = "/sdcard/Download/" + filename
        with tempfile.TemporaryDirectory(prefix="jzg-bigtiff-") as directory:
            parts = {"head": header, "first": bytes([160]) * strip_bytes, "tail": tail}
            for name, contents in parts.items():
                local = Path(directory) / name
                local.write_bytes(contents)
                self.command("push", str(local), "/data/local/tmp/jzg-bigtiff-" + name, timeout=70)
            self.command("shell",
                         f"test ! -e {remote} && cat /data/local/tmp/jzg-bigtiff-head > {remote} && "
                         f"dd if=/dev/zero bs=1048576 count=4096 >> {remote} && "
                         f"cat /data/local/tmp/jzg-bigtiff-first /data/local/tmp/jzg-bigtiff-tail >> {remote}",
                         timeout=300)
        evidence = self.command("shell", "stat", "-c", "%s,%b,%B", remote)
        size, blocks, unit = map(int, evidence.split(","))
        if size != ifd_offset + len(tail) or size <= 4 * 1024 ** 3:
            raise RuntimeError("The BigTIFF on the emulator is incomplete")
        self.command("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                     "-d", "file://" + remote)
        self.open_fixture(filename, "BigTIFF", (width, height))
        self.screenshot("15-preview-bigtiff-over-4gib")
        node = self.wait(lambda nodes: self.find(nodes, description=STAGE_DESCRIPTION), "bigtiff-stage")
        x1, y1, x2, y2 = self.bounds(node)
        raw = self.command("exec-out", "screencap", binary=True)
        screen_width, screen_height, fmt = struct.unpack_from("<III", raw)
        header_size = len(raw) - screen_width * screen_height * 4
        if fmt not in (1, 2) or header_size not in (12, 16):
            raise RuntimeError("Unsupported Android screencap for BigTIFF pixel sampling")
        x = (x1 + x2) // 2
        def rgb(y):
            offset = header_size + (y * screen_width + x) * 4
            return tuple(raw[offset:offset + 3])
        first = [rgb(y) for y in range(y1, min(y1 + 4, y2))]
        center = rgb((y1 + y2) // 2)
        if not any(r == g == b and r > 25 for r, g, b in first) or center != (0, 0, 0):
            raise RuntimeError(f"Expected visible gray marker from the strip beyond 4 GiB; {first=} {center=}")
        self.interactions.append({"format": "BigTIFF", "source_bytes": size, "allocated_bytes": blocks * unit,
                                  "source_dimensions": [width, height], "first_strip_offset": high_strip,
                                  "first_ifd_offset": ifd_offset, "gray_marker_samples": first, "center_rgb": center})
        self.step(f"Android SAF read and displayed pixel data beyond 4 GiB in a {size}-byte BigTIFF")
        self.tap_description("返回首页")
        self.home()

    def check_svg(self):
        transparent = SVG_FIXTURES / "transparent.svg"
        self.push_fixture(transparent)
        self.open_fixture(transparent.name, "SVG", (160, 90), SAVE_PREVIEW)
        self.screenshot("11-preview-transparent-svg", SAVE_PREVIEW)
        png = self.check_export(SAVE_PREVIEW, (160, 90), "saved-svg-preview.png")
        if png[24:26] != b"\x08\x06":
            raise RuntimeError("Transparent SVG preview did not produce an RGBA PNG")
        offset, image = 8, bytearray()
        while offset + 12 <= len(png):
            length, tag = struct.unpack_from(">I4s", png, offset)
            if tag == b"IDAT":
                image.extend(png[offset + 8:offset + 8 + length])
            offset += length + 12
        pixels = zlib.decompress(image)
        # The leading pixel has no predictors regardless of the PNG row filter.
        stride = 1 + 160 * 4
        if (len(pixels) != 90 * stride or pixels[4] != 0
                or not any(any(pixels[row + 1:row + stride]) for row in range(0, len(pixels), stride))):
            raise RuntimeError("Transparent SVG export lacks transparent margins or visible content")
        self.step("Verified transparent SVG raster PNG includes transparent margin and visible content")
        self.tap_description("返回首页")
        self.home()
        scripted = SVG_FIXTURES / "script.svg"
        self.push_fixture(scripted)
        self.select_fixture(scripted.name)
        nodes = self.wait(lambda current: current if (self.find(current, contains="预览失败")
                          and self.find(current, contains="script")) else None, "svg-script-rejected")
        if self.find(nodes, description=STAGE_DESCRIPTION) or any(
                node.get("text") in {SAVE_PREVIEW, SAVE_ORIGINAL} for node in nodes):
            raise RuntimeError("Rejected scripted SVG unexpectedly exposes preview or export")
        self.screenshot("12-rejected-scripted-svg")
        self.step("Verified shared safety parser rejects scripted SVG in Android UI")
        self.tap_description("返回首页")
        self.home()

    def check_animated_svg(self):
        name = "jzg-safe-animated.svg"
        description = "SVG 动画预览"
        with tempfile.TemporaryDirectory(prefix="jzg-svg-") as directory:
            fixture = Path(directory) / name
            fixture.write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90">'
                '<rect x="4" y="20" width="30" height="48" fill="#13a980">'
                '<animate attributeName="x" from="4" to="126" dur="17s" repeatCount="indefinite"/>'
                '</rect></svg>', encoding="utf-8")
            self.push_fixture(fixture)
        self.open_fixture(name, "SVG", (160, 90), SAVE_PREVIEW)
        self.tap_text("开始")
        first, _ = self.stage_pixels(description)
        time.sleep(.4)
        later, _ = self.stage_pixels(description)
        if first == later:
            raise RuntimeError("Animated SVG did not change the displayed pixels")
        self.tap_text("暂停")
        self.wait(lambda nodes: self.find(nodes, text="继续"), "svg-pause")
        stopped, _ = self.stage_pixels(description)
        time.sleep(.4)
        unchanged, _ = self.stage_pixels(description)
        if stopped != unchanged:
            raise RuntimeError("SVG display changed across paused frames")
        self.screenshot("16-animated-svg-paused")
        self.check_export(SAVE_PREVIEW, (160, 90), "saved-animated-svg-first-frame.png")
        self.tap_text("重播")
        self.wait(lambda nodes: self.find(nodes, text="暂停"), "svg-restarted")
        self.interactions.append({"format": "SVG animation", "playing_before": first, "playing_after": later,
                                  "paused": stopped, "paused_recheck": unchanged})
        self.step("Verified SVG playback, pause, restart and first-frame PNG through Android UI")
        self.tap_description("返回首页")
        self.home()

    def check_jpeg_orientation(self):
        oriented = self.output / "jzg-exif-orientation-6.jpg"
        jpeg = JPEG_FIXTURE.read_bytes()
        # APP1 IFD0 Orientation=6. The actual bundled 64×48 JPEG scan data stays intact.
        exif = bytes.fromhex("45786966000049492a0008000000010012010300010000000600000000000000")
        oriented.write_bytes(jpeg[:2] + b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif + jpeg[2:])
        self.push_fixture(oriented)
        self.open_fixture(oriented.name, "JPEG", (48, 64))
        self.screenshot("13-preview-jpeg-exif-portrait")
        self.check_export(SAVE_ORIGINAL, (48, 64), "saved-exif-jpeg-original.png")
        self.step("Verified EXIF orientation changes actual exported dimensions to portrait")
        self.tap_description("返回首页")
        self.home()

    def rotate(self, rotation):
        self.command("shell", "wm", "user-rotation", "lock", str(rotation))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            png = self.command("exec-out", "screencap", "-p", binary=True)
            width, height = struct.unpack(">II", png[16:24])
            if (width > height) == (rotation == 1):
                return
            time.sleep(0.5)
        state = self.command("shell", "wm", "user-rotation")
        raise RuntimeError("Window manager did not rotate display to %s: %s" % (rotation, state))

    def portrait(self):
        self.rotate(0)

    def landscape(self):
        self.rotate(1)

    def check_small_layout(self):
        self.command("shell", "wm", "size", "720x1280")
        self.command("shell", "wm", "density", "320")
        self.command("shell", "settings", "put", "system", "font_scale", "1.3")
        self.home()
        self.screenshot("09-home-small-large-font")
        self.push_fixture(FIXTURE, LONG_FILENAME)
        self.open_fixture(LONG_FILENAME)
        self.screenshot("10-preview-small-large-font")
        self.step("Verified actual long filename preview and fixed save action with large font on small display")

    def diagnostics(self):
        for filename, args in [
            ("failure-logcat.txt", ("logcat", "-d", "-t", "500")),
            ("failure-activity.txt", ("shell", "dumpsys", "activity", "activities")),
            ("failure-webview.txt", ("shell", "dumpsys", "webviewupdate")),
        ]:
            try:
                (self.output / filename).write_text(self.command(*args), encoding="utf-8")
            except Exception as error:
                (self.output / filename).write_text(str(error), encoding="utf-8")
        try:
            self.screenshot("failure-current-display")
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"))
    parser.add_argument("--output", type=Path, default=ROOT / "out/ui-screenshots")
    parser.add_argument("--large-file", action="store_true", help="Generate and read a >4 GiB BigTIFF in the emulator")
    parser.add_argument("--small-layout-only", action="store_true", help="Exercise the small-screen long filename check")
    arguments = parser.parse_args()
    smoke = Smoke(arguments.serial, arguments.output)
    report = {"status": "NOT_RUN", "scope": "Actual emulator UI screenshots and SAF fixture smoke; not physical-device qualification",
              "fixture": {"path": str(FIXTURE.relative_to(ROOT)), "bytes": FIXTURE.stat().st_size,
                          "sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest()}}
    success = "EMULATOR_SMALL_LAYOUT_PASS" if arguments.small_layout_only else "EMULATOR_UI_PASS"
    if arguments.small_layout_only:
        report["scope"] = "Actual Android small screen, large font, long filename and fixed save action"
    original_font = "1.0"
    try:
        smoke.command("wait-for-device", timeout=60)
        report["device"] = {"model": smoke.command("shell", "getprop", "ro.product.model"),
                            "api": smoke.command("shell", "getprop", "ro.build.version.sdk"),
                            "fingerprint": smoke.command("shell", "getprop", "ro.build.fingerprint")}
        original_font = smoke.command("shell", "settings", "get", "system", "font_scale")
        smoke.portrait()
        smoke.push_fixture(FIXTURE)
        smoke.launch()
        if not arguments.small_layout_only:
            if arguments.large_file:
                smoke.check_bigtiff()
            smoke.check_animated_svg()
            smoke.open_picker()
            smoke.tap_back()
            smoke.wait(lambda nodes: smoke.find(nodes, contains="已取消"), "cancelled-open")
            smoke.step("Verified Android SAF selection cancellation returns to home")
            for index, theme in enumerate(["青墨", "宣纸", "夜墨"], 1):
                smoke.set_theme(theme)
                smoke.screenshot("%02d-home-theme-%d" % (index * 2 - 1, index))
                smoke.open_fixture()
                smoke.screenshot("%02d-preview-theme-%d" % (index * 2, index))
                if index == 1:
                    smoke.tap_description("查看文件详情")
                    smoke.screenshot("02a-file-details")
                    smoke.tap_description("关闭")
                if index == 3:
                    smoke.check_viewport()
                    smoke.screenshot("06b-preview-panned")
                    smoke.landscape()
                    smoke.percent("200%")
                    smoke.screenshot("07-preview-landscape")
                    smoke.wait(lambda nodes: smoke.find(nodes, text="背景：棋盘")
                               and smoke.find(nodes, description="重置预览"), "wide-toolbar")
                    smoke.portrait()
                    smoke.percent("200%")
                    smoke.tap_description("适应屏幕")
                    smoke.percent("100%")
                    smoke.step("Verified both rotation directions preserve the open file and zoom")
                    smoke.check_export(cancel=True)
                nodes = smoke.dump("before-home")
                if smoke.find(nodes, description="返回首页"):
                    smoke.tap_description("返回首页")
                smoke.home()
            smoke.check_svg()
            smoke.check_jpeg_orientation()
            smoke.check_hd_psb()
            smoke.command("shell", "am", "force-stop", PACKAGE)
            smoke.launch()
            smoke.screenshot("08-home-after-restart")
        smoke.check_small_layout()
        if not smoke.command("shell", "pidof", PACKAGE):
            raise RuntimeError("App process is absent after UI smoke")
        report["status"] = success
    except Exception as error:
        report["status"] = "FAIL"
        report["error"] = str(error)
        report["traceback"] = traceback.format_exc()
        print(report["traceback"], file=sys.stderr, flush=True)
        smoke.diagnostics()
    finally:
        report["steps"] = smoke.steps
        report["screenshots"] = smoke.screenshots
        report["layout_checks"] = smoke.layout_checks
        report["interactions"] = smoke.interactions
        report["exports"] = smoke.exports
        (smoke.output / "ui-smoke-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        for args in [("shell", "wm", "size", "reset"), ("shell", "wm", "density", "reset"),
                     ("shell", "settings", "put", "system", "font_scale", original_font if original_font != "null" else "1.0"),
                     ("shell", "wm", "user-rotation", "free")]:
            try:
                smoke.command(*args)
            except Exception:
                pass
    print(json.dumps({"status": report["status"], "screenshots": len(smoke.screenshots), "output": str(smoke.output)}, ensure_ascii=False), flush=True)
    return 0 if report["status"] == success else 1


if __name__ == "__main__":
    sys.exit(main())

# AI sample

This third-party design sample is local-only and excluded from Git, including the
private repository. Keep an existing authorized local copy at the path below;
tests that require it explicitly skip when it is absent. Tests never download it.
Project-generated PDF structure controls remain mandatory. The provenance and
license record below is retained; it does not cause the asset to be uploaded.

`upstream-illustrator-grid.ai` is an unchanged 402,941-byte public sample from
[flyfish-dev/file-viewer](https://github.com/flyfish-dev/file-viewer/blob/1ffa8b6f99fe4df352c64ff0bd8f8003b4dd87de/apps/viewer-demo/public/example/illustrator-grid.ai), commit `1ffa8b6f99fe4df352c64ff0bd8f8003b4dd87de`.
SHA-256: `af0f68462ff032c81309744f6ddc5c06f032949074f59464763bf8bf14517084`.

The repository states Apache-2.0; its full license is retained in `UPSTREAM-LICENSE.txt`.
No separate sample license is claimed. Metadata identifies Adobe Illustrator CC 2015 (Macintosh),
and the container has four pages; Producer is pdf-lib, so this is not claimed to be an untouched
original Illustrator export. Node checks validate structure and parse pages with pdf-lib.
They do not prove that WeChat openDocument succeeds on a device.

The synthetic PDF containers generated inside tests are separate structural controls,
not Illustrator-produced files or native-viewer tests.

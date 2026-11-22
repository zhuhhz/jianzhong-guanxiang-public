# Photoshop binary fixtures

These are real binary documents decoded by the installed `ag-psd@31.0.3`. No parser mocks or hardcoded success responses are used.

## Optional upstream references: local only, not distributed

Public source references were retrieved from [Agamnentzar/ag-psd](https://github.com/Agamnentzar/ag-psd) at commit `04d927df87130ad6d765bc63d51ade0a98d66c14` on 2026-10-23. The full [upstream license](https://github.com/Agamnentzar/ag-psd/blob/04d927df87130ad6d765bc63d51ade0a98d66c14/LICENSE) explicitly states: “Any image or brush files included in this repository are not covered by this license and belong to their copyright holders.”

**The PSD/PSB/PNG references are not MIT-licensed project fixtures. Their redistribution authorization is UNKNOWN.** They were moved out of this distributable directory into gitignored `.local-fixtures/photoshop/` for local-only comparison. Do not distribute, publish or copy them into the project package without explicit permission from their copyright holders. Their original public URLs, hashes and observed decoding results are documented below; documentation of those observations does not authorize asset redistribution. Tests skip these optional references when the local files are absent. The generated fixtures below remain mandatory.

| Local-only file under .local-fixtures/photoshop/ | Original path | SHA-256 |
| --- | --- | --- |
| upstream-fill-opacity.psd | test/read/fill-opacity/src.psd | 0e3940268aa1b06092d6fb2bddeaad85656e02ad6e30eecd34beb90f6752bbd1 |
| upstream-fill-opacity.png | test/read/fill-opacity/canvas.png | c9737be4ac795843f0f1252d14de0f35c86f63030333fccd9c83a502ec7508f4 |
| upstream-layers.psb | test/read/psb/src.psb | 3aae71e57e7e6044c3df63ee9292151007eec7e63c44587e79c607d0eda34449 |
| upstream-layers.png | test/read/psb/canvas.png | 15e5870356f2f19e15f19659eb3448f4b3843e9876f7c65bad81978d01a7f804 |
| UPSTREAM-LICENSE.txt | LICENSE | 035430250509b801de02201d2f9bc9388a1220198f9276d38f4059df882e585c |

`upstream-layers.psb` is a 413 × 413, RGB8, three-channel layered PSB with RLE composite data. Every decoded RGBA pixel matches its upstream PNG exactly.

`upstream-fill-opacity.psd` is a 1 × 1, RGB8, four-channel PSD with merged transparency. Saved planar values are `[100,112,102,206]`; the same white-matte inversion as ag-psd yields exactly `[63,78,66,206]`. Its upstream Canvas-produced PNG has `[62,78,66,206]`. The test asserts the exact decoded value and records the one-level PNG difference; it does not claim exact color agreement for this alpha sample.

## Generated fixtures

Regenerate with `node node_modules/tsx/dist/cli.mjs tools/generate-photoshop-fixtures.ts`. `generated-rle.*` and `generated-alpha.*` use the real ag-psd writer. `generated-raw.*` are minimal valid Raw documents written by the fixture generator according to the file structure; this writer is not production decoding code. Generated files are project fixtures, not independent Photoshop exports or upstream samples.

| File | SHA-256 |
| --- | --- |
| generated-raw.psd | 7c67e3bdeb8bf49ce84a729e66854d63dfc8648c2e822af62e76797ef0e85184 |
| generated-raw.psb | 25f8adbec9b0a06d6c37bacd96db97ebcc8bc6683042e938c501e21160418c14 |
| generated-rle.psd | 35fbc6473cacfdb2ea8366096c6882bda94799574743c45c54c84efc1f1c4319 |
| generated-rle.psb | 38235e37dfcc72ed6e79f8382cd4c3567b26f4ee70e6248a95e06db081f09275 |
| generated-alpha.psd | 54914abdbf9d17b12631e2d560294213480bf8ba37db44b48b15c69d32d5e627 |
| generated-alpha.psb | 0b9afb03c802674f0ef01c5cb9d52be1b1244e6c69dd6599b8cd0a654366ced6 |

The alpha fixtures use six pixels because ag-psd 31.0.3 undersizes its temporary RLE write buffer for a three-pixel RGBA PSB. Our preflight rejects that malformed output; the production library is not patched.

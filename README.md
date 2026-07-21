# Nikon Picture Control Editor (local)

A fully client-side re-implementation (and extension) of [nikonpc.com](https://www.nikonpc.com/) —
a third-party editor for **Nikon Picture Control** files. Everything runs in the browser: live
preview, 20-point tone curve with levels + gamma, adjustment sliders, monochrome filter/toning,
a preset library and preset browser, and real binary **`.NCP` and `.NP3`** export/import.
No server, no build step, works offline (installable PWA).

> Not an official Nikon product; not affiliated with Nikon Corporation or nikonpc.com.

## Run it

Open `index.html` in any modern browser, or serve the folder:

```
npx serve .        # or: python -m http.server
```

Run the unit tests with:

```
node --test tests/core.test.js
```

## Features

- **Preview** — sample images (generated locally), local files (`open file…` / drag & drop,
  including **NEF** via the embedded JPEG preview), or an image URL. Sizes 386–2400 px,
  a draggable "Original" panel, and a **split-compare** slider on the preview itself.
  Pixel processing runs in a Web Worker.
- **Custom curve** — up to 20 spline points (natural cubic spline, same model as the original
  editor), input/output level ranges, halftone/gamma, input + output histogram overlays,
  live input:output readout, **undo/redo** (Ctrl+Z / Ctrl+Y).
  - *Select point*: click point or its number · *Move*: drag or arrow keys ·
    *Add*: Ctrl+click · *Remove*: Backspace (or clear its table cell)
- **Adjustments** — Sharpening (Auto), Contrast (Auto), Brightness, Saturation (Auto), Hue;
  Monochrome filter effects (Y/O/R/G) and toning; NP3-only **Clarity** and
  **Mid-range sharpening** in 0.25 steps. The preview approximates the Standard / Vivid /
  Portrait / Landscape base looks.
- **Presets** — 166 community picture controls from the nikonpc.com collection
  (`assets/js/presets.js`), plus **My presets** saved in the browser (localStorage) with
  JSON export/import. The **Preset Browser** (View bar) renders every preset applied to the
  current image as a clickable thumbnail grid.
- **Download** — `PICCONxx.NCP` for DSLRs/Nikon utilities, or `PICCONxx.NP3`
  (version 0300 for the first Z generation, 0310 for Z8/Z9-era bodies; also D6/D780).
  Copy to the card at `NIKON\CUSTOMPC\` and load via *Manage Picture Control*.
- **Load file** — parses any `.NCP` / `.NP3` back into the editor (NP3 LUT-only curves are
  reconstructed into editable points via Douglas-Peucker simplification).
- **Share custom settings** — encodes the full state into a URL hash.
- **PWA** — installable, offline-capable; when installed, opens `.NCP`/`.NP3`/image files.

## File formats (as implemented)

Community-documented layouts (sources:
[horshack-dpreview/NikonPictureControlsDev](https://github.com/horshack-dpreview/NikonPictureControlsDev),
[`dumpncp.pl`](https://github.com/simeonpilgrim/nikon-firmware-tools/blob/master/nfiles/dumpncp.pl),
cross-checked against Nikon-generated NP3 files and nikonpicturecontrol.com's open parser).

### NCP (version "0100")

```
"NCP\0"
record id=1 (u32be), size=36:
    version "0100", name (20 bytes NUL-padded), base profile (u16be),
    modified flag, 0xFF,
    sharpening, contrast, brightness, saturation, hue,   } value + 0x80
    mono filter, toning type, toning strength            } 0x00=auto, 0x01=curve, 0xFF=N/A
record id=2 (u32be), size=578 — present with a custom curve:
    'I', reserved char, input black/white, output min/max,
    gamma (int + fraction byte), point count, 57 bytes of x,y pairs,
    256 × u16be LUT (0..32767)
terminator: u32be 0
```

### NP3 (versions "0300" / "0310")

Same `NCP\0` container, but tagged records `[id u32be][size u32be][data]`:
`0x0100` version · `0x0200` name · `0x0300` base profile · `0x0600` sharpening ·
`0x0700` clarity · `0x0800` contrast · `0x0900` brightness · `0x0A00` saturation ·
`0x0B00` hue · `0x0C00/0x0D00/0x0E00` mono filter/toning/strength · `0x1600` mid-range
sharpening · (0310 only) `0x1700`–`0x2000` highlight/shadow/WB/color-blender blocks ·
record id=2 curve (LUT only, no stored points). Numeric values are stored in **quarter
steps** (`0x80 + value*4`, type byte `0x04`); `0x00`=auto, `0x01`=curve, `0xFF`=N/A.

Base profile enums: Standard 0x0001, Neutral 0x03C2, Vivid 0x00C3, Portrait 0x0486,
Landscape 0x04C7, Monochrome 0x064D, D2X Mode 1–3 0x0014/0x03D5/0x00D6.

## Layout

```
index.html              UI markup
assets/css/main.css     styles (look modeled on nikonpc.com)
assets/js/core.js       pure logic: spline/LUT, pixel pipeline, NCP+NP3 codecs, NEF preview
assets/js/worker.js     Web Worker wrapper around the pixel pipeline
assets/js/app.js        UI layer / state / interactions
assets/js/presets.js    community preset data
tests/core.test.js      Node unit tests (incl. real NCP/NP3 fixture files)
manifest.webmanifest, sw.js, assets/icons/   PWA
```

## Notes

- On-screen rendering approximates in-camera processing: the tone curve is exact; base looks,
  saturation/hue, sharpening, clarity and toning are perceptual approximations.
- NCP export is byte-validated against community-documented files. NP3 export follows the same
  structure as Nikon-generated files, but **test one NP3 on your camera** before a real shoot.
- The curve-points table shows raw point coordinates (0–255) before input/output level scaling.

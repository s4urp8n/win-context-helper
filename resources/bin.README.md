# resources/bin — external tool binaries

This folder is gitignored. Download each tool once and place its Windows binary here. `electron-builder` bundles the entire folder into `dist/win-unpacked/resources/bin/` at package time.

## Required binaries (currently bundled)

| File | Version | Source |
|---|---|---|
| `7z.exe` | 7-Zip **26.01** (standalone reduced "7zr.exe" renamed; supports `.7z` creation, no companion DLL) | https://www.7-zip.org/a/7zr.exe |
| `magick.exe` | ImageMagick **7.1.2-23** portable Q16 x64 (extracted from `.7z` archive) | https://imagemagick.org/archive/binaries/ImageMagick-7.1.2-23-portable-Q16-x64.7z |
| `gswin64c.exe` + `gsdll64.dll` | Ghostscript **10.07.1** (gswin64c.exe + its required companion gsdll64.dll, both extracted from the official Win64 installer with `7z x`) | https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10071/gs10071w64.exe |
| `ffmpeg.exe` + `ffprobe.exe` | ffmpeg **8.1.1** essentials build (from gyan.dev release-essentials zip) | https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip |

## Layout expected

```
resources/bin/
├── 7z.exe          (~600 KB; standalone "reduced" 7zr build — supports .7z create)
├── magick.exe      (~28 MB; ImageMagick portable static)
├── gswin64c.exe    (~95 KB; Ghostscript console)
├── gsdll64.dll     (~24 MB; required by gswin64c.exe at runtime)
├── ffmpeg.exe      (~97 MB; ffmpeg release essentials build)
└── ffprobe.exe     (~97 MB)
```

## Size note

The combined folder is ~246 MB. The portable `dist/win-unpacked/` distribution will grow accordingly.

## How to refresh binaries

Each tool's download URL is listed above. For tools shipped as installers (Ghostscript) or compressed archives (ImageMagick `.7z`, ffmpeg `.zip`), extract with `7z x` and copy the listed file(s) here.

## License note

- 7-Zip: LGPL + unRAR restriction (don't redistribute the unRAR code if you customise builds).
- ImageMagick: Apache-style — see project license.
- Ghostscript: AGPL v3 (free for personal use; commercial use requires a license from Artifex).
- ffmpeg: LGPL by default; GPL components if certain flags enabled.

Bundling these for personal use is fine. Redistribution publicly without compliance to each license is your responsibility.

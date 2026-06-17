#!/bin/sh
# Fix for: GLib-GObject-CRITICAL "value 32 ... invalid ... for property 'space'
# of type 'VipsInterpretation'" / "Sharp processing failed: colourspace:
# parameter space not set" in RoboFrame after a Homebrew libvips upgrade.
#
# Cause: sharp's native binding is built from source against Homebrew libvips
# (that's what gives it JXL/HEIF support). libvips 8.18 added OKLAB/OKLCH,
# moving the VIPS_INTERPRETATION_LAST sentinel from 30 to 32. A binding
# compiled against 8.17 headers compares the runtime value 32 against its
# baked-in 30, mistakes "no colourspace conversion" for a request to convert
# to (nonexistent) colourspace 32, and every sharp operation fails.
#
# Fix: rebuild the binding against the currently installed libvips headers.
# Re-run this any time a `brew upgrade vips` breaks sharp the same way.
#
# Usage: ./scripts/fix-sharp-libvips.sh [path-to-RoboFrame-repo]

set -e
REPO="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
cd "$REPO"

echo "libvips via pkg-config: $(pkg-config --modversion vips-cpp)"

# Build deps for sharp's from-source path. --no-save keeps them out of
# package.json/package-lock.json; the node-gyp spec must match the
# `overrides` pin in the root package.json or npm fails with EOVERRIDE.
npm install --no-save node-addon-api "node-gyp@^11.5.0"
npm rebuild sharp --foreground-scripts

# Verify: load sharp, confirm JXL support, and run the same
# resize -> flatten -> linear -> jpeg pipeline that index.js uses.
node -e "
const sharp = require('$REPO/node_modules/sharp');
console.log('sharp', sharp.versions.sharp, '/ libvips', sharp.versions.vips,
  '/ jxl input:', sharp.format.jxl.input.buffer);
sharp({ create: { width: 64, height: 64, channels: 3,
                  background: { r: 8, g: 8, b: 8 } } })
  .png().toBuffer()
  .then(png => sharp(png)
    .resize(32, 32, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#000000' })
    .linear(0.32, 0)
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer())
  .then(() => console.log('sharp pipeline OK — fix verified'))
  .catch(e => { console.error('still broken:', e.message); process.exit(1); });
"

#!/usr/bin/env bash
# Builds the kiosk for the Pi (Linux, arm64) in Docker and leaves the stripped
# binary at swift-kiosk/dist/roboframe-kiosk.
#
# The package reaches RoboFrameKit (../RoboFrameKit) and RAVESDK
# (../../RAVESDK) by path, and RAVESDK reaches DebugTrace and vergence beside
# it, so RoboFrameKit and those checkouts are copied into a
# directory under $HOME first: Colima and Docker Desktop share the home
# directory, not /tmp, where worktrees live. Builds stay in that directory
# between runs, so a rebuild is incremental.
#
#   scripts/build-linux.sh            release build
#   KIOSK_BUILD_CACHE=dir ...         somewhere else for the copies and builds
set -euo pipefail

kiosk=$(cd "$(dirname "$0")/.." && pwd)
projects=$(cd "$kiosk/../.." && pwd)
image=roboframe-kiosk-build
case "$(uname -s)" in
    Darwin) cache_root="$HOME/Library/Caches" ;;
    *) cache_root="${XDG_CACHE_HOME:-$HOME/.cache}" ;;
esac
cache="${KIOSK_BUILD_CACHE:-$cache_root/roboframe-kiosk-build}"

if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker build --platform linux/arm64 -t "$image" -f "$kiosk/docker/build.Dockerfile" "$kiosk/docker"
fi

mkdir -p "$cache/src/RoboFrame" "$cache/build"
sync() {
    [ -d "$1" ] || { echo "build-linux: $1 not found (expected beside RoboFrame)" >&2; exit 1; }
    rsync -a --delete --exclude .git --exclude .build --exclude build --exclude dist \
        --exclude DerivedData --exclude node_modules "$1/" "$2/"
}
for package in RAVESDK DebugTrace vergence; do
    sync "$projects/$package" "$cache/src/$package"
done
sync "$kiosk" "$cache/src/RoboFrame/swift-kiosk"
sync "$kiosk/../RoboFrameKit" "$cache/src/RoboFrame/RoboFrameKit"

# --static-swift-stdlib links the Swift runtime and Foundation in; SDL2,
# libmpv, GLES and libcurl stay dynamic and come from the Pi's Debian.
docker run --rm --platform linux/arm64 \
    -v "$cache/src:/w" -v "$cache/build:/w/RoboFrame/swift-kiosk/.build" \
    -w /w/RoboFrame/swift-kiosk "$image" \
    bash -c 'swift build -c release --static-swift-stdlib \
        && strip -o .build/roboframe-kiosk.stripped .build/release/roboframe-kiosk'

mkdir -p "$kiosk/dist"
cp "$cache/build/roboframe-kiosk.stripped" "$kiosk/dist/roboframe-kiosk"
echo "build-linux: $kiosk/dist/roboframe-kiosk ($(du -h "$kiosk/dist/roboframe-kiosk" | cut -f1))"

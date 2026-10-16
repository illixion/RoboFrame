#!/usr/bin/env bash
# Installs the kiosk on a Pi: dist/roboframe-kiosk (from build-linux.sh) and
# pi/run-kiosk go to /opt/swift-kiosk, which is on the SD card's real
# filesystem even under overlayroot. Each file lands beside its old copy and
# is renamed over it, so a running kiosk keeps its binary until it restarts.
#
#   scripts/deploy-pi.sh root@kiosk-pi3            install; takes effect next session
#   scripts/deploy-pi.sh root@kiosk-pi3 --restart  and restart the session onto it
#
# The one-time setup per Pi (libmpv2, start-kiosk exec'ing run-kiosk) is in
# the README, under "On the Pi".
set -euo pipefail

host=${1:?usage: deploy-pi.sh user@host [--restart]}
restart=${2:-}
kiosk=$(cd "$(dirname "$0")/.." && pwd)
binary=$kiosk/dist/roboframe-kiosk
[ -f "$binary" ] || { echo "deploy-pi: no $binary; run scripts/build-linux.sh first" >&2; exit 1; }

# One connection for every step, so the SSH agent asks once.
# KIOSK_SSH_CONTROL reuses a master connection that's already open.
if [ -n "${KIOSK_SSH_CONTROL:-}" ]; then
    ssh_opts=(-o "ControlPath=$KIOSK_SSH_CONTROL")
else
    control=$(mktemp -u "${TMPDIR:-/tmp}/deploy-pi.XXXXXX")
    ssh_opts=(-o ControlMaster=auto -o "ControlPath=$control" -o ControlPersist=60)
    trap 'ssh "${ssh_opts[@]}" -O exit "$host" 2>/dev/null || true' EXIT
fi

ssh "${ssh_opts[@]}" "$host" 'mkdir -p /opt/swift-kiosk'
scp -q "${ssh_opts[@]}" "$binary" "$host:/opt/swift-kiosk/roboframe-kiosk.new"
scp -q "${ssh_opts[@]}" "$kiosk/pi/run-kiosk" "$host:/opt/swift-kiosk/run-kiosk.new"
ssh "${ssh_opts[@]}" "$host" 'set -e
    cd /opt/swift-kiosk
    chmod 755 roboframe-kiosk.new run-kiosk.new
    # ldd fails outright on a binary this machine cannot run (the wrong
    # architecture), which would otherwise pass as "nothing missing".
    if ! libraries=$(ldd roboframe-kiosk.new 2>&1); then
        rm -f roboframe-kiosk.new run-kiosk.new
        echo "deploy-pi: the Pi cannot run this binary: $libraries" >&2
        exit 1
    fi
    missing=$(echo "$libraries" | grep "not found" || true)
    if [ -n "$missing" ]; then
        rm -f roboframe-kiosk.new run-kiosk.new
        echo "deploy-pi: the Pi is missing libraries the kiosk links:" >&2
        echo "$missing" >&2
        exit 1
    fi
    mv roboframe-kiosk.new roboframe-kiosk
    mv run-kiosk.new run-kiosk
    # The settings menu saves here, as the session user (kiosk).
    if id kiosk >/dev/null 2>&1; then install -d -o kiosk -g kiosk -m 755 state; else mkdir -p state; fi
    echo "deploy-pi: installed $(du -h roboframe-kiosk | cut -f1) in /opt/swift-kiosk"
    grep -q /opt/swift-kiosk/run-kiosk /usr/local/bin/start-kiosk \
        || echo "deploy-pi: start-kiosk does not launch run-kiosk yet, so native-kiosk stays the frontend (see the README)"
    [ -e disabled ] && echo "deploy-pi: /opt/swift-kiosk/disabled is set, so native-kiosk stays the frontend" || true'

if [ "$restart" = --restart ]; then
    # SIGTERM to the frontend ends the X session; getty starts a new one.
    ssh "${ssh_opts[@]}" "$host" 'pid=$(pgrep -o -f "^/opt/swift-kiosk/roboframe-kiosk|^/usr/bin/python3 /opt/RoboFrame/native-kiosk/kiosk.py") \
        && kill "$pid" && echo "deploy-pi: restarting the kiosk session" \
        || echo "deploy-pi: no kiosk running to restart"'
fi

#!/usr/bin/env bash
# Installs the watchdog's host side from this folder:
#   ~/.local/lib/paperclip-watchdog/watchdog.mjs  -> symlink to watchdog.mjs here
#   ~/.local/bin/paperclip-notify, paperclip-wait -> symlinks to the scripts here
#   ~/.config/systemd/user/paperclip-watchdog.{service,timer} (copied), timer not enabled:
#   paperclip-start starts it and paperclip-stop stops it, so it never runs at boot.
# The symlinks make this folder the live copy: a `git pull` updates the watchdog.
# Run it again after changing the unit files. For the timer to keep running without an
# open WSL session, lingering must be on: sudo loginctl enable-linger "$USER"
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/.local/lib/paperclip-watchdog" "$HOME/.local/bin" "$HOME/.config/systemd/user"
mkdir -p -m 700 "$HOME/.paperclip-dev/watchdog"

ln -sfn "$HERE/watchdog.mjs" "$HOME/.local/lib/paperclip-watchdog/watchdog.mjs"
for cmd in paperclip-notify paperclip-wait; do
  chmod +x "$HERE/$cmd"
  ln -sfn "$HERE/$cmd" "$HOME/.local/bin/$cmd"
done
cp "$HERE/paperclip-watchdog.service" "$HERE/paperclip-watchdog.timer" "$HOME/.config/systemd/user/"

systemctl --user daemon-reload
systemctl --user disable paperclip-watchdog.timer 2>/dev/null || true
echo "Watchdog installed. It runs while Paperclip does: paperclip-start starts the timer, paperclip-stop stops it."
loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes' \
  || echo "Lingering is off, so the timer stops when you close WSL. Turn it on with: sudo loginctl enable-linger $USER"

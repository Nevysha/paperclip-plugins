#!/usr/bin/env bash
# Installs the watchdog's host side from this folder:
#   ~/.local/lib/paperclip-watchdog/watchdog.mjs  -> symlink to watchdog.mjs here
#   ~/.local/bin/paperclip-notify, paperclip-wait -> symlinks to the scripts here
#   ~/.config/systemd/user/paperclip-watchdog.{service,timer} (copied), timer enabled
# The symlinks make this folder the live copy: a `git pull` updates the watchdog.
# Run it again after changing the unit files. For the timer to run without an open
# WSL session, lingering must be on: sudo loginctl enable-linger "$USER"
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
systemctl --user enable --now paperclip-watchdog.timer
echo "Watchdog installed. Check it with: systemctl --user list-timers paperclip-watchdog.timer"
loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes' \
  || echo "Lingering is off, so the timer stops when you close WSL. Turn it on with: sudo loginctl enable-linger $USER"

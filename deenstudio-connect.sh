#!/usr/bin/env bash
# Deenstudio USB bridge for macOS / Linux.
# Keeps an ADB tunnel open so OBS can reach the phone at tcp://127.0.0.1:PORT.
PORT="${1:-8000}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found. Install Android platform-tools and add it to your PATH."
  exit 1
fi

echo "Deenstudio USB bridge. Waiting for your phone (USB debugging must be on)..."
while true; do
  adb wait-for-device
  if adb forward "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1; then
    echo "[ok] Tunnel is up: tcp://127.0.0.1:$PORT"
  else
    echo "[!] Could not create the tunnel. Is the phone authorised? Run: adb devices"
  fi
  while adb get-state 2>/dev/null | grep -q device; do sleep 2; done
  echo "[..] Phone unplugged. Waiting for it to come back..."
done

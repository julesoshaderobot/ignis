#!/bin/bash
# Railway entrypoint: no useradd/gosu (Railway runs as project-defined user).
# A single Bind Volume at /data (or any path) holds all mutable state.
#
# Expected env (Railway Variables):
#   VAULT_ROOT=/data/vaults
#   DATA_ROOT=/data/data
#   OBSIDIAN_ASSETS_PATH=/data/obsidian-app
#   OBSIDIAN_VERSION=1.12.7   (optional; default 1.12.7)
# Railway injects PORT automatically - server/config.js reads it.
set -e

OBSIDIAN_VERSION="${OBSIDIAN_VERSION:-1.12.7}"
OBSIDIAN_DIR="${OBSIDIAN_ASSETS_PATH:-/app/obsidian-app}"
VAULT_ROOT="${VAULT_ROOT:-/vaults}"
DATA_ROOT="${DATA_ROOT:-/app/data}"

mkdir -p "$OBSIDIAN_DIR" "$VAULT_ROOT" "$DATA_ROOT"

if [ ! -f "$OBSIDIAN_DIR/index.html" ]; then
  echo "[railway] Downloading Obsidian v${OBSIDIAN_VERSION}..."
  curl -fSL --retry 3 \
    "https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/obsidian-${OBSIDIAN_VERSION}.asar.gz" \
    -o /tmp/obsidian.asar.gz
  gunzip -f /tmp/obsidian.asar.gz
  npx --yes @electron/asar extract /tmp/obsidian.asar "$OBSIDIAN_DIR"
  rm -f /tmp/obsidian.asar
  echo "[railway] Obsidian ready."
else
  echo "[railway] Obsidian already present at $OBSIDIAN_DIR."
fi

# Headless sync CLI (optional, same as image entrypoint but swallowed on failure).
if ! command -v ob >/dev/null 2>&1; then
  if npm install -g obsidian-headless --silent 2>/dev/null; then
    echo "[railway] obsidian-headless $(ob --version 2>/dev/null) installed."
  else
    echo "[railway] WARNING: obsidian-headless install failed; headless sync unavailable."
  fi
fi

exec node apps/ignis-server/server/index.js

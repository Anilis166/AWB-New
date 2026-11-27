#!/usr/bin/env bash
# Upload file AWB ke GitHub (Anilis166/AWB-New)
# Jalankan di PC lokal kamu (Git Bash / WSL / macOS / Linux)
#
# Cara pakai:
#   bash upload-awb.sh "/c/Users/NamaKamu/Downloads/file-awb.pdf"
#
# File di bawah 100MB -> push biasa (tanpa LFS)
# File 100MB ke atas -> otomatis pakai Git LFS

set -euo pipefail

REPO="Anilis166/AWB-New"
SRC="${1:-}"

if [ -z "$SRC" ]; then
  echo "Pakai: bash upload-awb.sh <path-file-awb>"
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "File tidak ditemukan: $SRC"
  exit 1
fi

SIZE=$(stat -c%s "$SRC" 2>/dev/null || stat -f%z "$SRC")
MB=$(( SIZE / 1024 / 1024 ))
# jadikan path absolut supaya tetap valid setelah pindah direktori
SRC="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
echo "File: $SRC  (~${MB} MB)"

read -rp "GitHub username: " GHUSER
read -rsp "Personal Access Token (input tersembunyi): " GHTOKEN
echo
if [ -z "$GHTOKEN" ]; then echo "Token kosong, batal."; exit 1; fi

URL="https://${GHUSER}:${GHTOKEN}@github.com/${REPO}.git"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo ">> Clone repo..."
git clone --quiet "$URL" "$WORKDIR/repo"
cd "$WORKDIR/repo"

BASENAME="$(basename "$SRC")"

if [ "$SIZE" -ge 104857600 ]; then
  echo ">> File >= 100MB, pakai Git LFS"
  git lfs install --local
  EXT=".${BASENAME##*.}"
  git lfs track "*${EXT}"
  git add .gitattributes
fi

cp "$SRC" "./$BASENAME"
git add "./$BASENAME"
git commit -m "Tambah file AWB: ${BASENAME}"

echo ">> Push ke GitHub..."
git push origin HEAD:main

echo
echo ">> Selesai. Cek: https://github.com/${REPO}"

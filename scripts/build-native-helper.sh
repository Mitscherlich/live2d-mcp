#!/bin/sh
# 构建 macOS 进程输出电平 helper（ADR 0001 · F6）
# 产物：native/bin/darwin/live2d-audio-listener（arm64 + x86_64 universal，若 SDK 允许）
# 用法：scripts/build-native-helper.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos/Live2dAudioListener.mm"
OUT_DIR="$ROOT/native/bin/darwin"
OUT="$OUT_DIR/live2d-audio-listener"

mkdir -p "$OUT_DIR"

ARCHS="-arch arm64"
if clang++ -arch x86_64 -x c++ -E /dev/null -o /dev/null >/dev/null 2>&1; then
  ARCHS="-arch arm64 -arch x86_64"
fi

clang++ -std=c++17 -fobjc-arc -O2 -mmacosx-version-min=14.2 \
  $ARCHS \
  -framework Foundation -framework CoreAudio -framework CoreGraphics \
  "$SRC" -o "$OUT"

echo "built: $OUT ($ARCHS)"
"$OUT" --self-test

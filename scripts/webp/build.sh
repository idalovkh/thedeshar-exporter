#!/usr/bin/env bash
set -euo pipefail

# Run with Emscripten 5.0.5 active (source emsdk_env.sh). Arguments are an
# existing output directory and an optional cache of the source archive.
here=$(cd -- "$(dirname -- "$0")" && pwd)
output=$(cd -- "${1:-$here/../../src/vendor/webp}" && pwd)
cache=
if [[ -n "${2:-}" ]]; then cache=$(cd -- "$2" && pwd); fi
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
compiler_version=$(emcc --version)
if [[ "$compiler_version" != *' 5.0.5 '* ]]; then
  printf 'Emscripten 5.0.5 is required.\n' >&2
  exit 1
fi

source_archive() {
  local name=$1 url=$2 digest=$3
  if [[ -n "$cache" ]]; then
    cp -- "$cache/$name" "$name"
  else
    curl --proto '=https' --tlsv1.2 -fsSL --retry 2 "$url" -o "$name"
  fi
  printf '%s  %s\n' "$digest" "$name" | shasum -a 256 -c
  tar -xzf "$name"
}

source_archive libwebp-1.6.0.tar.gz \
  https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz \
  e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564
webp=libwebp-1.6.0

# The encoder needs only generic DSP sources on wasm32.
export LC_ALL=C SOURCE_DATE_EPOCH=0
emcc -std=c99 -O3 -flto -DNDEBUG \
  -I"$webp" -I"$webp/src" \
  "$here/codec.c" \
  "$webp"/src/{enc,dec,utils}/*.c \
  "$webp"/src/dsp/{alpha_processing,cost,cpu,dec,dec_clip_tables,enc,filters,lossless,lossless_enc,rescaler,ssim,upsampling,yuv}.c \
  "$webp"/sharpyuv/{sharpyuv,sharpyuv_cpu,sharpyuv_csp,sharpyuv_dsp,sharpyuv_gamma}.c \
  --no-entry -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 -sENVIRONMENT=web,worker \
  -sEXPORT_ES6=1 -sMODULARIZE=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 \
  -sMAXIMUM_MEMORY=402653184 \
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_encode_verified_rgba","_encoded_webp_result","_release_encoded_webp"]' \
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]' \
  -o codec.mjs

cp codec.mjs codec.wasm "$output"
chmod 644 "$output/codec.mjs" "$output/codec.wasm"
cp "$webp/COPYING" "$output/LICENSE-libwebp.txt"
cp "$webp/PATENTS" "$output/PATENTS-libwebp.txt"
emscripten=$(cd -- "$(dirname -- "$(command -v emcc)")" && pwd)
cp "$emscripten/LICENSE" "$output/LICENSE-emscripten.txt"
cp "$emscripten/system/lib/libc/musl/COPYRIGHT" "$output/LICENSE-musl.txt"
cp "$emscripten/system/lib/compiler-rt/LICENSE.TXT" "$output/LICENSE-compiler-rt.txt"
(cd "$output" && shasum -a 256 codec.mjs codec.wasm > SHA256SUMS)

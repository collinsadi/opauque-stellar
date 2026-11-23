#!/usr/bin/env bash
set -euo pipefail

version="${WASM_PACK_VERSION:-0.14.0}"
bindgen_version="${WASM_BINDGEN_VERSION:-0.2.108}"
install_dir="${WASM_PACK_INSTALL_DIR:-/usr/local/bin}"

if [[ -n "${WASM_PACK_TARGET:-}" ]]; then
  target="$WASM_PACK_TARGET"
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) target="x86_64-unknown-linux-musl" ;;
    Linux-aarch64|Linux-arm64) target="aarch64-unknown-linux-musl" ;;
    Darwin-x86_64) target="x86_64-apple-darwin" ;;
    Darwin-arm64) target="aarch64-apple-darwin" ;;
    *)
      echo "Unsupported wasm-pack install target: $(uname -s)-$(uname -m)" >&2
      exit 1
      ;;
  esac
fi

archive="wasm-pack-v${version}-${target}.tar.gz"
url="https://github.com/wasm-bindgen/wasm-pack/releases/download/v${version}/${archive}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$install_dir"
curl -fsSL "$url" -o "$tmp_dir/$archive"
tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
install -m 0755 "$tmp_dir/wasm-pack-v${version}-${target}/wasm-pack" "$install_dir/wasm-pack"
"$install_dir/wasm-pack" --version

bindgen_archive="wasm-bindgen-${bindgen_version}-${target}.tar.gz"
bindgen_url="https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${bindgen_version}/${bindgen_archive}"
curl -fsSL "$bindgen_url" -o "$tmp_dir/$bindgen_archive"
tar -xzf "$tmp_dir/$bindgen_archive" -C "$tmp_dir"
install -m 0755 "$tmp_dir/wasm-bindgen-${bindgen_version}-${target}/wasm-bindgen" "$install_dir/wasm-bindgen"
"$install_dir/wasm-bindgen" --version

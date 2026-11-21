#!/usr/bin/env bash
# Build the Go, Rust, Python and Java shims for the qledger-v1 differential fuzzer
# against one checkout of qorechain-rdk. The TypeScript side uses the @qorechain/rdk
# version pinned in scripts/package.json.
#
#   scripts/fuzz/setup.sh                     # clones qorechain-rdk into scripts/fuzz/build
#   RDK_REPO=/path/to/qorechain-rdk scripts/fuzz/setup.sh
#
# Needs: git, go, cargo, uv (Python 3.13 by default, which uv can fetch), javac/java 17+, curl, shasum.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
build="$here/build"
RDK_COMMIT="${RDK_COMMIT:-2c72e47}"
RDK_REPO="${RDK_REPO:-$build/qorechain-rdk}"
mkdir -p "$build"

if [ ! -d "$RDK_REPO/.git" ]; then
  git clone -q https://github.com/qorechain/qorechain-rdk.git "$RDK_REPO"
fi
git -C "$RDK_REPO" -c advice.detachedHead=false checkout -q "$RDK_COMMIT"
P="$RDK_REPO/packages"
echo "qorechain-rdk at $(git -C "$RDK_REPO" rev-parse --short HEAD)"

# Go
mkdir -p "$build/go"
cp "$here/shims/go/main.go" "$build/go/main.go"
cat > "$build/go/go.mod" <<EOF
module vigil/fuzz/goshim

go 1.22

require github.com/qorechain/qorechain-rdk/packages/go v0.0.0

replace github.com/qorechain/qorechain-rdk/packages/go => $P/go
EOF
(cd "$build/go" && GOFLAGS=-mod=mod go mod tidy >/dev/null && go build -o goshim .)
echo "go shim:     $build/go/goshim"

# Rust (the crate's built-in ML-DSA-44 verifier)
mkdir -p "$build/rust/src"
cp "$here/shims/rust/src/main.rs" "$build/rust/src/main.rs"
sed "s#@RDK_RUST@#$P/rust#" "$here/shims/rust/Cargo.toml.in" > "$build/rust/Cargo.toml"
cargo build -q --release --manifest-path "$build/rust/Cargo.toml"
echo "rust shim:   $build/rust/target/release/rust-shim"

# Python (qorechain-rdk needs Python >= 3.10; FUZZ_PYTHON picks another version)
rm -rf "$build/py"
uv venv -q --python "${FUZZ_PYTHON:-3.13}" "$build/py"
uv pip install -q --python "$build/py/bin/python" -e "$P/py"
echo "python shim: $build/py/bin/python $here/shims/py/shim.py"

# Java: compile the shim with the RDK sources and its two runtime jars, pinned by SHA-1
# (the values Maven Central publishes for these releases, checked on 21 Nov 2026).
mkdir -p "$build/java/lib"
fetch() { # group/path artifact version sha1
  local url="https://repo1.maven.org/maven2/$1/$2/$3/$2-$3.jar" jar="$build/java/lib/$2-$3.jar"
  if [ ! -f "$jar" ]; then
    curl -fsSL --retry 5 --retry-all-errors -o "$jar.part" "$url" && mv "$jar.part" "$jar"
  fi
  [ "$(shasum -a 1 "$jar" | cut -c1-40)" = "$4" ] || { echo "checksum mismatch for $jar (removed; run setup.sh again)" >&2; rm -f "$jar"; exit 1; }
}
fetch org/bouncycastle bcprov-jdk18on 1.85 2320b854dffe134687f7266bb22021b779e576d3
fetch io/github/qorechain qorechain-pqc 0.2.3 2c004f5b5d03940cb300275d3463107efc31de0e
CP="$build/java/lib/bcprov-jdk18on-1.85.jar:$build/java/lib/qorechain-pqc-0.2.3.jar"
rm -rf "$build/java/classes" && mkdir -p "$build/java/classes"
javac -nowarn -d "$build/java/classes" -cp "$CP" -sourcepath "$P/jvm/src/main/java" "$here/shims/java/Shim.java" 2>&1 | grep -v '^Note:' || true
printf '#!/bin/sh\nexec java -cp "%s:%s" Shim\n' "$build/java/classes" "$CP" > "$build/java/run.sh"
chmod +x "$build/java/run.sh"
echo "java shim:   $build/java/run.sh"

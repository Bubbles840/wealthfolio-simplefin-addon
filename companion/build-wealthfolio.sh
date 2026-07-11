#!/usr/bin/env bash
# Builds a patched Wealthfolio Docker image with Basic auth support for addon
# network requests (required for SimpleFin Sync).
#
# Usage: bash companion/build-wealthfolio.sh [IMAGE_TAG]
#   IMAGE_TAG defaults to "wealthfolio-patched"
#
# After running, update your compose.yml:
#   image: wealthfolio-patched   (or whatever IMAGE_TAG you chose)

set -euo pipefail

IMAGE_TAG="${1:-wealthfolio-patched}"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Cloning Wealthfolio source..."
git clone --depth=1 https://github.com/afadil/wealthfolio.git "$WORK_DIR/wealthfolio"

NETWORK_RS="$WORK_DIR/wealthfolio/crates/core/src/addons/network.rs"

echo "==> Applying Basic auth patch to network.rs..."

# Replace the bearer-only check + format with a bearer/basic match
python3 - "$NETWORK_RS" << 'PYEOF'
import sys

path = sys.argv[1]
src = open(path).read()

old = '''\
    if auth.auth_type != "bearer" {
        return Err("Addon network auth type is not supported".to_string());
    }'''

new = '''\
    let auth_type = auth.auth_type.as_str();
    if auth_type != "bearer" && auth_type != "basic" {
        return Err("Addon network auth type is not supported".to_string());
    }'''

if old not in src:
    print("ERROR: Could not find the bearer check to patch. Wealthfolio source may have changed.")
    sys.exit(1)

src = src.replace(old, new)

old2 = '    Ok(Some(format!("Bearer {}", secret)))'
new2 = '''\
    let scheme = if auth_type == "basic" { "Basic" } else { "Bearer" };
    Ok(Some(format!("{} {}", scheme, secret)))'''

if old2 not in src:
    print("ERROR: Could not find the Bearer format line to patch.")
    sys.exit(1)

src = src.replace(old2, new2)
open(path, 'w').write(src)
print("Patch applied successfully.")
PYEOF

echo "==> Building Docker image '$IMAGE_TAG' (this takes ~10 minutes first time)..."
# --network=host lets the build container use the host's DNS — avoids transient
# Alpine mirror failures inside Docker's default bridge network (Linux only).
NETWORK_FLAG=""
if [[ "$(uname)" == "Linux" ]]; then
  NETWORK_FLAG="--network=host"
fi
docker build $NETWORK_FLAG -t "$IMAGE_TAG" "$WORK_DIR/wealthfolio"

echo ""
echo "==> Done! Update your compose.yml:"
echo "      image: $IMAGE_TAG"
echo ""
echo "    Then restart:"
echo "      docker compose up -d"

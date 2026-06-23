#!/usr/bin/env bash
#
# Sync website/src to the Scaleway Object Storage bucket www.ename.ngo.
#
# Usage:
#   ./website/scripts/deploy.sh            # deploy
#   ./website/scripts/deploy.sh --dryrun   # simulate without writing anything
#
set -euo pipefail

PROFILE="ename"
BUCKET="www.ename.ngo"
ENDPOINT="https://s3.fr-par.scw.cloud"

# Source dir = website/src, relative to this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../src"

aws s3 sync "$SRC_DIR" "s3://$BUCKET" \
  --profile "$PROFILE" \
  --endpoint-url "$ENDPOINT" \
  --delete \
  --exclude "*.DS_Store" \
  "$@"

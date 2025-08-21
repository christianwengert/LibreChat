#!/usr/bin/env bash
set -euo pipefail
usage(){ echo "Usage: $0 [-p profiles] -f FILE [-f FILE] ..."; exit 1; }

PROFILES=""; FILES=()
while getopts ":p:f:" opt; do
  case $opt in
    p) PROFILES="$OPTARG";;
    f) FILES+=("-f" "$OPTARG");;
    *) usage;;
  esac
done
[ ${#FILES[@]} -gt 0 ] || usage

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
if [ -n "$PROFILES" ]; then
  docker compose "${FILES[@]}" --profile "$PROFILES" config --images | sort -u > "$TMP"
else
  docker compose "${FILES[@]}" config --images | sort -u > "$TMP"
fi

mkdir -p exported
while read -r img; do
  out="exported/$(echo "$img" | tr '/:@' '__').tar"
  echo "==> $img  ->  $out"
  skopeo copy --override-os linux --override-arch amd64 "docker://$img" "docker-archive:$out:$img"
done < "$TMP"

echo "Done. Tars in ./exported"

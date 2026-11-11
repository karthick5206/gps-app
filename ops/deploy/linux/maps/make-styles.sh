#!/usr/bin/env bash
# Rewrites the OpenFreeMap styles (liberty / positron / dark, OpenMapTiles schema, BSD + CC-BY) to load everything from
# this server: vector tiles (Martin, India), fonts and sprites under https://<site>/tiles. Removes the Natural Earth
# shaded-relief raster (an OpenFreeMap-hosted layer at low zoom). Run as root: SITE=app.veetrax.com bash make-styles.sh
# Input: /opt/veetrax/maps/tiles/src/{liberty,positron,dark}.json   Output: /opt/veetrax/maps/tiles/styles/*.json
set -euo pipefail
SITE="${SITE:-app.veetrax.com}"
T=/opt/veetrax/maps/tiles
BASE="https://${SITE}/tiles"
# India extract bounds (Geofabrik india-latest incl. Andaman & Nicobar, Lakshadweep)
BOUNDS="${BOUNDS:-[67.67,5.89,97.42,35.74]}"

for s in liberty positron dark; do
  jq --arg base "$BASE" --argjson bounds "$BOUNDS" '
    .sources |= (del(.ne2_shaded) | .openmaptiles = {
      type: "vector",
      tiles: [($base + "/india/{z}/{x}/{y}")],
      minzoom: 0, maxzoom: 14, bounds: $bounds,
      attribution: "<a href=\"https://openmaptiles.org/\" target=\"_blank\">© OpenMapTiles</a> <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\">© OpenStreetMap contributors</a>"
    })
    | .layers |= map(select(.source != "ne2_shaded"))
    | .glyphs = ($base + "/fonts/{fontstack}/{range}.pbf")
    | .sprite = ($base + "/sprites/ofm")
  ' "$T/src/$s.json" > "$T/styles/$s.json"
  # Nothing may point outside the server
  if grep -q 'openfreemap' "$T/styles/$s.json"; then echo "ERROR: $s still references openfreemap" >&2; exit 1; fi
  echo "$s: $(jq '.layers | length' "$T/styles/$s.json") layers"
done
chown -R veetrax:veetrax "$T/styles"

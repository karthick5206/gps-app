#!/usr/bin/env bash
# Rewrites the OpenFreeMap styles (liberty / positron / dark, OpenMapTiles schema, BSD + CC-BY) to load everything from
# this server: vector tiles (Martin), fonts and sprites under https://<site>/tiles. Removes the Natural Earth
# shaded-relief raster (an OpenFreeMap-hosted layer at low zoom). Run as root: SITE=app.veetrax.com bash make-styles.sh
# Input: /opt/veetrax/maps/tiles/src/{liberty,positron,dark}.json   Output: /opt/veetrax/maps/tiles/styles/*.json
#
# TILE_SOURCES: Martin source(s) of the vector tiles, default "india,us" (Martin's composite source: one tile URL
# /tiles/india,us/{z}/{x}/{y} merging india.pmtiles and us.pmtiles). Use TILE_SOURCES=india until us.pmtiles is
# served (a composite with a missing source fails). With one source the style carries its bounds (BOUNDS, India by
# default); with several, no bounds (tiles are requested everywhere, Martin answers 204 where it has none).
set -euo pipefail
SITE="${SITE:-app.veetrax.com}"
T=/opt/veetrax/maps/tiles
BASE="https://${SITE}/tiles"
TILE_SOURCES="${TILE_SOURCES:-india,us}"
if [[ ! "$TILE_SOURCES" =~ ^[a-z0-9_-]+(,[a-z0-9_-]+)*$ ]]; then echo "ERROR: TILE_SOURCES must be source ids separated by commas (e.g. india,us)" >&2; exit 1; fi
if [[ "$TILE_SOURCES" == *,* ]]; then
  BOUNDS="${BOUNDS:-null}"
elif [[ "$TILE_SOURCES" == india ]]; then
  # India extract bounds (Geofabrik india-latest incl. Andaman & Nicobar, Lakshadweep)
  BOUNDS="${BOUNDS:-[67.67,5.89,97.42,35.74]}"
else
  BOUNDS="${BOUNDS:-null}"
fi

for s in liberty positron dark; do
  jq --arg base "$BASE" --arg src "$TILE_SOURCES" --argjson bounds "$BOUNDS" '
    .sources |= (del(.ne2_shaded) | .openmaptiles = ({
      type: "vector",
      tiles: [($base + "/" + $src + "/{z}/{x}/{y}")],
      minzoom: 0, maxzoom: 14,
      attribution: "<a href=\"https://openmaptiles.org/\" target=\"_blank\">© OpenMapTiles</a> <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\">© OpenStreetMap contributors</a>"
    } + (if $bounds == null then {} else { bounds: $bounds } end)))
    | .layers |= map(select(.source != "ne2_shaded"))
    | .glyphs = ($base + "/fonts/{fontstack}/{range}.pbf")
    | .sprite = ($base + "/sprites/ofm")
  ' "$T/src/$s.json" > "$T/styles/$s.json"
  # Nothing may point outside the server
  if grep -q 'openfreemap' "$T/styles/$s.json"; then echo "ERROR: $s still references openfreemap" >&2; exit 1; fi
  echo "$s: $(jq '.layers | length' "$T/styles/$s.json") layers, tiles $BASE/$TILE_SOURCES/{z}/{x}/{y}"
done
chown -R veetrax:veetrax "$T/styles"

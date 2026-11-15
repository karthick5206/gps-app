# Self-hosted maps (production, Ubuntu)

Everything the maps need runs on the production server. Browsers and the API never call an outside map service.

| Service | What | Listens | Data | RAM |
|---|---|---|---|---|
| `veetrax-graphhopper` | Routing (`/route`) and road snapping (`/match`), profile `car` (CH + LM) | 127.0.0.1:8989 | `/opt/veetrax/maps/graphhopper/graph-cache` from `india-latest.osm.pbf` | ≤ 8 GB |
| `veetrax-photon` | Reverse geocoding and place search, India | 127.0.0.1:2322 | `/opt/veetrax/maps/photon/photon_data` (India, Photon 1.x format) | ≤ 3 GB |
| `veetrax-photon-us` | Reverse geocoding and place search, USA (optional) | 127.0.0.1:2323 | `/opt/veetrax/maps/photon-us/photon_data` (USA, imported from the planet dump) | ≤ 4 GB |
| `veetrax-martin` | Vector tiles (OpenMapTiles schema): sources `india` and `us` | 127.0.0.1:3000 | `/opt/veetrax/maps/india.pmtiles`, `/opt/veetrax/maps/us.pmtiles` (built with Planetiler) | < 0.5 GB |
| Caddy | `/tiles/india/*`, `/tiles/us/*`, `/tiles/india,us/*` → Martin; `/tiles/{styles,fonts,sprites}` static | 443 | `/opt/veetrax/maps/tiles` | |

API settings (`apps/api/.env`): `GEOCODER=photon`, `GEOCODER_URL=http://127.0.0.1:2322`,
`GEOCODER_REGIONS=IN|http://127.0.0.1:2322|68,6,98,37;US|http://127.0.0.1:2323|-180,17,-65,72` (only once
`veetrax-photon-us` answers; without it the API uses `GEOCODER_URL` as the single India instance), `ROUTER_ENGINE=graphhopper`,
`ROUTER_URL=http://127.0.0.1:8989`, `MARTIN_URL=http://127.0.0.1:3000`. Satellite imagery stays off (`ESRI_BASEMAP_KEY` unset), because imagery can't be self-hosted.

**Address search (v1.18):** with `GEOCODER_REGIONS` the API asks every Photon instance in parallel, each within its own
bbox (4 s timeout each; an instance that is down only drops its hits), and merges the answers (confidence, then distance
to the map centre). Reverse geocoding asks the instance whose bbox contains the point (no instance → no address). Typed
coordinates (`12.97, 77.59`, `40.71N 74.01W`, DMS) are answered as an exact point and never sent to search. Every URL
must be loopback / private (otherwise address search is refused, `GEOCODER_NOT_PRIVATE`). Routing (GraphHopper) stays
India-only.

**Monitoring (v1.8.1):** System Health probes each configured service every ~15 s (2 s timeout) and raises an issue
after 2 failed checks in a row: `maps.martin` CRITICAL (blank maps), `maps.graphhopper` and `maps.photon` WARN (with
`GEOCODER_REGIONS` one check per instance: `maps.photon.in`, `maps.photon.us`). The release health gate
(`health-gate.sh`) still probes `GEOCODER_URL` only. A
service whose URL is unset is not monitored. Probes: GraphHopper `GET /health`, Photon `GET /status`, Martin
`GET /health` (any 2xx = up; confirm these paths on staging against the installed versions). `MARTIN_URL` is used only
for this check; unset it to silence the Martin check. `release.sh` also probes these once after a deploy and prints a
WARN line only (it does not deploy them, so they never fail the release gate). Details: `docs/MONITORING.md`.

Web settings (`apps/web/.env`, build time): `VITE_MAP_STYLE_STANDARD|LIGHT|DARK=https://app.veetrax.com/tiles/styles/{liberty,positron,dark}.json`.
The mobile apps need the same through `EXPO_PUBLIC_MAP_STYLE_STANDARD|LIGHT|DARK` and a new build.

Versions installed 2026-11-10: GraphHopper 11.1, Photon 1.3.0, Planetiler 0.10.2, Martin 1.16.1, Java 21.

## Files in this folder
- `graphhopper.yml` → `/opt/veetrax/maps/graphhopper/config.yml`
- `veetrax-graphhopper.service`, `veetrax-photon.service`, `veetrax-photon-us.service`, `veetrax-martin.service` → `/etc/systemd/system/`
  (`veetrax-photon-us` only starts when its data exists; `veetrax-martin` serves `us.pmtiles` only when the file exists)
- `make-styles.sh`: rewrites the OpenFreeMap styles (kept in `/opt/veetrax/maps/tiles/src`) to this server's tiles, fonts and sprites,
  removes the shaded-relief raster, and fails if any `openfreemap` reference is left. `TILE_SOURCES` (default `india,us`)
  picks the Martin source(s): `india,us` → tile URL `https://<site>/tiles/india,us/{z}/{x}/{y}` (Martin composite source)
  without `bounds`; `TILE_SOURCES=india` → the former `/tiles/india/...` with the India bounds.

## USA (tiles and addresses)
Disk: about 120 GB free during the builds (planet Photon dump ~ 75 GB, US extract ~ 11 GB, temporary files), RAM: the
import runs with 6 GB heap; serving needs ≤ 4 GB (Photon US) next to the India services. All as root, off-peak.

```bash
cd /opt/veetrax/maps
# 1. Tiles: US extract from Geofabrik, Planetiler into us.pmtiles (several hours with 4 threads)
sudo -u veetrax curl -fsSL -o us-latest.osm.pbf https://download.geofabrik.de/north-america/us-latest.osm.pbf
sudo -u veetrax java -Xmx8g -jar planetiler/planetiler.jar --osm-path=us-latest.osm.pbf \
  --output=planetiler/us-new.pmtiles --download --threads=4 --force
mv planetiler/us-new.pmtiles us.pmtiles
cp /opt/veetrax/app/ops/deploy/linux/maps/veetrax-martin.service /etc/systemd/system/ && systemctl daemon-reload && systemctl restart veetrax-martin
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/us/10/301/385     # 200 = the us source is served
# Caddy: the repo Caddyfile routes /tiles/india/*, /tiles/us/* and /tiles/india,us/* to Martin
cp /opt/veetrax/app/ops/deploy/linux/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
# Styles: composite source india,us (default); rerun with TILE_SOURCES=india to go back
SITE=app.veetrax.com bash /opt/veetrax/app/ops/deploy/linux/maps/make-styles.sh
curl -s -o /dev/null -w '%{http_code}\n' 'https://app.veetrax.com/tiles/india,us/10/732/479'

# 2. Addresses: Photon US instance, imported from the planet dump (download1.graphhopper.com/public/, Photon 1.x
#    format, photon-dump-planet-*.jsonl.zst saved as photon-dump-planet.jsonl.zst), country filter us
sudo -u veetrax mkdir -p /opt/veetrax/maps/photon-us
sudo -u veetrax java -Xmx6g -jar photon/photon-1.3.0.jar import -import-file photon-dump-planet.jsonl.zst \
  -country-codes us -languages en -j 3 -data-dir /opt/veetrax/maps/photon-us
cp /opt/veetrax/app/ops/deploy/linux/maps/veetrax-photon-us.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now veetrax-photon-us
curl -s 'http://127.0.0.1:2323/api?q=Empire+State+Building&limit=1' | jq '.features[0].properties.name'
# 3. API: add GEOCODER_REGIONS (above) to apps/api/.env, keep GEOCODER_URL, restart the API
systemctl restart veetrax-api
rm photon-dump-planet.jsonl.zst us-latest.osm.pbf   # optional, frees the disk once both work
```

Martin's composite source concatenates the tiles of both sources. Where one tile covers both India and the USA (only at
the lowest zooms, z0–z2) both carry the same OpenMapTiles layer names and MapLibre shows one source's layer there; from
z3 each tile belongs to one source. If that matters, build one `world.pmtiles` from an `osmium merge` of both extracts
instead and serve it as a single source (`TILE_SOURCES=world`).

Refresh: rebuild `us.pmtiles` like `india.pmtiles` below; for the addresses, import with `-data-dir /opt/veetrax/maps/photon-us-new`,
then stop `veetrax-photon-us`, swap `photon-us-new/photon_data` into `photon-us/` and start it.

## Refreshing the data (every few months, takes about 1–2 hours, off-peak)
All as root on the server. The old data keeps serving until the swap.

```bash
cd /opt/veetrax/maps
# 1. Road data
sudo -u veetrax curl -fsSL -o india-new.osm.pbf https://download.geofabrik.de/asia/india-latest.osm.pbf
# 2. Tiles: build into a new file, then swap
sudo -u veetrax java -Xmx4g -jar planetiler/planetiler.jar --osm-path=india-new.osm.pbf \
  --output=planetiler/india-new.pmtiles --download --threads=4 --force
mv planetiler/india-new.pmtiles india.pmtiles && systemctl restart veetrax-martin
# 3. Routing: re-import (routing and road snapping are off for ~30–60 min; the API just skips them)
mv india-new.osm.pbf india-latest.osm.pbf
systemctl stop veetrax-graphhopper && rm -rf graphhopper/graph-cache && systemctl start veetrax-graphhopper
# 4. Addresses: download the newest photon-db-india-1.0-latest.tar.bz2, extract to photon/photon_data.new, then
systemctl stop veetrax-photon && mv photon/photon_data photon/photon_data.old && mv photon/photon_data.new photon/photon_data && systemctl start veetrax-photon
```

Downloads: Geofabrik (`download.geofabrik.de/asia/india-latest.osm.pbf`), Photon dumps
(`download1.graphhopper.com/public/asia/india/`), Planetiler `--download` fetches Natural Earth, OSM water polygons and lake
centrelines once per build. These are the only outbound connections, and only while refreshing data.

## Checks
```bash
curl -s 'http://127.0.0.1:8989/route?profile=car&point=13.0827,80.2707&point=11.0168,76.9558&calc_points=false' | jq '.paths[0].distance'
curl -s 'http://127.0.0.1:2322/reverse?lat=13.0604&lon=80.2496' | jq '.features[0].properties'
curl -s -o /dev/null -w '%{http_code}\n' https://app.veetrax.com/tiles/india/10/732/479
# USA (once installed)
curl -s 'http://127.0.0.1:2323/reverse?lat=40.7484&lon=-73.9857' | jq '.features[0].properties'
curl -s -o /dev/null -w '%{http_code}\n' 'https://app.veetrax.com/tiles/india,us/10/301/385'
```

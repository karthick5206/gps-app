# Self-hosted maps (production, Ubuntu)

Everything the maps need runs on the production server. Browsers and the API never call an outside map service.

| Service | What | Listens | Data | RAM |
|---|---|---|---|---|
| `veetrax-graphhopper` | Routing (`/route`) and road snapping (`/match`), profile `car` (CH + LM) | 127.0.0.1:8989 | `/opt/veetrax/maps/graphhopper/graph-cache` from `india-latest.osm.pbf` | ≤ 8 GB |
| `veetrax-photon` | Reverse geocoding and place search | 127.0.0.1:2322 | `/opt/veetrax/maps/photon/photon_data` (India, Photon 1.x format) | ≤ 3 GB |
| `veetrax-martin` | India vector tiles (OpenMapTiles schema) | 127.0.0.1:3000 | `/opt/veetrax/maps/india.pmtiles` (built with Planetiler) | < 0.5 GB |
| Caddy | `/tiles/india/*` → Martin; `/tiles/{styles,fonts,sprites}` static | 443 | `/opt/veetrax/maps/tiles` | |

API settings (`apps/api/.env`): `GEOCODER=photon`, `GEOCODER_URL=http://127.0.0.1:2322`, `ROUTER_ENGINE=graphhopper`,
`ROUTER_URL=http://127.0.0.1:8989`, `MARTIN_URL=http://127.0.0.1:3000`. Satellite imagery stays off (`ESRI_BASEMAP_KEY` unset), because imagery can't be self-hosted.

**Monitoring (v1.8.1):** System Health probes each configured service every ~15 s (2 s timeout) and raises an issue
after 2 failed checks in a row: `maps.martin` CRITICAL (blank maps), `maps.graphhopper` and `maps.photon` WARN. A
service whose URL is unset is not monitored. Probes: GraphHopper `GET /health`, Photon `GET /status`, Martin
`GET /health` (any 2xx = up; confirm these paths on staging against the installed versions). `MARTIN_URL` is used only
for this check; unset it to silence the Martin check. `release.sh` also probes these once after a deploy and prints a
WARN line only (it does not deploy them, so they never fail the release gate). Details: `docs/MONITORING.md`.

Web settings (`apps/web/.env`, build time): `VITE_MAP_STYLE_STANDARD|LIGHT|DARK=https://app.veetrax.com/tiles/styles/{liberty,positron,dark}.json`.
The mobile apps need the same through `EXPO_PUBLIC_MAP_STYLE_STANDARD|LIGHT|DARK` and a new build.

Versions installed 2026-11-10: GraphHopper 11.1, Photon 1.3.0, Planetiler 0.10.2, Martin 1.16.1, Java 21.

## Files in this folder
- `graphhopper.yml` → `/opt/veetrax/maps/graphhopper/config.yml`
- `veetrax-graphhopper.service`, `veetrax-photon.service`, `veetrax-martin.service` → `/etc/systemd/system/`
- `make-styles.sh`: rewrites the OpenFreeMap styles (kept in `/opt/veetrax/maps/tiles/src`) to this server's tiles, fonts and sprites,
  removes the shaded-relief raster, and fails if any `openfreemap` reference is left.

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
```

/** Client-side preview parsing for geofence imports (no imports: node --test friendly). */

export interface ImportPreview {
  kind: 'geojson' | 'csv';
  total: number;
  circles: number;
  polygons: number;
  skipped: string[];
  names: string[];
}

/** Splits one CSV line honouring double quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Preview of a CSV `name,lat,lng,radiusM` file (header row optional). */
/** Translator for UI text; the default fills `{{vars}}` into the English key (keeps this file import-free for tests). */
export type Translate = (key: string, vars?: Record<string, string>) => string;
const plain: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars?.[k] ?? '');

export function previewCsv(text: string, tr: Translate = plain): ImportPreview {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const preview: ImportPreview = { kind: 'csv', total: 0, circles: 0, polygons: 0, skipped: [], names: [] };
  lines.forEach((line, i) => {
    const cols = splitCsvLine(line);
    if (i === 0 && /^name$/i.test(cols[0] ?? '')) return;
    const [name, lat, lng, r] = cols;
    const ok = name && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Number(r) >= 20 && Number(r) <= 50_000 && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;
    if (!ok) {
      preview.skipped.push(tr('Line {{line}}: {{text}}', { line: String(i + 1), text: line.slice(0, 60) }));
      return;
    }
    preview.total++;
    preview.circles++;
    preview.names.push(name);
  });
  return preview;
}

/** Preview of a GeoJSON FeatureCollection with Polygon features or Point features carrying a `radius` property. */
export function previewGeoJson(text: string, tr: Translate = plain): ImportPreview {
  const preview: ImportPreview = { kind: 'geojson', total: 0, circles: 0, polygons: 0, skipped: [], names: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(tr('The file is not valid JSON'));
  }
  const fc = data as { type?: string; features?: { geometry?: { type?: string }; properties?: Record<string, unknown> }[] };
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new Error(tr('Expected a GeoJSON FeatureCollection'));
  fc.features.forEach((f, i) => {
    const name = String(f.properties?.name ?? f.properties?.Name ?? tr('Feature {{n}}', { n: String(i + 1) }));
    const t = f.geometry?.type;
    if (t === 'Polygon') {
      preview.polygons++;
    } else if (t === 'Point' && Number(f.properties?.radius ?? f.properties?.radiusM) > 0) {
      preview.circles++;
    } else {
      preview.skipped.push(`${name}: ${t === 'Point' ? tr('Point without a radius property') : tr('unsupported {{type}}', { type: t ?? tr('geometry') })}`);
      return;
    }
    preview.total++;
    preview.names.push(name);
  });
  return preview;
}

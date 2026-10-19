import { strToU8, zipSync } from 'fflate';
import { circleRing, toGeoJson, toKml } from './poi-export';
import { detectFormat, ImportFormatError, parseCsv, parseGeoJson, parseGpx, parseImportFile, parseKml } from './poi-import';
import { matchStopsToPois, PoiIndex } from './poi-match';
import { canWritePoi, poiScopeWhere } from './pois.service';
import { parseXml } from './xml';

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder>
  <Placemark>
    <name>Chennai Depot &amp; Yard</name>
    <description><![CDATA[<b>Main</b> depot]]></description>
    <Style><IconStyle><color>ff0000ff</color></IconStyle></Style>
    <ExtendedData><Data name="category"><value>Depot</value></Data><Data name="radius"><value>250</value></Data></ExtendedData>
    <Point><coordinates>80.2707,13.0827,0</coordinates></Point>
  </Placemark>
  <Placemark>
    <name>Warehouse zone</name>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>
      80.1,13.0,0 80.2,13.0,0 80.2,13.1,0 80.1,13.1,0 80.1,13.0,0
    </coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
  <Placemark><name>Route</name><LineString><coordinates>80.1,13.0 80.2,13.1</coordinates></LineString></Placemark>
  <Placemark><name>Bad</name><Point><coordinates>200,13</coordinates></Point></Placemark>
</Folder></Document></kml>`;

describe('KML import', () => {
  const items = parseKml(KML);

  it('turns points into POIs with name, description, colour, category and radius', () => {
    expect(items[0]).toMatchObject({
      kind: 'POI',
      name: 'Chennai Depot & Yard',
      description: 'Main depot',
      lat: 13.0827,
      lng: 80.2707,
      category: 'DEPOT',
      radiusM: 250,
      color: '#ff0000',
      error: null,
    });
  });

  it('turns polygons into polygon geofences without the closing point', () => {
    expect(items[1].kind).toBe('GEOFENCE');
    expect(items[1].geometry).toEqual({
      type: 'POLYGON',
      points: [
        { lat: 13, lng: 80.1 },
        { lat: 13, lng: 80.2 },
        { lat: 13.1, lng: 80.2 },
        { lat: 13.1, lng: 80.1 },
      ],
    });
  });

  it('reports lines and bad coordinates per item', () => {
    expect(items[2]).toMatchObject({ kind: null, name: 'Route' });
    expect(items[2].error).toMatch(/Lines/);
    expect(items[3]).toMatchObject({ kind: null, name: 'Bad' });
  });

  it('recognises a circle drawn as a polygon', () => {
    const ring = circleRing({ lat: 13, lng: 80 }, 500);
    const coords = [...ring, ring[0]].map((p) => `${p.lng},${p.lat}`).join(' ');
    const [c] = parseKml(`<kml><Placemark><name>C</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`);
    expect(c.geometry?.type).toBe('CIRCLE');
    expect(c.geometry?.type === 'CIRCLE' && Math.abs(c.geometry.radiusM - 500)).toBeLessThan(10);
  });

  it('simplifies very large polygons to the geofence point limit', () => {
    const pts = Array.from({ length: 1200 }, (_, i) => {
      const a = (2 * Math.PI * i) / 1200;
      const r = 0.01 * (1 + 0.3 * Math.sin(7 * a));
      return `${80 + r * Math.cos(a)},${13 + r * Math.sin(a)}`;
    });
    const [p] = parseKml(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${pts.join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`);
    expect(p.kind).toBe('GEOFENCE');
    expect(p.geometry?.type === 'POLYGON' && p.geometry.points.length).toBeLessThanOrEqual(500);
    expect(p.warning).toMatch(/simplified/);
  });
});

describe('KMZ import', () => {
  it('reads doc.kml from the archive', () => {
    const zip = Buffer.from(zipSync({ 'doc.kml': strToU8(KML), 'files/icon.png': new Uint8Array([1, 2, 3]) }));
    expect(detectFormat('places.kmz', zip)).toBe('kmz');
    expect(detectFormat(undefined, zip)).toBe('kmz');
    const items = parseImportFile('kmz', zip);
    expect(items).toHaveLength(4);
    expect(items[0].name).toBe('Chennai Depot & Yard');
  });

  it('rejects an archive without a KML document', () => {
    const zip = Buffer.from(zipSync({ 'readme.txt': strToU8('hello') }));
    expect(() => parseImportFile('kmz', zip)).toThrow(ImportFormatError);
  });
});

describe('XML safety', () => {
  it('rejects DOCTYPE and entity declarations (XXE / billion laughs)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><kml><Placemark><name>&xxe;</name></Placemark></kml>`;
    expect(() => parseXml(xxe)).toThrow(/DOCTYPE/);
    const lol = `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><gpx>&lol2;</gpx>`;
    expect(() => parseImportFile('gpx', Buffer.from(lol))).toThrow(ImportFormatError);
  });

  it('rejects undefined entities and malformed XML', () => {
    expect(() => parseXml('<kml><name>&foo;</name></kml>')).toThrow(/Invalid XML/);
    expect(() => parseXml('<kml><name>x</kml>')).toThrow(/Invalid XML/);
  });
});

describe('GPX import', () => {
  it('imports waypoints and ignores tracks', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="12.9716" lon="77.5946"><name>Bengaluru office</name><desc>HQ</desc><type>Customer</type></wpt>
      <wpt lat="abc" lon="77"><name>Broken</name></wpt>
      <trk><name>Drive</name><trkseg><trkpt lat="12.9" lon="77.5"/></trkseg></trk>
    </gpx>`;
    const items = parseGpx(gpx);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'POI', name: 'Bengaluru office', description: 'HQ', category: 'CUSTOMER', lat: 12.9716, lng: 77.5946 });
    expect(items[1]).toMatchObject({ kind: null, name: 'Broken' });
  });

  it('explains a GPX with only tracks', () => {
    expect(() => parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>')).toThrow(/no waypoints/);
  });
});

describe('GeoJSON import', () => {
  it('points become POIs, polygons geofences, other geometries errors', () => {
    const items = parseGeoJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'Pump', category: 'fuel station', radius: 60 }, geometry: { type: 'Point', coordinates: [77.1, 28.6] } },
        { type: 'Feature', properties: { name: 'Zone' }, geometry: { type: 'Polygon', coordinates: [[[77, 28], [77.1, 28], [77.1, 28.1], [77, 28]]] } },
        { type: 'Feature', properties: { name: 'Road' }, geometry: { type: 'LineString', coordinates: [[77, 28], [78, 29]] } },
        { type: 'Feature', properties: {}, geometry: null },
      ],
    });
    expect(items[0]).toMatchObject({ kind: 'POI', category: 'FUEL_STATION', radiusM: 60, lat: 28.6, lng: 77.1 });
    expect(items[1]).toMatchObject({ kind: 'GEOFENCE', geometry: { type: 'POLYGON' } });
    expect(items[2]).toMatchObject({ kind: null, error: 'Unsupported geometry type LineString' });
    expect(items[3]).toMatchObject({ kind: null, error: 'Feature has no geometry' });
    expect(() => parseGeoJson({ foo: 1 })).toThrow(ImportFormatError);
  });

  it('round-trips the GeoJSON export', () => {
    const json = toGeoJson(
      [{ name: 'A', category: 'DEPOT', lat: 13, lng: 80, radiusM: 120, color: '#2563eb', address: null, description: null }],
      [{ name: 'Z', category: 'OTHER', color: '#0f766e', description: null, geometry: { type: 'CIRCLE', center: { lat: 13, lng: 80 }, radiusM: 300 } }],
    );
    const items = parseGeoJson(JSON.parse(json));
    expect(items[0]).toMatchObject({ kind: 'POI', name: 'A', radiusM: 120, category: 'DEPOT' });
    expect(items[1]).toMatchObject({ kind: 'GEOFENCE', geometry: { type: 'CIRCLE' } });
  });
});

describe('CSV import', () => {
  it('reads name,lat,lng,category,address with a header and flags bad rows', () => {
    const items = parseCsv('name,lat,lng,category,address\r\n"Depot, North",13.1,80.2,Depot,"12 Main Rd"\r\nBroken,abc,80\r\nZero,0,0,,\r\nFar,95,80,,\r\n');
    expect(items[0]).toMatchObject({ kind: 'POI', name: 'Depot, North', lat: 13.1, lng: 80.2, category: 'DEPOT', address: '12 Main Rd' });
    expect(items[1]).toMatchObject({ kind: null, name: 'Broken' });
    expect(items[2]).toMatchObject({ kind: null, error: 'Coordinates are 0, 0' });
    expect(items[3]).toMatchObject({ kind: null });
  });

  it('works without a header, clamps radius and requires lat/lng columns in a header', () => {
    const [a] = parseCsv('Shop,12.5,77.5,customer,Somewhere');
    expect(a).toMatchObject({ kind: 'POI', name: 'Shop', category: 'CUSTOMER' });
    const [b] = parseCsv('name,lat,lng,radius\nX,12,77,99999');
    expect(b).toMatchObject({ radiusM: 5000 });
    expect(b.warning).toMatch(/adjusted/);
    expect(() => parseCsv('name,city\nX,Y')).toThrow(ImportFormatError);
  });
});

describe('KML export', () => {
  it('escapes names and parses back', () => {
    const kml = toKml(
      'Demo <places>',
      [{ name: 'A & B "shop"', category: 'CUSTOMER', lat: 13.05, lng: 80.25, radiusM: 80, color: '#ff0000', address: '1 <Main>', description: null }],
      [{ name: 'Yard', category: 'DEPOT', color: '#0f766e', description: 'x', geometry: { type: 'POLYGON', points: [{ lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 2, lng: 2 }] } }],
    );
    expect(kml).toContain('A &amp; B &quot;shop&quot;');
    const items = parseKml(kml);
    expect(items[0]).toMatchObject({ kind: 'POI', name: 'A & B "shop"', radiusM: 80, category: 'CUSTOMER', color: '#ff0000', address: '1 <Main>' });
    expect(items[1]).toMatchObject({ kind: 'GEOFENCE', name: 'Yard', geometry: { type: 'POLYGON' } });
  });
});

describe('POI scoping', () => {
  const company = { companyId: 'c1', dataScope: 'COMPANY' as const, branchIds: [] };
  const assigned = { companyId: 'c1', dataScope: 'ASSIGNED' as const, branchIds: ['b1'] };

  it('company scope sees the whole company; assigned scope sees its branches and company-wide POIs', () => {
    expect(poiScopeWhere(company)).toEqual({ companyId: 'c1' });
    expect(poiScopeWhere(assigned)).toEqual({ companyId: 'c1', OR: [{ branchId: null }, { branchId: { in: ['b1'] } }] });
  });

  it('assigned users may only change POIs of their own branches', () => {
    expect(canWritePoi(company, null)).toBe(true);
    expect(canWritePoi(assigned, null)).toBe(false);
    expect(canWritePoi(assigned, 'b1')).toBe(true);
    expect(canWritePoi(assigned, 'b2')).toBe(false);
  });
});

describe('POI visit matching', () => {
  const pois = [
    { id: 'p1', name: 'Depot', category: 'DEPOT', lat: 13.0, lng: 80.0, radiusM: 100 },
    { id: 'p2', name: 'Customer', category: 'CUSTOMER', lat: 13.0005, lng: 80.0, radiusM: 200 },
    { id: 'p3', name: 'Pump', category: 'FUEL_STATION', lat: 13.1, lng: 80.1, radiusM: 50 },
  ];
  const index = new PoiIndex(pois);
  const t = (min: number) => new Date(Date.UTC(2026, 9, 19, 8, min));
  const stop = (objectId: string, lat: number, lng: number, from: number, to: number) => ({
    objectId, lat, lng, startTime: t(from), endTime: t(to), durationSec: (to - from) * 60, ignitionOn: false, address: null,
  });

  it('picks the nearest POI whose radius contains the stop', () => {
    expect(index.nearest(13.0, 80.0)?.poi.id).toBe('p1'); // inside both, Depot closer
    expect(index.nearest(13.0012, 80.0)?.poi.id).toBe('p2'); // ~133 m from Depot: outside its 100 m
    expect(index.nearest(13.1006, 80.1)).toBeNull(); // 67 m from Pump, radius 50
  });

  it('merges close consecutive stops at the same POI and keeps vehicles apart', () => {
    const visits = matchStopsToPois(
      [
        stop('v1', 13.0, 80.0, 0, 20),
        stop('v1', 13.0001, 80.0, 25, 40), // 5 min later, same POI → merged
        stop('v1', 13.1, 80.1, 60, 70),
        stop('v1', 12.5, 79.0, 80, 90), // no POI
        stop('v1', 13.0, 80.0, 95, 100), // new visit of the depot
        stop('v2', 13.0, 80.0, 30, 35),
      ],
      index,
    );
    expect(visits.map((v) => [v.objectId, v.poi.id, v.durationSec])).toEqual([
      ['v1', 'p1', 40 * 60],
      ['v1', 'p3', 600],
      ['v1', 'p1', 300],
      ['v2', 'p1', 300],
    ]);
  });
});

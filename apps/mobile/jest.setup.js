/* Component tests (jest-expo + RNTL, E5 WP 5.5): native-only modules that jest-expo does not mock. */
jest.mock('@maplibre/maplibre-react-native', () => {
  const Stub = () => null;
  return { __esModule: true, Map: Stub, Camera: Stub, GeoJSONSource: Stub, Layer: Stub, MapView: Stub, Marker: Stub };
});

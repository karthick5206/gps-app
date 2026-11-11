/**
 * GraphHopper 11 response fixtures (`GET /route` with points_encoded=true, `POST /match` with points_encoded=false,
 * `GET /info`, error bodies) in the engine's JSON format, for the Chennai test points below. Shapes and fields follow
 * the production engine's answers (car profile, precision-5 polylines, `time` in ms); the numbers are fixed test
 * values, not a live capture. No test talks to a real GraphHopper.
 */

export const A = { lat: 13.08268, lng: 80.27072 };
export const B = { lat: 13.06041, lng: 80.24963 };
export const C = { lat: 13.04181, lng: 80.23412 };
export const D = { lat: 13.00672, lng: 80.22061 };

const routeAnswer = (distance: number, time: number, points: string) => ({
  hints: { 'visited_nodes.sum': 58, 'visited_nodes.average': 58.0 },
  info: { copyrights: ['GraphHopper', 'OpenStreetMap contributors'], took: 3 },
  paths: [
    {
      distance,
      weight: time / 1000,
      time,
      transfers: 0,
      points_encoded: true,
      points_encoded_multiplier: 1e5,
      bbox: [80.22061, 13.00672, 80.27072, 13.08268],
      points,
      snapped_waypoints: '',
    },
  ],
});

export const GH_ROUTE = {
  AB: routeAnswer(3456.789, 512_345, 'weznA_{|hNzUhO|Zx^fg@`f@bo@rk@'),
  BC: routeAnswer(2810.104, 401_118, 'qzunAewxhNl_@na@pf@x^fk@r]'),
  CD: routeAnswer(4122.5, 498_731, 'ifrnAgvuhNbhAhUljAz]veAf^'),
  ABCD: routeAnswer(10_401.66, 1_421_502, 'weznA_{|hNzUhO|Zx^fg@`f@bo@rk@l_@na@pf@x^fk@r]bhAhUljAz]veAf^'),
};

export const GH_ERROR = {
  pointNotFound: { message: 'Cannot find point 0: 13.5,80.1', hints: [{ message: 'Cannot find point 0: 13.5,80.1', details: 'com.graphhopper.util.exceptions.PointNotFoundException', point_index: 0 }] },
  noConnection: { message: 'Connection between locations not found', hints: [{ message: 'Connection between locations not found', details: 'com.graphhopper.util.exceptions.ConnectionNotFoundException' }] },
  server: { message: 'Internal server error', hints: [] },
};

export const GH_MATCH = {
  hints: {},
  info: { copyrights: ['GraphHopper', 'OpenStreetMap contributors'], took: 12 },
  map_matching: { original_distance: 1590.2, distance: 1571.4, time: 186_220 },
  paths: [
    {
      distance: 1571.4,
      time: 186_220,
      points_encoded: false,
      points: {
        type: 'LineString',
        coordinates: [
          [80.27072, 13.08268],
          [80.26811, 13.07902],
          [80.26302, 13.07455],
          [80.25677, 13.06811],
        ],
      },
    },
  ],
};

export const GH_INFO = {
  bbox: [68.1, 6.5, 97.4, 35.5],
  profiles: [{ name: 'car' }],
  version: '11.1',
  elevation: false,
  encoded_values: {},
  import_date: '2026-11-10T03:12:44Z',
  data_date: '2026-11-08T21:20:02Z',
};

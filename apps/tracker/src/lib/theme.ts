import { useColorScheme } from 'react-native';

/** VeeTrax teal & saffron palette, light and dark. */
const light = {
  background: '#f5f8f7',
  card: '#ffffff',
  text: '#0f1d1b',
  muted: '#566966',
  border: '#dce6e3',
  primary: '#0f766e',
  primaryText: '#ffffff',
  primarySoft: '#e3f1ee',
  accent: '#f59e0b',
  accentSoft: '#fff4dd',
  accentText: '#7a4a00',
  danger: '#dc2626',
  dangerSoft: '#fdecec',
  success: '#16a34a',
  input: '#ffffff',
};

export type Colors = typeof light;

const dark: Colors = {
  background: '#0b1514',
  card: '#13201e',
  text: '#e8f1ef',
  muted: '#9fb3af',
  border: '#24413c',
  primary: '#14b8a6',
  primaryText: '#04201d',
  primarySoft: '#0f2e2a',
  accent: '#f59e0b',
  accentSoft: '#3a2a08',
  accentText: '#ffd48a',
  danger: '#ef4444',
  dangerSoft: '#3b1414',
  success: '#22c55e',
  input: '#0f1b19',
};

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

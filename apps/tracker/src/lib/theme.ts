import { useColorScheme } from 'react-native';

/**
 * Brand colours. One build = one brand, chosen with EXPO_PUBLIC_BRAND at build time (default VeeTrax), so the
 * second brand (ProSer) gets its own header band and primary colour without code changes. Everything else
 * (cards, status tints, text) is shared.
 */
interface Brand {
  /** Header band behind the logo and screen titles (white text on it). */
  header: string;
  /** Secondary text on the header band. */
  headerMuted: string;
  /** Buttons, links and highlights. */
  primary: string;
  primarySoft: string;
  primaryDark: string;
  primarySoftDark: string;
  /** Logo trail dots / small highlights. */
  accent: string;
  /** App-icon tile behind the tracker mark, and the phone body on it. */
  logoTile: string;
  logoInk: string;
}

const BRANDS: Record<'veetrax' | 'proser', Brand> = {
  veetrax: {
    header: '#0b3b36',
    headerMuted: '#cfe3df',
    primary: '#0f766e',
    primarySoft: '#e3f1ee',
    primaryDark: '#14b8a6',
    primarySoftDark: '#0f2e2a',
    accent: '#ffb443',
    logoTile: '#0e5e57',
    logoInk: '#0b3b36',
  },
  proser: {
    header: '#1e3a8a',
    headerMuted: '#c7d5f5',
    primary: '#1d4ed8',
    primarySoft: '#e4ebfb',
    primaryDark: '#60a5fa',
    primarySoftDark: '#14223f',
    accent: '#ffb443',
    logoTile: '#1d4ed8',
    logoInk: '#1e3a8a',
  },
};

export const BRAND_ID: keyof typeof BRANDS = process.env.EXPO_PUBLIC_BRAND?.toLowerCase() === 'proser' ? 'proser' : 'veetrax';
export const brand: Brand = BRANDS[BRAND_ID];

/** Enterprise palette: brand header band, light grey-green screen, white bordered cards, soft tinted status chips. */
const light = {
  background: '#f2f5f4',
  card: '#ffffff',
  text: '#14212b',
  muted: '#5b6b78',
  border: '#dde5e3',
  divider: '#eef1f2',
  header: brand.header,
  headerText: '#ffffff',
  headerMuted: brand.headerMuted,
  primary: brand.primary,
  primaryText: '#ffffff',
  primarySoft: brand.primarySoft,
  accent: brand.accent,
  accentSoft: '#fff1d6',
  accentText: '#8a5300',
  danger: '#c8322a',
  dangerSoft: '#fdecea',
  dangerText: '#a8261a',
  success: '#1f8a4c',
  successSoft: '#e3f4ea',
  successText: '#17683a',
  idle: '#98a4ae',
  idleSoft: '#eef1f3',
  input: '#ffffff',
};

export type Colors = typeof light;

const dark: Colors = {
  background: '#0b1514',
  card: '#13201e',
  text: '#e8f1ef',
  muted: '#9fb3af',
  border: '#24413c',
  divider: '#1c302d',
  header: brand.header,
  headerText: '#ffffff',
  headerMuted: brand.headerMuted,
  primary: brand.primaryDark,
  primaryText: '#04201d',
  primarySoft: brand.primarySoftDark,
  accent: brand.accent,
  accentSoft: '#3a2a08',
  accentText: '#ffd48a',
  danger: '#ef4444',
  dangerSoft: '#3b1414',
  dangerText: '#fca5a5',
  success: '#22c55e',
  successSoft: '#0f2e1c',
  successText: '#86efac',
  idle: '#6b7a85',
  idleSoft: '#1b2624',
  input: '#0f1b19',
};

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

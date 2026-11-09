/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAP_STYLE_STANDARD?: string;
  readonly VITE_MAP_STYLE_LIGHT?: string;
  readonly VITE_MAP_STYLE_DARK?: string;
  readonly VITE_MAP_FONT?: string;
  /** Comma list of UI flags to turn on (`uiRefresh`) or off (`-uiRefresh`); see src/lib/flags.ts. */
  readonly VITE_UI_FLAGS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

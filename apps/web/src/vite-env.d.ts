/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAP_STYLE_STANDARD?: string;
  readonly VITE_MAP_STYLE_LIGHT?: string;
  readonly VITE_MAP_STYLE_DARK?: string;
  readonly VITE_MAP_FONT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

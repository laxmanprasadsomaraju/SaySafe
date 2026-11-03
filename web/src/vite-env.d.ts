/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** AG Studio licence key (Render env var at build time). Never commit a key. */
  readonly VITE_AG_STUDIO_LICENSE?: string;
  /** Local-only: '1' lets the AG Studio view render unlicensed (with AG's watermark) for a recorded demo. Never set on Render. */
  readonly VITE_AG_STUDIO_LOCAL_EVAL?: string;
}

/** Build-time constant (web/vite.config.ts): true only when the AG Studio licence (or local eval) was set at build. */
declare const __AG_STUDIO_BUILD__: boolean;

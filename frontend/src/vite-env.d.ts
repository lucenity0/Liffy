/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Liffy API. See frontend/.env.example. */
  readonly VITE_API_BASE_URL: string;
  /** "true" runs the UI against MSW fixtures with no backend at all. */
  readonly VITE_USE_MSW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Liffy API. See frontend/.env.example. */
  readonly VITE_API_BASE_URL: string;
  /** "true" runs the UI against MSW fixtures with no backend at all. */
  readonly VITE_USE_MSW?: string;
  /**
   * "true" marks a static showcase build: mocks are served even in a
   * production bundle, and the UI says so on screen. Separate from
   * VITE_USE_MSW so mock data cannot reach a real deployment by accident.
   */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

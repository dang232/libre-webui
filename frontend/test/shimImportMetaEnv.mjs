// Self-registers import.meta.env defaults for plain `node --test` runs.
// Loaded via `node --import ./test/shimImportMetaEnv.mjs` (see test:unit) and
// via direct side-effect import in suites that run standalone. ESM caching
// makes the double registration a no-op.
const defaults = {
  VITE_API_BASE_URL: 'http://localhost:3001/api',
  VITE_AUTH_URL: 'https://auth.alcore.io.vn',
  VITE_ALCORE_AUTH_MODE: '',
  VITE_AUTH_BROWSER_HANDOFF: '',
  VITE_APP_VERSION: '0.0.0-test',
  VITE_DEMO_MODE: '',
  PROD: false,
  DEV: true,
};

for (const [key, value] of Object.entries(defaults)) {
  if (typeof value === 'string' && process.env[key] === undefined) {
    process.env[key] = value;
  }
}

try {
  const meta = import.meta;
  if (meta != null && (meta.env == null || typeof meta.env !== 'object')) {
    Object.defineProperty(meta, 'env', {
      value: { ...defaults },
      configurable: true,
      writable: true,
    });
  } else if (meta?.env != null) {
    for (const [key, value] of Object.entries(defaults)) {
      if (meta.env[key] === undefined) meta.env[key] = value;
    }
  }
} catch {
  // Ignore when the runtime seals import.meta; process.env covers tsx.
}

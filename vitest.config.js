import { defineConfig } from 'vitest/config';

// Deliberately NOT vite.config.js. That config loads .env, mutates process.env
// and registers dev-server middleware for the api/ routes; none of it belongs in
// a unit-test run, and all of it fails noisily without secrets present.
export default defineConfig({
  test: {
    environment: 'node',
    // src/lib/supabase.js calls createClient() at import time and throws without
    // a URL, so every test importing a service needed a real .env to exist. Unit
    // tests must not depend on local secrets (and must never reach a real
    // project): these are inert placeholders nothing ever connects to.
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      // The agent's existing tests script a model and assert what it is sent;
      // they exercise the model loop, so the local router stays out of their
      // way. Its own tests (api/_lib/agent/local) switch it on per call.
      BUDDY_LOCAL_ROUTER: 'off',
    },
    // api/ is included as well as src/: the serverless handlers hold the
    // recipient validation and the header-injection guards, which are exactly
    // the parts worth a unit test. They import lazily (supabaseAdmin() is only
    // called inside a request), so importing a handler here starts nothing.
    include: ['src/**/*.test.{js,jsx,ts,tsx}', 'api/**/*.test.{js,ts}'],
  },
});

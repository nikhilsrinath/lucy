import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Vite re-runs this config in the same process when .env changes. Drop what
  // we injected last time first: loadEnv(..., '') lets process.env override the
  // files, so a stale value would otherwise survive (a rotated API key never
  // took effect until a full restart).
  for (const key of globalThis.__dotenvInjected ?? []) delete process.env[key]
  const env = loadEnv(mode, process.cwd(), '')

  // loadEnv() returns the values; it does NOT populate process.env, and Vite
  // only ever exposes VITE_-prefixed vars to the client. The api/ handlers below
  // run in this same Node process and read server-only secrets off process.env,
  // so without this every /api/* route on localhost fails with a bare
  // "Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY". In production
  // Vercel injects these itself. A real shell variable still wins.
  globalThis.__dotenvInjected = []
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value
      globalThis.__dotenvInjected.push(key)
    }
  }

  const SERVER_ONLY = ['SUPABASE_SERVICE_ROLE_KEY', 'SECRETS_ENCRYPTION_KEY', 'PORTAL_TOKEN_SECRET', 'OPENROUTER_API_KEY']
  const missing = SERVER_ONLY.filter((k) => !process.env[k])
  if (missing.length) {
    console.warn(`[vite] missing server-only env: ${missing.join(', ')} — /api routes will fail on localhost`)
  }

  return {
    plugins: [
      react(),
      {
        // The api/ directory is deployed as serverless functions; on localhost
        // there is nothing to serve them, so load and run each module in-process.
        //
        // /api/nvidia is on this list, not on a proxy. It used to be proxied
        // straight to integrate.api.nvidia.com with the key injected here, which
        // meant the three things api/nvidia.js does before forwarding — verify the
        // bearer token, check org membership, and meter the message against the
        // plan's AI limit — never ran in development. Quota enforcement that only
        // exists in production is quota enforcement nobody has tested.
        name: 'dev-api-routes',
        configureServer(server) {
          const routes = ['email', 'org-secrets', 'portal', 'portal-token', 'admin', 'nvidia', 'export', 'brain', 'library', 'agent']
          for (const route of routes) {
            server.middlewares.use(`/api/${route}`, async (req, res) => {
              let body = ''
              req.on('data', (chunk) => { body += chunk })
              req.on('end', async () => {
                try {
                  if (body) req.body = JSON.parse(body)
                  // Enough of the Vercel response object for these handlers:
                  // json() for the ordinary replies, and write()/end() because
                  // /api/nvidia streams tokens back as they arrive.
                  const resShim = {
                    statusCode: 200,
                    setHeader: (k, v) => res.setHeader(k, v),
                    status(code) { this.statusCode = code; return this },
                    json(payload) {
                      res.statusCode = this.statusCode
                      res.setHeader('Content-Type', 'application/json')
                      res.end(JSON.stringify(payload))
                    },
                    write(chunk) {
                      if (!res.headersSent) res.statusCode = this.statusCode
                      return res.write(chunk)
                    },
                    end(chunk) {
                      if (!res.headersSent) res.statusCode = this.statusCode
                      return res.end(chunk)
                    },
                  }
                  const mod = await server.ssrLoadModule(`/api/${route}.js`)
                  await mod.default(req, resShim)
                } catch (err) {
                  console.error(`[dev-api/${route}]`, err)
                  res.statusCode = 500
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ success: false, error: err?.message || 'dev server error' }))
                }
              })
            })
          }
        },
      },
    ],
  }
})

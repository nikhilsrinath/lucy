import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/shared/ is loaded by the serverless functions as well as the browser.
// On Vercel there is no import.meta.env, no localStorage and no browser
// Supabase client, so anything here that reaches for one breaks every agent
// request at module load. This test is the fence.

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

describe('src/shared stays isomorphic', () => {
  it.each(files)('%s imports nothing outside src/shared and touches no browser globals', (f) => {
    const src = readFileSync(join(here, f), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    // Relative, inside this folder, and with its .js extension: plain Node ESM
    // on Vercel resolves nothing else, and Vite would hide the mistake.
    for (const spec of imports) expect(spec, `${f} imports ${spec}`).toMatch(/^\.\/[^/]+\.js$/);
    // Code only: a comment ending "…of the document." is not a DOM access.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/import\.meta/);
    expect(code).not.toMatch(/\b(localStorage|sessionStorage|window|document)\.[A-Za-z_]/);
  });
});

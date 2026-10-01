import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * Every .js file directly in api/ becomes a Vercel serverless function —
 * a test file there included. The Hobby plan allows 12; one more and the
 * build passes but "Deploying outputs…" fails. Tests and helpers live under
 * api/_lib/ (the underscore keeps a folder from being deployed).
 */
const HOBBY_LIMIT = 12;
const functions = readdirSync(fileURLToPath(new URL('../..', import.meta.url)), { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(?:js|mjs|cjs|ts)$/.test(e.name) && !e.name.startsWith('_'))
  .map((e) => e.name);

describe('Vercel serverless function count', () => {
  it('has no test files in api/ (they would be deployed as functions)', () => {
    expect(functions.filter((f) => /\.(?:test|spec)\./.test(f))).toEqual([]);
  });
  it(`stays within the Hobby plan's ${HOBBY_LIMIT} functions (now ${functions.length})`, () => {
    expect(functions.length).toBeLessThanOrEqual(HOBBY_LIMIT);
  });
});

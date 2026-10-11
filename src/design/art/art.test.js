import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { avatarUrl, faceUrl, AVATAR_IDS, AVATAR_MOODS } from './avatars.js';
import { backgroundSvg, BG_IDS, BG_MOODS } from './backgrounds.js';

const IDS = ['steve', 'elon', 'mark'];
const MOODS = ['neutral', 'thinking', 'explaining', 'happy', 'serious', 'surprised', 'disappointed', 'laughing'];
const MAX_BYTES = 15 * 1024;
const MAX_STICKER_BYTES = 80 * 1024;
const bytes = (s) => new TextEncoder().encode(s).length;
const pairs = IDS.flatMap((id) => MOODS.map((mood) => [id, mood]));

describe('avatars', () => {
    const DIR = fileURLToPath(new URL('./stickers/', import.meta.url));

    it('cover the three cofounders and the eight moods', () => {
        expect(AVATAR_IDS).toEqual(IDS);
        expect(AVATAR_MOODS).toEqual(MOODS);
        expect(readdirSync(DIR).sort()).toEqual([...IDS].sort());
        // Nothing left over from the four old poses.
        for (const id of IDS) expect(readdirSync(join(DIR, id)).sort()).toEqual(MOODS.flatMap((m) => [`${m}-face.webp`, `${m}.webp`]).sort());
    });

    it.each(pairs)('%s %s', (id, mood) => {
        expect(avatarUrl(id, mood)).toMatch(new RegExp(`${id}/${mood}[.]webp`));
        expect(faceUrl(id, mood)).toMatch(new RegExp(`${id}/${mood}-face[.]webp`));
        // A sticker and its face are real files, small enough to ship twenty-four of.
        for (const name of [`${mood}.webp`, `${mood}-face.webp`]) {
            const size = statSync(join(DIR, id, name)).size;
            expect(size).toBeGreaterThan(2000);
            expect(size).toBeLessThan(MAX_STICKER_BYTES);
        }
    });

    it('all twenty-four are different drawings', () => {
        const hash = ([id, mood]) => createHash('sha1').update(readFileSync(join(DIR, id, `${mood}.webp`))).digest('hex');
        expect(new Set(pairs.map(hash)).size).toBe(24);
        expect(new Set(pairs.map(([id, mood]) => avatarUrl(id, mood))).size).toBe(24);
    });

    it('the face defaults to the resting pose', () => {
        for (const id of IDS) expect(faceUrl(id)).toBe(faceUrl(id, 'neutral'));
    });

    it('unknown ids and moods draw nothing', () => {
        expect(avatarUrl('nobody', 'happy')).toBe('');
        expect(avatarUrl('steve', 'furious')).toBe('');
        // The four retired names draw nothing.
        for (const old of ['warning', 'win', 'celebrate']) expect(avatarUrl('steve', old)).toBe('');
        expect(faceUrl('nobody')).toBe('');
    });
});

describe('backgrounds', () => {
    it('cover the three cofounders and the eight moods', () => {
        expect(BG_IDS).toEqual(IDS);
        expect(BG_MOODS).toEqual(MOODS);
    });

    it.each(pairs)('%s %s', (id, mood) => {
        const svg = backgroundSvg(id, mood);
        expect(svg).toMatch(/^<svg viewBox="0 0 390 420" preserveAspectRatio="xMidYMid slice"/);
        expect(bytes(svg)).toBeLessThan(MAX_BYTES);
        expect(svg).not.toMatch(/<image|href=|NaN|undefined/);
        // No text baked in, except question marks (thinking) and exclamation marks (surprised).
        const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
        const sign = { thinking: '?', surprised: '!' }[mood];
        expect(texts.every((t) => t === sign)).toBe(true);
        expect(texts.length > 0).toBe(!!sign);
        expect(svg).toMatchSnapshot();
    });

    it('the same mood looks different for each cofounder, in the same colour family', () => {
        const top = { neutral: '#34558b', thinking: '#ffb000', explaining: '#0c8377', happy: '#1e9cf0', serious: '#9e0f17', surprised: '#f04a12', disappointed: '#3a3752', laughing: '#5b21c9' };
        expect(new Set(Object.values(top)).size).toBe(8);
        for (const mood of MOODS) {
            const three = IDS.map((id) => backgroundSvg(id, mood));
            expect(new Set(three).size).toBe(3);
            for (const svg of three) expect(svg).toContain(`stop-color="${top[mood]}"`);
        }
    });

    it('gradient ids are unique, so stacked backgrounds never share a fill', () => {
        const ids = pairs.map(([id, mood]) => backgroundSvg(id, mood).match(/linearGradient id="([^"]+)"/)[1]);
        expect(new Set(ids).size).toBe(24);
    });
});

/* ══════════════════════════════════════════════════════════════════════════
   The mood backgrounds: eight moods × three cofounders, as SVG strings.

   Each mood has a colour family and a scene (buddy-mood-chat.html):
     neutral       slate blue, a pale sun, low hills
     thinking      yellow and amber, a ray fan, question marks
     explaining    teal, a ray fan, a lit idea, dotted lines
     happy         sky blue, sun, green hills
     serious       red and orange, a low sun, dark cloud
     surprised     hot orange, a burst, exclamation marks
     disappointed  dusk violet, a heavy cloud, rain
     laughing      purple, burst rays, confetti, sparkles

   Each cofounder's motif is drawn into that scene, so the same mood looks
   different per cofounder:
     steve   clean geometric shapes and light beams
     elon    a blueprint grid, a rocket on its arc, stars, a planet
     mark    speech bubbles, a handshake, a city skyline, arrows going up

   390×420, preserveAspectRatio slice. No text except "?" and "!" marks. The headline
   sits top-left and the avatar on the right, so the left column carries only
   low-contrast shapes and the stronger ones sit along the top and the base.
   ══════════════════════════════════════════════════════════════════════════ */

export const BG_MOODS = ['neutral', 'thinking', 'explaining', 'happy', 'serious', 'surprised', 'disappointed', 'laughing'];
export const BG_VIEWBOX = '0 0 390 420';

const INK = '#1d1a17';
const n = (v) => Math.round(v * 10) / 10;
const K = `stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"`;

const PALETTE = {
    neutral: { top: '#34558b', bottom: '#9db8d9', tint: '#e3edf8', deep: '#1f3558', pop: '#ffd23f' },
    thinking: { top: '#ffb000', bottom: '#ffd84a', tint: '#fff4c2', deep: '#a86a00', pop: '#ffffff' },
    explaining: { top: '#0c8377', bottom: '#6fd6c4', tint: '#d9fbf3', deep: '#07544d', pop: '#ffd23f' },
    happy: { top: '#1e9cf0', bottom: '#8fd6ff', tint: '#ffffff', deep: '#0b5fa8', pop: '#ffd23f' },
    serious: { top: '#9e0f17', bottom: '#e2401f', tint: '#ffb08a', deep: '#5c070d', pop: '#ff8a4c' },
    surprised: { top: '#f04a12', bottom: '#ffb347', tint: '#fff1d6', deep: '#a8300a', pop: '#ffffff' },
    disappointed: { top: '#3a3752', bottom: '#8e86a8', tint: '#d8d3e6', deep: '#252236', pop: '#b9b2d6' },
    laughing: { top: '#5b21c9', bottom: '#a855f7', tint: '#e9d5ff', deep: '#3b1391', pop: '#f472b6' },
};

/* ── shared pieces ─────────────────────────────────────────────────────── */

const rays = (cx, cy, count, r1, r2, turn = 0) => Array.from({ length: count }, (_, i) => {
    const a = (i * 2 * Math.PI) / count + turn;
    return `<line x1="${n(cx + Math.cos(a) * r1)}" y1="${n(cy + Math.sin(a) * r1)}" x2="${n(cx + Math.cos(a) * r2)}" y2="${n(cy + Math.sin(a) * r2)}"/>`;
}).join('');

const fan = (cx, cy, count, width) => Array.from({ length: count }, (_, i) => {
    const a = (i * 2 * Math.PI) / count;
    const b = a + width;
    return `<path d="M${cx} ${cy} L${n(cx + Math.cos(a) * 560)} ${n(cy + Math.sin(a) * 560)} L${n(cx + Math.cos(b) * 560)} ${n(cy + Math.sin(b) * 560)}Z"/>`;
}).join('');

const sparkle = (x, y, s) => `<path d="M${x} ${n(y - s * 1.6)} Q${x} ${y} ${n(x + s * 1.6)} ${y} Q${x} ${y} ${x} ${n(y + s * 1.6)} Q${x} ${y} ${n(x - s * 1.6)} ${y} Q${x} ${y} ${x} ${n(y - s * 1.6)}Z"/>`;

const bumps = (list, fill) => `<g fill="${fill}">${list.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>`;

/* ── the eight scenes ──────────────────────────────────────────────────── */

const mark = (ch, list, fill, stroke) => list.map(([x, y, s, r]) => `<text x="${x}" y="${y}" font-family="Bricolage Grotesque, Inter, system-ui, sans-serif" font-weight="800" font-size="${s}" fill="${fill}" stroke="${stroke}" stroke-width="3.5" paint-order="stroke" transform="rotate(${r} ${x} ${y})">${ch}</text>`).join('');

const SCENES = {
    // A quiet sky: a pale sun, two clouds, low hills.
    neutral: () => `<circle cx="84" cy="140" r="46" fill="#e3edf8" opacity=".55"/>
        <g fill="#fff" opacity=".8"><ellipse cx="282" cy="80" rx="36" ry="13"/><ellipse cx="304" cy="70" rx="22" ry="14"/><ellipse cx="170" cy="236" rx="28" ry="10"/></g>
        <path d="M0 338 Q98 300 196 330 T390 320 V420 H0Z" fill="#587aa8"/>
        <path d="M0 374 Q120 344 224 368 T390 358 V420 H0Z" fill="#3f5f8f"/>`,
    // A board of dotted lines and a lit idea.
    explaining: () => `<g fill="#17a394">${fan(250, 210, 9, 0.16)}</g>
        <g stroke="#d9fbf3" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 13" opacity=".85"><path d="M26 262 h112"/><path d="M26 290 h84"/><path d="M26 318 h100"/></g>
        <g stroke="#ffe066" stroke-width="6" stroke-linecap="round">${rays(74, 132, 8, 44, 62, 0.4)}</g>
        <circle cx="74" cy="132" r="32" fill="#ffd23f" stroke="${INK}" stroke-width="3"/>
        ${bumps([[60, 392, 46], [150, 400, 40], [320, 394, 48]], '#0a6f65')}`,
    // A burst and exclamation marks.
    surprised: () => `<g fill="#ff7a2e">${fan(250, 214, 16, 0.12)}</g>
        <g stroke="#fff1d6" stroke-width="7" stroke-linecap="round">${rays(78, 150, 12, 50, 84, 0.2)}</g>
        ${mark('!', [[58, 300, 78, -12], [322, 84, 54, 14], [204, 86, 42, -8]], '#fff', '#5c1a03')}
        <g fill="#fff">${sparkle(150, 316, 10)}${sparkle(352, 228, 9)}</g>`,
    // Dusk, a heavy cloud and rain.
    disappointed: () => `<g fill="#6d6788"><ellipse cx="96" cy="118" rx="62" ry="24"/><ellipse cx="132" cy="100" rx="40" ry="26"/><ellipse cx="60" cy="104" rx="30" ry="20"/></g>
        <g stroke="#d8d3e6" stroke-width="4" stroke-linecap="round" opacity=".7">${[[50, 158], [84, 172], [118, 158], [150, 174], [66, 204], [104, 216], [138, 204]].map(([x, y]) => `<path d="M${x} ${y} l-7 20"/>`).join('')}</g>
        <path d="M0 344 Q110 322 204 340 T390 334 V420 H0Z" fill="#4a4665"/>
        <path d="M0 380 Q124 362 228 376 T390 370 V420 H0Z" fill="#33304a"/>`,
    serious: () => `<g stroke="#ff8a4c" stroke-width="6" stroke-linecap="round" opacity=".9">${rays(88, 142, 12, 62, 84)}</g>
        <circle cx="88" cy="142" r="48" fill="#ff7a3d" stroke="#b81d16" stroke-width="3.5"/>
        ${bumps([[20, 322, 50], [92, 310, 58], [170, 326, 50], [248, 314, 60], [326, 322, 54], [390, 310, 50]], '#7d0b12')}
        <rect y="322" width="390" height="98" fill="#7d0b12"/>
        ${bumps([[0, 372, 50], [78, 366, 46], [156, 376, 50], [248, 368, 52], [338, 374, 54]], '#5c070d')}
        <rect y="376" width="390" height="44" fill="#5c070d"/>`,
    happy: () => `<g stroke="#ffe066" stroke-width="7" stroke-linecap="round">${rays(80, 144, 10, 66, 94, 0.3)}</g>
        <circle cx="80" cy="144" r="54" fill="#ffd23f" stroke="#f2a900" stroke-width="3.5"/>
        <g fill="#fff" opacity=".95"><ellipse cx="286" cy="76" rx="34" ry="14"/><ellipse cx="308" cy="66" rx="21" ry="15"/><ellipse cx="196" cy="244" rx="26" ry="10"/></g>
        <path d="M0 332 Q92 280 196 322 T390 310 V420 H0Z" fill="#7cc84f"/>
        <path d="M0 370 Q118 328 222 362 T390 350 V420 H0Z" fill="#4fa83a"/>`,
    thinking: () => `<g fill="#ffc933">${fan(260, 216, 10, 0.18)}</g>
        ${[[44, 302, 76, -12], [320, 80, 52, 14], [208, 82, 40, -8], [340, 232, 44, 10]].map(([x, y, s, r]) => `<text x="${x}" y="${y}" font-family="Bricolage Grotesque, Inter, system-ui, sans-serif" font-weight="800" font-size="${s}" fill="#fff" stroke="#3a2a00" stroke-width="3.5" paint-order="stroke" transform="rotate(${r} ${x} ${y})">?</text>`).join('')}
        ${bumps([[52, 384, 44], [118, 396, 40], [326, 390, 46]], '#fff4c2')}`,
    laughing: () => `<g fill="#7c3aed">${fan(266, 222, 14, 0.14)}</g>
        <g fill="#fff" stroke="${INK}" stroke-width="3" stroke-linejoin="round">${[[52, 90, 0], [34, 192, -20], [144, 74, 25], [78, 294, 10]].map(([x, y, r]) => `<path d="M${x} ${y} l9 34 l-18 0Z" transform="rotate(${r} ${x} ${y})"/>`).join('')}</g>
        <g fill="#f472b6" stroke="${INK}" stroke-width="3" stroke-linejoin="round"><rect x="116" y="140" width="21" height="13" rx="2.5" transform="rotate(30 126 146)"/><rect x="22" y="254" width="21" height="13" rx="2.5" transform="rotate(-25 32 260)"/></g>
        <g fill="#fff">${sparkle(174, 50, 11)}${sparkle(40, 140, 8)}${sparkle(154, 318, 10)}${sparkle(352, 58, 9)}</g>
        <path d="M0 370 Q104 338 196 364 T390 356 V420 H0Z" fill="#f97316" opacity=".55"/>`,
};

/* ── the three motifs ──────────────────────────────────────────────────── */

const bubble = (x, y, w, h, fill, flip = false) => {
    const tx = flip ? x + w - 22 : x + 14;
    return `<path d="M${x + 10} ${y} H${x + w - 10} Q${x + w} ${y} ${x + w} ${y + 10} V${y + h - 10} Q${x + w} ${y + h} ${x + w - 10} ${y + h} H${tx + 16} L${tx + 2} ${y + h + 13} L${tx + 4} ${y + h} H${x + 10} Q${x} ${y + h} ${x} ${y + h - 10} V${y + 10} Q${x} ${y} ${x + 10} ${y}Z" fill="${fill}" ${K}/>
        <g fill="${INK}"><circle cx="${n(x + w / 2 - 12)}" cy="${n(y + h / 2)}" r="3"/><circle cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" r="3"/><circle cx="${n(x + w / 2 + 12)}" cy="${n(y + h / 2)}" r="3"/></g>`;
};

const arrowUp = (x, y, len, color) => `<path d="M${x} ${y} L${n(x + len * 0.55)} ${n(y - len)}" stroke="${INK}" stroke-width="10" stroke-linecap="round"/><path d="M${x} ${y} L${n(x + len * 0.55)} ${n(y - len)}" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
    <path d="M${n(x + len * 0.55 - 15)} ${n(y - len + 5)} L${n(x + len * 0.55 + 4)} ${n(y - len - 7)} L${n(x + len * 0.55 + 8)} ${n(y - len + 15)}Z" fill="${color}" ${K}/>`;

const MOTIFS = {
    // Clean geometric shapes and light beams.
    steve: (mood, p) => {
        const beams = mood === 'laughing' ? 4 : 3;
        return `<g fill="#fff" opacity=".13">${Array.from({ length: beams }, (_, i) => `<path d="M${-40 + i * 70} -10 L${96 + i * 96} 430 L${10 + i * 96} 430Z"/>`).join('')}</g>
            <g fill="none" stroke="${p.tint}" stroke-width="5" opacity=".8" stroke-linejoin="round">
                <circle cx="62" cy="292" r="30"/>
                <path d="M150 300 L178 250 L206 300Z"/>
                <rect x="296" y="26" width="42" height="42" transform="rotate(18 317 47)"/>
            </g>
            <circle cx="222" cy="50" r="11" fill="${p.pop}" ${K}/>
            <rect x="20" y="52" width="20" height="20" fill="${p.tint}" ${K} transform="rotate(-12 30 62)"/>
            <path d="M118 216 h44" stroke="${p.tint}" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 12" opacity=".8"/>`;
    },
    // A blueprint grid, a rocket on its arc, stars, a planet.
    elon: (mood, p) => {
        const grid = Array.from({ length: 9 }, (_, i) => `<path d="M${39 * (i + 1)} 0 V420"/>`).join('')
            + Array.from({ length: 10 }, (_, i) => `<path d="M0 ${39 * (i + 1)} H390"/>`).join('');
        // The rocket climbs with the mood: grounded when things are bad, highest on a big win.
        const [rx, ry, tilt] = {
            serious: [70, 300, 0], disappointed: [64, 304, -10], thinking: [58, 292, 8], neutral: [78, 284, 14],
            explaining: [88, 272, 20], happy: [96, 262, 24], surprised: [104, 248, 28], laughing: [112, 236, 32],
        }[mood];
        const grounded = mood === 'serious' || mood === 'disappointed';
        const flame = grounded ? '' : `<path d="M-7 28 Q0 ${mood === 'laughing' ? 62 : 48} 7 28Z" fill="${p.pop}" ${K}/>`;
        const stars = [[226, 46, 7], [300, 34, 5], [26, 60, 6], [176, 300, 5], [346, 92, 6]].map(([x, y, s]) => sparkle(x, y, s)).join('');
        return `<g stroke="#fff" stroke-width="1.5" opacity=".14">${grid}</g>
            <path d="M14 330 Q${n(rx - 10)} ${n(ry + 70)} ${rx} ${ry}" fill="none" stroke="${p.tint}" stroke-width="4" stroke-linecap="round" stroke-dasharray="3 11" opacity=".85"/>
            <g fill="${p.tint}" opacity=".9">${stars}</g>
            <g transform="rotate(-18 322 54)"><ellipse cx="322" cy="54" rx="40" ry="10" fill="none" stroke="${p.tint}" stroke-width="4"/><circle cx="322" cy="54" r="22" fill="${p.pop}" ${K}/><path d="M303 50 Q322 42 341 50" fill="none" stroke="${INK}" stroke-width="2" opacity=".5"/></g>
            <g transform="translate(${rx} ${ry}) rotate(${tilt})">${flame}
                <path d="M-11 12 L-22 30 L-11 26Z M11 12 L22 30 L11 26Z" fill="${p.deep}" ${K}/>
                <path d="M0 -34 Q14 -14 11 28 H-11 Q-14 -14 0 -34Z" fill="#fff" ${K}/>
                <circle cx="0" cy="-6" r="5.5" fill="${p.top}" ${K}/></g>`;
    },
    // Speech bubbles, a handshake, a city skyline, arrows going up.
    mark: (mood, p) => {
        const towers = [[0, 60, 34], [34, 96, 30], [64, 44, 40], [104, 78, 28], [132, 112, 34], [166, 58, 30], [196, 88, 36], [232, 50, 30], [262, 104, 32], [294, 66, 38], [332, 92, 30], [362, 54, 28]];
        const skyline = towers.map(([x, h, w]) => `<rect x="${x}" y="${330 - h}" width="${w}" height="${h + 90}"/>`).join('');
        const windows = towers.filter((_, i) => i % 2 === 0).map(([x, h, w]) => `<rect x="${x + w / 2 - 4}" y="${330 - h + 12}" width="8" height="9" rx="1.5"/>`).join('');
        const arrows = mood === 'serious' || mood === 'disappointed' ? 1 : mood === 'thinking' || mood === 'neutral' ? 2 : 3;
        return `<g fill="${p.deep}" opacity=".5">${skyline}</g><g fill="${p.tint}" opacity=".7">${windows}</g>
            ${bubble(288, 26, 70, 40, '#fff', true)}
            ${bubble(22, 44, 58, 34, p.tint)}
            ${Array.from({ length: arrows }, (_, i) => arrowUp(24 + i * 44, 316 - i * 8, 46 + i * 12, p.pop)).join('')}
            <g transform="translate(196 34)"><path d="M0 14 L18 8 L30 20 L14 30Z" fill="${p.tint}" ${K}/><path d="M60 14 L42 8 L30 20 L46 30Z" fill="${p.pop}" ${K}/>
                <path d="M14 30 Q22 40 34 34 L46 30 Q38 16 30 20 Q22 14 18 22Z" fill="#f3c9a8" ${K}/><path d="M24 26 l8 6 M29 23 l8 6" stroke="${INK}" stroke-width="2" stroke-linecap="round"/></g>`;
    },
};

/* ── the background ────────────────────────────────────────────────────── */

export const BG_IDS = Object.keys(MOTIFS);

/** A whole background as an SVG string. `attrs` is extra markup for the <svg> tag (a class, data-*). */
export function backgroundSvg(id, mood, attrs = '') {
    const p = PALETTE[mood];
    const motif = MOTIFS[id];
    if (!p || !motif) return '';
    const grad = `bg-${id}-${mood}`;
    const body = `<defs><linearGradient id="${grad}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.top}"/><stop offset="1" stop-color="${p.bottom}"/></linearGradient></defs>
        <rect width="390" height="420" fill="url(#${grad})"/>${SCENES[mood]()}${motif(mood, p)}`.replace(/\s*\n\s*/g, '');
    return `<svg viewBox="${BG_VIEWBOX}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"${attrs ? ` ${attrs}` : ''}>${body}</svg>`;
}

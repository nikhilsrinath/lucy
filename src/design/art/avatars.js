/* ══════════════════════════════════════════════════════════════════════════
   The cofounders, drawn. Three characters × four mood poses, as sticker
   images cut from the artwork sheets (thick dark outline, flat colours, upper
   body; the white sticker border is CSS, on the wrapper).

     warning    one finger raised
     win        fists up, sparks
     thinking   hand on chin, a question mark
     celebrate  arms crossed, laughing

   stickers/<id>/<mood>.webp is the upper body on a transparent 400×464
   canvas: the body stands on the bottom edge, centred, at one scale for all
   four moods, so it never changes size when the mood does.
   stickers/<id>/<mood>-face.webp is the head of the same pose, 160×160.
   ══════════════════════════════════════════════════════════════════════════ */

export const AVATAR_MOODS = ['warning', 'win', 'thinking', 'celebrate'];
export const AVATAR_IDS = ['steve', 'elon', 'mark'];
export const AVATAR_SIZE = { width: 400, height: 464 };
export const FACE_SIZE = 160;

const files = import.meta.glob('./stickers/*/*.webp', { eager: true, query: '?url', import: 'default' });
const known = (id, mood) => AVATAR_IDS.includes(id) && AVATAR_MOODS.includes(mood);

/** The sticker for a mood, as a URL ('' for an unknown id or mood). */
export function avatarUrl(id, mood) {
    return known(id, mood) ? files[`./stickers/${id}/${mood}.webp`] || '' : '';
}

/** The round face of the same pose: tab bar, beside a reply, lists. */
export function faceUrl(id, mood = 'win') {
    return known(id, mood) ? files[`./stickers/${id}/${mood}-face.webp`] || '' : '';
}

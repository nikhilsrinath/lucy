import React from 'react';
import { avatarUrl, faceUrl, AVATAR_SIZE, FACE_SIZE } from './avatars';
import { backgroundSvg, BG_MOODS } from './backgrounds';
import './art.css';

/* The cofounder drawings as components. The avatars are sticker images
   (avatars.js). The background markup comes from our own pure builder
   (backgrounds.js) — never from data — so it is set as HTML directly. */

const html = (__html) => ({ __html });

/** The upper-body sticker for a mood. `pop` replays the entrance when the key changes. */
export function CofounderAvatar({ id, mood = 'win', className = '', label }) {
    return (
        <span className={`cf-avatar ${className}`.trim()} role={label ? 'img' : undefined} aria-label={label}
            aria-hidden={label ? undefined : true}>
            <img src={avatarUrl(id, mood)} alt="" width={AVATAR_SIZE.width} height={AVATAR_SIZE.height} draggable={false} decoding="async" />
        </span>
    );
}

/** The small round face: tab bar, the "who" label, lists. */
export function CofounderFace({ id, mood = 'win', size, className = '', label, style }) {
    return (
        <span className={`cf-face ${className}`.trim()} style={{ ...(size ? { width: size, height: size } : null), ...style }}
            role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
            <img src={faceUrl(id, mood)} alt="" width={FACE_SIZE} height={FACE_SIZE} draggable={false} decoding="async" />
        </span>
    );
}

/** One mood's background, filling its container. */
export function MoodBackground({ id, mood, className = '' }) {
    return <span className={`cf-bg ${className}`.trim()} aria-hidden="true" dangerouslySetInnerHTML={html(backgroundSvg(id, mood))} />;
}

/** All four backgrounds stacked; the current one fades in (about 450 ms). */
export function MoodBackdrop({ id, mood }) {
    return (
        <div className="cf-backdrop" aria-hidden="true">
            {BG_MOODS.map((m) => <MoodBackground key={m} id={id} mood={m} className={m === mood ? 'on' : ''} />)}
        </div>
    );
}

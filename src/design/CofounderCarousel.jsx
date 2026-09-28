import React, { useEffect, useRef, useState } from 'react';
import { PERSONAS, personaOf } from './personas';
import { PixelAvatar } from './ui';
import { IconPrev, IconNext } from './icons';
import { speakSample, stopSpeaking } from './speakLocal';
import './carousel.css';

/* ══════════════════════════════════════════════════════════════════════════
   Choose a cofounder. A port of the mockup's carousel(): previous/next
   buttons, swipe, arrow keys, thumbnails, an "01 / 08" counter, and a preview
   of how the persona talks. "Hear a sample" speaks the (data-free) sample
   line with the browser's own voice — local, no model call, nothing metered.
   ══════════════════════════════════════════════════════════════════════════ */

const n = PERSONAS.length;

export default function CofounderCarousel({ value, onChange, compact = false }) {
    const [i, setI] = useState(() => Math.max(0, PERSONAS.findIndex((p) => p.id === personaOf(value).id)));
    const [speaking, setSpeaking] = useState(false);
    const touchX = useRef(null);
    const bars = useRef([]);
    const cur = PERSONAS[i];

    useEffect(() => { onChange?.(cur); }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => () => stopSpeaking(), []);

    // The sample's little waveform moves only while the voice is really speaking.
    useEffect(() => {
        if (!speaking) { bars.current.forEach((b) => b && (b.style.height = '4px')); return undefined; }
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (reduced) return undefined;
        const id = setInterval(() => bars.current.forEach((b) => b && (b.style.height = `${3 + Math.random() * 11}px`)), 90);
        return () => clearInterval(id);
    }, [speaking]);

    // Moving on silences the previous sample.
    const select = (k) => { stopSpeaking(); setSpeaking(false); setI(k); };
    const go = (d) => select((i + d + n) % n);
    const onKeyDown = (e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };

    const play = () => {
        if (speaking) { stopSpeaking(); setSpeaking(false); return; }
        const ok = speakSample(cur, cur.sample, { onStart: () => setSpeaking(true), onEnd: () => setSpeaking(false) });
        if (!ok) setSpeaking(false);
    };

    return (
        <div className={`sb-carwrap${compact ? ' compact' : ''}`}>
            <div className={`sb-car${compact ? ' compact' : ''}`} tabIndex={0} onKeyDown={onKeyDown}
                role="region" aria-roledescription="carousel" aria-label="Cofounders"
                onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
                onTouchEnd={(e) => {
                    if (touchX.current == null) return;
                    const dx = e.changedTouches[0].clientX - touchX.current;
                    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
                    touchX.current = null;
                }}>
                {PERSONAS.map((p, k) => {
                    let o = k - i;
                    if (o > n / 2) o -= n;
                    if (o < -n / 2) o += n;
                    const a = Math.abs(o);
                    const style = {
                        transform: `translateX(${o * (compact ? 66 : 74)}%) scale(${a === 0 ? 1 : a === 1 ? 0.84 : 0.7})`,
                        opacity: a === 0 ? 1 : a === 1 ? (compact ? 0.3 : 0.45) : 0,
                        zIndex: 10 - a,
                        pointerEvents: a <= 1 ? 'auto' : 'none',
                    };
                    return (
                        <div key={p.id} className={`slot${a === 0 ? ' cur' : ''}`} style={style}
                            role="group" aria-roledescription="slide" aria-label={`${k + 1} of ${n}: ${p.name}`}
                            aria-hidden={a !== 0}>
                            <div className="sb-cd ccard" onClick={() => a !== 0 && select(k)}>
                                <PixelAvatar spec={p} />
                                <h3>{p.name}</h3>
                                <div className="role">{p.role}</div>
                                <div className="traits">{p.traits.map((t) => <span key={t}>{t}</span>)}</div>
                                <div className="idx">{String(k + 1).padStart(2, '0')} / {String(n).padStart(2, '0')}</div>
                            </div>
                        </div>
                    );
                })}
                <button type="button" className="cnav prev" onClick={() => go(-1)} aria-label="Previous cofounder"><IconPrev /></button>
                <button type="button" className="cnav next" onClick={() => go(1)} aria-label="Next cofounder"><IconNext /></button>
                <span className="sb-sr" aria-live="polite">{cur.name}, {cur.role}</span>
            </div>

            {!compact && (
                <div className="thumbs" role="group" aria-label="Pick a cofounder">
                    {PERSONAS.map((p, k) => (
                        <button key={p.id} type="button" aria-label={p.name} aria-pressed={k === i}
                            className={k === i ? 'on' : undefined} onClick={() => select(k)}>
                            <PixelAvatar spec={p} size={40} />
                        </button>
                    ))}
                </div>
            )}

            <div className="sb-cd preview">
                <PixelAvatar spec={cur} size={40} />
                <div className="pv">
                    <b>How {cur.name} talks</b>
                    <p>“{cur.sample}”</p>
                    <button type="button" className="play" onClick={play} aria-pressed={speaking}>
                        <span className="pw" aria-hidden="true">
                            {Array.from({ length: 14 }, (_, k) => <i key={k} ref={(el) => { bars.current[k] = el; }} />)}
                        </span>
                        {speaking ? 'Stop' : compact ? 'Hear voice' : 'Hear a sample'}
                    </button>
                </div>
            </div>
        </div>
    );
}

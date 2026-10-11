import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PERSONAS, personaOf } from './personas';
import { Button } from './ui';
import { CofounderAvatar, MoodBackground } from './art/Art';
import { speakSample, stopSpeaking } from './speakLocal';
import { QUIZ, rank } from '../shared/cofounders/match.js';
import { FOUNDER_PROFILE_KEY } from './useCofounder';
import './chooser.css';

/* ══════════════════════════════════════════════════════════════════════════
   Choose a cofounder: a four-question founder quiz, then a hand of three
   foil playing cards in a carousel.

   The quiz (stage, biggest problem, risk comfort, pushback) is scored against
   each cofounder's selection vector (shared/cofounders/match.js) in two
   modes — complement (strong where you are not; the default) and mirror
   (thinks like you) — and ranks the three, with a one-line reason each. It
   can be skipped: all three cards are always in the hand.

   One card is in front at a time (arrows, swipe, arrow keys, the dots, or a
   tap on a card behind). Its face carries the cofounder's celebrate drawing,
   name, IQ in the corners like a card's rank, and speciality. Flipping it
   (tap, Enter or the button) shows the back: the same sample situation
   answered their way, the blind spot and "Hear voice" (the browser's own
   voice — local, no model call). Nothing needs scrolling.

   Used by onboarding, Settings → Change cofounder, the first-time sheet and
   the "your cofounder is now…" notice. `onPick(persona, extra)` gets the
   answers as `extra`, ready to save with the choice. `startFlipped` opens
   with the front card's back showing (the preview page uses it).
   ══════════════════════════════════════════════════════════════════════════ */

const N = PERSONAS.length;
const indexOfId = (id) => Math.max(0, PERSONAS.findIndex((p) => p.id === id));

export default function CofounderChooser({ value, answers: saved = null, onPick, cta = (p) => `Choose ${p.name}`, busy = false, startFlipped = false }) {
    const [answers, setAnswers] = useState(saved || {});
    const done = QUIZ.every((q) => answers[q.id]);
    const [step, setStep] = useState(saved && QUIZ.every((q) => saved[q.id]) ? 'pick' : 'quiz');
    const [mode, setMode] = useState('complement');
    const ranked = useMemo(() => (done ? rank(answers, PERSONAS, { mode }) : null), [answers, done, mode]);
    const [i, setI] = useState(() => indexOfId(personaOf(value).id));
    const [flipped, setFlipped] = useState(startFlipped);
    const [speaking, setSpeaking] = useState(null);
    const touchX = useRef(null);
    const cards = useRef([]);

    useEffect(() => () => stopSpeaking(), []);
    // A fresh ranking brings its top match to the front, until the person moves the hand.
    const [touched, setTouched] = useState(false);
    useEffect(() => { if (ranked && !touched) setI(indexOfId(ranked[0].id)); }, [ranked, touched]);

    const hear = (p) => {
        if (speaking === p.id) { stopSpeaking(); setSpeaking(null); return; }
        const ok = speakSample(p, p.sample.voice_line, { onStart: () => setSpeaking(p.id), onEnd: () => setSpeaking((s) => (s === p.id ? null : s)) });
        if (!ok) setSpeaking(null);
    };

    if (step === 'quiz') {
        return (
            <div className="cc">
                <p className="cc-lede">Four quick questions to find the cofounder who fits you. Same tools and rules, different minds.</p>
                {QUIZ.map((q) => (
                    <fieldset key={q.id} className="cc-q">
                        <legend>{q.question}</legend>
                        <div className="cc-opts">
                            {q.options.map((o) => (
                                <button key={o.value} type="button" aria-pressed={answers[q.id] === o.value}
                                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.value }))}>{o.label}</button>
                            ))}
                        </div>
                    </fieldset>
                ))}
                <div className="cc-cta">
                    <Button variant="primary" size="lg" block disabled={!done} onClick={() => setStep('pick')}>See my matches</Button>
                    <Button variant="ghost" block onClick={() => { setAnswers({}); setStep('pick'); }}>Skip, show me all three</Button>
                </div>
            </div>
        );
    }

    const chosen = PERSONAS[i];
    const extra = done ? { [FOUNDER_PROFILE_KEY]: { ...answers, mode } } : {};
    const place = (id) => (ranked ? ranked.findIndex((r) => r.id === id) : -1);
    const reason = ranked?.find((r) => r.id === chosen.id)?.reason;

    // Moving on silences the sample and turns the card face up again.
    const select = (k) => { stopSpeaking(); setSpeaking(null); setFlipped(false); setTouched(true); setI(k); };
    const go = (d) => select((i + d + N) % N);
    const flip = () => { if (flipped) { stopSpeaking(); setSpeaking(null); } setFlipped((f) => !f); };
    const onKeyDown = (e) => {
        if (e.target.closest('button')) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    };

    // The front card leans towards the pointer, and its foil follows it.
    const tilt = (k, e) => {
        const el = cards.current[k];
        if (!el || k !== i || e.pointerType === 'touch') return;
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        el.style.setProperty('--rx', `${((0.5 - y) * 14).toFixed(2)}deg`);
        el.style.setProperty('--ry', `${((x - 0.5) * 18).toFixed(2)}deg`);
        el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
        el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
        el.classList.add('lit');
    };
    const rest = (k) => {
        const el = cards.current[k];
        if (!el) return;
        for (const v of ['--rx', '--ry', '--mx', '--my']) el.style.removeProperty(v);
        el.classList.remove('lit');
    };

    return (
        <div className="cc cc-pick">
            {ranked ? (
                <div className="cc-mode" role="group" aria-label="How to match">
                    <button type="button" aria-pressed={mode === 'complement'} onClick={() => { setTouched(false); setFlipped(false); setMode('complement'); }}>Balances me</button>
                    <button type="button" aria-pressed={mode === 'mirror'} onClick={() => { setTouched(false); setFlipped(false); setMode('mirror'); }}>Thinks like me</button>
                    <button type="button" className="redo" onClick={() => setStep('quiz')}>Change answers</button>
                </div>
            ) : (
                <p className="cc-lede">Same tools and rules, different minds. <button type="button" className="cc-link" onClick={() => setStep('quiz')}>Take the 4-question quiz</button> to see who fits you.</p>
            )}

            <div className="cc-deck" tabIndex={0} onKeyDown={onKeyDown}
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
                    if (o > N / 2) o -= N;
                    if (o < -N / 2) o += N;
                    const cur = o === 0;
                    const pos = place(p.id);
                    const score = pos >= 0 ? Math.round(ranked[pos].score * 100) : null;
                    return (
                        <div key={p.id} className={`cc-slot${cur ? ' cur' : ''}`} style={{ '--o': o, '--k': k, '--acc': p.acc, zIndex: 10 - Math.abs(o) }}
                            role="group" aria-roledescription="slide" aria-label={`${k + 1} of ${N}: ${p.full_name || p.name}, ${p.title}`} aria-hidden={!cur}>
                            <div className="cc-tilt" ref={(el) => { cards.current[k] = el; }}
                                onPointerMove={(e) => tilt(k, e)} onPointerLeave={() => rest(k)}
                                onClick={() => (cur ? flip() : select(k))}>
                                <div className={`cc-flip${cur && flipped ? ' turned' : ''}`}>
                                    <div className="cc-front">
                                        <div className="cc-window">
                                            <MoodBackground id={p.art} mood="celebrate" />
                                            <CofounderAvatar id={p.art} mood="celebrate" />
                                            <span className="cc-rank-corner tl"><small>IQ</small><b>{p.iq}</b></span>
                                            <span className="cc-rank-corner br" aria-hidden="true"><small>IQ</small><b>{p.iq}</b></span>
                                            {pos >= 0 && <span className={`cc-match${pos === 0 ? ' best' : ''}`}>{pos === 0 ? 'Best match' : `No. ${pos + 1}`} {score}%</span>}
                                        </div>
                                        <div className="cc-plate">
                                            <h3>{p.full_name || p.name}</h3>
                                            <p className="cc-title">{p.title}</p>
                                            <p className="cc-spec">{p.speciality}</p>
                                            <ul className="cc-traits">{p.traits.map((t) => <li key={t}>{t}</li>)}</ul>
                                        </div>
                                        <span className="cc-sweep" aria-hidden="true" />
                                        <span className="cc-foil" aria-hidden="true" />
                                        <span className="cc-glare" aria-hidden="true" />
                                    </div>
                                    <div className="cc-back" aria-hidden={!(cur && flipped)}>
                                        <p className="cc-back-name">How {p.name} answers</p>
                                        <p className="cc-sit">{p.sample.situation}</p>
                                        <p className="cc-ans">“{p.sample.answer}”</p>
                                        <p className="cc-blind"><b>Blind spot</b> {p.blind_spot}</p>
                                        <button type="button" className="cc-hear" aria-pressed={speaking === p.id} tabIndex={cur && flipped ? 0 : -1}
                                            onClick={(e) => { e.stopPropagation(); hear(p); }}>{speaking === p.id ? 'Stop' : 'Hear voice'}</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
                <span className="sb-sr" aria-live="polite">{chosen.full_name || chosen.name}, {chosen.title}. IQ {chosen.iq}. {chosen.speciality}.</span>
            </div>

            <div className="cc-nav">
                <button type="button" className="cc-arrow" onClick={() => go(-1)} aria-label="Previous cofounder">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5 8 12l6.5 7" /></svg>
                </button>
                <div className="cc-dots" role="group" aria-label="Pick a cofounder">
                    {PERSONAS.map((p, k) => (
                        <button key={p.id} type="button" aria-label={p.full_name || p.name} aria-pressed={k === i} onClick={() => select(k)} />
                    ))}
                </div>
                <button type="button" className="cc-arrow" onClick={() => go(1)} aria-label="Next cofounder">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5 16 12l-6.5 7" /></svg>
                </button>
                <button type="button" className="cc-turn" onClick={flip} aria-pressed={flipped}>{flipped ? 'Show the front' : `See how ${chosen.name} answers`}</button>
            </div>

            <p className="cc-why" aria-live="polite">{reason || ' '}</p>

            <div className="cc-cta">
                <Button variant="primary" size="lg" block disabled={busy} onClick={() => { stopSpeaking(); onPick(chosen, extra); }}>{cta(chosen)}</Button>
            </div>
        </div>
    );
}

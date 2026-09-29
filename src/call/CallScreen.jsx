import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useOrg } from '../context/OrgContext';
import { useCofounder } from '../design/useCofounder';
import { PixelAvatar } from '../design/ui';
import { IconMic, IconSpeaker, IconCaptions, IconHangUp, IconLock } from '../design/icons';
import { cardMeta } from '../chat/cardMeta';
import { useVoiceCall } from './useVoiceCall';
import './call.css';

/* ══════════════════════════════════════════════════════════════════════════
   The call screen — the mockup's dark call UI over useVoiceCall.

   The avatar's glow and the waveform follow the call's real level (the
   microphone while listening, the voice while speaking); the transcript is
   the chat itself from the moment the call began, so a card proposed during
   the call is the same card, with the same buttons, as in the chat.

   A spoken "yes" confirms only a low-risk card, and that is decided on the
   server (confirm_proposal exists only on voice turns, low risk only). The
   labels here just say so: "Say yes" or "Needs your tap".
   ══════════════════════════════════════════════════════════════════════════ */

const BARS = 24;
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function CallScreen({ onEnd, greeting = '' }) {
    const a = useAssistant();
    const { activeOrg } = useOrg();
    const { persona } = useCofounder();
    const call = useVoiceCall(a, { greeting, voiceStyle: persona.voice, fillers: persona.fillers });
    const [startIds] = useState(() => new Set(a.messages.map((m) => m.id)));
    const [trOpen, setTrOpen] = useState(true);
    const rootRef = useRef(null);
    const orbRef = useRef(null);
    const barsRef = useRef([]);
    const listRef = useRef(null);

    const items = a.messages.filter((m) => !startIds.has(m.id));
    const cards = items.filter((m) => m.kind === 'action' && m.card);

    const end = () => onEnd({
        duration: mmss(call.elapsed),
        exchanged: items.length > 0,
        confirmed: cards.filter((m) => m.card.status === 'executed').map((m) => ({ id: m.id, title: m.card.summary || m.card.title })),
        waiting: cards.filter((m) => m.card.status === 'proposed').map((m) => ({ id: m.id, title: m.card.title, risk: m.card.risk })),
    });
    const endRef = useRef(end);
    useEffect(() => { endRef.current = end; });

    useEffect(() => { rootRef.current?.focus(); }, []);
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRef.current(); } };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    // Glow and waveform from the call's level; no audio analysis of our own.
    useEffect(() => {
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const history = new Array(BARS).fill(0);
        let raf = 0;
        let last = 0;
        const frame = (now) => {
            const lvl = call.levelRef.current || 0;
            orbRef.current?.style.setProperty('--lvl', (reduced ? 0 : Math.min(1, lvl * 1.4)).toFixed(2));
            if (now - last > (reduced ? 200 : 60)) {
                last = now;
                history.pop();
                history.unshift(lvl);
            }
            const mid = (BARS - 1) / 2;
            barsRef.current.forEach((el, i) => {
                if (!el) return;
                const d = Math.abs(i - mid);
                const v = history[Math.min(history.length - 1, Math.round(d))] || 0;
                el.style.height = `${4 + Math.min(1, v * 1.6) * 22 * (1 - (d / (mid + 1)) * 0.5)}px`;
            });
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [call.levelRef]);

    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [items.length, call.answer, call.heard]);

    const status = call.error ? 'Microphone unavailable'
        : { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', paused: 'Muted', unsupported: 'Voice needs Chrome or Edge' }[call.phase];

    // The words being said now, lit as they are spoken.
    const lastText = [...items].reverse().find((m) => m.role === 'assistant' && m.content && !m.kind);
    const live = call.phase === 'speaking' && call.answer;

    return createPortal(
        <div ref={rootRef} className="sb sb-cv" role="dialog" aria-modal="true" aria-label={`Voice call with ${persona.name}`} tabIndex={-1}>
            <div className={`sb-cl${trOpen ? '' : ' notr'}`}>
                <div className="sb-ctop">
                    <span className="live"><i aria-hidden="true" />Live</span>
                    <span className="tm" aria-label={`Call time ${mmss(call.elapsed)}`}>{mmss(call.elapsed)}</span>
                    <span className="sp"><IconLock /><span>Private to {activeOrg?.company_name || 'your company'}</span></span>
                </div>

                <div className="sb-stage">
                    <button type="button" ref={orbRef} className="sb-orb" onClick={call.cutIn}
                        disabled={call.phase !== 'speaking' && call.phase !== 'thinking'}
                        aria-label={call.phase === 'speaking' || call.phase === 'thinking' ? 'Interrupt and speak' : persona.name}>
                        <PixelAvatar spec={persona} />
                    </button>
                    <h2>{persona.name}</h2>
                    <div className="st" role="status">{status}</div>
                    <div className="sb-wv" aria-hidden="true">
                        {Array.from({ length: BARS }, (_, i) => <i key={i} ref={(el) => { barsRef.current[i] = el; }} />)}
                    </div>
                    {(call.error || call.phase === 'unsupported') && (
                        <p className="sb-hintline">{call.error || 'This browser has no speech recognition. Open StartupBuddy in Chrome or Edge to talk, or type in the chat.'}</p>
                    )}
                    <div className="sb-ctrls">
                        <button type="button" className="sb-cc" onClick={call.togglePause}
                            aria-pressed={call.phase === 'paused'} aria-label={call.phase === 'paused' ? 'Unmute' : 'Mute'}
                            disabled={call.phase === 'unsupported' || !!call.error}><IconMic /></button>
                        <button type="button" className="sb-cc" onClick={() => call.setSpeakerOn(!call.speakerOn)}
                            aria-pressed={call.speakerOn} aria-label={call.speakerOn ? 'Speaker on' : 'Speaker off'}><IconSpeaker /></button>
                        <button type="button" className="sb-cc" onClick={() => setTrOpen((v) => !v)}
                            aria-pressed={trOpen} aria-label={trOpen ? 'Hide transcript' : 'Show transcript'}><IconCaptions /></button>
                        <button type="button" className="sb-cc end" onClick={end}><IconHangUp />End</button>
                    </div>
                </div>

                {trOpen && (
                    <div className="sb-tr" aria-label="Transcript">
                        <div className="sb-trh">Live transcript<small>From your words and the chat</small></div>
                        <div className="sb-trl" ref={listRef} aria-live="polite">
                            {greeting && (
                                <Line who={persona} text={greeting} />
                            )}
                            {items.map((m) => {
                                if (m.role === 'user') return <Line key={m.id} you text={m.content} />;
                                if (m.kind === 'action' && m.card) return <CallCard key={m.id} a={a} m={m} />;
                                if (m.kind === 'choice' || m.kind === 'input') return <Line key={m.id} who={persona} text={m.content || m.choice?.question} note="Answer in the chat, or say it" />;
                                if (m.kind === 'notice') return <Line key={m.id} who={persona} text={m.content} />;
                                if (!m.content) return null;
                                if (live && m === lastText) {
                                    return (
                                        <div key={m.id} className="sb-ln">
                                            <small><PixelAvatar spec={persona} />{persona.name}</small>
                                            <p><span className="said">{call.answer.slice(0, call.spokenTo)}</span><span className="todo">{call.answer.slice(call.spokenTo)}</span></p>
                                            {call.trimmed && <p className="pend" style={{ fontSize: 13 }}>The full answer is in the chat.</p>}
                                        </div>
                                    );
                                }
                                return <Line key={m.id} who={persona} text={m.content} />;
                            })}
                            {call.phase === 'listening' && call.heard && (
                                <div className="sb-ln you"><small>You</small><p>{call.finalText}<span className="pend"> {call.interim}</span></p></div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}

function Line({ who, you, text, note }) {
    return (
        <div className={`sb-ln${you ? ' you' : ''}`}>
            <small>{you ? 'You' : <><PixelAvatar spec={who} />{who.name}</>}</small>
            <p>{text}</p>
            {note && <p className="pend" style={{ fontSize: 13 }}>{note}</p>}
        </div>
    );
}

function CallCard({ a, m }) {
    const card = m.card;
    const { label } = cardMeta(card);
    const high = card.risk === 'high';
    const sub = (card.preview?.rows || []).slice(0, 2).map(([, v]) => v).join(' · ')
        || (card.diff || []).slice(0, 2).map((d) => `${d.label}: ${d.to}`).join(' · ');
    const closed = { cancelled: 'Cancelled. Nothing was changed.', expired: 'Expired. Nothing was changed.', undone: 'Undone.', failed: card.error || 'Not done.' }[card.status];
    return (
        <div className="sb-dc">
            <div className="dch">{label}{card.status === 'proposed' && <span className={`b${high ? ' a' : ''}`}>{high ? 'Needs your tap' : 'Say “yes”'}</span>}</div>
            <div className="dcb"><b>{card.title}</b>{sub && <small>{sub}</small>}</div>
            {card.status === 'proposed' && card.items?.length > 0 && (
                <div className="ok x">Pick the items in the chat after the call.</div>
            )}
            {card.status === 'proposed' && !card.items?.length && (
                <div className="dcf">
                    <button type="button" onClick={() => a.confirmCard(a.activeId, m.id)}>{card.confirmLabel || 'Confirm'}</button>
                    <button type="button" className="q" onClick={() => a.cancelCard(a.activeId, m.id)}>Cancel</button>
                </div>
            )}
            {card.status === 'executing' && <div className="ok x">Working…</div>}
            {card.status === 'executed' && <div className="ok">✓ {card.summary || 'Done.'}</div>}
            {closed && <div className="ok x">{closed}</div>}
        </div>
    );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orgStore } from '../../services/orgStore';
import { useNavigate } from 'react-router-dom';
import {
    ArrowUp, ArrowUpRight, Mic, Square, Phone, Search, Plus, MoreHorizontal,
    Share2, Pencil, Pin, PinOff, Trash2, Maximize2, Minimize2, X, PanelLeft, PanelRightClose,
    MessageSquare, Copy, Check, Volume2, VolumeX, RefreshCw,
} from 'lucide-react';
import { useAssistant } from './assistantStore';
import { confirmDialog } from '../../services/confirm';
import ActionCard from './ActionCard';
import DisambiguationCard from './DisambiguationCard';
import FollowUpChips from './FollowUpChips';
import Markdown from './Markdown';
import VoiceCall from './VoiceCall';
import '../../theme/surface.css';
import './copilot.css';

/* ══════════════════════════════════════════════════════════════════════════
   EdgeAI — one copilot, two frames.

   · variant="dock"  the right-hand column of the hub. Chat and History share
                     the column as two tabs, so earlier conversations are one
                     click away without leaving the dashboard.
   · variant="full"  the full-screen workspace. History is a standing list on
                     the left, the conversation fills the rest.

   Both render the same state from AssistantContext, so a chat started in one
   is the same chat in the other.
   ══════════════════════════════════════════════════════════════════════════ */

const PROMPTS = [
    'How much runway do we have?',
    'Which clients are overdue?',
    'Summarise this week',
    'We spent 4,500 on office chairs yesterday',
    'Move the pricing task to next Friday',
];

// With projects in the workspace, lead with the project questions.
function promptsFor() {
    const open = orgStore.getSectionAsList('projects').filter((p) => !p.archived_at && !['completed', 'cancelled'].includes(p.status));
    if (!open.length) return PROMPTS;
    const top = open.slice().sort((a, b) => (b.contract_value || 0) - (a.contract_value || 0))[0];
    return ['Which projects are at risk?', `Is ${top.name} profitable?`, 'Who is over-allocated?', ...PROMPTS].slice(0, 6);
}

// Markdown colours itself from these; CSS variables keep it on the surface theme.
const MD_TOKENS = { text: 'var(--text)', raised: 'var(--card-3)' };

const MENU_W = 184;
const MENU_H = 180;

/** "just now", "12m", "3h", "Tue", "4 Sept". */
function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24 && new Date().getDate() === d.getDate()) return `${h}h ago`;
    if (diff < 6 * 86400000) return d.toLocaleDateString('en-IN', { weekday: 'short' });
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** Buckets for the history list, newest first within each. */
function groupChats(chats) {
    const startOf = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d.getTime(); };
    const today = startOf(0);
    const yesterday = startOf(1);
    const week = startOf(7);
    const month = startOf(30);
    const groups = [
        { id: 'pinned', label: 'Pinned', items: [] },
        { id: 'today', label: 'Today', items: [] },
        { id: 'yesterday', label: 'Yesterday', items: [] },
        { id: 'week', label: 'Previous 7 days', items: [] },
        { id: 'month', label: 'Previous 30 days', items: [] },
        { id: 'older', label: 'Older', items: [] },
    ];
    const at = (id) => groups.find((g) => g.id === id).items;
    [...chats].sort((a, b) => (b.at || 0) - (a.at || 0)).forEach((c) => {
        if (c.pinned) at('pinned').push(c);
        else if (c.at >= today) at('today').push(c);
        else if (c.at >= yesterday) at('yesterday').push(c);
        else if (c.at >= week) at('week').push(c);
        else if (c.at >= month) at('month').push(c);
        else at('older').push(c);
    });
    return groups.filter((g) => g.items.length);
}

const lastLine = (c) => {
    const m = [...(c.messages || [])].reverse().find((x) => x.content);
    return m ? m.content.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim() : 'No messages yet';
};

/* ══════════════════════════════════════════════════════════════════════════ */

export default function Copilot({ variant = 'dock', theme = 'dark', onExpand, onCollapse, onClose, onHide }) {
    const a = useAssistant();
    const navigate = useNavigate();
    const [callOpen, setCallOpen] = useState(false);
    const full = variant === 'full';
    const phone = usePhone();
    const [sideOpen, setSideOpen] = useState(() => !(typeof window !== 'undefined' && window.innerWidth < 760));
    const { registerDock } = a;
    const dock = useDockWidth(!full && !phone);

    // The launcher hides while a dock is on screen.
    useEffect(() => (full ? undefined : registerDock()), [full, registerDock]);


    const historyCount = a.chats.filter((c) => c.messages.length).length;
    const showHistory = !full && a.view === 'history';

    const chatBody = (
        <>
            {a.messages.length === 0
                ? <Welcome a={a} compact={!full} />
                : <Thread a={a} onOpen={(href) => { if (full) onClose?.(); navigate(href); }} />}
            <div className="cp-foot">
                <div className="cp-foot-inner">
                    {a.pendingQuestion && !a.streaming && (
                        <div className="cp-pending" role="status">
                            <span>Waiting for: {a.pendingQuestion.content}</span>
                            <button type="button" onClick={() => a.dismissQuestion(a.activeId, a.pendingQuestion.id)}>Skip</button>
                        </div>
                    )}
                    <Composer a={a} onCall={() => setCallOpen(true)} autoFocus={full} />
                    <div className="cp-disclaimer">Answers use your live EdgeOS data. Check anything you act on.</div>
                </div>
            </div>
        </>
    );

    const note = a.note && <div className="cp-note" role="status">{a.note}</div>;
    const call = callOpen && <VoiceCall a={a} onClose={() => setCallOpen(false)} />;

    /* ── dock ─────────────────────────────────────────────────────────── */
    if (!full) {
        return (
            <section className="cp cp-dock eo-surface" data-theme={theme} aria-label="EdgeAI copilot"
                style={dock.enabled ? { width: dock.width } : undefined}>
                {dock.enabled && <DockResizer width={dock.width} onCommit={dock.commit} />}
                <header className="cp-head">
                    <span className={`cp-orb${a.streaming ? ' is-live' : ''}`} aria-hidden="true" />
                    <span className="cp-title">EdgeAI</span>
                    <div className="cp-tabs" role="tablist" aria-label="Copilot view">
                        <button type="button" role="tab" aria-selected={!showHistory} onClick={() => a.setView('chat')}>Chat</button>
                        <button type="button" role="tab" aria-selected={showHistory} onClick={() => a.setView('history')}>
                            History{historyCount > 0 && <span className="cp-count">{historyCount}</span>}
                        </button>
                    </div>
                    <div className="cp-head-actions">
                        <button type="button" className="cp-icon" onClick={a.startChat} aria-label="New chat" title="New chat">
                            <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                        {onExpand && (
                            <button type="button" className="cp-icon" onClick={onExpand} aria-label="Open full screen" title="Full screen">
                                <Maximize2 size={15} strokeWidth={1.8} aria-hidden="true" />
                            </button>
                        )}
                        {onHide && (
                            <button type="button" className="cp-icon" onClick={onHide} aria-label="Hide copilot panel" title="Hide panel">
                                <PanelRightClose size={16} strokeWidth={1.8} aria-hidden="true" />
                            </button>
                        )}
                    </div>
                </header>
                {showHistory
                    ? <History a={a} phone={phone} onPicked={() => a.setView('chat')} />
                    : chatBody}
                {note}
                {call}
            </section>
        );
    }

    /* ── full screen ──────────────────────────────────────────────────── */
    return (
        <div className="cp cp-full eo-surface" data-theme={theme} role="dialog" aria-modal="true" aria-label="EdgeAI copilot">
            {sideOpen && phone && <div className="cp-scrim" onClick={() => setSideOpen(false)} />}
            {sideOpen && (
                <aside className="cp-side" aria-label="Chat history">
                    <div className="cp-side-head">
                        <span className={`cp-orb${a.streaming ? ' is-live' : ''}`} aria-hidden="true" />
                        <span className="cp-title">EdgeAI</span>
                        <button type="button" className="cp-icon" style={{ marginLeft: 'auto' }}
                            onClick={() => setSideOpen(false)} aria-label="Hide chat history" title="Hide history">
                            {phone ? <X size={16} aria-hidden="true" /> : <PanelLeft size={16} strokeWidth={1.8} aria-hidden="true" />}
                        </button>
                    </div>
                    <History a={a} phone={phone} onPicked={() => { if (phone) setSideOpen(false); }} />
                </aside>
            )}
            <div className="cp-col">
                <header className="cp-head">
                    {!sideOpen && (
                        <button type="button" className="cp-icon" onClick={() => setSideOpen(true)} aria-label="Show chat history" title="History">
                            <PanelLeft size={16} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                    )}
                    <span className="cp-sub" style={{ fontSize: 14, color: 'var(--text-2)' }}>
                        {a.active.messages.length ? a.active.title : 'New chat'}
                    </span>
                    <div className="cp-head-actions">
                        <button type="button" className="cp-icon" onClick={a.startChat} aria-label="New chat" title="New chat">
                            <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                        {onCollapse && (
                            <button type="button" className="cp-icon" onClick={onCollapse} aria-label="Back to the dashboard panel" title="Dock to dashboard">
                                <Minimize2 size={15} strokeWidth={1.8} aria-hidden="true" />
                            </button>
                        )}
                        <button type="button" className="cp-icon" onClick={() => { setCallOpen(false); onClose?.(); }}
                            aria-label="Close copilot" title="Close (Esc)">
                            <X size={17} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                    </div>
                </header>
                {chatBody}
            </div>
            {note}
            {call}
        </div>
    );
}

/* ── dock width ───────────────────────────────────────────────────────────
   The dock's left edge is a splitter. Drag it (or focus it and use the arrow
   keys) between DOCK_MIN and a cap that always leaves the dashboard room to
   breathe; it clicks back to the default when dragged near it, double-click
   resets, and the choice is remembered. While dragging, the width is written
   straight to the element so the thread doesn't re-render every frame. */

const DOCK_KEY = 'edgeos.copilot.dockWidth';
const DOCK_MIN = 340;
const DOCK_MAX = 760;
const DOCK_SNAP = 10;
const dockDefault = () => Math.round(Math.min(460, Math.max(360, window.innerWidth * 0.3)));
// Never let the dock take more than 55% of the window.
const dockMax = () => Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.round(window.innerWidth * 0.55)));
const clampDock = (w) => Math.round(Math.min(dockMax(), Math.max(DOCK_MIN, w)));

function readDock() {
    try {
        const v = Number(localStorage.getItem(DOCK_KEY));
        return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
}
function saveDock(w) {
    try { w == null ? localStorage.removeItem(DOCK_KEY) : localStorage.setItem(DOCK_KEY, String(w)); } catch { /* private mode */ }
}

function useDockWidth(enabled) {
    const [stored, setStored] = useState(() => (typeof window === 'undefined' ? null : readDock()));
    const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));

    useEffect(() => {
        const fn = () => setVw(window.innerWidth);
        window.addEventListener('resize', fn);
        return () => window.removeEventListener('resize', fn);
    }, []);

    // vw keeps the clamp honest when the window shrinks under a wide dock.
    const width = useMemo(() => (stored == null ? dockDefault() : clampDock(stored)), [stored, vw]); // eslint-disable-line react-hooks/exhaustive-deps

    const commit = useCallback((w) => {
        const next = clampDock(w);
        const isDefault = Math.abs(next - dockDefault()) <= 1;
        setStored(isDefault ? null : next);
        saveDock(isDefault ? null : next);
    }, []);

    return { enabled, width, commit };
}

function DockResizer({ width, onCommit }) {
    const [dragging, setDragging] = useState(false);

    const onPointerDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget.parentElement;
        const startX = e.clientX;
        const startW = el.getBoundingClientRect().width;
        let w = startW;
        setDragging(true);
        const root = document.documentElement;
        root.classList.add('cp-resizing');

        const move = (ev) => {
            let next = clampDock(startW + (startX - ev.clientX));
            const def = dockDefault();
            if (Math.abs(next - def) <= DOCK_SNAP) next = def;
            w = next;
            el.style.width = `${next}px`;
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            root.classList.remove('cp-resizing');
            setDragging(false);
            onCommit(w);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    };

    const onKeyDown = (e) => {
        const step = e.shiftKey ? 64 : 16;
        // The handle sits on the left edge, so ← widens the dock.
        const map = { ArrowLeft: width + step, ArrowRight: width - step, Home: dockMax(), End: DOCK_MIN };
        if (!(e.key in map)) return;
        e.preventDefault();
        onCommit(map[e.key]);
    };

    return (
        <div
            role="separator" aria-orientation="vertical" aria-label="Resize copilot panel"
            aria-valuemin={DOCK_MIN} aria-valuemax={dockMax()} aria-valuenow={width}
            tabIndex={0} title="Drag to resize · double-click to reset"
            className={`cp-resize${dragging ? ' is-dragging' : ''}`}
            onPointerDown={onPointerDown} onKeyDown={onKeyDown}
            onDoubleClick={() => onCommit(dockDefault())}
        />
    );
}

function usePhone() {
    const [p, setP] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);
    useEffect(() => {
        const fn = () => setP(window.innerWidth < 760);
        window.addEventListener('resize', fn);
        return () => window.removeEventListener('resize', fn);
    }, []);
    return p;
}

/* ── welcome ────────────────────────────────────────────────────────────── */

function Welcome({ a, compact }) {
    const recent = a.chats
        .filter((c) => c.messages.length && c.id !== a.activeId)
        .sort((x, y) => (y.at || 0) - (x.at || 0))
        .slice(0, 3);
    return (
        <div className="cp-welcome eo-scroll">
            <div className="cp-welcome-inner">
                <div className="cp-big-orb" aria-hidden="true" />
                <h2>Ask EdgeAI</h2>
                <p>Answers come from everything in EdgeBrain.</p>
                <div className="cp-prompts">
                    {(compact ? promptsFor().slice(0, 3) : promptsFor()).map((p) => (
                        <button key={p} type="button" onClick={() => a.send(p)} disabled={a.streaming}>
                            {p}<ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                        </button>
                    ))}
                </div>
                {recent.length > 0 && (
                    <>
                        <div className="cp-recent-label">
                            <span>Continue a recent chat</span>
                            {compact && <button type="button" onClick={() => a.setView('history')}>View all</button>}
                        </div>
                        <div className="cp-recent">
                            {recent.map((c) => (
                                <button key={c.id} type="button" onClick={() => a.pickChat(c.id)}>
                                    <MessageSquare size={14} strokeWidth={1.8} aria-hidden="true" style={{ flex: 'none' }} />
                                    <span className="cp-t">{c.title}</span>
                                    <span className="cp-when">{when(c.at)}</span>
                                </button>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

/* ── thread ─────────────────────────────────────────────────────────────── */

function Thread({ a, onOpen }) {
    const ref = useRef(null);
    const { messages, streaming, working, activeId } = a;

    useEffect(() => {
        const el = ref.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages, streaming, activeId]);

    return (
        <div ref={ref} className="cp-thread eo-scroll" aria-live="polite">
            <div className="cp-thread-inner">
                {messages.map((m, i) => {
                    if (m.role === 'user') return <div key={m.id} className="cp-msg is-user">{m.content}</div>;

                    if (m.kind === 'action' && m.card) {
                        return (
                            <div key={m.id} className="cp-msg">
                                <ActionCard
                                    card={m.card}
                                    onConfirm={(opts) => a.confirmCard(activeId, m.id, opts)}
                                    onCancel={() => a.cancelCard(activeId, m.id)}
                                    onUndo={() => a.undoCard(activeId, m.id)}
                                    onOpen={onOpen}
                                />
                            </div>
                        );
                    }

                    if (m.kind === 'choice' && m.choice) {
                        return (
                            <div key={m.id} className="cp-msg">
                                <DisambiguationCard message={m} disabled={streaming} onPick={(o) => a.answer(m.id, o)} />
                            </div>
                        );
                    }

                    const replying = streaming && i === messages.length - 1;
                    return (
                        <div key={m.id} className={`cp-msg${m.error ? ' is-error' : ''}${m.kind === 'notice' ? ' is-notice' : ''}`}>
                            {m.content
                                ? <Markdown text={m.content} t={MD_TOKENS} />
                                : (
                                    <span className="cp-typing-row">
                                        <span className="cp-typing" role="status" aria-label="EdgeAI is replying"><span /><span /><span /></span>
                                        {working && replying && <span className="cp-working">{working}</span>}
                                    </span>
                                )}
                            {m.hint && <div className="cp-hint">{m.hint}</div>}
                            {m.kind === 'input' && !m.resolved && (
                                <FollowUpChips options={m.input?.options} disabled={streaming} label={m.content}
                                    onPick={(o) => a.answer(m.id, o)} />
                            )}
                            {m.kind === 'notice' && m.offer && (
                                <div className="cp-chips">
                                    <button type="button" className="cp-chip" disabled={streaming} onClick={() => a.takeOffer(m.id)}>
                                        {m.offer.label || 'Create it'}
                                    </button>
                                </div>
                            )}
                            {m.content && !replying && (
                                <MessageActions
                                    a={a} message={m}
                                    canRegenerate={!m.kind && messages[i - 1]?.role === 'user' && !streaming}
                                    after={messages.length - 1 - i}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/* ── actions under an answer ────────────────────────────────────────────── */

// What is read aloud: the words, not the Markdown around them.
const plain = (md) => md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[#>|-]+\s*/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// One voice at a time across every answer: starting one stops the other.
let speakingId = null;
const speakListeners = new Set();
const setSpeaking = (id) => { speakingId = id; speakListeners.forEach((fn) => fn(id)); };

function useSpeaking(id) {
    const [on, setOn] = useState(speakingId === id);
    useEffect(() => {
        const fn = (cur) => setOn(cur === id);
        speakListeners.add(fn);
        return () => { speakListeners.delete(fn); };
    }, [id]);
    return on;
}

const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

function speak(id, text) {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(plain(text));
    // An Indian English voice where the browser has one, for ₹ and lakh.
    const voices = synth.getVoices();
    u.voice = voices.find((v) => v.lang === 'en-IN') || voices.find((v) => v.lang?.startsWith('en')) || null;
    u.lang = u.voice?.lang || 'en-IN';
    u.onend = () => { if (speakingId === id) setSpeaking(null); };
    u.onerror = u.onend;
    setSpeaking(id);
    synth.speak(u);
}

function MessageActions({ a, message, canRegenerate, after }) {
    const [copied, setCopied] = useState(false);
    const speaking = useSpeaking(message.id);

    // Leaving the chat, or the answer being replaced, stops its voice.
    useEffect(() => () => {
        if (speakingId === message.id) { window.speechSynthesis?.cancel(); setSpeaking(null); }
    }, [message.id]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch {
            a.setNote('Could not copy — your browser blocked the clipboard.');
        }
    };

    const toggleSpeak = () => {
        if (speaking) { window.speechSynthesis.cancel(); setSpeaking(null); return; }
        speak(message.id, message.content);
    };

    const regenerate = async () => {
        if (after > 0) {
            const ok = await confirmDialog({
                title: 'Regenerate this answer?',
                message: `The ${after} message${after > 1 ? 's' : ''} after it will be removed, and the conversation continues from the new answer.`,
                confirmLabel: 'Regenerate',
                tone: 'default',
            });
            if (!ok) return;
        }
        a.regenerate(message.id);
    };

    return (
        <div className="cp-actions">
            <button type="button" className="cp-act" onClick={copy}
                title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Copied' : 'Copy answer'}>
                {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
            </button>
            {canSpeak && (
                <button type="button" className={`cp-act${speaking ? ' is-on' : ''}`} onClick={toggleSpeak}
                    title={speaking ? 'Stop reading' : 'Read aloud'} aria-label={speaking ? 'Stop reading' : 'Read answer aloud'}
                    aria-pressed={speaking}>
                    {speaking ? <VolumeX size={14} strokeWidth={1.8} /> : <Volume2 size={14} strokeWidth={1.8} />}
                </button>
            )}
            {canRegenerate && (
                <button type="button" className="cp-act" onClick={regenerate}
                    title={message.error ? 'Try again' : 'Regenerate'} aria-label={message.error ? 'Try again' : 'Regenerate answer'}>
                    <RefreshCw size={14} strokeWidth={1.8} />
                </button>
            )}
        </div>
    );
}

/* ── composer ───────────────────────────────────────────────────────────── */

function Composer({ a, onCall, autoFocus }) {
    const inputRef = useRef(null);
    const { draft, setDraft, send, streaming, speech } = a;
    const { supported, listening, finalText, interim, start, stop, reset } = speech;
    // What was typed before dictation started, so stopping does not eat it.
    const baseRef = useRef('');
    // Whether heard words still belong in the box. Cleared on send: the
    // recogniser commits its last words a moment after it is told to stop, and
    // those must not refill a box that was just emptied.
    const dictatingRef = useRef(false);

    useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus, a.activeId]);

    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }, [draft]);

    // Dictation writes straight into the draft, so the person edits what was
    // heard instead of accepting or discarding a separate transcript.
    useEffect(() => {
        if (!dictatingRef.current) return;
        const heard = (finalText + (interim ? ' ' + interim : '')).trim();
        if (heard) setDraft((baseRef.current ? baseRef.current + ' ' : '') + heard);
        // The final words have landed once the session has ended.
        if (!listening) dictatingRef.current = false;
    }, [listening, finalText, interim, setDraft]);

    const endDictation = () => {
        dictatingRef.current = false;
        if (listening) stop();
    };

    // Moving to another chat, or this box going away, ends dictation into it.
    // Read from the ref, not `listening`: the cleanup holds an old render's
    // values, and a voice call sharing the microphone must be left alone.
    useEffect(() => () => {
        if (dictatingRef.current) { dictatingRef.current = false; stop(); }
    }, [a.activeId, stop]);

    const toggleMic = () => {
        if (listening) { stop(); return; }   // keeps the last words, then ends
        baseRef.current = draft.trim();
        // Each dictation starts empty; the previous one's words are in the box already.
        reset();
        dictatingRef.current = true;
        start({ autoStop: true });
    };

    const canSend = Boolean(draft.trim()) && !streaming;
    const submit = () => {
        if (!canSend) return;
        endDictation();
        send();
    };

    return (
        <div className="cp-composer">
            <textarea
                ref={inputRef} rows={1} value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                placeholder={listening ? 'Listening…' : 'Ask anything about your company'}
                aria-label="Message EdgeAI"
            />
            <button
                type="button" className="cp-mic" onClick={toggleMic} disabled={!supported}
                aria-label={listening ? 'Stop dictation' : 'Dictate'} aria-pressed={listening}
                title={!supported ? 'Speech recognition is not available in this browser'
                    : listening ? 'Stop — or just pause, it stops by itself' : 'Dictate'}
            >{listening ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <Mic size={16} strokeWidth={1.8} aria-hidden="true" />}</button>
            {streaming ? (
                <span className="cp-spin" role="status" aria-label="Generating answer"><span /></span>
            ) : canSend || !supported ? (
                <button type="button" className="cp-send" onClick={submit} disabled={!canSend} aria-label="Send">
                    <ArrowUp size={16} strokeWidth={2.2} aria-hidden="true" />
                </button>
            ) : (
                <button type="button" className="cp-call" onClick={onCall} aria-label="Start voice call" title="Voice call">
                    <Phone size={15} strokeWidth={2} aria-hidden="true" />
                </button>
            )}
        </div>
    );
}

/* ── history ────────────────────────────────────────────────────────────── */

function History({ a, phone, onPicked }) {
    const [q, setQ] = useState('');
    const [menu, setMenu] = useState(null);          // { id, x, y }
    const [renamingId, setRenamingId] = useState(null);

    const clear = useCallback(() => { setRenamingId(null); }, []);

    // Deleting asks through the app's confirmation dialog.
    const askRemove = async (chat) => {
        const ok = await confirmDialog({
            title: 'Delete chat',
            message: `Are you sure you want to delete “${chat.title}”? This cannot be undone.`,
        });
        if (ok) a.removeChat(chat.id);
    };
    const askClear = async (count) => {
        const ok = await confirmDialog({
            title: 'Clear chat history',
            message: `Delete ${count} unpinned chat${count === 1 ? '' : 's'}? Pinned chats are kept. This cannot be undone.`,
            confirmLabel: 'Delete all',
        });
        if (ok) a.clearHistory();
    };

    const openMenu = useCallback((id, rect) => {
        // Beside the button, flipped when it would run off the viewport, and
        // clamped so the last row still gets a menu that is fully on screen.
        const x = Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8));
        const below = rect.bottom + 6;
        const y = below + MENU_H > window.innerHeight ? Math.max(8, rect.top - MENU_H - 6) : below;
        clear();
        setMenu({ id, x, y });
    }, [clear]);

    const needle = q.trim().toLowerCase();
    const used = a.chats.filter((c) => c.messages.length || c.titled);
    const matches = needle
        ? used.filter((c) => c.title.toLowerCase().includes(needle)
            || c.messages.some((m) => String(m.content || '').toLowerCase().includes(needle)))
        : used;
    const groups = groupChats(matches);
    const menuChat = menu ? a.chats.find((c) => c.id === menu.id) : null;
    const unpinned = used.filter((c) => !c.pinned).length;

    return (
        <div className="cp-history">
            <div className="cp-hist-top">
                <label className="cp-search">
                    <Search size={14} strokeWidth={2} aria-hidden="true" />
                    <span className="eo-sr">Search chats</span>
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats"
                        onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} />
                </label>
                <button type="button" className="cp-newbtn" onClick={() => { a.startChat(); onPicked?.(); }}>
                    <Plus size={14} strokeWidth={2.2} aria-hidden="true" />New
                </button>
            </div>

            <div className="cp-hist-list eo-scroll">
                {groups.length === 0 ? (
                    <div className="cp-hist-empty">
                        {needle ? <>No chats match “{q.trim()}”.</> : <>No conversations yet.<br />Chats you start are kept here.</>}
                    </div>
                ) : groups.map((g) => (
                    <div key={g.id} role="group" aria-label={g.label}>
                        <div className="cp-group">{g.label}</div>
                        {g.items.map((c) => (
                            <HistoryRow
                                key={c.id} chat={c} active={c.id === a.activeId} phone={phone}
                                renaming={renamingId === c.id}
                                menuOpen={menu?.id === c.id}
                                onPick={() => { clear(); a.pickChat(c.id); onPicked?.(); }}
                                onRename={(title) => { a.renameChat(c.id, title); setRenamingId(null); }}
                                onStartRename={() => setRenamingId(c.id)}
                                onCancel={clear}
                                onMenu={(rect) => openMenu(c.id, rect)}
                            />
                        ))}
                    </div>
                ))}
            </div>

            <div className="cp-hist-foot">
                <span>Saved in this browser</span>
                {unpinned > 0 && <button type="button" onClick={() => askClear(unpinned)}>Clear history</button>}
            </div>

            {menuChat && (
                <ChatMenu
                    chat={menuChat} at={menu} onClose={() => setMenu(null)}
                    onShare={() => a.shareChat(menuChat)}
                    onRename={() => setRenamingId(menuChat.id)}
                    onPin={() => a.togglePin(menuChat.id)}
                    onDelete={() => askRemove(menuChat)}
                />
            )}
        </div>
    );
}

function HistoryRow({ chat, active, phone, renaming, menuOpen, onPick, onRename, onStartRename, onCancel, onMenu }) {
    const inputRef = useRef(null);

    useEffect(() => {
        if (!renaming) return;
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [renaming]);

    const commit = () => onRename(inputRef.current?.value ?? '');

    if (renaming) {
        return (
            <div className="cp-row">
                <input
                    ref={inputRef} className="cp-rename" defaultValue={chat.title} aria-label="Chat name" maxLength={60}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commit(); }
                        if (e.key !== 'Escape') return;
                        // Escape also closes the workspace; here it only cancels.
                        e.preventDefault();
                        e.stopPropagation();
                        onCancel();
                    }}
                />
            </div>
        );
    }

    return (
        <div className={`cp-row${active ? ' is-active' : ''}`}>
            <button type="button" className="cp-row-main" onClick={onPick} onDoubleClick={onStartRename}
                aria-current={active ? 'true' : undefined}>
                <span className="cp-row-title">
                    <span>{chat.title}</span>
                    {chat.pinned && <Pin size={11} strokeWidth={1.8} aria-label="Pinned" />}
                </span>
                <span className="cp-row-sub">
                    <span className="cp-prev">{lastLine(chat)}</span>
                    <span className="cp-when">{when(chat.at)}</span>
                </span>
            </button>
            <button
                type="button" className={`cp-row-act${phone || menuOpen ? ' is-shown' : ''}`}
                onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}
                aria-label={`Actions for ${chat.title}`} aria-haspopup="menu" aria-expanded={menuOpen}
            ><MoreHorizontal size={15} aria-hidden="true" /></button>
        </div>
    );
}

/**
 * Per-chat actions, positioned `fixed` from the button's rect so the scrolling
 * list never clips it. Closes on scroll, like any anchored menu.
 */
function ChatMenu({ chat, at, onClose, onShare, onRename, onPin, onDelete }) {
    const ref = useRef(null);

    useEffect(() => { ref.current?.querySelector('button')?.focus(); }, []);

    useEffect(() => {
        const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = [...ref.current.querySelectorAll('button')];
            const i = items.indexOf(document.activeElement);
            const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
            items[next]?.focus();
        };
        const onScroll = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onClose);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    const run = (fn) => () => { onClose(); fn(); };

    return (
        <div ref={ref} className="cp-menu" role="menu" aria-label={`Actions for ${chat.title}`} style={{ top: at.y, left: at.x }}>
            <button type="button" role="menuitem" onClick={run(onShare)}><Share2 size={14} strokeWidth={1.8} aria-hidden="true" />Share</button>
            <button type="button" role="menuitem" onClick={run(onRename)}><Pencil size={14} strokeWidth={1.8} aria-hidden="true" />Rename</button>
            <button type="button" role="menuitem" onClick={run(onPin)}>
                {chat.pinned
                    ? <><PinOff size={14} strokeWidth={1.8} aria-hidden="true" />Unpin</>
                    : <><Pin size={14} strokeWidth={1.8} aria-hidden="true" />Pin to top</>}
            </button>
            <hr />
            <button type="button" role="menuitem" className="is-danger" onClick={run(onDelete)}>
                <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />Delete
            </button>
        </div>
    );
}

import React, { useEffect, useState } from 'react';
import Markdown from '../components/assistant/Markdown';
import { Button, IconTile, Badge } from '../design/ui';
import { CofounderFace } from '../design/art/Art';
import { IconChevronRight, IconRefresh, IconSpeaker, IconCall } from '../design/icons';
import ActionCard from './ActionCard';
import PlanCard from './PlanCard';
import ViewBlock from './ViewBlock';
import { speakSample } from '../design/speakLocal';
import { currentExchange } from './exchange';

/* ══════════════════════════════════════════════════════════════════════════
   The exchange: the person's question, then one block from the cofounder —
   face, name, time, the mood's tag — holding everything that turn produced:
   words, figures and lists (views), a card, a plan, a choice, a question with
   chips, a notice. Only ever one: asking something new replaces it.
   ══════════════════════════════════════════════════════════════════════════ */

const MD = { text: 'var(--ink)', raised: 'var(--soft)' };
const time = (at) => (at ? new Date(at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '');

export default function Exchange({ a, persona, mood, tag, onOpen }) {
    const { messages, streaming, working } = a;
    const { question, items } = currentExchange(messages);
    if (!question && !items.length) return null;
    return (
        <div className="mc-x" key={a.exchange?.id}>
            {question && <div className="mc-q">{question.content}</div>}
            <div className="mc-who">
                <CofounderFace id={persona.art} mood={mood} size={22} />
                <b>{persona.name}</b>
                <span>· {time(items[0]?.at) || 'now'}{tag ? ` · ${tag}` : ''}</span>
            </div>
            <div className="mc-a">
                {items.map((m, i) => (
                    <Item key={m.id} a={a} m={m} replying={streaming && i === items.length - 1} working={working}
                        onOpen={onOpen} persona={persona} canRetry={!!question && !streaming} />
                ))}
            </div>
        </div>
    );
}

function Item({ a, m, replying, working, onOpen, persona, canRetry }) {
    const { streaming } = a;

    if (m.kind === 'call' && m.call) return <CallSummary call={m.call} persona={persona} />;

    if (m.kind === 'view' && m.view) {
        const onInsight = (insight, action) => {
            if (action.kind === 'open' && action.href) onOpen(action.href);
            else if (action.prompt) a.send(action.prompt, { source: `insight:${insight.id}`.slice(0, 158) });
        };
        return <ViewBlock view={m.view} onOpen={onOpen} onInsight={onInsight} busy={streaming} />;
    }

    if (m.kind === 'action' && m.card) {
        const Card = m.card.kind === 'plan' ? PlanCard : ActionCard;
        return (
            <div id={`msg-${m.id}`} style={{ display: 'contents' }}>
                <ContextChips card={m.card} onOpen={onOpen} />
                <Card
                    card={m.card}
                    onConfirm={(opts) => a.confirmCard(m.id, opts)}
                    onCancel={() => a.cancelCard(m.id)}
                    onUndo={() => a.undoCard(m.id)}
                    onRetry={() => a.retryCard(m.id)}
                    onOpen={onOpen}
                />
            </div>
        );
    }

    // A question with quick picks: tapping one asks it, and that becomes the exchange.
    if ((m.kind === 'choice' && m.choice) || m.kind === 'input') {
        const options = m.choice?.options || m.input?.options || [];
        const question = m.choice?.question || m.content;
        return (
            <div role="group" aria-label={question}>
                <div className="sb-say">{question}{m.hint && <small className="mc-hint">{m.hint}</small>}</div>
                {options.length > 0 && (
                    <div className="mc-picks">
                        {options.map((o) => (
                            <button key={`${o.value}`} type="button" className="mc-pick" disabled={streaming}
                                onClick={() => a.answer(m.id, o)} aria-label={o.sub ? `${o.label}, ${o.sub}` : o.label}>
                                {o.label}{o.sub && <small>{o.sub}</small>}
                            </button>
                        ))}
                    </div>
                )}
                {m.kind === 'input' && <p className="sb-acnote">Or type the answer below.</p>}
            </div>
        );
    }

    if (m.kind === 'notice') {
        return (
            <div className="sb-notice" role="status">
                <p>{m.content}</p>
                {m.offer && <Button size="sm" disabled={streaming} onClick={() => a.takeOffer(m.id)}>{m.offer.label || 'Create it'}</Button>}
            </div>
        );
    }

    if (!m.content) {
        return (
            <div className="sb-typing mc-typing" role="status" aria-label={`${persona.name} is replying`}>
                <i /><i /><i />{working && replying && <span>{working}</span>}
            </div>
        );
    }

    return (
        <>
            <div className={`sb-say${m.error ? ' err' : ''}`}>
                {m.error ? m.content : <Markdown text={m.content} t={MD} />}
            </div>
            {m.error && canRetry && (
                <div><Button size="sm" onClick={() => a.regenerate(m.id)}><IconRefresh /> Retry</Button></div>
            )}
            {!m.error && !replying && <Actions a={a} m={m} persona={persona} canRegenerate={canRetry} />}
        </>
    );
}

/** Records the card is about — only what the card itself references. */
function ContextChips({ card, onOpen }) {
    const chips = [];
    const seen = new Set();
    for (const e of card.entities || []) {
        if (!e?.id || seen.has(e.id) || !e.href) continue;
        seen.add(e.id);
        chips.push({ key: e.id, label: e.label, href: e.href });
    }
    if (card.target?.href && card.target.label && !chips.some((c) => c.label === card.target.label)) {
        chips.unshift({ key: 'target', label: card.target.label, href: card.target.href });
    }
    if (!chips.length || card.status !== 'proposed') return null;
    return (
        <div className="sb-ctx">
            {chips.slice(0, 3).map((c) => (
                <button key={c.key} type="button" onClick={() => onOpen(c.href, card)}>{c.label}</button>
            ))}
        </div>
    );
}

/* ── copy · read aloud · regenerate, under a plain answer ─────────────── */

const plain = (md) => md.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*[#>|-]+\s*/gm, '').replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ').trim();

// One voice at a time across every answer.
let speakingId = null;
const listeners = new Set();
const setSpeaking = (id) => { speakingId = id; listeners.forEach((fn) => fn(id)); };
function useSpeaking(id) {
    const [on, setOn] = useState(speakingId === id);
    useEffect(() => {
        const fn = (cur) => setOn(cur === id);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, [id]);
    return on;
}
const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

function Actions({ a, m, persona, canRegenerate }) {
    const [copied, setCopied] = useState(false);
    const speaking = useSpeaking(m.id);

    useEffect(() => () => {
        if (speakingId === m.id) { window.speechSynthesis?.cancel(); setSpeaking(null); }
    }, [m.id]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(m.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch {
            a.setNote('Could not copy. Your browser blocked the clipboard.');
        }
    };
    const toggleSpeak = () => {
        const synth = window.speechSynthesis;
        if (speaking) { synth.cancel(); setSpeaking(null); return; }
        // In the cofounder's own voice.
        const done = () => { if (speakingId === m.id) setSpeaking(null); };
        if (speakSample(persona, plain(m.content), { onEnd: done })) setSpeaking(m.id);
    };
    const regenerate = () => a.regenerate(m.id);

    return (
        <div className="sb-acts">
            <button type="button" onClick={copy} aria-label={copied ? 'Copied' : 'Copy answer'} title={copied ? 'Copied' : 'Copy'}>
                {copied ? '✓' : <CopyGlyph />}
            </button>
            {canSpeak && (
                <button type="button" onClick={toggleSpeak} aria-pressed={speaking}
                    aria-label={speaking ? 'Stop reading' : 'Read answer aloud'} title={speaking ? 'Stop' : 'Read aloud'}>
                    <IconSpeaker size={16} />
                </button>
            )}
            {canRegenerate && (
                <button type="button" onClick={regenerate} aria-label="Ask again" title="Ask again"><IconRefresh /></button>
            )}
        </div>
    );
}

const CopyGlyph = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
);

/* What a call left behind: what was confirmed, and what still waits for a tap.
   When the call ends this is the exchange on screen. Display-only — never
   sent to the model. */
function CallSummary({ call, persona }) {
    return (
        <section className="sb-cd sb-ac" aria-label={`Voice call with ${persona.name}, ${call.duration}`}>
            <div className="sb-ach">
                <IconTile tone="n"><IconCall size={14} /></IconTile>
                <span>Voice call with {persona.name}</span>
                <span className="right"><Badge tone="n" plain className="sb-num">{call.duration}</Badge></span>
            </div>
            <div className="sb-acb">
                <h4>Call summary</h4>
                <dl>
                    {call.confirmed.map((c) => <div key={c.id} className="sb-kv2"><dt>{c.title}</dt><dd>Done</dd></div>)}
                    {call.waiting.map((c) => (
                        <div key={c.id} className="sb-kv2"><dt>{c.title}</dt><dd>{c.risk === 'high' ? 'Needs your tap' : 'Waiting for you'}</dd></div>
                    ))}
                    {!call.confirmed.length && !call.waiting.length && <div className="sb-kv2"><dt>No changes were proposed.</dt><dd /></div>}
                </dl>
            </div>
        </section>
    );
}

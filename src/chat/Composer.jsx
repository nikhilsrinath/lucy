import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useShell } from '../shell/shellContext';
import { IconAttach, IconCall, IconMic, IconSend } from '../design/icons';

/* ══════════════════════════════════════════════════════════════════════════
   The one message box — under every section, not just Chat (plan §8.2).

   Sending from a section switches to Chat first; the page and record the
   person was looking at still go with the message (AssistantContext sends
   `context.page` from the router), so "this client" means the one on screen.

   Suggestion chips show on Chat only. Each is a plain prompt an agent tool
   handles today (checked against api/_lib/agent/registry.js):
     Who owes me?     → list_invoices
     Log an expense   → create_cash_entry, which asks for the amount
     New quote        → create_quotation_draft, which asks for the client
     Add a task       → create_task, which asks for the title
     How's the month? → finance_summary (only when the knowledge base is built)
   ══════════════════════════════════════════════════════════════════════════ */

const SUGGESTIONS = [
    { label: 'Who owes me?', prompt: 'Who owes me money?' },
    { label: 'Log an expense', prompt: 'Log an expense' },
    { label: 'New quote', prompt: 'Make a quote' },
    { label: 'Add a task', prompt: 'Add a task' },
    { label: "How's the month?", prompt: 'How did we do this month?', needsBrain: true },
];

const placeholderFor = (section, name) => ({
    chat: `Message ${name}`,
    money: `Ask ${name} about money, or log a payment`,
    clients: 'Ask about a client, or add a lead',
    work: "Add a task, or ask what's next",
    team: 'Ask about the team',
    settings: `Ask ${name} a question`,
}[section] || `Message ${name}`);

export default function Composer({ section, persona, brainBuilt = false }) {
    const a = useAssistant();
    const shell = useShell();
    const navigate = useNavigate();
    const inputRef = useRef(null);
    const { draft, setDraft, send, streaming, speech } = a;
    const { supported, listening, finalText, interim, start, stop, reset } = speech;
    const onChat = section === 'chat';
    // Dictation writes into the draft; `baseRef` is what was typed before it.
    const baseRef = useRef('');
    const dictatingRef = useRef(false);

    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }, [draft]);

    useEffect(() => {
        if (!dictatingRef.current) return;
        const heard = (finalText + (interim ? ` ${interim}` : '')).trim();
        if (heard) setDraft((baseRef.current ? `${baseRef.current} ` : '') + heard);
        if (!listening) dictatingRef.current = false;
    }, [listening, finalText, interim, setDraft]);

    useEffect(() => () => {
        if (dictatingRef.current) { dictatingRef.current = false; stop(); }
    }, [a.activeId, stop]);

    const toggleMic = () => {
        if (listening) { stop(); return; }
        baseRef.current = draft.trim();
        reset();
        dictatingRef.current = true;
        start({ autoStop: true });
    };

    const go = (text) => {
        if (streaming) return;
        dictatingRef.current = false;
        if (listening) stop();
        if (!onChat) navigate('/chat');
        send(text);
    };

    const canSend = Boolean(draft.trim()) && !streaming;
    const submit = (e) => { e?.preventDefault(); if (canSend) go(); };
    const pending = onChat && a.pendingQuestion && !streaming ? a.pendingQuestion : null;

    return (
        <div className="sb-composer">
            <div className="in">
                {onChat && a.messages.length === 0 && (
                    <div className="sb-sugg" role="group" aria-label="Suggestions">
                        {SUGGESTIONS.filter((s) => !s.needsBrain || brainBuilt).map((s) => (
                            <button key={s.label} type="button" disabled={streaming} onClick={() => go(s.prompt)}>{s.label}</button>
                        ))}
                    </div>
                )}
                {pending && (
                    <div className="sb-pending" role="status">
                        <span>Waiting for: {pending.content}</span>
                        <button type="button" onClick={() => a.dismissQuestion(a.activeId, pending.id)}>Skip</button>
                    </div>
                )}
                <form className="sb-bar" onSubmit={submit} autoComplete="off">
                    <button type="button" className="i" onClick={() => shell.openFiles({ upload: true })} aria-label="Attach a file">
                        <IconAttach />
                    </button>
                    <textarea
                        ref={inputRef} rows={1} value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
                        placeholder={listening ? 'Listening…' : placeholderFor(section, persona.name)}
                        aria-label={`Message ${persona.name}`}
                    />
                    {supported && (
                        <button type="button" className={`i${listening ? ' on' : ''}`} onClick={toggleMic}
                            aria-label={listening ? 'Stop dictation' : 'Dictate'} aria-pressed={listening}>
                            <IconMic size={18} />
                        </button>
                    )}
                    {shell.canCall && (
                        <button type="button" className="i" onClick={() => shell.startCall()} aria-label={`Call ${persona.name}`}>
                            <IconCall size={17} outline />
                        </button>
                    )}
                    {streaming
                        ? <span className="spin" role="status" aria-label={`${persona.name} is replying`}><i /></span>
                        : <button type="submit" className="i send" disabled={!canSend} aria-label="Send"><IconSend /></button>}
                </form>
                {onChat && <div className="sb-hint">{persona.name} proposes changes as cards. Nothing is saved until you confirm.</div>}
            </div>
        </div>
    );
}

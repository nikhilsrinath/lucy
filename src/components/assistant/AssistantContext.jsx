import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AssistantCtx } from './assistantStore';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import { VOICE_INSTRUCTION } from '../../services/voice';
import {
    streamAgent, confirmAction, cancelAction, undoAction, actionStatus, retryAction,
} from '../../services/agentService';
import { ACTIONS_CHANGED } from '../../chat/useInsights';
import { amountHints } from '../../shared/cashIntent';
import { cardLine } from './cardText';
import { orgStore } from '../../services/orgStore';
import { openedLabel, statusLabel } from '../../shell/agentLabels';

// The orgStore sections that show each table the agent can change. After a
// confirm or an undo the confirming tab re-reads them at once; other tabs and
// other people get the same change through Realtime (0068 publishes these).
const SECTIONS_OF = {
    tasks: ['tasks'],
    clients: ['customers', 'crm_leads'],
    expenses: ['expenses'],
    income_entries: ['income_entries'],
    project_allocations: ['project_allocations'],
    vendors: ['vendors'],
    purchase_invoices: ['purchase_invoices'],
};
// Invoices, quotations and proformas span three tables and reload together.
const FIN_DOC_TABLES = new Set(['financial_documents', 'document_line_items', 'payments']);

function refreshScreens(tables) {
    if ((tables || []).some((t) => FIN_DOC_TABLES.has(t))) {
        orgStore.refreshFinDocs().catch(() => { /* the next load catches up */ });
    }
    for (const table of tables || []) {
        for (const section of SECTIONS_OF[table] || []) {
            orgStore.refreshSection(section).catch(() => { /* the next load catches up */ });
        }
        if (table === 'tasks') {
            try { window.dispatchEvent(new CustomEvent('edgeos:tasks-changed')); } catch { /* ignore */ }
        }
    }
    // "Buddy noticed" re-checks: a chased invoice or finished task drops off.
    try { window.dispatchEvent(new CustomEvent(ACTIONS_CHANGED)); } catch { /* ignore */ }
}

/** What a finished card says in the conversation, under the card. */
function doneLine(card) {
    if (card?.kind === 'plan') {
        return card.partial
            ? `${card.summary} You can retry the ones that failed from the card.`
            : card.summary || 'Done.';
    }
    return ['Done.', card?.followUp].filter(Boolean).join(' ');
}


/* ══════════════════════════════════════════════════════════════════════════
   The cofounder's state, held once for the whole app.

   There is one exchange: the person's question and everything the cofounder
   answered with — words, a card, a plan, a view, a question with chips — plus
   its mood. Asking something new replaces it. There is no chat list, no
   threads and no history, and the model is never sent earlier turns: it gets
   this message, the company's records and its memory.

   Every message goes to the agent (api/agent.js). It answers, and when the
   message means something should change, it sends back a CARD: a proposal
   the person confirms with a tap. Nothing here writes business data except
   the card buttons (confirm / undo), which call the server with the card's
   action id. The action log and undo live on the server (ai_actions), apart
   from what is on screen.

   The exchange is kept in localStorage per company and person, so a reload
   still shows the card that is waiting.
   ══════════════════════════════════════════════════════════════════════════ */

const MAX_ENTITIES = 10;
const LIVE = new Set(['proposed', 'executing', 'confirmed']);

let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const exchangeKey = (orgId, userId) => `startupbuddy.exchange.${orgId}.${userId}`;
const blank = () => ({ id: uid('x'), messages: [], entities: [], mood: null, at: Date.now() });

function readExchange(key) {
    try {
        const x = JSON.parse(localStorage.getItem(key) || 'null');
        if (!x || !Array.isArray(x.messages)) return null;
        // A reply that was still streaming when the page closed never finished.
        return { ...blank(), ...x, messages: x.messages.filter((m) => m.role === 'user' || m.content || m.kind) };
    } catch { return null; }
}

/** The record open on the current page, when the URL names one. */
function pageOf(location) {
    const route = location.pathname + location.search;
    const project = location.pathname.match(/^\/projects\/([0-9a-f-]{36})/i);
    if (project) return { route, recordType: 'project', recordId: project[1] };
    const task = new URLSearchParams(location.search).get('task');
    if (location.pathname === '/tasks' && task) return { route, recordType: 'task', recordId: task };
    return { route };
}

const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* quota or private mode */ } };

/** `orgId` and `userId` say whose exchange this is. `personaId` is the chosen cofounder. */
export function AssistantProvider({ orgId: orgIdProp, userId = null, personaId = null, edgeContext, children }) {
    const orgId = orgIdProp ?? edgeContext?.orgId ?? null;
    // Until both are known the exchange is in memory only: nothing is written
    // to a key that could belong to someone else.
    const key = orgId && userId ? exchangeKey(orgId, userId) : null;
    const [store, setStore] = useState(() => ({ key, x: (key && readExchange(key)) || blank() }));
    // Another company or person: their own exchange.
    if (store.key !== key) setStore({ key, x: (key && readExchange(key)) || blank() });
    const exchange = store.x;
    const setExchange = useCallback((fn) => {
        setStore((st) => ({ ...st, x: typeof fn === 'function' ? fn(st.x) : fn }));
    }, []);
    const [draft, setDraft] = useState('');
    const [streaming, setStreaming] = useState(false);
    // A one-line "Checking tasks…" while a read tool runs. Not stored.
    const [working, setWorking] = useState('');
    const [note, setNote] = useState('');
    // The undo toast after a confirm: { messageId, until }.
    const [toast, setToast] = useState(null);

    const speech = useSpeechRecognition();
    const navigate = useNavigate();
    const location = useLocation();
    const xRef = useRef(exchange);
    useEffect(() => { xRef.current = exchange; }, [exchange]);
    const pageRef = useRef(pageOf(location));
    useEffect(() => { pageRef.current = pageOf(location); }, [location]);

    useEffect(() => {
        if (store.key) lsSet(store.key, JSON.stringify(store.x));
    }, [store]);

    useEffect(() => {
        if (!note) return undefined;
        const id = setTimeout(() => setNote(''), 2600);
        return () => clearTimeout(id);
    }, [note]);

    const patchMessage = useCallback((messageId, fields) => {
        setExchange((x) => ({
            ...x,
            messages: x.messages.map((m) => (m.id === messageId ? { ...m, ...(typeof fields === 'function' ? fields(m) : fields) } : m)),
        }));
    }, [setExchange]);

    /** Adds to the exchange on screen. `at` is display-only (the time beside a reply). */
    const append = useCallback((msgs) => {
        setExchange((x) => ({ ...x, at: Date.now(), messages: [...x.messages, ...msgs.map((m) => (m.at ? m : { ...m, at: Date.now() }))] }));
    }, [setExchange]);

    /** Records this turn referred to, newest first. They outlive the exchange: they are records, not chat. */
    const remember = useCallback((turn, entities) => {
        if (!entities?.length) return;
        setExchange((x) => {
            const fresh = entities.map((e) => ({ type: e.type, id: e.id, label: e.label, turn }));
            const rest = (x.entities || []).filter((e) => !fresh.some((f) => f.id === e.id));
            return { ...x, entities: [...fresh, ...rest].slice(0, MAX_ENTITIES) };
        });
    }, [setExchange]);

    /* ── one turn with the agent ──────────────────────────────────────────── */

    /**
     * Runs a turn, which becomes the exchange on screen: `leading` (the
     * person's line) and the reply replace whatever was there. `body` carries
     * what the server needs: `message`, or `resume` (a tapped chip), and
     * `pending` (an open question).
     */
    const runTurn = useCallback((body, leading = [], { voice = false, source = null } = {}) => {
        const replyId = uid('m');
        const before = xRef.current;
        const now = Date.now();
        const next = {
            ...before, id: uid('x'), at: now, mood: null,
            messages: [...leading, { id: replyId, role: 'assistant', content: '' }].map((m) => ({ ...m, at: now })),
        };
        xRef.current = next;
        setExchange(next);
        setStreaming(true);
        const chatId = next.id;
        const stale = () => xRef.current.id !== chatId;

        let said = '';
        let added = 0;
        const add = (msg) => { added += 1; append([{ id: uid('m'), role: 'assistant', ...msg }]); };

        const onEvent = (event, data) => {
            if (stale()) return;
            switch (event) {
                case 'status': setWorking(statusLabel(data.text || '')); break;
                case 'text':
                    said = said ? `${said}\n\n${data.text}` : data.text;
                    patchMessage(replyId, { content: said });
                    setWorking('');
                    break;
                case 'card':
                    add({ kind: 'action', actionId: data.card.action_id, card: data.card, content: cardLine(data.card) });
                    remember(replyId, data.card.entities);
                    break;
                case 'choice':
                    add({ kind: 'choice', content: data.choice.question, choice: data.choice });
                    break;
                case 'input': {
                    // The amount is usually already in the question. Offer it back as a chip.
                    const msgs = xRef.current.messages;
                    const hints = data.input.param === 'amount'
                        ? amountHints(msgs.filter((m) => !m.error).slice(-6).map((m) => m.content))
                        : [];
                    add({ kind: 'input', content: data.input.question, hint: data.input.hint || null, input: { ...data.input, options: [...hints, ...(data.input.options || [])].slice(0, 8) } });
                    break;
                }
                case 'notice': add({ kind: 'notice', content: data.text, offer: data.offer || null }); break;
                // A figures / list / timeline / insights block, built by the
                // server from a read — display only, summarised in history.
                case 'view': if (data.view) add({ kind: 'view', view: data.view, content: '' }); break;
                case 'navigate':
                    navigate(data.href);
                    add({ kind: 'notice', content: `Opened ${openedLabel(data.href, data.label)}.` });
                    break;
                case 'entities': remember(replyId, data.entities); break;
                case 'card_update': cardUpdateRef.current?.(data); added += 1; break;
                // How the reply lands — decided by the server, last in the turn.
                case 'mood': setExchange((x) => ({ ...x, mood: data })); break;
                case 'error': patchMessage(replyId, { content: data.message || 'Something went wrong.', error: true }); said = data.message || 'x'; break;
                default: break;
            }
        };

        const finish = () => {
            if (stale()) return;
            setStreaming(false);
            setWorking('');
            // A turn that ended in a card needs no words of its own.
            if (!said) {
                if (added) setExchange((x) => ({ ...x, messages: x.messages.filter((m) => m.id !== replyId) }));
                else patchMessage(replyId, { content: 'I did not get an answer back. Try again?', error: true });
            }
        };

        // What carries into this turn is the system's own record of the last
        // one — the records in play, cards still open, what was done — never
        // its words.
        const prior = before.messages;
        streamAgent({
            org_id: orgId,
            chat_id: chatId,
            message_id: replyId,
            context: {
                // The chosen cofounder, for tone. The server accepts only known ids.
                persona: personaId || undefined,
                page: pageRef.current,
                recentEntities: before.entities || [],
                // Cards still waiting, so "scrap that" or (on a call) "yes, do it"
                // is understood against them by the model — not matched by the app.
                openCards: prior
                    .filter((m) => m.kind === 'action' && m.card?.status === 'proposed')
                    .slice(-5)
                    // A plan is always tapped, never agreed to out loud.
                    .map((m) => ({ action_id: m.actionId, title: m.card.title, risk: m.card.kind === 'plan' ? 'high' : m.card.risk })),
                // What Buddy did or tried just before — the server's record,
                // so "did it work?" and "send the same one again" are answered
                // from fact.
                recentActions: prior
                    .filter((m) => m.kind === 'action' && m.card && m.card.status !== 'proposed' && m.card.status !== 'executing')
                    .slice(-6)
                    .map((m) => ({ action_id: m.actionId, tool: m.card.tool, title: m.card.title, status: m.card.status, summary: m.card.summary || m.card.error || '' })),
                source: source || undefined,
            },
            voice,
            channel: voice ? 'voice' : source ? 'insight' : 'chat',
            ...body,
        }, onEvent).then(finish).catch((err) => {
            said = err?.message || 'x';
            if (!stale()) patchMessage(replyId, { content: err?.message || 'Something went wrong.', error: true });
            finish();
        });
    }, [orgId, personaId, append, patchMessage, remember, navigate, setExchange]);

    /** The question still waiting in this exchange, if its last message is one. */
    const openQuestion = (x) => {
        const last = [...(x?.messages || [])].reverse().find((m) => m.role === 'assistant');
        return last && (last.kind === 'input' || last.kind === 'choice') && !last.resolved ? last : null;
    };

    /* ── cards ─────────────────────────────────────────────────────────── */

    const setCard = useCallback((messageId, card, extra = {}) => {
        patchMessage(messageId, { card, content: cardLine(card), ...extra });
    }, [patchMessage]);
    const find = (messageId) => xRef.current.messages.find((m) => m.id === messageId);

    /** A card the agent changed in its own turn (withdrawn, or confirmed on a call). */
    const cardUpdateRef = useRef(null);
    cardUpdateRef.current = ({ card, entities }) => {
        const msg = xRef.current.messages.find((m) => m.actionId === card?.action_id);
        if (!msg) return;
        setCard(msg.id, card);
        if (card.status === 'executed') {
            refreshScreens(card.tables);
            remember(msg.id, entities || card.entities);
            append([{ id: uid('m'), role: 'assistant', content: doneLine(card) }]);
        }
    };

    const confirmCard = useCallback(async (messageId, { selected, edits } = {}) => {
        const msg = find(messageId);
        if (!msg?.card || msg.card.status !== 'proposed') return;
        setCard(messageId, { ...msg.card, status: 'executing', error: null });
        try {
            const res = await confirmAction(orgId, msg.actionId, { selected, edits });
            if (res.status === 'invalid') {
                setCard(messageId, { ...msg.card, status: 'proposed', error: res.message });
                return;
            }
            if (res.status === 'repreviewed') {
                setCard(messageId, { ...msg.card, status: 'expired', error: 'Changed since — see the updated card below.' });
                append([{ id: uid('m'), role: 'assistant', kind: 'action', actionId: res.card.action_id, card: res.card, content: cardLine(res.card) }]);
                return;
            }
            setCard(messageId, res.card || { ...msg.card, status: res.status });
            if (res.status === 'executed') {
                refreshScreens(res.card?.tables);
                remember(messageId, res.entities || res.card?.entities);
                append([{ id: uid('m'), role: 'assistant', content: doneLine(res.card) }]);
                // The undo toast: Undo is on the card for as long as the server allows it.
                if (res.card?.undo_until) setToast({ messageId, until: res.card.undo_until });
            }
        } catch (err) {
            setCard(messageId, { ...msg.card, status: 'proposed', error: err?.message || 'Could not reach the server.' });
        }
    }, [orgId, setCard, append, remember]);

    const cancelCard = useCallback(async (messageId) => {
        const msg = find(messageId);
        if (!msg?.card) return;
        setCard(messageId, { ...msg.card, status: 'cancelled' });
        try {
            const res = await cancelAction(orgId, msg.actionId);
            if (res.card) setCard(messageId, res.card);
        } catch { /* it expires on its own */ }
    }, [orgId, setCard]);

    const undoCard = useCallback(async (messageId) => {
        const msg = find(messageId);
        if (!msg?.card) return;
        setToast(null);
        try {
            const res = await undoAction(orgId, msg.actionId);
            if (res.status === 'undone') refreshScreens(res.card?.tables);
            if (res.card) setCard(messageId, res.card);
            else setCard(messageId, { ...msg.card, error: res.message });
        } catch (err) {
            setCard(messageId, { ...msg.card, error: err?.message || 'Could not undo.' });
        }
    }, [orgId, setCard]);

    /** Try again on a failed card (or a plan's failed steps): a fresh proposal below it. */
    const retryCard = useCallback(async (messageId) => {
        const msg = find(messageId);
        if (!msg?.card) return;
        try {
            const res = await retryAction(orgId, msg.actionId);
            if (res.card) {
                append([{ id: uid('m'), role: 'assistant', kind: 'action', actionId: res.card.action_id, card: res.card, content: cardLine(res.card) }]);
                remember(messageId, res.entities || res.card.entities);
            } else {
                append([{ id: uid('m'), role: 'assistant', kind: 'notice', content: res.message || 'That cannot be prepared again right now.' }]);
            }
        } catch (err) {
            setNote(err?.message || 'Could not reach the server.');
        }
    }, [orgId, append, remember]);

    // After a reload: cards that were still open get their real state.
    useEffect(() => {
        if (!orgId) return undefined;
        const ids = exchange.messages.filter((m) => m.kind === 'action' && LIVE.has(m.card?.status)).map((m) => m.actionId);
        if (!ids.length) return undefined;
        let gone = false;
        actionStatus(orgId, ids).then(({ cards }) => {
            if (gone) return;
            for (const card of cards || []) {
                const msg = xRef.current.messages.find((m) => m.actionId === card.action_id);
                if (msg && msg.card?.status !== card.status) setCard(msg.id, card);
            }
        }).catch(() => { /* shown as last known */ });
        return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store.key, orgId]);

    /* ── sending ───────────────────────────────────────────────────────── */

    const send = useCallback((text, opts = {}) => {
        const content = String(text ?? draft).trim();
        if (!content || streaming) return false;
        const userMsg = { id: uid('m'), role: 'user', content };
        setDraft('');
        setToast(null);

        // No word-matching here: whether this answers the open question, drops
        // it, withdraws a card or (on a call) agrees to one is for the model to
        // understand. It gets the question and the open cards alongside.
        const q = openQuestion(xRef.current);
        const src = q ? (q.input || q.choice) : null;
        const pending = src?.resume
            ? { ...src.resume, param: src.param, question: q.content }
            : null;

        runTurn({
            message: opts.voice ? `${content}\n\n${VOICE_INSTRUCTION}` : content,
            pending,
        }, [userMsg], { voice: !!opts.voice, source: opts.source || null });
        return true;
    }, [draft, streaming, runTurn]);

    /** A tapped chip on a question or a choice: it becomes the next exchange. */
    const answer = useCallback((messageId, option) => {
        if (streaming) return;
        const msg = find(messageId);
        const src = msg?.input || msg?.choice;
        if (!src?.resume) return;
        runTurn({
            resume: { ...src.resume, param: src.param, value: option.value },
        }, [{ id: uid('m'), role: 'user', content: option.label }]);
    }, [streaming, runTurn]);

    /** "Create it" on a nothing-found notice. */
    const takeOffer = useCallback((messageId) => {
        if (streaming) return;
        const msg = find(messageId);
        if (!msg?.offer) return;
        runTurn({ resume: { tool: msg.offer.tool, args: msg.offer.args } },
            [{ id: uid('m'), role: 'user', content: msg.offer.label || 'Yes, create it' }]);
    }, [streaming, runTurn]);

    /** Ask the same question again. Only a plain answer: a card is a proposal on the server, and asking again would propose it twice. */
    const regenerate = useCallback((messageId) => {
        if (streaming) return;
        const msgs = xRef.current.messages;
        const msg = msgs.find((m) => m.id === messageId);
        if (!msg || msg.kind || msgs[0]?.role !== 'user') return;
        runTurn({ message: msgs[0].content }, [msgs[0]]);
    }, [streaming, runTurn]);

    /**
     * A change proposed on another channel — a Telegram "Review in
     * StartupBuddy" link (/chat?action=<id>) — shown here as the exchange, so
     * it is reviewed, edited and approved through the same card and confirm
     * path as any other. The server returns it only if it is this person's,
     * in this company. null = not ready (no company yet).
     */
    const openAction = useCallback(async (actionId) => {
        if (!orgId) return null;
        if (!/^[0-9a-f-]{36}$/i.test(String(actionId || ''))) return false;
        if (xRef.current.messages.some((m) => m.actionId === actionId)) return true;
        try {
            const { cards } = await actionStatus(orgId, [actionId]);
            const card = cards?.[0];
            if (!card) { setNote('That change is no longer available.'); return false; }
            const where = card.channel === 'telegram' ? 'Telegram' : null;
            setExchange((x) => ({
                ...x, id: uid('x'), at: Date.now(), mood: null,
                messages: [
                    { id: uid('m'), role: 'assistant', at: Date.now(), content: where ? `You asked for this on ${where}. Review it here:` : 'Review this change:' },
                    { id: uid('m'), role: 'assistant', at: Date.now(), kind: 'action', actionId: card.action_id, card, content: cardLine(card) },
                ],
            }));
            return true;
        } catch (err) {
            setNote(err?.message || 'Could not open that change.');
            return false;
        }
    }, [orgId, setExchange]);

    /**
     * Something shown without a turn — the summary of a call that just ended,
     * a slash command's result. It becomes the exchange, and is never sent to
     * the model. `mood` is how it lands, when the caller knows; `cards` are
     * card messages to keep with it (what a call left waiting for a tap).
     */
    const addLocal = useCallback((msg, { mood = null, cards = [] } = {}) => {
        setExchange((x) => ({
            ...x, id: uid('x'), at: Date.now(), mood,
            messages: [{ id: uid('m'), role: 'assistant', at: Date.now(), content: '', ...msg }, ...cards],
        }));
    }, [setExchange]);

    const pendingQuestion = openQuestion(exchange);

    const value = useMemo(() => ({
        exchange, messages: exchange.messages, mood: exchange.mood,
        draft, setDraft, streaming, working, send, regenerate,
        answer, takeOffer, pendingQuestion,
        confirmCard, cancelCard, undoCard, retryCard, openAction,
        note, setNote, toast, setToast, speech, addLocal,
    }), [
        exchange, draft, streaming, working, send, regenerate,
        answer, takeOffer, pendingQuestion,
        confirmCard, cancelCard, undoCard, retryCard, openAction,
        note, toast, speech, addLocal,
    ]);

    return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AssistantCtx } from './assistantStore';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import { VOICE_INSTRUCTION } from '../../services/voice';
import {
    streamAgent, confirmAction, cancelAction, undoAction, actionStatus,
} from '../../services/agentService';
import { amountHints } from '../../shared/cashIntent';
import { cardLine } from './cardText';
import { orgStore } from '../../services/orgStore';

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
}

/* ══════════════════════════════════════════════════════════════════════════
   The assistant's state, held once for the whole app.

   Two surfaces show the same conversations: the panel docked into the hub,
   and the full-screen workspace every other page opens from the launcher.
   Keeping the chats here rather than in either surface is what lets a reply
   keep streaming while you move from one to the other, and what makes a chat
   started in the hub the same chat when you expand it.

   Every message goes to the agent (api/agent.js). It answers, and when the
   message means something should change, it sends back a CARD: a proposal
   the person confirms with a tap. Nothing here writes business data except
   the card buttons (confirm / undo), which call the server with the card's
   action id. A chat stores its cards by that id, so a reloaded thread asks
   the server for their current state instead of trusting a stale copy.

   Conversations live in localStorage, so the history survives a reload.
   ══════════════════════════════════════════════════════════════════════════ */

const STORE_KEY = 'edgeos.ai.chats';
const MAX_CHATS = 60;
const MAX_ENTITIES = 10;
const LIVE = new Set(['proposed', 'executing', 'confirmed']);

let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const newChat = () => ({ id: uid('c'), title: 'New chat', messages: [], entities: [], at: Date.now() });

/** First user line, trimmed to something that fits a history row. */
const titleFor = (text) => {
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > 44 ? one.slice(0, 44).trimEnd() + '…' : one || 'New chat';
};


/** The conversation as the model should read it: words, and one line per card. */
function historyOf(messages) {
    return messages
        .filter((m) => !m.error && (m.content || m.card))
        .map((m) => ({ role: m.role, content: m.kind === 'action' ? cardLine(m.card) : m.content }));
}

function loadChats() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
        if (Array.isArray(raw) && raw.length) {
            // A reply that was mid-stream when the tab closed will never finish.
            // Left empty it would render as a typing indicator forever.
            return raw.map((c) => ({
                entities: [],
                ...c,
                messages: (c.messages || [])
                    // The old in-browser cash card (before the agent) cannot be
                    // acted on any more; its stored line says what it was.
                    .map((m) => (m.kind === 'card' || m.kind === 'ask' ? { ...m, kind: undefined } : m))
                    .map((m) => (
                        m.role === 'assistant' && !m.content && !m.kind
                            ? { ...m, content: 'This reply was interrupted.', error: true }
                            : m
                    )),
            }));
        }
    } catch {
        // A corrupt or unreadable store is not worth a broken assistant.
    }
    return [newChat()];
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

export function AssistantProvider({ edgeContext, children }) {
    const [chats, setChats] = useState(loadChats);
    const [activeId, setActiveId] = useState(() => chats[0].id);
    const [draft, setDraft] = useState('');
    const [streaming, setStreaming] = useState(false);
    // A one-line "Checking tasks…" while a read tool runs. Not stored.
    const [working, setWorking] = useState('');
    const [open, setOpen] = useState(false);
    const [view, setView] = useState('chat');
    const [docks, setDocks] = useState(0);
    const [note, setNote] = useState('');

    const speech = useSpeechRecognition();
    const navigate = useNavigate();
    const location = useLocation();
    const orgId = edgeContext?.orgId || null;

    const chatsRef = useRef(chats);
    useEffect(() => { chatsRef.current = chats; }, [chats]);
    const pageRef = useRef(pageOf(location));
    useEffect(() => { pageRef.current = pageOf(location); }, [location]);

    const active = useMemo(() => chats.find((c) => c.id === activeId) || chats[0], [chats, activeId]);

    useEffect(() => {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(chats.slice(0, MAX_CHATS))); } catch { /* quota */ }
    }, [chats]);

    // Another tab wrote the history. Adopt it unless this tab is mid-reply.
    useEffect(() => {
        const onStorage = (e) => {
            if (e.key !== STORE_KEY || streaming) return;
            try {
                const next = JSON.parse(e.newValue || '[]');
                if (Array.isArray(next) && next.length) setChats(next);
            } catch { /* ignore */ }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [streaming]);

    useEffect(() => {
        if (!note) return undefined;
        const id = setTimeout(() => setNote(''), 2600);
        return () => clearTimeout(id);
    }, [note]);

    const patchChat = useCallback((id, fn) => {
        setChats((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
    }, []);

    const patchMessage = useCallback((chatId, messageId, fields) => {
        patchChat(chatId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...(typeof fields === 'function' ? fields(m) : fields) } : m)),
        }));
    }, [patchChat]);

    const append = useCallback((chatId, msgs, firstText) => {
        patchChat(chatId, (c) => ({
            ...c,
            at: Date.now(),
            title: (c.titled || c.messages.length) ? c.title : titleFor(firstText || msgs[0]?.content || ''),
            messages: [...c.messages, ...msgs],
        }));
    }, [patchChat]);

    /** Records this turn referred to, newest first, tagged with the turn. */
    const remember = useCallback((chatId, turn, entities) => {
        if (!entities?.length) return;
        patchChat(chatId, (c) => {
            const fresh = entities.map((e) => ({ type: e.type, id: e.id, label: e.label, turn }));
            const rest = (c.entities || []).filter((e) => !fresh.some((f) => f.id === e.id));
            return { ...c, entities: [...fresh, ...rest].slice(0, MAX_ENTITIES) };
        });
    }, [patchChat]);

    /* ── one turn with the agent ──────────────────────────────────────────── */

    /**
     * Runs a turn. `body` carries what the server needs besides the chat:
     * `message`, or `resume` (a tapped chip), and `pending` (an open question).
     */
    const runTurn = useCallback((chatId, body, leading = [], { voice = false } = {}) => {
        const replyId = uid('m');
        const chatNow = chatsRef.current.find((c) => c.id === chatId);
        append(chatId, [...leading, { id: replyId, role: 'assistant', content: '' }], leading[0]?.content);
        setStreaming(true);

        let said = '';
        let added = 0;
        const add = (msg) => { added += 1; append(chatId, [{ id: uid('m'), role: 'assistant', ...msg }]); };

        const onEvent = (event, data) => {
            switch (event) {
                case 'status': setWorking(data.text || ''); break;
                case 'text':
                    said = said ? `${said}\n\n${data.text}` : data.text;
                    patchMessage(chatId, replyId, { content: said });
                    setWorking('');
                    break;
                case 'card':
                    add({ kind: 'action', actionId: data.card.action_id, card: data.card, content: cardLine(data.card) });
                    remember(chatId, replyId, data.card.entities);
                    break;
                case 'choice':
                    add({ kind: 'choice', content: data.choice.question, choice: data.choice });
                    break;
                case 'input': {
                    // The amount is usually already in the conversation — a
                    // figure named a few lines up. Offer it back as a chip.
                    const msgs = chatsRef.current.find((c) => c.id === chatId)?.messages || [];
                    const hints = data.input.param === 'amount'
                        ? amountHints(msgs.filter((m) => !m.error).slice(-6).map((m) => m.content))
                        : [];
                    add({ kind: 'input', content: data.input.question, hint: data.input.hint || null, input: { ...data.input, options: [...hints, ...(data.input.options || [])].slice(0, 8) } });
                    break;
                }
                case 'notice': add({ kind: 'notice', content: data.text, offer: data.offer || null }); break;
                case 'navigate':
                    navigate(data.href);
                    // The full-screen workspace would hide the page just opened.
                    setOpen(false);
                    add({ kind: 'notice', content: `Opened ${data.label}.` });
                    break;
                case 'entities': remember(chatId, replyId, data.entities); break;
                case 'card_update': cardUpdateRef.current?.(chatId, data); added += 1; break;
                case 'error': patchMessage(chatId, replyId, { content: data.message || 'Something went wrong.', error: true }); said = data.message || 'x'; break;
                default: break;
            }
        };

        const finish = () => {
            setStreaming(false);
            setWorking('');
            // A turn that ended in a card needs no words of its own.
            if (!said) {
                if (added) patchChat(chatId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== replyId) }));
                else patchMessage(chatId, replyId, { content: 'I did not get an answer back. Try again?', error: true });
            }
        };

        const recent = chatNow?.entities || [];
        streamAgent({
            org_id: orgId,
            chat_id: chatId,
            message_id: replyId,
            history: historyOf(chatNow?.messages || []),
            context: {
                page: pageRef.current,
                recentEntities: recent,
                // Cards still waiting, so "scrap that" or (on a call) "yes, do it"
                // is understood against them by the model — not matched by the app.
                openCards: (chatNow?.messages || [])
                    .filter((m) => m.kind === 'action' && m.card?.status === 'proposed')
                    .slice(-5)
                    .map((m) => ({ action_id: m.actionId, title: m.card.title, risk: m.card.risk })),
            },
            voice,
            ...body,
        }, onEvent).then(finish).catch((err) => {
            said = err?.message || 'x';
            patchMessage(chatId, replyId, { content: err?.message || 'Something went wrong.', error: true });
            finish();
        });
    }, [orgId, append, patchChat, patchMessage, remember, navigate]);

    /** The question still waiting on this chat, if its last message is one. */
    const openQuestion = (chat) => {
        const last = [...(chat?.messages || [])].reverse().find((m) => m.role === 'assistant');
        return last && (last.kind === 'input' || last.kind === 'choice') && !last.resolved ? last : null;
    };

    /* ── cards ─────────────────────────────────────────────────────────── */

    const setCard = useCallback((chatId, messageId, card, extra = {}) => {
        patchMessage(chatId, messageId, { card, content: cardLine(card), ...extra });
    }, [patchMessage]);

    /** A card the agent changed in its own turn (withdrawn, or confirmed on a call). */
    const cardUpdateRef = useRef(null);
    cardUpdateRef.current = (chatId, { card, entities }) => {
        const msg = chatsRef.current.find((c) => c.id === chatId)?.messages.find((m) => m.actionId === card?.action_id);
        if (!msg) return;
        setCard(chatId, msg.id, card);
        if (card.status === 'executed') {
            refreshScreens(card.tables);
            remember(chatId, msg.id, entities || card.entities);
            append(chatId, [{ id: uid('m'), role: 'assistant', content: ['Done.', card.followUp].filter(Boolean).join(' ') }]);
        }
    };

    const confirmCard = useCallback(async (chatId, messageId, { selected, edits } = {}) => {
        const msg = chatsRef.current.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId);
        if (!msg?.card || msg.card.status !== 'proposed') return;
        setCard(chatId, messageId, { ...msg.card, status: 'executing', error: null });
        try {
            const res = await confirmAction(orgId, msg.actionId, { selected, edits });
            if (res.status === 'invalid') {
                setCard(chatId, messageId, { ...msg.card, status: 'proposed', error: res.message });
                return;
            }
            if (res.status === 'repreviewed') {
                setCard(chatId, messageId, { ...msg.card, status: 'expired', error: 'Changed since — see the updated card below.' });
                append(chatId, [{ id: uid('m'), role: 'assistant', kind: 'action', actionId: res.card.action_id, card: res.card, content: cardLine(res.card) }]);
                return;
            }
            setCard(chatId, messageId, res.card || { ...msg.card, status: res.status });
            if (res.status === 'executed') {
                refreshScreens(res.card?.tables);
                remember(chatId, messageId, res.entities || res.card?.entities);
                append(chatId, [{ id: uid('m'), role: 'assistant', content: ['Done.', res.card?.followUp].filter(Boolean).join(' ') }]);
            }
        } catch (err) {
            setCard(chatId, messageId, { ...msg.card, status: 'proposed', error: err?.message || 'Could not reach the server.' });
        }
    }, [orgId, setCard, append, remember]);

    const cancelCard = useCallback(async (chatId, messageId) => {
        const msg = chatsRef.current.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId);
        if (!msg?.card) return;
        setCard(chatId, messageId, { ...msg.card, status: 'cancelled' });
        try {
            const res = await cancelAction(orgId, msg.actionId);
            if (res.card) setCard(chatId, messageId, res.card);
        } catch { /* it expires on its own */ }
    }, [orgId, setCard]);

    const undoCard = useCallback(async (chatId, messageId) => {
        const msg = chatsRef.current.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId);
        if (!msg?.card) return;
        try {
            const res = await undoAction(orgId, msg.actionId);
            if (res.status === 'undone') refreshScreens(res.card?.tables);
            if (res.card) setCard(chatId, messageId, res.card);
            else setCard(chatId, messageId, { ...msg.card, error: res.message });
        } catch (err) {
            setCard(chatId, messageId, { ...msg.card, error: err?.message || 'Could not undo.' });
        }
    }, [orgId, setCard]);

    // A reopened thread: cards that were still open get their real state.
    useEffect(() => {
        if (!orgId) return;
        const ids = (active.messages || []).filter((m) => m.kind === 'action' && LIVE.has(m.card?.status)).map((m) => m.actionId);
        if (!ids.length) return;
        let gone = false;
        actionStatus(orgId, ids).then(({ cards }) => {
            if (gone) return;
            for (const card of cards || []) {
                const msg = active.messages.find((m) => m.actionId === card.action_id);
                if (msg && msg.card?.status !== card.status) setCard(active.id, msg.id, card);
            }
        }).catch(() => { /* shown as last known */ });
        return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active.id, orgId]);

    /* ── sending ───────────────────────────────────────────────────────── */

    const send = useCallback((text, opts = {}) => {
        const content = String(text ?? draft).trim();
        if (!content || streaming) return;
        const chatId = opts.chatId || active.id;
        const chat = chatsRef.current.find((c) => c.id === chatId);
        const userMsg = { id: uid('m'), role: 'user', content };
        setDraft('');

        // No word-matching here: whether this answers the open question, drops
        // it, withdraws a card or (on a call) agrees to one is for the model to
        // understand. It gets the question and the open cards alongside.
        const q = openQuestion(chat);
        const src = q ? (q.input || q.choice) : null;
        const pending = src?.resume
            ? { ...src.resume, param: src.param, question: q.content }
            : null;
        if (q) patchMessage(chatId, q.id, { resolved: true });

        runTurn(chatId, {
            message: opts.voice ? `${content}\n\n${VOICE_INSTRUCTION}` : content,
            pending,
        }, [userMsg], { voice: !!opts.voice });
    }, [draft, streaming, active, patchMessage, runTurn]);

    /** A tapped chip on a question or a choice. */
    const answer = useCallback((messageId, option) => {
        if (streaming) return;
        const chatId = active.id;
        const msg = active.messages.find((m) => m.id === messageId);
        const src = msg?.input || msg?.choice;
        if (!src?.resume) return;
        patchMessage(chatId, messageId, { resolved: true });
        runTurn(chatId, {
            resume: { ...src.resume, param: src.param, value: option.value },
        }, [{ id: uid('m'), role: 'user', content: option.label }]);
    }, [streaming, active, patchMessage, runTurn]);

    /** "Create it" on a nothing-found notice. */
    const takeOffer = useCallback((messageId) => {
        if (streaming) return;
        const msg = active.messages.find((m) => m.id === messageId);
        if (!msg?.offer) return;
        patchMessage(active.id, messageId, { offer: null });
        runTurn(active.id, { resume: { tool: msg.offer.tool, args: msg.offer.args } },
            [{ id: uid('m'), role: 'user', content: msg.offer.label || 'Yes, create it' }]);
    }, [streaming, active, patchMessage, runTurn]);

    const dismissQuestion = useCallback((chatId, messageId) => {
        patchMessage(chatId, messageId, { resolved: true });
        append(chatId, [{ id: uid('m'), role: 'assistant', content: 'Left it there — nothing was changed.' }]);
    }, [patchMessage, append]);

    /**
     * Ask again. The answer is replaced and the conversation resumes from the
     * question that produced it. Only plain answers regenerate: a card is a
     * proposal on the server, and asking again would propose it twice.
     */
    const regenerate = useCallback((messageId) => {
        if (streaming) return;
        const chatId = activeId;
        const msgs = chatsRef.current.find((c) => c.id === chatId)?.messages || [];
        const at = msgs.findIndex((m) => m.id === messageId);
        const qAt = at - 1;
        if (at < 0 || msgs[qAt]?.role !== 'user' || msgs[at].kind) return;
        const question = msgs[qAt].content;
        patchChat(chatId, (c) => ({ ...c, messages: c.messages.slice(0, qAt) }));
        chatsRef.current = chatsRef.current.map((c) => (c.id === chatId ? { ...c, messages: c.messages.slice(0, qAt) } : c));
        runTurn(chatId, { message: question }, [msgs[qAt]]);
    }, [streaming, activeId, patchChat, runTurn]);

    /* ── chats ─────────────────────────────────────────────────────────── */

    const startChat = useCallback(() => {
        const blank = chatsRef.current.find((c) => !c.messages.length);
        if (blank) {
            setActiveId(blank.id);
        } else {
            const c = newChat();
            setChats((cs) => [c, ...cs]);
            setActiveId(c.id);
        }
        setDraft('');
        setView('chat');
    }, []);

    /** A question from elsewhere on the page, asked in a fresh chat. */
    const askNew = useCallback((text) => {
        const content = String(text || '').trim();
        if (!content || streaming) return false;
        const current = chatsRef.current.find((c) => c.id === activeId);
        let chatId = current?.id;
        if (!current || current.messages.length) {
            const blank = chatsRef.current.find((c) => !c.messages.length);
            if (blank) chatId = blank.id;
            else {
                const c = newChat();
                setChats((cs) => [c, ...cs]);
                chatsRef.current = [c, ...chatsRef.current];
                chatId = c.id;
            }
        }
        setActiveId(chatId);
        setView('chat');
        send(content, { chatId });
        return true;
    }, [streaming, activeId, send]);

    const pickChat = useCallback((id) => {
        setActiveId(id);
        setDraft('');
        setView('chat');
    }, []);

    const removeChat = useCallback((id) => {
        setChats((cs) => {
            const rest = cs.filter((c) => c.id !== id);
            const next = rest.length ? rest : [newChat()];
            if (id === activeId) setActiveId(next[0].id);
            return next;
        });
    }, [activeId]);

    /** Deletes every chat except those pinned. */
    const clearHistory = useCallback(() => {
        setChats((cs) => {
            const kept = cs.filter((c) => c.pinned);
            const next = kept.length ? kept : [newChat()];
            if (!next.some((c) => c.id === activeId)) setActiveId(next[0].id);
            return next;
        });
    }, [activeId]);

    const renameChat = useCallback((id, title) => {
        const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!clean) return;
        patchChat(id, (c) => ({ ...c, title: clean, titled: true }));
    }, [patchChat]);

    const togglePin = useCallback((id) => patchChat(id, (c) => ({ ...c, pinned: !c.pinned })), [patchChat]);

    /**
     * Share: the system share sheet where there is one, the clipboard where
     * there is not. Not a link — these chats live in this browser only.
     */
    const shareChat = useCallback(async (chat) => {
        const text = (chat.messages || [])
            .filter((m) => !m.error && m.content)
            .map((m) => `${m.role === 'user' ? 'You' : 'EdgeAI'}: ${m.content}`)
            .join('\n\n');
        if (!text) { setNote('That chat is empty — nothing to share yet.'); return; }
        const payload = `${chat.title}\n\n${text}`;
        try {
            if (navigator.share) {
                await navigator.share({ title: chat.title, text: payload });
                return;
            }
            await navigator.clipboard.writeText(payload);
            setNote('Conversation copied to your clipboard.');
        } catch {
            if (!navigator.share) setNote('Could not copy this conversation.');
        }
    }, []);

    const registerDock = useCallback(() => {
        setDocks((n) => n + 1);
        return () => setDocks((n) => Math.max(0, n - 1));
    }, []);

    const pendingQuestion = openQuestion(active);

    const value = useMemo(() => ({
        chats, active, activeId: active.id, messages: active.messages,
        draft, setDraft, streaming, working, send, askNew, regenerate,
        startChat, pickChat, removeChat, clearHistory, renameChat, togglePin, shareChat,
        answer, takeOffer, dismissQuestion, pendingQuestion,
        confirmCard, cancelCard, undoCard,
        open, setOpen, view, setView, docked: docks > 0, registerDock,
        note, setNote, speech,
    }), [
        chats, active, draft, streaming, working, send, askNew, regenerate,
        startChat, pickChat, removeChat, clearHistory, renameChat, togglePin, shareChat,
        answer, takeOffer, dismissQuestion, pendingQuestion,
        confirmCard, cancelCard, undoCard,
        open, view, docks, registerDock, note, speech,
    ]);

    return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>;
}

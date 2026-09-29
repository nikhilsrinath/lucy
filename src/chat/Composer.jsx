import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useShell } from '../shell/shellContext';
import { useMoneyData } from '../money/useMoneyData';
import { IconPlus, IconCall, IconMic, IconSend } from '../design/icons';
import PlusMenu from './PlusMenu';
import SlashPalette from './SlashPalette';
import SlashWizard from './SlashWizard';
import { matchSlashCommands, SLASH_COMMANDS, slashWizardFor, parseSlashAnswer } from './slashCommands';
import { orgStore } from '../services/orgStore';

/* ══════════════════════════════════════════════════════════════════════════
   The one message box — under every section, not just Chat (plan §8.2).

   Upgraded with:
   1. '+' Button context menu with folder submenus & quick actions
   2. Instant slash commands ('/netcash', '/revenue', '/overdue', '/tax', etc.)
   3. Direct 0ms execution without LLM calls for instant business queries
   ══════════════════════════════════════════════════════════════════════════ */

const SUGGESTIONS = [
    { label: 'Who owes me?', prompt: 'Who owes me money?' },
    { label: 'Log an expense', prompt: 'Log an expense' },
    { label: 'New quote', prompt: 'Make a quote' },
    { label: 'Add a task', prompt: 'Add a task' },
    { label: "How's the month?", prompt: 'How did we do this month?', needsBrain: true },
];

const placeholderFor = (section, name) => ({
    chat: `Message ${name}, or type / for commands`,
    money: `Ask ${name} about money, or type /`,
    clients: 'Ask about a client, or add a lead',
    work: "Add a task, or ask what's next",
    team: 'Ask about the team',
    settings: `Ask ${name} a question`,
}[section] || `Message ${name}`);

export default function Composer({ section, persona, brainBuilt = false }) {
    const a = useAssistant();
    const shell = useShell();
    const moneyData = useMoneyData();
    const navigate = useNavigate();
    const inputRef = useRef(null);
    const { draft, setDraft, send, streaming, speech, addLocal } = a;
    const { supported, listening, finalText, interim, start, stop, reset } = speech;
    const onChat = section === 'chat';

    const [showPlusMenu, setShowPlusMenu] = useState(false);
    const [webSearchEnabled, setWebSearchEnabled] = useState(true);
    const [slashIndex, setSlashIndex] = useState(0);
    const [wizard, setWizard] = useState(null);
    const [wizardError, setWizardError] = useState('');
    const [wizardBusy, setWizardBusy] = useState(false);

    // Dictation writes into the draft; `baseRef` is what was typed before it.
    const baseRef = useRef('');
    const dictatingRef = useRef(false);

    // Check if user is typing a slash command
    const isSlash = draft.startsWith('/');
    const slashMatches = useMemo(() => (isSlash ? matchSlashCommands(draft) : []), [isSlash, draft]);

    useEffect(() => {
        setSlashIndex(0);
    }, [draft]);

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

    // Ctrl+U global shortcut to open file upload
    useEffect(() => {
        const onGlobalKey = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
                e.preventDefault();
                shell.openFiles({ upload: true });
            }
        };
        window.addEventListener('keydown', onGlobalKey);
        return () => window.removeEventListener('keydown', onGlobalKey);
    }, [shell]);

    const toggleMic = () => {
        if (listening) { stop(); return; }
        baseRef.current = draft.trim();
        reset();
        dictatingRef.current = true;
        start({ autoStop: true });
    };

    const startWizard = (cmd, textAfter = '') => {
        const definition = slashWizardFor(cmd.name);
        if (!definition) return false;
        const next = { definition, index: 0, values: {} };
        const seed = textAfter.trim();
        if (seed && ['expense', 'income'].includes(cmd.name)) {
            const match = seed.match(/^([\d,]+(?:\.\d+)?)\s*(.*)$/);
            if (match) {
                next.values.amount = Number(match[1].replace(/,/g, ''));
                if (match[2].trim()) next.values.description = match[2].trim();
                next.index = match[2].trim() ? 2 : 1;
            }
        } else if (seed && cmd.name === 'client') {
            next.values.clientName = seed;
            next.index = definition.questions.length;
        } else if (seed && cmd.name === 'task') {
            next.values.title = seed;
            next.index = 1;
        } else if (seed) {
            next.values.clientName = seed;
            next.index = 1;
        }
        setWizardError('');
        setWizard(next.index >= definition.questions.length ? { ...next, ready: true } : next);
        setDraft('');
        return true;
    };

    // Each new question puts the cursor back in the box for the answer.
    const wizardStep = wizard ? (wizard.ready ? 'ready' : wizard.index) : null;
    useEffect(() => {
        if (wizardStep !== null) inputRef.current?.focus();
    }, [wizardStep]);

    const answerWizard = (answer) => {
        if (!wizard || wizard.ready) return;
        const question = wizard.definition.questions[wizard.index];
        const parsed = parseSlashAnswer(question.key, answer);
        if (parsed.error) { setWizardError(parsed.error); return; }
        const values = { ...wizard.values, [question.key]: parsed.value };
        const index = wizard.index + 1;
        setWizardError('');
        setDraft('');
        // After editing an earlier answer, jump to the next unanswered question.
        const nextOpen = wizard.definition.questions.findIndex((q, i) => i >= index && !(q.key in values));
        setWizard(nextOpen === -1 ? { ...wizard, values, ready: true } : { ...wizard, values, index: nextOpen });
        inputRef.current?.focus();
    };

    const editWizardStep = (i) => {
        if (!wizard) return;
        const key = wizard.definition.questions[i].key;
        setWizardError('');
        setWizard({ ...wizard, index: i, ready: false });
        setDraft(key in wizard.values ? String(wizard.values[key] ?? '') : '');
        inputRef.current?.focus();
    };

    const cancelWizard = () => {
        setWizard(null);
        setWizardError('');
        setDraft('');
    };

    const saveWizard = async () => {
        if (!wizard?.ready) return;
        const { kind } = wizard.definition;
        const v = wizard.values;
        setWizardBusy(true);
        try {
            if (kind === 'expense' || kind === 'income') {
                await orgStore.addItem(kind === 'expense' ? 'expenses' : 'income_entries', {
                    description: v.description,
                    original_amount: v.amount,
                    currency: 'INR', fx_rate: 1,
                    category: kind === 'expense' ? 'other_expense' : 'other_income',
                    date: new Date().toISOString().slice(0, 10),
                    payment_method: 'bank_transfer',
                    ...(kind === 'expense' ? { status: 'paid' } : {}),
                });
                addLocal({ content: `Recorded ${kind} of ₹${Number(v.amount).toLocaleString('en-IN')} for ${v.description}.`, kind: 'instant', title: 'Slash command completed' });
            } else if (kind === 'task') {
                await orgStore.addItem('tasks', {
                    title: v.title,
                    description: '',
                    deadline: v.deadline || null,
                    status: 'pending', priority: 'medium',
                    assignedTo: '', assignedName: '', assignedEmail: '', notes: '',
                });
                addLocal({ content: `Created task: ${v.title}${v.deadline ? ` (due ${v.deadline})` : ''}.`, kind: 'instant', title: 'Slash command completed' });
            } else if (kind === 'client') {
                await orgStore.addItem('customers', { clientName: v.clientName, status: 'active' });
                addLocal({ content: `Added client: ${v.clientName}.`, kind: 'instant', title: 'Slash command completed' });
            } else if (kind === 'invoice' || kind === 'quotation') {
                navigate(kind === 'invoice' ? '/money/invoices/new' : '/money/invoices/new?type=quotation', {
                    state: { slashPrefill: { clientName: v.clientName, description: v.description, amount: v.amount, gstRate: v.gstRate }, autoSubmit: true },
                });
            } else if (kind === 'offer') {
                navigate('/team/letters/offer/new', { state: { slashPrefill: v, autoSubmit: true } });
            }
            setWizard(null);
            setWizardError('');
        } catch (err) {
            setWizardError(err.message || 'Could not save this entry.');
        } finally {
            setWizardBusy(false);
        }
    };

    /**
     * Executes or routes a slash command
     */
    const executeCommand = (cmd, textAfter = '') => {
        setShowPlusMenu(false);
        if (startWizard(cmd, textAfter)) return;
        if (!onChat) navigate('/chat');

        // 1. Instant calculation (0ms, 0 tokens)
        if (cmd.instant && typeof cmd.run === 'function') {
            setDraft('');
            const result = cmd.run({ data: moneyData, a, shell, navigate });
            if (result) {
                addLocal({
                    content: result,
                    kind: 'instant',
                    title: cmd.description,
                });
            }
            return;
        }

        // 2. Direct client-side action
        if (cmd.action) {
            setDraft('');
            cmd.action({ a, shell, navigate });
            return;
        }

        // 3. Navigation command
        if (cmd.navigate && !textAfter.trim()) {
            setDraft('');
            navigate(cmd.navigate);
            return;
        }

        // 4. Prompt routing to cofounder
        const promptText = (cmd.prompt ? cmd.prompt : '') + (textAfter || '');
        setDraft('');
        send(promptText || `/${cmd.name}`);
    };

    const handleSelectSlash = (cmd) => {
        executeCommand(cmd);
    };

    const go = (text) => {
        if (streaming) return;
        dictatingRef.current = false;
        if (listening) stop();

        const msg = String(text ?? draft).trim();
        if (!msg) return;

        // Intercept slash commands
        if (msg.startsWith('/')) {
            const parts = msg.slice(1).split(/\s+/);
            const cmdName = parts[0].toLowerCase();
            const rest = parts.slice(1).join(' ');
            const found = SLASH_COMMANDS.find(
                (c) => c.name === cmdName || c.aliases?.includes(cmdName)
            );

            if (found) {
                executeCommand(found, rest);
                return;
            }
        }

        if (!onChat) navigate('/chat');
        send(msg);
    };

    const canSend = Boolean(draft.trim()) && !streaming;
    const submit = (e) => {
        e?.preventDefault();
        if (!canSend) return;
        if (wizard && !wizard.ready) { answerWizard(draft); return; }
        go();
    };
    const pending = onChat && a.pendingQuestion && !streaming ? a.pendingQuestion : null;

    const handleKeyDown = (e) => {
        if (wizard && e.key === 'Escape') {
            e.preventDefault();
            cancelWizard();
            return;
        }
        if (wizard?.ready && e.key === 'Enter' && !e.shiftKey && !draft.trim()) {
            e.preventDefault();
            saveWizard();
            return;
        }
        if (isSlash && slashMatches.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSlashIndex((prev) => (prev + 1) % slashMatches.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashIndex((prev) => (prev - 1 + slashMatches.length) % slashMatches.length);
                return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
                e.preventDefault();
                const selected = slashMatches[slashIndex] || slashMatches[0];
                if (selected) handleSelectSlash(selected);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setDraft('');
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
        }
    };

    return (
        <div className="sb-composer">
            <div className="in">
                {onChat && !wizard && a.messages.length === 0 && (
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

                {wizard && (
                    <SlashWizard
                        wizard={wizard}
                        error={wizardError}
                        busy={wizardBusy}
                        onAnswer={answerWizard}
                        onEdit={editWizardStep}
                        onCreate={saveWizard}
                        onCancel={cancelWizard}
                    />
                )}

                <div className="sb-composer-box">
                    {/* Floating Plus Menu matching screenshot */}
                    <PlusMenu
                        isOpen={showPlusMenu}
                        onClose={() => setShowPlusMenu(false)}
                        onUpload={() => shell.openFiles({ upload: true })}
                        onCapture={() => shell.openFiles({ upload: true })}
                        onRunInstant={(type, customPrompt) => {
                            if (type === 'prompt' && customPrompt) {
                                go(customPrompt);
                            } else {
                                const found = SLASH_COMMANDS.find((c) => c.name === type);
                                if (found) executeCommand(found);
                            }
                        }}
                        onNavigate={(path) => navigate(path)}
                        onStartCall={() => shell.startCall()}
                        webSearchEnabled={webSearchEnabled}
                        onToggleWebSearch={() => setWebSearchEnabled((prev) => !prev)}
                    />

                    {/* Floating Slash Autocomplete Palette */}
                    {isSlash && slashMatches.length > 0 && (
                        <SlashPalette
                            commands={slashMatches}
                            selectedIndex={slashIndex}
                            onSelect={handleSelectSlash}
                            onClose={() => setDraft('')}
                        />
                    )}

                    <form className="sb-bar" onSubmit={submit} autoComplete="off">
                        {/* The '+' button triggering the context menu */}
                        <button
                            type="button"
                            className={`i sb-plus-btn ${showPlusMenu ? 'on' : ''}`}
                            onClick={() => setShowPlusMenu((prev) => !prev)}
                            aria-label="Add actions, files and skills"
                            title="Add actions and skills"
                        >
                            <IconPlus size={15} />
                        </button>

                        <textarea
                            ref={inputRef}
                            rows={1}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={listening ? 'Listening…'
                                : wizard ? (wizard.ready ? 'Press Enter to create, or tap a row to edit' : wizard.definition.questions[wizard.index].placeholder || 'Type your answer')
                                : placeholderFor(section, persona.name)}
                            aria-label={`Message ${persona.name}`}
                        />

                        {supported && (
                            <button
                                type="button"
                                className={`i${listening ? ' on' : ''}`}
                                onClick={toggleMic}
                                aria-label={listening ? 'Stop dictation' : 'Dictate'}
                                aria-pressed={listening}
                            >
                                <IconMic size={18} />
                            </button>
                        )}

                        {shell.canCall && (
                            <button
                                type="button"
                                className="i"
                                onClick={() => shell.startCall()}
                                aria-label={`Call ${persona.name}`}
                            >
                                <IconCall size={17} outline />
                            </button>
                        )}

                        {streaming ? (
                            <span className="spin" role="status" aria-label={`${persona.name} is replying`}>
                                <i />
                            </span>
                        ) : (
                            <button
                                type="submit"
                                className="i send"
                                disabled={!canSend}
                                aria-label="Send"
                            >
                                <IconSend />
                            </button>
                        )}
                    </form>
                </div>

                {onChat && (
                    <div className="sb-hint">
                        {persona.name} proposes changes as cards. Type <b>/</b> for instant metrics or click <b>+</b> for tools.
                    </div>
                )}
            </div>
        </div>
    );
}

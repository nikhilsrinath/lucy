import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useAuth } from '../context/AuthContext';
import { useCofounder } from '../design/useCofounder';
import { Button, Sheet } from '../design/ui';
import { IconCall, IconFile } from '../design/icons';
import { CofounderAvatar, CofounderFace, MoodBackdrop } from '../design/art/Art';
import CofounderChooser from '../design/CofounderChooser';
import { useShell } from '../shell/shellContext';
import { useMe } from '../shell/useMe';
import { useBrief } from './useBrief';
import { useBriefActions } from './useBriefActions';
import Brief from './BriefCard';
import Exchange from './ExchangeView';
import Composer from './Composer';
import { currentExchange } from './exchange';
import { stageFor } from './stage';
import './chat.css';
import './mood.css';

/* ══════════════════════════════════════════════════════════════════════════
   Buddy — the cofounder, on one screen (buddy-mood-chat.html).

   Top: the mood. The background crossfades to the mood's scene, the
   cofounder's pose for it pops in, and the headline word and tag sit
   top-left. The server decides the mood (the `mood` event that ends a turn);
   while a reply is loading it is "thinking".

   Below: a white panel holding ONLY the current exchange — the question and
   the cofounder's answer with its card, plan, view or quick picks — and the
   composer. Asking something new replaces it. There is no chat list and no
   history.

   Before anything is asked the panel shows today's brief (brief.js): built in
   the browser, never sent to the model.
   ══════════════════════════════════════════════════════════════════════════ */

export default function ChatScreen() {
    const a = useAssistant();
    const shell = useShell();
    const navigate = useNavigate();
    const location = useLocation();
    const { user } = useAuth();
    const { persona, chosen, setCofounder } = useCofounder();
    const me = useMe();
    const { brief, build, building, buildError, dismissInsight, insightsLoading } = useBrief({ persona, name: me.name });
    // Existing users who never picked a cofounder are asked once, here.
    const chooserKey = user?.id ? `startupbuddy.chooser.seen.${user.id}` : null;
    const [chooserSeen, setChooserSeen] = useState(() => {
        try { return !chooserKey || !!localStorage.getItem(chooserKey); } catch { return true; }
    });
    const closeChooser = () => { try { localStorage.setItem(chooserKey, '1'); } catch { /* fine */ } setChooserSeen(true); };
    const scrollRef = useRef(null);

    const { question, items } = currentExchange(a.messages);
    const empty = !question && !items.length;
    const stage = stageFor({ persona, mood: a.mood, streaming: a.streaming, empty });

    // /chat?files=1 (the old /library) opens the Files sheet.
    useEffect(() => {
        const q = new URLSearchParams(location.search);
        if (q.get('files')) { shell.openFiles(); navigate('/chat', { replace: true }); }
    }, [location.search, shell, navigate]);

    // /chat?action=<id> — "Review in StartupBuddy" from Telegram: open that card.
    const openAction = a.openAction;
    useEffect(() => {
        const id = new URLSearchParams(location.search).get('action');
        if (!id || !openAction) return undefined;
        let gone = false;
        openAction(id).then((done) => { if (!gone && done !== null) navigate('/chat', { replace: true }); });
        return () => { gone = true; };
    }, [location.search, openAction, navigate]);

    // A new exchange starts from the top; a growing answer stays in view.
    const xid = a.exchange?.id;
    useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [xid]);

    const open = (href) => navigate(href);
    const { onKpi, onSuggestion, runInsightAction } = useBriefActions({ build });

    const toast = a.toast;
    useEffect(() => {
        if (!toast) return undefined;
        const id = setTimeout(() => a.setToast(null), 6000);
        return () => clearTimeout(id);
    }, [toast, a]);

    return (
        <section className={`sb-chat mc mood-${stage.mood}`} aria-label={`Buddy: ${persona.name}`}>
            <div className="mc-stage">
                <MoodBackdrop id={persona.art} mood={stage.mood} />
                <div className="mc-in">
                    <header className="mc-top">
                        <Link to="/settings#set-cofounder" className="mc-pill" aria-label={`${persona.name}, ${persona.title}. Change cofounder`}>
                            <CofounderFace id={persona.art} mood={stage.mood} size={24} />
                            {persona.name} <small>· {persona.role}</small>
                        </Link>
                        <button type="button" className="mc-ib" onClick={() => shell.openFiles()} aria-label="Files"><IconFile /></button>
                        {shell.canCall && (
                            <button type="button" className="mc-ib" onClick={() => shell.startCall()} aria-label={`Call ${persona.name}`}><IconCall size={16} /></button>
                        )}
                    </header>
                    <div className="mc-head" aria-live="polite">
                        <div className="word">{stage.word}</div>
                        <span className="tag">{stage.tag}</span>
                    </div>
                    <CofounderAvatar key={`${persona.art}-${stage.mood}-${xid}`} id={persona.art} mood={stage.mood} className="mc-avatar pop" />
                </div>
            </div>

            <div className="mc-panel">
                <div className="mc-scroll" ref={scrollRef} aria-live="polite">
                    {empty ? (
                        <Brief brief={brief} persona={persona} onKpi={onKpi} onSuggestion={onSuggestion}
                            onInsight={runInsightAction} onDismiss={dismissInsight} checking={insightsLoading}
                            building={building} buildError={buildError} />
                    ) : (
                        <Exchange a={a} persona={persona} mood={stage.mood} tag={stage.tag} onOpen={open} />
                    )}
                </div>
                <Composer section="chat" persona={persona} brainBuilt={shell.brainBuilt} />
                {toast && (
                    <div className="mc-toast" role="status">
                        <span>Done. You can undo for 10 minutes.</span>
                        <button type="button" onClick={() => a.undoCard(toast.messageId)}>Undo</button>
                    </div>
                )}
            </div>

            {a.note && <div className="sb sb-toast" role="status">{a.note}</div>}
            <Sheet open={!chosen && !chooserSeen && !!chooserKey} onClose={closeChooser} title="Choose your cofounder" size="wide">
                <CofounderChooser value={persona.id} cta={(p) => `Continue with ${p.name}`}
                    onPick={async (p, extra) => { await setCofounder(p.id, extra).catch(() => {}); closeChooser(); }} />
            </Sheet>
        </section>
    );
}

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useAuth } from '../context/AuthContext';
import { useOrg } from '../context/OrgContext';
import { useCofounder } from '../design/useCofounder';
import { Button, PixelAvatar } from '../design/ui';
import { ME_AVATAR } from '../design/personas';
import { IconCall, IconFile, IconClock, IconPlus, IconBolt } from '../design/icons';
import { useShell } from '../shell/shellContext';
import { useMe } from '../shell/useMe';
import { useBrief } from './useBrief';
import { useBriefActions } from './useBriefActions';
import { isoDay } from './brief';
import Brief from './BriefCard';
import Feed from './Feed';
import ChatsSheet from './ChatsSheet';
import CofounderCarousel from '../design/CofounderCarousel';
import { Sheet } from '../design/ui';
import './chat.css';

/* ══════════════════════════════════════════════════════════════════════════
   Buddy — the cofounder: conversation, voice, files and memory, commands,
   and the actions it prepares for you to review and confirm.

   The first chat of each day opens with the brief (brief.js): built in the
   browser, never sent to the model, never stored as a message. Which chat is
   "today's" is remembered per company and person, so the brief stays at the
   top of that conversation for the rest of the day.
   ══════════════════════════════════════════════════════════════════════════ */

const briefKey = (org, user) => `startupbuddy.brief.${org}.${user}`;
const readRec = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const writeRec = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export default function ChatScreen() {
    const a = useAssistant();
    const shell = useShell();
    const navigate = useNavigate();
    const location = useLocation();
    const { user } = useAuth();
    const { activeOrg } = useOrg();
    const { persona, chosen, setCofounder } = useCofounder();
    const me = useMe();
    const { brief, build, building, buildError } = useBrief({ persona, name: me.name });
    const [chatsOpen, setChatsOpen] = useState(false);
    // Existing users who never picked a cofounder are asked once, here.
    const chooserKey = user?.id ? `startupbuddy.chooser.seen.${user.id}` : null;
    const [chooserSeen, setChooserSeen] = useState(() => {
        try { return !chooserKey || !!localStorage.getItem(chooserKey); } catch { return true; }
    });
    const [pick, setPick] = useState(persona);
    const closeChooser = () => { try { localStorage.setItem(chooserKey, '1'); } catch { /* fine */ } setChooserSeen(true); };
    const scrollRef = useRef(null);

    const today = isoDay(new Date());
    const key = activeOrg?.id && user?.id ? briefKey(activeOrg.id, user.id) : null;
    const rec = key ? readRec(key) : null;
    const recToday = rec?.day === today ? rec : null;
    // Today's chat is the one recorded for today; before one is recorded, the
    // empty chat on screen is about to become it.
    const isBriefChat = recToday ? recToday.chatId === a.activeId : !a.messages.length;

    // First visit of the day with a conversation open: start a fresh one.
    const started = useRef(null);
    useEffect(() => {
        if (!key || started.current === key) return;
        started.current = key;
        if (!readRec(key) || readRec(key).day !== today) {
            if (a.messages.length) a.startChat();
        }
    }, [key, today, a]);
    useEffect(() => {
        if (!key || recToday || a.messages.length) return;
        writeRec(key, { day: today, chatId: a.activeId });
    }, [key, recToday, a.messages.length, a.activeId, today]);

    // /chat?files=1 (the old /library) opens the Files sheet.
    useEffect(() => {
        const q = new URLSearchParams(location.search);
        if (q.get('files')) { shell.openFiles(); navigate('/chat', { replace: true }); }
    }, [location.search, shell, navigate]);

    // New messages scroll into view; a fresh brief shows from the top.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = a.messages.length ? el.scrollHeight : 0;
    }, [a.messages, a.activeId]);

    const open = (href) => navigate(href);

    const { onKpi, onSuggestion } = useBriefActions({ build });

    // "/" in the composer opens the command palette.
    const openCommands = () => {
        a.setDraft('/');
        requestAnimationFrame(() => document.querySelector('.sb-composer textarea')?.focus());
    };

    const title = isBriefChat ? `${new Date().toLocaleDateString('en-IN', { weekday: 'long' })} brief` : a.active.title;

    return (
        <section className="sb-chat" aria-label={`Buddy: ${persona.name}`}>
            <header className="sb-top">
                <div className="tt"><b>{title}</b><small>{isBriefChat ? 'Today' : `${a.messages.length} messages`}</small></div>
                <div className="tools">
                    {shell.canCall && (
                        <Button size="sm" onClick={() => shell.startCall()} aria-label={`Call ${persona.name}`}>
                            <IconCall size={14} /><span className="lbl">Call {persona.name}</span>
                        </Button>
                    )}
                    <Button size="sm" onClick={() => shell.openFiles()} aria-label="Files"><IconFile /><span className="lbl">Files</span></Button>
                    <Button size="sm" onClick={() => setChatsOpen(true)} aria-label="All chats"><IconClock /><span className="lbl">Chats</span></Button>
                    <Button variant="primary" size="sm" onClick={a.startChat} aria-label="New chat"><IconPlus /><span className="lbl">New chat</span></Button>
                    <Link to="/settings" className="mob" aria-label="Settings">
                        <PixelAvatar spec={ME_AVATAR} round size={32} />
                    </Link>
                </div>
            </header>

            <div className="sb-scroll" ref={scrollRef}>
                <div className="sb-feedw">
                    <div className="sb-feed" aria-live="polite">
                        {isBriefChat && (
                            <Brief brief={brief} persona={persona} onKpi={onKpi} onSuggestion={onSuggestion}
                                building={building} buildError={buildError} />
                        )}
                        {!isBriefChat && a.messages.length === 0 && (
                            <div className="sb-m">
                                <PixelAvatar spec={persona} className="mav" />
                                <div className="mb">
                                    <div className="sb-mh"><b>{persona.name}</b></div>
                                    <h2 className="sb-greet" style={{ fontSize: 26 }}>What's on your mind, {me.name}?</h2>
                                    <p className="sb-lede2">Ask a question, or tell me something that happened and I'll prepare the change for you to confirm.</p>
                                </div>
                            </div>
                        )}
                        {a.messages.length === 0 && (
                            <div className="sb-tools" role="group" aria-label={`What ${persona.name} can do`}>
                                {shell.canCall && (
                                    <button type="button" className="sb-cd" onClick={() => shell.startCall()}>
                                        <span className="sb-ico g"><IconCall size={15} /></span><span><b>Talk</b><small>Call {persona.name} and say it out loud</small></span>
                                    </button>
                                )}
                                <button type="button" className="sb-cd" onClick={openCommands}>
                                    <span className="sb-ico n"><IconBolt /></span><span><b>Commands</b><small>Type / for invoices, expenses, tasks</small></span>
                                </button>
                                <button type="button" className="sb-cd" onClick={() => shell.openFiles()}>
                                    <span className="sb-ico b"><IconFile /></span><span><b>Files & memory</b><small>What {persona.name} knows about the company</small></span>
                                </button>
                                <button type="button" className="sb-cd" onClick={() => setChatsOpen(true)}>
                                    <span className="sb-ico n"><IconClock /></span><span><b>Past chats</b><small>Pick up where you left off</small></span>
                                </button>
                            </div>
                        )}
                        <Feed a={a} persona={persona} onOpen={open} />
                    </div>
                </div>
            </div>

            {a.note && <div className="sb sb-toast" role="status">{a.note}</div>}
            <ChatsSheet open={chatsOpen} onClose={() => setChatsOpen(false)} />
            <Sheet open={!chosen && !chooserSeen && !!chooserKey} onClose={closeChooser} title="Choose your cofounder"
                footer={<Button variant="primary" block size="lg" onClick={async () => { await setCofounder(pick.id).catch(() => {}); closeChooser(); }}>Continue with {pick.name}</Button>}>
                <p className="sb-say quiet" style={{ textAlign: 'center' }}>Same skills, different personalities. You can switch anytime in Settings.</p>
                <CofounderCarousel compact value={persona.id} onChange={setPick} />
            </Sheet>
        </section>
    );
}

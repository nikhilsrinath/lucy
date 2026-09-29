import React, { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useCofounder } from '../design/useCofounder';
import { PixelAvatar } from '../design/ui';
import { ME_AVATAR } from '../design/personas';
import { IconHome, IconBusiness, IconWork, IconTeam, IconSettings, IconCall } from '../design/icons';
import { useMe } from './useMe';
import { useAuth } from '../context/AuthContext';
import { INTRO_CALL_KEY } from '../onboarding/onboardingState';
import { SECTIONS, NAV_AREAS, sectionOf, areaOf } from './sections';
import { useNavCounts } from './useNavCounts';
import { useShell } from './shellContext';
import Composer from '../chat/Composer';
import FilesSheet from '../chat/FilesSheet';
import CallHost from '../call/CallHost';
import TabBar from './TabBar';
import '../chat/chat.css';
import '../design/sb.css';
import './shell.css';

/* ══════════════════════════════════════════════════════════════════════════
   The StartupBuddy frame: sidebar (desktop), icon rail (tablet), bottom tab
   bar (phone). Five areas — Home, Work, Buddy, Business, Team — with Buddy,
   the cofounder, as the primary one: the card at the top of the sidebar and
   the raised avatar in the middle of the tab bar. Settings lives behind the
   company and profile areas, not in the navigation.
   Everything inside is a screen; this owns only navigation, identity and the
   counts.
   ══════════════════════════════════════════════════════════════════════════ */

const ICONS = { home: IconHome, work: IconWork, business: IconBusiness, team: IconTeam };
const area = (id) => SECTIONS.find((s) => s.id === id);
const SIDE_NAV = NAV_AREAS.filter((id) => id !== 'chat');

export default function AppShell({ children, composer = true }) {
    const location = useLocation();
    const navigate = useNavigate();
    const { persona } = useCofounder();
    const me = useMe();
    const counts = useNavCounts();
    const a = useAssistant();
    const shell = useShell();
    const current = sectionOf(location.pathname);
    const currentArea = areaOf(current);
    const { user } = useAuth();
    const uid = user?.id;
    const { startCall } = shell;

    // The end of onboarding leaves an intro call to ring once (its greeting is
    // spoken locally — see onboarding/Onboarding.jsx).
    useEffect(() => {
        if (!uid) return;
        let greeting = null;
        try { greeting = localStorage.getItem(INTRO_CALL_KEY(uid)); localStorage.removeItem(INTRO_CALL_KEY(uid)); } catch { /* none */ }
        if (greeting) startCall('incoming', { greeting });
    }, [uid, startCall]);
    const sectionLabel = area(currentArea)?.label || '';

    const recent = a.chats.filter((c) => c.messages.length).slice(0, 6);
    const openChat = (id) => { a.pickChat(id); navigate('/chat'); };

    const navLink = (id) => {
        const s = area(id);
        const Icon = ICONS[id];
        const c = counts[id];
        return (
            <Link key={id} to={s.path} className="sb-nv" aria-current={currentArea === id ? 'page' : undefined}
                aria-label={c?.n ? `${s.label}, ${c.label}` : s.label} title={s.label}>
                <Icon /><span>{s.label}</span>
                {c?.n > 0 && <i className={`c${c.tone === 'r' ? ' r' : ''}`} aria-hidden="true">{c.n}</i>}
            </Link>
        );
    };

    return (
        <div className="sb sb-shell">
            <nav className="sb-side" aria-label="Main">
                <Link to="/settings" className="ws" title={`${me.company} settings`} aria-label={`${me.company}, company settings`}
                    aria-current={current === 'settings' ? 'page' : undefined}>
                    <span className="wl" aria-hidden="true">{me.company.charAt(0).toUpperCase()}</span>
                    <span className="wn">{me.company}</span>
                    <span className="wg" aria-hidden="true"><IconSettings size={15} /></span>
                </Link>

                <div className={`sb-cd cof${current === 'chat' ? ' on' : ''}`}>
                    <Link to="/chat" aria-label={`Buddy: chat with ${persona.name}`} aria-current={current === 'chat' ? 'page' : undefined}
                        style={{ display: 'contents', color: 'inherit', textDecoration: 'none' }}>
                        <PixelAvatar spec={persona} />
                        <span className="t">
                            <b>{persona.name}</b>
                            <small><i className="sb-dot g" aria-hidden="true" />Buddy · {persona.role}</small>
                        </span>
                    </Link>
                    {shell.canCall && (
                        <button type="button" className="callb" onClick={() => shell.startCall()} aria-label={`Call ${persona.name}`}>
                            <IconCall />
                        </button>
                    )}
                </div>

                {SIDE_NAV.map(navLink)}

                {recent.length > 0 && (
                    <>
                        <div className="sh" id="sb-recent-h">Recent chats</div>
                        <div role="list" aria-labelledby="sb-recent-h">
                            {recent.map((c) => (
                                <button key={c.id} type="button" role="listitem" className="rc"
                                    aria-current={current === 'chat' && a.activeId === c.id ? 'true' : undefined}
                                    onClick={() => openChat(c.id)}>{c.title}</button>
                            ))}
                        </div>
                    </>
                )}

                <div className="bottom">
                    <Link to="/settings" className="me" aria-label={`Settings, signed in as ${me.email}`}
                        aria-current={current === 'settings' ? 'page' : undefined}>
                        <PixelAvatar spec={ME_AVATAR} round />
                        <span className="t"><b>{me.name}</b><small>{me.email}</small></span>
                        <span className="mg" aria-hidden="true"><IconSettings size={16} /></span>
                    </Link>
                </div>
            </nav>

            <header className={`sb-mtop${current === 'chat' ? ' hidden' : ''}`}>
                <Link to="/settings" className="tt" aria-label={`${me.company}, company settings`}>
                    <span className="wl" aria-hidden="true">{me.company.charAt(0).toUpperCase()}</span>
                    <span className="tx"><b>{me.company}</b><small>{sectionLabel}</small></span>
                </Link>
                <Link to="/settings" className="meb" aria-label="Your profile and settings"><PixelAvatar spec={ME_AVATAR} round /></Link>
            </header>

            <main className="sb-main" id="sb-main">
                {children}
                {composer && current && <Composer section={current} persona={persona} brainBuilt={shell.brainBuilt} />}
            </main>
            <FilesSheet />
            <CallHost />

            <TabBar current={current} currentArea={currentArea} counts={counts} persona={persona} />
        </div>
    );
}

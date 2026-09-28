import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useCofounder } from '../design/useCofounder';
import { PixelAvatar } from '../design/ui';
import { ME_AVATAR } from '../design/personas';
import { IconChat, IconMoney, IconClients, IconWork, IconTeam, IconSettings, IconCall } from '../design/icons';
import { useMe } from './useMe';
import { SECTIONS, sectionOf } from './sections';
import { useNavCounts } from './useNavCounts';
import { useShell } from './shellContext';
import Composer from '../chat/Composer';
import FilesSheet from '../chat/FilesSheet';
import '../chat/chat.css';
import '../design/sb.css';
import './shell.css';

/* ══════════════════════════════════════════════════════════════════════════
   The StartupBuddy frame: sidebar (desktop), icon rail (tablet), bottom tab
   bar with the cofounder in the middle (phone). Everything inside is a
   screen; this owns only navigation, identity and the counts.
   ══════════════════════════════════════════════════════════════════════════ */

const ICONS = { chat: IconChat, money: IconMoney, clients: IconClients, work: IconWork, team: IconTeam, settings: IconSettings };
const NAV = SECTIONS.filter((s) => s.id !== 'settings');

export default function AppShell({ children, composer = true }) {
    const location = useLocation();
    const navigate = useNavigate();
    const { persona } = useCofounder();
    const me = useMe();
    const counts = useNavCounts();
    const a = useAssistant();
    const shell = useShell();
    const current = sectionOf(location.pathname);
    const sectionLabel = SECTIONS.find((s) => s.id === current)?.label || '';

    const recent = a.chats.filter((c) => c.messages.length).slice(0, 6);
    const openChat = (id) => { a.pickChat(id); navigate('/chat'); };

    const navLink = (s) => {
        const Icon = ICONS[s.id];
        const c = counts[s.id];
        return (
            <Link key={s.id} to={s.path} className="sb-nv" aria-current={current === s.id ? 'page' : undefined}
                aria-label={c?.n ? `${s.label}, ${c.label}` : s.label} title={s.label}>
                <Icon /><span>{s.label}</span>
                {c?.n > 0 && <i className={`c${c.tone === 'r' ? ' r' : ''}`} aria-hidden="true">{c.n}</i>}
            </Link>
        );
    };

    return (
        <div className="sb sb-shell">
            <nav className="sb-side" aria-label="Main">
                <div className="ws" title={me.company}>
                    <span className="wl" aria-hidden="true">{me.company.charAt(0).toUpperCase()}</span>
                    <span className="wn">{me.company}</span>
                </div>

                <div className="sb-cd cof">
                    <Link to="/chat" aria-label={`Chat with ${persona.name}`} style={{ display: 'contents', color: 'inherit', textDecoration: 'none' }}>
                        <PixelAvatar spec={persona} />
                        <span className="t">
                            <b>{persona.name}</b>
                            <small><i className="sb-dot g" aria-hidden="true" />{persona.role}</small>
                        </span>
                    </Link>
                    {shell.canCall && (
                        <button type="button" className="callb" onClick={() => shell.startCall()} aria-label={`Call ${persona.name}`}>
                            <IconCall />
                        </button>
                    )}
                </div>

                {NAV.map(navLink)}

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
                    {navLink(SECTIONS.find((s) => s.id === 'settings'))}
                    <Link to="/settings" className="me" aria-label={`Settings, signed in as ${me.email}`}>
                        <PixelAvatar spec={ME_AVATAR} round />
                        <span className="t"><b>{me.name}</b><small>{me.email}</small></span>
                    </Link>
                </div>
            </nav>

            <header className={`sb-mtop${current === 'chat' ? ' hidden' : ''}`}>
                <div className="tt"><b>{me.company}</b><small>{sectionLabel}</small></div>
                <Link to="/settings" className="meb" aria-label="Settings"><PixelAvatar spec={ME_AVATAR} round /></Link>
            </header>

            <main className="sb-main" id="sb-main">
                {children}
                {composer && current && <Composer section={current} persona={persona} brainBuilt={shell.brainBuilt} />}
            </main>
            <FilesSheet />

            <nav className="sb-tabbar" aria-label="Main">
                {['money', 'clients'].map((id) => tab(id))}
                <Link to="/chat" className="sb-tab co" aria-current={current === 'chat' ? 'page' : undefined} aria-label={`Chat with ${persona.name}`}>
                    <PixelAvatar spec={persona} />
                </Link>
                {['work', 'team'].map((id) => tab(id))}
            </nav>
        </div>
    );

    function tab(id) {
        const s = SECTIONS.find((x) => x.id === id);
        const Icon = ICONS[id];
        const c = counts[id];
        return (
            <Link key={id} to={s.path} className="sb-tab" aria-current={current === id ? 'page' : undefined}
                aria-label={c?.n ? `${s.label}, ${c.label}` : s.label}>
                <Icon /><span>{s.label}</span>
            </Link>
        );
    }
}

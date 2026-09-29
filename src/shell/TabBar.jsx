import React from 'react';
import { Link } from 'react-router-dom';
import { PixelAvatar } from '../design/ui';
import { IconHome, IconBusiness, IconWork, IconTeam } from '../design/icons';
import { SECTIONS, NAV_AREAS } from './sections';

/* ══════════════════════════════════════════════════════════════════════════
   The phone tab bar: a floating white dock of five icons — Home · Work ·
   Buddy · Business · Team. No labels on screen (each link carries its name
   for screen readers). The active icon is white on an ink circle; Buddy is the
   cofounder's portrait in the middle; a red dot marks something overdue.
   ══════════════════════════════════════════════════════════════════════════ */

const ICONS = { home: IconHome, work: IconWork, business: IconBusiness, team: IconTeam };
const area = (id) => SECTIONS.find((s) => s.id === id);

export default function TabBar({ current, currentArea, counts, persona }) {
    return (
        <nav className="sb-tabbar" aria-label="Main">
            {NAV_AREAS.map((id) => {
                if (id === 'chat') {
                    return (
                        <Link key={id} to="/chat" className="sb-tab co" aria-current={current === 'chat' ? 'page' : undefined}
                            aria-label={`Buddy: chat with ${persona.name}`}>
                            <PixelAvatar spec={persona} round />
                        </Link>
                    );
                }
                const s = area(id);
                const Icon = ICONS[id];
                const c = counts[id];
                const alert = c?.tone === 'r' && c.n > 0;
                return (
                    <Link key={id} to={s.path} className="sb-tab" aria-current={currentArea === id ? 'page' : undefined}
                        aria-label={c?.n ? `${s.label}, ${c.label}` : s.label}>
                        <Icon size={21} />
                        {alert && <i className="dot" aria-hidden="true" />}
                    </Link>
                );
            })}
        </nav>
    );
}

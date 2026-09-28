import React from 'react';
import { PixelAvatar, Button, IconTile, ListRow } from '../design/ui';
import { IconDoc, IconMail, IconTask, IconBolt, IconCheckCircle } from '../design/icons';

const ICONS = { doc: IconDoc, mail: IconMail, task: IconTask, bolt: IconBolt, bell: IconCheckCircle };

/* The top of the day's chat: greeting, four figures, what needs doing.
   Everything comes from buildBrief (brief.js); this only lays it out. */
export default function Brief({ brief, persona, onKpi, onSuggestion, building, buildError }) {
    const n = brief.kpis.length;
    return (
        <div className="sb-m">
            <PixelAvatar spec={persona} className="mav" />
            <div className="mb">
                <div className="sb-mh"><b>{persona.name}</b><span>Today</span></div>
                <h2 className="sb-greet">{brief.greeting}</h2>
                <p className="sb-lede2">{brief.lede}</p>

                {n > 0 && (
                    <div className={`sb-cd sb-bk n${n}`}>
                        {brief.kpis.map((k) => (
                            <button key={k.id} type="button" className="sb-kpi" onClick={() => onKpi(k)}>
                                <span className="kl">{k.label}</span>
                                <span className="kv sb-num">{k.value}</span>
                                <span className="ks"><i className={`sb-dot ${k.tone}`} aria-hidden="true" />{k.sub}</span>
                            </button>
                        ))}
                    </div>
                )}

                <div className="sb-cd sb-todo sb-list">
                    <div className="th">Suggested for today<span>{brief.suggestions.length || ''}</span></div>
                    {brief.suggestions.length === 0 ? (
                        <p className="sb-say quiet" style={{ padding: '4px 16px 16px' }}>Nothing needs you today.</p>
                    ) : brief.suggestions.map((s) => {
                        const Icon = ICONS[s.icon] || IconDoc;
                        const isBuild = s.build;
                        return (
                            <ListRow key={s.id} lead={<IconTile tone={s.tone}><Icon /></IconTile>} title={s.title}
                                sub={isBuild && buildError ? buildError : s.sub}
                                trail={(
                                    <Button size="sm" onClick={() => onSuggestion(s)} disabled={isBuild && building}>
                                        {isBuild && building ? 'Building…' : s.action}
                                    </Button>
                                )} />
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

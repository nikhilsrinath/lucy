import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useShell } from '../shell/shellContext';
import { useCofounder } from './useCofounder';
import { Button, Card, PixelAvatar } from './ui';
import { IconCall, IconChat, IconSparkle } from './icons';

/**
 * The cofounder, at the top of a hub page: who is talking, one line in their
 * voice, and a few things to ask. Every ask goes to Buddy (the chat), where
 * the answer — or the change to review and confirm — appears.
 *
 * chips: [{ label, prompt }]
 */
export default function BuddyHero({ eyebrow, title, lede, chips = [], steps = false }) {
    const { persona } = useCofounder();
    const shell = useShell();
    const a = useAssistant();
    const navigate = useNavigate();
    const ask = (text) => { navigate('/chat'); a.send(text); };

    return (
        <Card className="sb-hero">
            <div className="hh">
                <PixelAvatar spec={persona} />
                <div className="hx">
                    <div className="hn"><i className="sb-dot g" aria-hidden="true" />{eyebrow || `${persona.name} · your cofounder`}</div>
                    <h1>{title}</h1>
                    {lede && <p className="hl">{lede}</p>}
                </div>
                <div className="ha">
                    {shell.canCall && <Button onClick={() => shell.startCall()} aria-label={`Call ${persona.name}`}><IconCall size={14} />Talk</Button>}
                    <Button variant="primary" onClick={() => navigate('/chat')}><IconChat size={14} />Open Buddy</Button>
                </div>
            </div>
            {chips.length > 0 && (
                <div className="hc" role="group" aria-label={`Ask ${persona.name}`}>
                    {chips.map((c) => (
                        <button key={c.label} type="button" disabled={a.streaming} onClick={() => ask(c.prompt)}>
                            <IconSparkle size={11} />{c.label}
                        </button>
                    ))}
                </div>
            )}
            {steps && (
                <p className="sb-steps" aria-label="Talk, review, tap, done">
                    <b>Talk</b><i aria-hidden="true" /><b>Review</b><i aria-hidden="true" /><b>Tap</b><i aria-hidden="true" /><b>Done</b>
                    <span>· tell {persona.name} what happened; nothing changes until you confirm.</span>
                </p>
            )}
        </Card>
    );
}

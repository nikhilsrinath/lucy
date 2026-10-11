import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { useShell } from '../shell/shellContext';
import { useCofounder } from '../design/useCofounder';
import { PixelAvatar } from '../design/ui';
import { IconCall, IconHangUp } from '../design/icons';
import CallScreen from './CallScreen';
import './call.css';

/* ══════════════════════════════════════════════════════════════════════════
   Where a call lives while it is on. `shell.startCall()` opens it from the
   sidebar, the chat or the composer; `shell.startCall('incoming', { greeting })`
   rings first — used once, at the end of onboarding, and by Settings'
   "Replay intro call". The greeting is spoken locally (useVoiceCall), so a
   ringing phone costs nothing; Accept begins a real call.

   Ending a call that said anything makes its summary the exchange on screen:
   what was confirmed, and the cards still waiting for a tap (display-only,
   never sent to the model).
   ══════════════════════════════════════════════════════════════════════════ */

export default function CallHost() {
    const shell = useShell();
    const a = useAssistant();
    const navigate = useNavigate();
    const { persona } = useCofounder();
    const [acceptedAt, setAcceptedAt] = useState(null);
    const call = shell.call;
    if (!call) return null;

    const ringing = call.mode === 'incoming' && acceptedAt !== call.at;

    const finish = (summary) => {
        shell.endCall();
        setAcceptedAt(null);
        if (summary?.exchanged) {
            const { cards = [], ...call } = summary;
            const mood = call.waiting.length || call.confirmed.length ? 'win' : null;
            a.addLocal({ kind: 'call', call }, {
                cards,
                mood: mood && { mood, headline_word: persona.headlines[mood], tag: call.waiting.length ? 'Needs your tap' : 'Call summary' },
            });
        }
        navigate('/chat');
    };

    if (ringing) {
        return createPortal(
            <div className="sb sb-cv" role="dialog" aria-modal="true" aria-label={`${persona.name} is calling`}>
                <div className="sb-cin">
                    <span className="lb"><IconCall size={14} />StartupBuddy voice call</span>
                    <div className="sb-rings" aria-hidden="true"><i /><i /><i /><PixelAvatar spec={persona} /></div>
                    <h2>{persona.name}</h2>
                    <p>is calling you</p>
                    <div className="sb-cbtns">
                        <div>
                            <button type="button" className="sb-rb red" aria-label="Decline" onClick={() => finish(null)}><IconHangUp size={26} /></button>
                            Decline
                        </div>
                        <div>
                            <button type="button" className="sb-rb grn" aria-label="Accept" autoFocus onClick={() => setAcceptedAt(call.at)}><IconCall size={26} /></button>
                            Accept
                        </div>
                    </div>
                </div>
            </div>,
            document.body,
        );
    }

    return <CallScreen key={call.at} greeting={call.greeting || ''} onEnd={finish} />;
}

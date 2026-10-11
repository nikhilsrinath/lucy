import React, { useState } from 'react';
import { Sheet, Button } from '../design/ui';
import { personaOf } from '../design/personas';
import { useCofounder, dismissMoved, MOVED_KEY } from '../design/useCofounder';
import { CofounderAvatar, MoodBackground } from '../design/art/Art';
import CofounderChooser from '../design/CofounderChooser';

/* Shown once to someone whose cofounder was retired and replaced
   (useCofounderMigration): "Your cofounder is now <name>. Change?"
   Keeping or changing both clear the notice, on every device. */
export default function MovedNotice() {
    const { movedTo, setCofounder, founderProfile } = useCofounder();
    const [changing, setChanging] = useState(false);
    if (!movedTo) return null;
    const p = personaOf(movedTo);

    if (changing) {
        return (
            <Sheet open onClose={() => { setChanging(false); }} title="Choose your cofounder" size="wide">
                <CofounderChooser value={p.id} answers={founderProfile} cta={(c) => `Continue with ${c.name}`}
                    onPick={(c, extra) => setCofounder(c.id, { ...extra, [MOVED_KEY]: null }).catch(() => {})} />
            </Sheet>
        );
    }

    return (
        <Sheet open onClose={dismissMoved} title="Your cofounder has changed"
            footer={(
                <div style={{ display: 'flex', gap: 8 }}>
                    <Button block size="lg" onClick={() => setChanging(true)}>Change</Button>
                    <Button variant="primary" block size="lg" onClick={dismissMoved}>Keep {p.name}</Button>
                </div>
            )}>
            <div style={{ position: 'relative', height: 220, borderRadius: 18, overflow: 'hidden', border: '2px solid #141414' }}>
                <MoodBackground id={p.art} mood="celebrate" />
                <CofounderAvatar id={p.art} mood="celebrate" label={p.name}
                    className="" />
            </div>
            <h2 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '18px 0 6px' }}>Your cofounder is now {p.name}. Change?</h2>
            <p className="sb-say quiet">{p.name} is {p.title.replace(/^The /, 'the ')}: {p.speciality.toLowerCase()}. We replaced the earlier cofounders with three new ones. Your records, files and settings are untouched.</p>
        </Sheet>
    );
}

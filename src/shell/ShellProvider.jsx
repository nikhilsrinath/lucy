import React, { useCallback, useMemo, useState } from 'react';
import { ShellCtx } from './shellContext';

/* State the frame shares with every screen: the Files sheet (opened from the
   composer's paperclip, the chat's Files button, or /library) and the call. */
export default function ShellProvider({ children }) {
    const [filesOpen, setFilesOpen] = useState(false);
    const [filesUpload, setFilesUpload] = useState(false);
    const [call, setCall] = useState(null);
    // Whether the knowledge base is built — the brief learns it, the
    // composer's "How's the month?" chip depends on it.
    const [brainBuilt, setBrainBuilt] = useState(false);

    const openFiles = useCallback(({ upload = false } = {}) => { setFilesUpload(upload); setFilesOpen(true); }, []);
    const closeFiles = useCallback(() => { setFilesOpen(false); setFilesUpload(false); }, []);
    const startCall = useCallback((mode = 'app') => setCall({ mode, at: Date.now() }), []);
    const endCall = useCallback(() => setCall(null), []);

    const value = useMemo(() => ({
        filesOpen, filesUpload, openFiles, closeFiles,
        // The call screen arrives in Phase 3; until then nothing offers a call.
        canCall: false, call, startCall, endCall,
        brainBuilt, setBrainBuilt,
    }), [filesOpen, filesUpload, openFiles, closeFiles, call, startCall, endCall, brainBuilt]);

    return <ShellCtx.Provider value={value}>{children}</ShellCtx.Provider>;
}

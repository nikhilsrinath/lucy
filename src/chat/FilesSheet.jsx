import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOrg } from '../context/OrgContext';
import { orgStore } from '../services/orgStore';
import { libraryService, validateLibraryFile, READABLE_HINT } from '../services/libraryService';
import { useShell } from '../shell/shellContext';
import { useCofounder } from '../design/useCofounder';
import { Sheet, Button, Badge, ListRow, IconTile } from '../design/ui';
import { IconDoc, IconDownload, IconTrash, IconRefresh } from '../design/icons';
import { confirmDialog } from '../services/confirm';

/* ══════════════════════════════════════════════════════════════════════════
   Files the cofounder can read — the document library (0063), unchanged
   underneath: private Storage bucket, a library_documents row under RLS,
   then /api/library reads it into passages the knowledge base quotes.
   ══════════════════════════════════════════════════════════════════════════ */

const STATUS = {
    ready: ['g', 'Readable'], partial: ['a', 'Partly readable'], pending: ['n', 'Waiting to read'],
    processing: ['n', 'Reading…'], failed: ['r', 'Could not read'], unsupported: ['n', 'Stored only'],
};
const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const describe = (d) => [
    d.page_count ? `${d.page_count} ${d.page_count === 1 ? 'page' : 'pages'}` : null,
    d.extraction_method === 'ocr' ? 'read by OCR' : null,
    size(d.size_bytes || 0),
].filter(Boolean).join(' · ');

export default function FilesSheet() {
    const shell = useShell();
    const { activeOrg } = useOrg();
    const { persona } = useCofounder();
    const orgId = activeOrg?.id;
    const [docs, setDocs] = useState(null);
    const [error, setError] = useState('');
    const [queue, setQueue] = useState([]);
    const [over, setOver] = useState(false);
    const inputRef = useRef(null);
    const canCreate = orgStore.can('library_documents', 'create');
    const canView = orgStore.can('library_documents', 'view');
    const canEdit = orgStore.can('library_documents', 'edit');
    const canDelete = orgStore.can('library_documents', 'delete');
    const [busy, setBusy] = useState(null);

    const refresh = useCallback(async () => {
        if (!orgId || !canView) return;
        try { setDocs(await libraryService.list(orgId)); setError(''); }
        catch (e) { setError(e.message || 'Could not load your files.'); }
    }, [orgId, canView]);

    useEffect(() => { if (shell.filesOpen) refresh(); }, [shell.filesOpen, refresh]);
    // Opened from the paperclip: go straight to the picker.
    useEffect(() => {
        if (shell.filesOpen && shell.filesUpload && canCreate) inputRef.current?.click();
    }, [shell.filesOpen, shell.filesUpload, canCreate]);

    const upload = async (files) => {
        const list = [...(files || [])];
        if (!list.length || !orgId) return;
        const jobs = list.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, file: f, error: validateLibraryFile(f) }));
        setQueue((q) => [...jobs.map((j) => ({ key: j.key, name: j.name, state: j.error ? 'failed' : 'uploading', error: j.error })), ...q]);
        for (const j of jobs.filter((x) => !x.error)) {
            try {
                const row = await libraryService.upload(orgId, j.file);
                setQueue((q) => q.filter((x) => x.key !== j.key));
                setDocs((d) => [row, ...(d || []).filter((x) => x.id !== row.id)]);
            } catch (e) {
                setQueue((q) => q.map((x) => (x.key === j.key ? { ...x, state: 'failed', error: e.message || 'Upload failed' } : x)));
            }
        }
    };

    const reread = async (d) => {
        setBusy(d.id);
        try { await libraryService.process(orgId, d.id); await refresh(); }
        catch (e) { setError(e.message || 'Reading failed.'); }
        finally { setBusy(null); }
    };
    const remove = async (d) => {
        const ok = await confirmDialog({ title: 'Delete file', message: `Delete “${d.title || d.file_name}”? ${persona.name} will no longer be able to read it.` });
        if (!ok) return;
        try { await libraryService.remove(d); setDocs((list) => (list || []).filter((x) => x.id !== d.id)); }
        catch (e) { setError(e.message || 'Could not delete the file.'); }
    };

    const onDrop = (e) => { e.preventDefault(); setOver(false); if (canCreate) upload(e.dataTransfer.files); };

    return (
        <Sheet open={shell.filesOpen} onClose={shell.closeFiles} title={`Files ${persona.name} can read`}
            footer={canCreate ? (
                <>
                    <Button variant="primary" block onClick={() => inputRef.current?.click()}>Upload file</Button>
                    <input ref={inputRef} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
                </>
            ) : null}>
            <div className="sb-note b">
                {persona.name} reads these to answer your questions. Files stay private to {activeOrg?.company_name || 'your company'}.
            </div>

            {!canView && <div className="sb-empty">Your role can't see the company's files.</div>}
            {error && <p className="sb-acerr" role="alert">{error}</p>}

            {canCreate && (
                <div className={`sb-drop${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                    onDragLeave={() => setOver(false)} onDrop={onDrop}>
                    Drop files here, up to 25 MB each.<br /><small>{READABLE_HINT}</small>
                </div>
            )}

            {queue.length > 0 && (
                <div className="sb-cd sb-list" aria-live="polite">
                    {queue.map((j) => (
                        <ListRow key={j.key} lead={<IconTile><IconDoc /></IconTile>} title={j.name}
                            sub={j.state === 'failed' ? j.error : 'Uploading and reading…'}
                            trail={j.state === 'failed' ? <Badge tone="r">Failed</Badge> : <Badge tone="n">Working</Badge>} />
                    ))}
                </div>
            )}

            {canView && docs && (
                <div className="sb-cd sb-list">
                    {docs.length === 0 && <div className="sb-empty">No files yet. Contracts, price lists and policies are good first uploads.</div>}
                    {docs.map((d) => {
                        const [tone, label] = STATUS[d.extraction_status] || STATUS.pending;
                        return (
                            <ListRow key={d.id} lead={<IconTile><IconDoc /></IconTile>} title={d.title || d.file_name} sub={describe(d)}
                                trail={(
                                    <>
                                        <Badge tone={tone} className="hide-m">{label}</Badge>
                                        {canEdit && d.extraction_status === 'failed' && (
                                            <Button variant="ghost" size="sm" iconOnly disabled={busy === d.id} aria-label={`Read ${d.title || d.file_name} again`}
                                                onClick={() => reread(d)}><IconRefresh /></Button>
                                        )}
                                        <Button variant="ghost" size="sm" iconOnly aria-label={`Open ${d.title || d.file_name}`}
                                            onClick={() => libraryService.open(d).catch((e) => setError(e.message))}><IconDownload /></Button>
                                        {canDelete && (
                                            <Button variant="ghost" size="sm" iconOnly aria-label={`Delete ${d.title || d.file_name}`}
                                                onClick={() => remove(d)}><IconTrash /></Button>
                                        )}
                                    </>
                                )} />
                        );
                    })}
                </div>
            )}
            {canView && docs === null && !error && <div className="sb-empty">Loading…</div>}
        </Sheet>
    );
}

import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useOrg } from '../context/OrgContext';
import { orgStore } from '../services/orgStore';
import { taskStore } from '../services/taskStore';
import {
    createProject, closeProject, archiveProject, prefillFromQuotation, canCreateProjects, canEditProjects, friendlyError,
} from '../services/projectService';
import { confirmDialog } from '../services/confirm';
import { useSectionList } from '../shell/useSectionList';
import { Button, Badge, Card, PageHeader, Sheet, Field, Segmented, PixelAvatar, KpiStrip } from '../design/ui';
import { personAvatar } from '../design/personas';
import { IconPlus, IconMore } from '../design/icons';
import { isoDay, endOfWeek } from '../chat/brief';
import '../money/money.css';
import '../design/hub.css';
import './work.css';

/* ══════════════════════════════════════════════════════════════════════════
   Work — tasks, projects, deadlines and who is on what. Tasks are grouped
   Overdue / This week / Later (or by person, for assignments), filtered by
   project through the project cards. taskStore underneath (orgStore → tasks;
   it announces `edgeos:tasks-changed`, as it always did).

   Projects keep only what the mockup shows — a name to file tasks under —
   plus a small "New project" sheet (decision D6), because neither the agent
   nor any other screen can start one any more. Their money, milestones,
   timesheets and health stay in the database, untouched.
   ══════════════════════════════════════════════════════════════════════════ */

const isOpenProject = (p) => !p.archived_at && !['completed', 'cancelled'].includes(p.status);
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const fmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const dueLabel = (d, today, eow) => {
    if (!d) return 'No date';
    if (d < today) {
        const days = Math.round((new Date(`${today}T00:00:00`) - new Date(`${d}T00:00:00`)) / 86400000);
        return `Overdue ${days} ${days === 1 ? 'day' : 'days'}`;
    }
    if (d === today) return 'Today';
    if (d <= eow) return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' });
    return fmt(d);
};

export default function WorkScreen() {
    const { activeOrg } = useOrg();
    const orgId = activeOrg?.id || null;
    const [params, setParams] = useSearchParams();
    const tasks = useSectionList('tasks', orgId);
    const projects = useSectionList('projects', orgId);
    const employees = useSectionList('employees', orgId);
    const [note, setNote] = useState('');
    const [editing, setEditing] = useState(null);
    const [projectSheet, setProjectSheet] = useState(null);
    const [menu, setMenu] = useState(false);
    const [groupBy, setGroupBy] = useState('due');
    const notify = (m) => { setNote(m); setTimeout(() => setNote(''), 2600); };

    const now = new Date();
    const today = isoDay(now);
    const eow = endOfWeek(now);
    const tab = params.get('project') || 'all';
    const setTab = (t) => setParams(t === 'all' ? {} : { project: t });

    const open = projects.filter(isOpenProject);
    const projectName = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);
    const empById = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e])), [employees]);

    // Deep links: ?task=<id> (the agent's open_record), ?newProject=1 (from a
    // client, an accepted quotation or its notification). The URL is the state.
    const taskParam = params.get('task');
    const sheetTask = editing || (taskParam ? tasks.find((x) => x.id === taskParam) : null) || null;
    const projectSeed = projectSheet || (params.get('newProject') === '1'
        ? { fromQuotation: params.get('fromQuotation'), client: params.get('client') } : null);
    const clearParams = (...keys) => {
        if (!keys.some((k) => params.has(k))) return;
        setParams((prev) => {
            const n = new URLSearchParams(prev);
            keys.forEach((k) => n.delete(k));
            return n;
        }, { replace: true });
    };

    const shown = tasks.filter((t) => (tab === 'done' ? t.status === 'done'
        : t.status !== 'done' && (tab === 'all' || (tab === 'general' ? !t.projectId : t.projectId === tab))));
    const byDue = (a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999'));
    const whoOf = (t) => empById[t.assignedTo]?.name || t.assignedName || '';
    const groups = tab === 'done'
        ? [['Done', shown.sort((a, b) => String(b.updated_at || b.createdAt).localeCompare(String(a.updated_at || a.createdAt)))]]
        : groupBy === 'person'
            ? Object.entries(shown.reduce((m, t) => { const k = whoOf(t) || 'Unassigned'; (m[k] = m[k] || []).push(t); return m; }, {}))
                .sort((a, b) => (a[0] === 'Unassigned') - (b[0] === 'Unassigned') || b[1].length - a[1].length)
                .map(([n, l]) => [n, l.sort(byDue)])
            : [
                ['Overdue', shown.filter((t) => t.deadline && t.deadline < today)],
                ['This week', shown.filter((t) => t.deadline && t.deadline >= today && t.deadline <= eow)],
                ['Later', shown.filter((t) => !t.deadline || t.deadline > eow)],
            ].map(([n, l]) => [n, l.sort(byDue)]);

    const openCount = tasks.filter((t) => t.status !== 'done').length;
    const lateCount = tasks.filter((t) => t.status !== 'done' && t.deadline && t.deadline < today).length;
    const weekCount = tasks.filter((t) => t.status !== 'done' && t.deadline && t.deadline >= today && t.deadline <= eow).length;
    const people = new Set(tasks.filter((t) => t.status !== 'done').map(whoOf).filter(Boolean)).size;
    const projectStats = open.map((p) => {
        const mine = tasks.filter((t) => t.projectId === p.id);
        const done = mine.filter((t) => t.status === 'done').length;
        return { ...p, total: mine.length, done, open: mine.length - done, late: mine.filter((t) => t.status !== 'done' && t.deadline && t.deadline < today).length };
    });
    const canEdit = orgStore.can('tasks', 'edit');

    const toggle = async (t) => {
        if (!canEdit) return;
        const done = t.status !== 'done';
        try {
            await taskStore.update(t.id, { status: done ? 'done' : (t.deadline && t.deadline < today ? 'overdue' : 'pending') });
            notify(done ? 'Task completed.' : 'Task reopened.');
        } catch (err) { notify(`Could not update: ${err.message}`); }
    };

    const current = open.find((p) => p.id === tab);
    // Projects are picked from their cards; the tabs keep the cross-cutting views
    // (and the picked project, so it reads as the current filter).
    const tabs = [
        { id: 'all', label: 'All open', count: openCount },
        ...(current ? [{ id: current.id, label: current.name }] : []),
        ...(open.length ? [{ id: 'general', label: 'General' }] : []),
        { id: 'done', label: 'Done' },
    ];

    return (
        <div className="sb-scroll">
            <div className="sb-page" style={{ maxWidth: 860 }}>
                <PageHeader title="Work" sub={`Tasks, projects and deadlines · ${openCount} open${lateCount ? `, ${lateCount} overdue` : ''}`}
                    actions={(
                        <>
                            {canCreateProjects() && <Button onClick={() => setProjectSheet({})}>Project</Button>}
                            {orgStore.can('tasks', 'create') && <Button variant="primary" onClick={() => setEditing({ projectId: current?.id || null })}><IconPlus /><span className="lbl">New task</span></Button>}
                        </>
                    )} />

                <KpiStrip items={[
                    { label: 'Overdue', value: String(lateCount), sub: lateCount ? 'Needs a new date or a nudge' : 'Nothing late', tone: lateCount ? 'r' : 'g', onClick: () => { setTab('all'); setGroupBy('due'); } },
                    { label: 'Due this week', value: String(weekCount), sub: `Through ${new Date(`${eow}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long' })}`, tone: weekCount ? 'a' : 'n', onClick: () => { setTab('all'); setGroupBy('due'); } },
                    { label: 'Assigned', value: `${people} ${people === 1 ? 'person' : 'people'}`, sub: `${open.length} active ${open.length === 1 ? 'project' : 'projects'}`, tone: 'n', onClick: () => { setTab('all'); setGroupBy('person'); } },
                ]} />

                {projectStats.length > 0 && (
                    <>
                        <div className="sb-lh"><span>Projects</span><span>{projectStats.length}</span></div>
                        <div className="sb-projs">
                            {projectStats.map((p) => (
                                <button key={p.id} type="button" className="sb-cd sb-proj" aria-pressed={tab === p.id} onClick={() => setTab(tab === p.id ? 'all' : p.id)}>
                                    <span><b>{p.name}</b><small>{[p.code, p.client_name].filter(Boolean).join(' · ') || (p.client_id ? 'Client project' : 'Internal')}</small></span>
                                    <span className="bar" aria-hidden="true"><i style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} /></span>
                                    <span className="ft"><span>{p.total ? `${p.done} of ${p.total} done` : 'No tasks yet'}</span>{p.late ? <span className="late">{p.late} late</span> : <span>{p.open} open</span>}</span>
                                </button>
                            ))}
                        </div>
                    </>
                )}

                <div className="sb-tabs-row">
                    <div className="sb-tabs" role="tablist" aria-label="Projects">
                        {tabs.map((t) => (
                            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                                {t.label}{t.count ? <span className="c">{t.count}</span> : null}
                            </button>
                        ))}
                    </div>
                    {tab !== 'done' && (
                        <Segmented label="Group tasks" value={groupBy} onChange={setGroupBy}
                            options={[{ value: 'due', label: 'By date' }, { value: 'person', label: 'By person' }]} />
                    )}
                    {current && canEditProjects() && (
                        <Button variant="ghost" size="sm" iconOnly aria-label={`${current.name} options`} aria-expanded={menu} onClick={() => setMenu((v) => !v)}><IconMore /></Button>
                    )}
                </div>
                {menu && current && (
                    <Card style={{ padding: 12, marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ flex: 1, fontSize: 13, color: 'var(--muted)' }}>{current.code} · {current.name}</span>
                        <Button size="sm" onClick={async () => {
                            if (!(await confirmDialog({ title: 'Close project', message: `Mark ${current.name} as completed? Its tasks stay.`, confirmLabel: 'Close', tone: 'default' }))) return;
                            try { await closeProject(current.id, 'completed'); setMenu(false); setTab('all'); notify('Project closed.'); } catch (e) { notify(e.message); }
                        }}>Close project</Button>
                        <Button size="sm" variant="ghost" onClick={async () => {
                            try { await archiveProject(current.id); setMenu(false); setTab('all'); notify('Project archived.'); } catch (e) { notify(e.message); }
                        }}>Archive</Button>
                    </Card>
                )}

                {groups.every(([, l]) => !l.length) && (
                    <Card><div className="sb-empty">{tab === 'done' ? 'Nothing finished yet.' : 'Nothing here. Ask your cofounder to add a task, for example “Riya to fix login by Friday”.'}</div></Card>
                )}
                {groups.map(([name, list]) => (list.length ? (
                    <React.Fragment key={name}>
                        <div className="sb-lh"><span>{name}</span><span>{list.length}</span></div>
                        <Card list>
                            {list.map((t) => {
                                const owner = empById[t.assignedTo];
                                const who = owner?.name || t.assignedName || '';
                                const late = t.status !== 'done' && t.deadline && t.deadline < today;
                                return (
                                    <div key={t.id} className={`sb-lr sb-task${t.status === 'done' ? ' dn' : ''}`}>
                                        <button type="button" className={`sb-cbx${t.status === 'done' ? ' d' : ''}`} role="checkbox" aria-checked={t.status === 'done'}
                                            aria-label={`${t.status === 'done' ? 'Reopen' : 'Complete'} ${t.title}`} disabled={!canEdit} onClick={() => toggle(t)} />
                                        <button type="button" className="t" onClick={() => setEditing(t)}>
                                            <b>{t.title}</b>
                                            <small>{t.projectId ? projectName[t.projectId] || 'Project' : 'General'}<span className="mdue"> · {dueLabel(t.deadline, today, eow)}</span></small>
                                        </button>
                                        <Badge tone={late ? 'r' : 'n'} plain className="hide-m">{dueLabel(t.deadline, today, eow)}</Badge>
                                        {who && <span className="sb-who"><PixelAvatar spec={personAvatar(who)} round size={22} />{firstName(who)}</span>}
                                    </div>
                                );
                            })}
                        </Card>
                    </React.Fragment>
                ) : null))}
            </div>

            {sheetTask && <TaskSheet key={sheetTask.id || 'new'} task={sheetTask} employees={employees} projects={open}
                onClose={() => { setEditing(null); clearParams('task'); }} notify={notify} />}
            {projectSeed && <ProjectSheet seed={projectSeed} notify={notify} onCreated={(id) => setTab(id)}
                onClose={() => { setProjectSheet(null); clearParams('newProject', 'fromQuotation', 'client'); }} />}
            {note && <div className="sb sb-toast" role="status">{note}</div>}
        </div>
    );
}

function TaskSheet({ task, employees, projects, onClose, notify }) {
    const isEdit = !!task.id;
    const [f, setF] = useState(() => ({
        title: task.title || '', description: task.description || '', assignedTo: task.assignedTo || '',
        priority: task.priority || 'medium', deadline: task.deadline || '', status: task.status === 'overdue' ? 'pending' : (task.status || 'pending'),
        projectId: task.projectId || '', milestoneId: task.milestoneId || '', notes: task.notes || '',
    }));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
    const canSave = isEdit ? orgStore.can('tasks', 'edit') : orgStore.can('tasks', 'create');

    const save = async () => {
        if (!f.title.trim()) { setError('Give the task a title.'); return; }
        if (!f.assignedTo) { setError('Choose who this is for.'); return; }
        setSaving(true);
        setError('');
        try {
            const emp = employees.find((e) => e.id === f.assignedTo) || {};
            const payload = {
                ...f, title: f.title.trim(),
                assignedName: emp.name || '', assignedEmail: emp.email || '', assignedPhone: emp.phone || '',
                assignedRole: emp.role || '', assignedDept: emp.department || '',
                deadline: f.deadline || null, followUpSentAt: task.followUpSentAt ?? null,
                projectId: f.projectId || null,
                // A milestone belongs to its project; moving the task drops it (as before).
                milestoneId: f.projectId && f.projectId === task.projectId ? f.milestoneId || null : null,
            };
            if (isEdit) await taskStore.update(task.id, payload);
            else await taskStore.create(payload);
            notify(isEdit ? 'Task saved.' : 'Task added.');
            onClose();
        } catch (e) {
            setError(/MILESTONE|project/i.test(e?.message || '') ? 'That milestone belongs to a different project.' : 'Could not save the task. Try again.');
        } finally { setSaving(false); }
    };
    const remove = async () => {
        if (!(await confirmDialog({ title: 'Delete task', message: `Delete “${task.title}”? This cannot be undone.` }))) return;
        taskStore.remove(task.id);
        notify('Task deleted.');
        onClose();
    };
    const pickable = projects;

    return (
        <Sheet open onClose={onClose} title={isEdit ? 'Task' : 'New task'}
            footer={canSave ? (
                <>
                    {isEdit && orgStore.can('tasks', 'delete') && <Button variant="danger" onClick={remove}>Delete</Button>}
                    <Button variant="primary" block onClick={save} disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save' : 'Add task'}</Button>
                </>
            ) : null}>
            {error && <div className="sb-err" role="alert">{error}</div>}
            <Field label="What needs doing"><input value={f.title} data-autofocus onChange={set('title')} readOnly={!canSave} /></Field>
            <div className="sb-grid2">
                <Field label="Who" select>
                    <select value={f.assignedTo} onChange={set('assignedTo')} disabled={!canSave}>
                        <option value="">Choose…</option>
                        {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.role ? `, ${e.role}` : ''}</option>)}
                    </select>
                </Field>
                <Field label="Due"><input type="date" value={f.deadline || ''} onChange={set('deadline')} readOnly={!canSave} /></Field>
                <Field label="Project" select>
                    <select value={f.projectId} onChange={set('projectId')} disabled={!canSave}>
                        <option value="">General</option>
                        {pickable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        {f.projectId && !pickable.some((p) => p.id === f.projectId) && <option value={f.projectId}>Closed project</option>}
                    </select>
                </Field>
            </div>
            <div className="sb-field"><label>Priority</label>
                <Segmented block label="Priority" value={f.priority} onChange={set('priority')} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
            </div>
            {isEdit && (
                <div className="sb-field"><label>Status</label>
                    <Segmented block label="Status" value={f.status} onChange={set('status')} options={[{ value: 'pending', label: 'To do' }, { value: 'in-progress', label: 'Doing' }, { value: 'done', label: 'Done' }]} />
                </div>
            )}
            <Field label="Details"><textarea rows={3} value={f.description} onChange={set('description')} readOnly={!canSave} /></Field>
        </Sheet>
    );
}

function ProjectSheet({ seed, onClose, notify, onCreated }) {
    const clients = orgStore.getSectionAsList('customers').filter((c) => c.status !== 'archived');
    const fromQuote = seed.fromQuotation ? prefillFromQuotation(seed.fromQuotation) : null;
    const [f, setF] = useState(() => ({
        name: fromQuote?.name || '', kind: 'client',
        client_id: fromQuote?.client_id || seed.client || '',
    }));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const save = async () => {
        if (!f.name.trim()) { setError('Give the project a name.'); return; }
        if (f.kind === 'client' && !f.client_id) { setError('Choose the client, or make it internal.'); return; }
        setSaving(true);
        setError('');
        try {
            const data = {
                name: f.name.trim(), client_id: f.kind === 'client' ? f.client_id : null, status: 'active',
                ...(fromQuote ? { contract_value: fromQuote.contract_value, source_quotation_id: fromQuote.source_quotation_id } : {}),
            };
            const { project, problems } = await createProject(data, { milestones: fromQuote?.milestones || [] });
            notify(problems.length ? `Project started. ${problems[0]}` : 'Project started.');
            onCreated?.(project.id);
            onClose();
        } catch (e) { setError(friendlyError(e).message || e.message); }
        finally { setSaving(false); }
    };

    return (
        <Sheet open onClose={onClose} title="New project"
            footer={<Button variant="primary" block onClick={save} disabled={saving}>{saving ? 'Starting…' : 'Start project'}</Button>}>
            {error && <div className="sb-err" role="alert">{error}</div>}
            {fromQuote && <div className="sb-note b">From the accepted quotation. Its value and lines come with it.</div>}
            <Field label="Name"><input value={f.name} data-autofocus onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} placeholder="e.g. Website rebuild" /></Field>
            <div className="sb-field"><label>For</label>
                <Segmented block label="For" value={f.kind} onChange={(v) => setF((x) => ({ ...x, kind: v }))} options={[{ value: 'client', label: 'A client' }, { value: 'internal', label: 'Internal' }]} />
            </div>
            {f.kind === 'client' && (
                <Field label="Client" select>
                    <select value={f.client_id} onChange={(e) => setF((x) => ({ ...x, client_id: e.target.value }))}>
                        <option value="">Choose…</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </Field>
            )}
            <p className="sb-acnote">Tasks can be filed under it from Work or the chat.</p>
        </Sheet>
    );
}

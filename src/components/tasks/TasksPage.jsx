import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { taskStore } from '../../services/taskStore';
import { orgStore } from '../../services/orgStore';
import { useAuth } from '../../context/AuthContext';
import { useSection } from '../financial/financeHooks';
import ProjectBadge from '../projects/ProjectBadge';
import TaskModal from './TaskModal';
import {
    Page, Toolbar, Panel, Row, Btn, Seg, Search, Select, Table, Tr, Td,
    Avatar, Status, Bar, Breakdown, Empty, Muted,
} from '../ui/edge';
import { useT, MONO } from '../ui/edgeUtils';

/* ══════════════════════════════════════════════════════════════════════════
   Task board.

   Two ways to read the same list. Board is the default — three columns, one
   per state, because a board's value is seeing the shape of the work. List is
   for when you want to sort by deadline or scan one person's load.

   Status is changed from the card itself, so moving a task from pending to
   done is one click rather than open-edit-save. Priority is a word, not a
   coloured chip, and only High and Overdue are allowed to use colour — if
   everything is highlighted, nothing is.

   Tasks belong to a project or to nobody ("General"). With `projectId` the
   board is that project's and the project filter is fixed — that is how the
   project page's Tasks tab uses it; on its own route it also honours
   ?project=<id>.
   ══════════════════════════════════════════════════════════════════════════ */

const COLUMNS = [
    { id: 'pending', label: 'Pending' },
    { id: 'in-progress', label: 'In progress' },
    { id: 'done', label: 'Done' },
];

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

function empName(emp) {
    if (!emp) return '';
    if (emp.first_name && emp.last_name) return `${emp.first_name} ${emp.last_name}`;
    return emp.first_name || emp.last_name || emp.studentName || emp.name || '';
}

/** Deadline as a person would read it: a countdown near the date, a plain
    date when it is far away. */
function deadlineOf(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d - today) / 86400000);
    if (diff < 0) return { text: Math.abs(diff) + 'd overdue', tone: 'down' };
    if (diff === 0) return { text: 'Due today', tone: 'down' };
    if (diff === 1) return { text: 'Due tomorrow', tone: 'neutral' };
    if (diff <= 7) return { text: diff + 'd left', tone: 'neutral' };
    return { text: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), tone: 'mute' };
}

export default function TasksPage({ projectId = null, embedded = false }) {
    const t = useT();
    const { user } = useAuth();
    const [params] = useSearchParams();
    const projects = useSection('projects');
    const milestones = useSection('project_milestones');
    const [tasks, setTasks] = useState([]);
    const [employees, setEmployees] = useState([]);
    const [view, setView] = useState('board');
    const [status, setStatus] = useState('all');
    const [who, setWho] = useState('all');
    const [project, setProject] = useState(projectId || params.get('project') || 'all');
    const [milestone, setMilestone] = useState('all');
    const [mine, setMine] = useState(false);
    const [query, setQuery] = useState('');
    const [sortBy, setSortBy] = useState('deadline');
    const [showModal, setShowModal] = useState(false);
    const [editing, setEditing] = useState(null);

    const reload = useCallback(() => {
        setTasks(taskStore.getAll());
        setEmployees(orgStore.getSectionAsList('employees'));
    }, []);

    useEffect(() => {
        reload();
        const unsubscribe = taskStore.onChanged(reload);
        const interval = setInterval(reload, 5000);
        return () => { unsubscribe(); clearInterval(interval); };
    }, [reload]);

    const today = new Date().toISOString().slice(0, 10);
    const isOverdue = useCallback(
        (task) => task.status !== 'done' && task.deadline && task.deadline < today,
        [today],
    );

    const byId = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e])), [employees]);
    const projectById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);
    const myEmployeeId = useMemo(() => employees.find((e) => e.user_id && e.user_id === user?.id)?.id || null, [employees, user]);
    const projectMilestones = useMemo(() => (project !== 'all' && project !== 'general'
        ? milestones.filter((m) => m.project_id === project).sort((a, b) => a.sort_order - b.sort_order)
        : []), [milestones, project]);

    // The project scope applies before everything else, stats included: on a
    // project's page, "3 overdue" means that project's.
    const scoped = useMemo(() => tasks.filter((x) => {
        if (project === 'general') return !x.projectId;
        if (project !== 'all' && x.projectId !== project) return false;
        if (milestone === 'none' && x.milestoneId) return false;
        if (milestone !== 'all' && milestone !== 'none' && x.milestoneId !== milestone) return false;
        if (mine && x.assignedTo !== myEmployeeId) return false;
        return true;
    }), [tasks, project, milestone, mine, myEmployeeId]);

    const stats = useMemo(() => ({
        total: scoped.length,
        pending: scoped.filter((x) => x.status === 'pending').length,
        progress: scoped.filter((x) => x.status === 'in-progress').length,
        done: scoped.filter((x) => x.status === 'done').length,
        overdue: scoped.filter(isOverdue).length,
    }), [scoped, isOverdue]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return scoped.filter((x) => {
            if (status === 'overdue' ? !isOverdue(x) : status !== 'all' && x.status !== status) return false;
            if (who !== 'all' && x.assignedTo !== who) return false;
            if (q && !(x.title || '').toLowerCase().includes(q)
                && !(x.description || '').toLowerCase().includes(q)) return false;
            return true;
        });
    }, [scoped, status, who, query, isOverdue]);

    const sorted = useMemo(() => [...filtered].sort((a, b) => {
        if (sortBy === 'deadline') {
            if (!a.deadline) return 1;
            if (!b.deadline) return -1;
            return a.deadline.localeCompare(b.deadline);
        }
        if (sortBy === 'priority') return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
        if (sortBy === 'person') return empName(byId[a.assignedTo]).localeCompare(empName(byId[b.assignedTo]));
        return 0;
    }), [filtered, sortBy, byId]);

    // Load per person, so it is obvious who is carrying the open work.
    const load = useMemo(() => {
        const m = {};
        scoped.filter((x) => x.status !== 'done').forEach((x) => {
            const n = empName(byId[x.assignedTo]) || 'Unassigned';
            m[n] = (m[n] || 0) + 1;
        });
        return Object.entries(m).map(([label, value]) => ({ label, value }));
    }, [scoped, byId]);

    const move = async (task, next) => {
        try {
            await taskStore.update(task.id, { ...task, status: next });
            reload();
        } catch {
            /* the store repaints on its own change event */
        }
    };

    const openCreate = () => { setEditing(null); setShowModal(true); };
    const openEdit = (task) => { setEditing(task); setShowModal(true); };

    // /tasks?task=<id> — EdgeAI's "Open" on a task card lands on that task.
    const linkedTask = params.get('task');
    const [openedLink, setOpenedLink] = useState(null);
    useEffect(() => {
        if (!linkedTask || openedLink === linkedTask) return;
        const task = tasks.find((x) => x.id === linkedTask);
        if (!task) return;
        setOpenedLink(linkedTask);
        setEditing(task);
        setShowModal(true);
    }, [linkedTask, openedLink, tasks]);

    const Card = ({ task }) => {
        const dl = deadlineOf(task.deadline);
        const over = isOverdue(task);
        const person = byId[task.assignedTo];
        const next = task.status === 'pending' ? 'in-progress' : task.status === 'in-progress' ? 'done' : null;
        return (
            <div style={{
                border: '1px solid ' + (over ? t.lineStrong : t.line),
                borderLeft: '2px solid ' + (over ? t.down : task.priority === 'high' ? t.dim : t.line),
                borderRadius: 9, padding: 11, background: t.panel,
                opacity: task.status === 'done' ? 0.62 : 1,
            }}>
                <button type="button" onClick={() => openEdit(task)} className="edge-tr" style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: 0, marginBottom: 9,
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontFamily: MONO, fontSize: 11.5, color: t.text, lineHeight: 1.5,
                }}>
                    {task.title}
                </button>

                {!projectId && task.projectId && (
                    <div style={{ fontSize: 10, marginBottom: 7 }}><ProjectBadge project={projectById[task.projectId]} /></div>
                )}

                {task.description && (
                    <p style={{
                        margin: '0 0 9px', fontSize: 10, color: t.faint, lineHeight: 1.6,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>{task.description}</p>
                )}

                <Row gap={8} style={{ marginBottom: 9 }}>
                    <Avatar name={empName(person) || '?'} size={20} />
                    <span style={{
                        flex: 1, minWidth: 0, fontSize: 10, color: t.faint,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{empName(person) || 'Unassigned'}</span>
                    {task.priority === 'high' && (
                        <span style={{ fontSize: 9, letterSpacing: '0.06em', color: t.dim }}>HIGH</span>
                    )}
                </Row>

                <Row gap={8} style={{ paddingTop: 9, borderTop: '1px solid ' + t.lineSoft }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                        {dl && <Status tone={over ? 'down' : dl.tone}>{dl.text}</Status>}
                    </span>
                    {next && <Btn size="sm" onClick={() => move(task, next)}>
                        {next === 'done' ? 'Done' : 'Start'}
                    </Btn>}
                    {task.status === 'done' && <Btn size="sm" onClick={() => move(task, 'pending')}>Reopen</Btn>}
                </Row>
            </div>
        );
    };

    const Frame = embedded ? 'div' : Page;
    return (
        <Frame>
            <Toolbar right={<Btn primary onClick={openCreate}>New task</Btn>}>
                <Seg value={view} onChange={setView} options={[
                    { id: 'board', label: 'Board' }, { id: 'list', label: 'List' },
                ]} />
                <Search value={query} onChange={setQuery} placeholder="Search tasks…" width={210} />
                <Select aria-label="Assigned to" value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 168, height: 29 }}>
                    <option value="all">Everyone</option>
                    {employees.map((e) => <option key={e.id} value={e.id}>{empName(e)}</option>)}
                </Select>
                {!projectId && (
                    <Select aria-label="Project" value={project}
                        onChange={(e) => { setProject(e.target.value); setMilestone('all'); }} style={{ width: 190, height: 29 }}>
                        <option value="all">Every project</option>
                        <option value="general">General (no project)</option>
                        {projects.filter((p) => !p.archived_at || p.id === project).map((p) => (
                            <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                        ))}
                    </Select>
                )}
                {projectMilestones.length > 0 && (
                    <Select aria-label="Milestone" value={milestone} onChange={(e) => setMilestone(e.target.value)} style={{ width: 170, height: 29 }}>
                        <option value="all">Every milestone</option>
                        <option value="none">No milestone</option>
                        {projectMilestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
                    </Select>
                )}
                {myEmployeeId && (
                    <Btn size="sm" aria-pressed={mine} onClick={() => setMine((v) => !v)}>{mine ? '\u2713 ' : ''}My tasks</Btn>
                )}
                {view === 'list' && (
                    <>
                        <Seg size="sm" value={status} onChange={setStatus} options={[
                            { id: 'all', label: 'All', count: stats.total },
                            { id: 'pending', label: 'Pending', count: stats.pending },
                            { id: 'in-progress', label: 'Active', count: stats.progress },
                            { id: 'done', label: 'Done', count: stats.done },
                            { id: 'overdue', label: 'Overdue', count: stats.overdue },
                        ]} />
                        <Select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ width: 132, height: 29 }}>
                            <option value="deadline">By deadline</option>
                            <option value="priority">By priority</option>
                            <option value="person">By person</option>
                        </Select>
                    </>
                )}
            </Toolbar>

            {/* Progress, not four counters: how much of the work is finished. */}
            {stats.total > 0 && (
                <div style={{
                    border: '1px solid ' + t.line, borderRadius: 10,
                    padding: '13px 15px', marginBottom: 14,
                }}>
                    <Row gap={14} wrap style={{ marginBottom: 10 }}>
                        <span style={{ fontSize: 18, fontWeight: 500, letterSpacing: '-0.03em' }}>
                            {Math.round((stats.done / stats.total) * 100)}%
                        </span>
                        <span style={{ fontSize: 10, letterSpacing: '0.09em', color: t.faint, alignSelf: 'center' }}>
                            DONE — {stats.done} of {stats.total}
                        </span>
                        <div style={{ flex: 1 }} />
                        {stats.overdue > 0 && (
                            <Status tone="down">{stats.overdue} overdue</Status>
                        )}
                        <Muted>{stats.progress} in progress · {stats.pending} not started</Muted>
                    </Row>
                    <Bar value={stats.done} max={stats.total} height={5} />
                </div>
            )}

            {scoped.length === 0 ? (
                <Panel>
                    <Empty action={<Btn primary onClick={openCreate}>Create the first task</Btn>}>
                        No tasks yet. Assign work here and the person sees it — with its deadline — in their portal.
                    </Empty>
                </Panel>
            ) : view === 'board' ? (
                <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', alignItems: 'start' }}>
                    {COLUMNS.map((col) => {
                        const items = filtered.filter((x) => x.status === col.id);
                        return (
                            <section key={col.id} style={{
                                border: '1px solid ' + t.line, borderRadius: 10,
                                background: t.panel, minWidth: 0,
                            }}>
                                <header style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    padding: '10px 13px', borderBottom: '1px solid ' + t.lineSoft,
                                }}>
                                    <span style={{ fontSize: 11.5, color: t.text, flex: 1 }}>{col.label}</span>
                                    <span style={{ fontSize: 10, color: t.ghost }}>{items.length}</span>
                                </header>
                                <div style={{ display: 'grid', gap: 8, padding: 10 }}>
                                    {items.length === 0
                                        ? <div style={{ padding: '20px 6px', textAlign: 'center', fontSize: 10, color: t.ghost }}>Nothing here</div>
                                        : items.map((task) => <Card key={task.id} task={task} />)}
                                </div>
                            </section>
                        );
                    })}

                    {load.length > 0 && (
                        <Panel title="Open work per person" pad={13} style={{ alignSelf: 'start' }}>
                            <Breakdown rows={load} max={8} />
                        </Panel>
                    )}
                </div>
            ) : sorted.length === 0 ? (
                <Panel><Empty>Nothing matches those filters.</Empty></Panel>
            ) : (
                <Table cols={[
                    { key: 't', label: 'Task' },
                    ...(projectId ? [] : [{ key: 'j', label: 'Project' }]),
                    { key: 'w', label: 'Assigned to' },
                    { key: 's', label: 'Status' },
                    { key: 'p', label: 'Priority' },
                    { key: 'd', label: 'Deadline' },
                    { key: 'a', label: '', align: 'right', width: 140 },
                ]}>
                    {sorted.map((task) => {
                        const dl = deadlineOf(task.deadline);
                        const over = isOverdue(task);
                        const person = byId[task.assignedTo];
                        const next = task.status === 'pending' ? 'in-progress' : task.status === 'in-progress' ? 'done' : null;
                        return (
                            <Tr key={task.id}>
                                <Td>
                                    <span style={{ display: 'block' }}>{task.title}</span>
                                    {task.description && (
                                        <span style={{
                                            display: 'block', fontSize: 9.5, color: t.faint, marginTop: 2,
                                            maxWidth: 420, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                        }}>{task.description}</span>
                                    )}
                                </Td>
                                {!projectId && <Td nowrap><ProjectBadge project={projectById[task.projectId]} /></Td>}
                                <Td nowrap>
                                    <Row gap={8}>
                                        <Avatar name={empName(person) || '?'} size={22} />
                                        <span style={{ fontSize: 11, color: t.dim }}>{empName(person) || 'Unassigned'}</span>
                                    </Row>
                                </Td>
                                <Td nowrap>
                                    <Status tone={task.status === 'done' ? 'up' : over ? 'down' : 'neutral'}>
                                        {over && task.status !== 'done' ? 'Overdue' : COLUMNS.find((c) => c.id === task.status)?.label || task.status}
                                    </Status>
                                </Td>
                                <Td muted nowrap>{PRIORITY_LABEL[task.priority] || '—'}</Td>
                                <Td nowrap>{dl ? <Status tone={over ? 'down' : dl.tone}>{dl.text}</Status> : <span style={{ color: t.ghost }}>—</span>}</Td>
                                <Td align="right">
                                    <Row gap={6} style={{ justifyContent: 'flex-end' }}>
                                        {next && <Btn size="sm" onClick={() => move(task, next)}>{next === 'done' ? 'Done' : 'Start'}</Btn>}
                                        {task.status === 'done' && <Btn size="sm" onClick={() => move(task, 'pending')}>Reopen</Btn>}
                                        <Btn size="sm" onClick={() => openEdit(task)}>Edit</Btn>
                                    </Row>
                                </Td>
                            </Tr>
                        );
                    })}
                </Table>
            )}

            {showModal && (
                <TaskModal
                    task={editing}
                    defaultProjectId={projectId || (project !== 'all' && project !== 'general' ? project : null)}
                    defaultMilestoneId={milestone !== 'all' && milestone !== 'none' ? milestone : null}
                    lockProject={!!projectId}
                    onClose={() => { setShowModal(false); setEditing(null); }}
                    onSaved={reload}
                />
            )}
        </Frame>
    );
}

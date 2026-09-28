import { useEffect, useMemo, useState } from 'react';
import { Send, Users } from 'lucide-react';
import {
  Panel, Grid, Btn, Field, Input, Textarea, Search, Seg, Empty, Row, Muted,
} from '../ui/edge';
import { useT, MONO } from '../ui/edgeUtils';
import { adminService } from '../../services/adminService';
import { useToast } from '../shared/Toast';
import { PlanTag } from './adminUi';

/* Reach customers from the console. The recipient list is built by picking
   from the tenants already on screen rather than typed, because a typed
   address is a typo and a typo is a message that silently never arrives.

   The send itself uses the platform's own mailbox, not any tenant's stored
   Gmail credentials — a customer's SMTP quota is theirs, not the operator's. */

const AUDIENCE = [
  { id: 'picked', label: 'Picked' },
  { id: 'all', label: 'All tenants' },
  { id: 'free', label: 'Free' },
  { id: 'pro', label: 'Pro' },
  { id: 'max', label: 'Max' },
];

const TEMPLATES = [
  {
    id: 'blank', label: 'Blank', subject: '', body: '',
  },
  {
    id: 'announce',
    label: 'Product update',
    subject: "What's new in StartupBuddy",
    body: 'Hi there,\n\nWe have shipped a few things to StartupBuddy this month that we think will save you time:\n\n• \n• \n\nAs always, reply to this email if anything is in your way.\n\n— The StartupBuddy team',
  },
  {
    id: 'upgrade',
    label: 'Plan nudge',
    subject: 'More room on your StartupBuddy workspace',
    body: 'Hi there,\n\nYou have been getting a lot out of StartupBuddy lately. Your current plan caps a few things you are close to — upgrading lifts those limits and unlocks bulk operations.\n\nHappy to walk you through it; just reply here.\n\n— The StartupBuddy team',
  },
  {
    id: 'dues',
    label: 'Payment reminder',
    subject: 'A quick note about your StartupBuddy subscription',
    body: 'Hi there,\n\nWe were not able to process the most recent payment for your StartupBuddy subscription. Nothing has changed on your workspace yet.\n\nYou can update the payment details any time, or reply here and we will sort it out together.\n\n— The StartupBuddy team',
  },
];

export default function AdminMail({ orgs, preset }) {
  const t = useT();
  const toast = useToast();

  const [audience, setAudience] = useState(preset?.length ? 'picked' : 'all');
  const [picked, setPicked] = useState(() => new Set(preset || []));
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);

  // A preset arriving from Organisations replaces the picked set and switches
  // the audience to it — the operator clicked "email these", so that is the
  // list they mean. `mailTo` hands over a fresh array each time, so clicking
  // it again with the same addresses still re-applies.
  useEffect(() => {
    if (!preset?.length) return;
    setPicked(new Set(preset));
    setAudience('picked');
  }, [preset]);

  const live = useMemo(() => (orgs || []).filter((o) => !o.deletedAt), [orgs]);

  const contacts = useMemo(() => {
    const seen = new Map();
    for (const o of live) {
      const address = (o.email || o.owner?.email || '').toLowerCase();
      if (!address || seen.has(address)) continue;
      seen.set(address, { address, name: o.name, plan: o.plan, id: o.id });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [live]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || c.address.includes(q));
  }, [contacts, query]);

  const recipients = useMemo(() => {
    if (audience === 'picked') return [...picked];
    if (audience === 'all') return contacts.map((c) => c.address);
    return contacts.filter((c) => c.plan === audience).map((c) => c.address);
  }, [audience, picked, contacts]);

  const toggle = (address) => {
    setAudience('picked');
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  const applyTemplate = (id) => {
    const tpl = TEMPLATES.find((x) => x.id === id);
    if (!tpl) return;
    setSubject(tpl.subject);
    setBody(tpl.body);
  };

  const send = async () => {
    setSending(true);
    setSent(null);
    try {
      const res = await adminService.sendEmail({ to: recipients, subject, body });
      setSent(res.sent);
      toast(`Sent to ${res.sent} recipient${res.sent === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      toast(err.message || 'Could not send', 'error');
    } finally {
      setSending(false);
    }
  };

  const ready = recipients.length > 0 && subject.trim() && body.trim();

  return (
    <Grid cols="minmax(320px, 1fr) minmax(0, 1.4fr)" gap={14}>
      {/* ── recipients ──────────────────────────────────────────────────── */}
      <Panel
        title="Recipients"
        note={`${recipients.length} selected`}
        actions={audience === 'picked' && picked.size > 0
          ? <Btn size="sm" onClick={() => setPicked(new Set())}>Clear</Btn>
          : null}
        pad={14}
      >
        <div style={{ display: 'grid', gap: 11 }}>
          <Seg value={audience} onChange={setAudience} options={AUDIENCE} size="sm" label="Audience" />
          <Search value={query} onChange={setQuery} placeholder="Find a tenant…" width="100%" />

          <div className="edge-scroll" style={{
            maxHeight: 360, overflowY: 'auto', margin: '0 -4px',
            border: '1px solid ' + t.line, borderRadius: 8,
          }}>
            {visible.length === 0 && <Empty>No tenants match.</Empty>}
            {visible.map((c, i) => {
              const on = recipients.includes(c.address);
              return (
                <label
                  key={c.address}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px',
                    cursor: 'pointer', borderTop: i === 0 ? 'none' : '1px solid ' + t.lineSoft,
                    background: on ? t.panelAlt : 'transparent',
                    // index.css styles every bare <label> as an uppercased,
                    // letter-spaced form caption. This one is a row of content.
                    textTransform: 'none', letterSpacing: 'normal',
                    fontWeight: 400, marginBottom: 0,
                  }}
                >
                  <input
                    type="checkbox" checked={on}
                    onChange={() => toggle(c.address)}
                    style={{ accentColor: t.text, width: 13, height: 13, flexShrink: 0, cursor: 'pointer' }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{
                      display: 'block', fontSize: 11.5, color: t.text,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{c.name}</span>
                    <span style={{
                      display: 'block', fontSize: 9.5, color: t.ghost, marginTop: 2,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{c.address}</span>
                  </span>
                  <PlanTag plan={c.plan} />
                </label>
              );
            })}
          </div>

          <Muted>
            Recipients are BCC'd, so nobody receives the customer list.
          </Muted>
        </div>
      </Panel>

      {/* ── message ─────────────────────────────────────────────────────── */}
      <Panel title="Message" pad={14}>
        <div style={{ display: 'grid', gap: 13 }}>
          <Field label="Start from" hint="A starting point, not a send — edit before it goes out.">
            <Row gap={6} wrap>
              {TEMPLATES.map((tpl) => (
                <Btn key={tpl.id} size="sm" onClick={() => applyTemplate(tpl.id)}>{tpl.label}</Btn>
              ))}
            </Row>
          </Field>

          <Field label="Subject">
            <Input
              value={subject} maxLength={300}
              placeholder="What this email is about"
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>

          <Field label="Message">
            <Textarea
              value={body} rows={14}
              placeholder="Write to your customers…"
              onChange={(e) => setBody(e.target.value)}
              style={{ minHeight: 260, lineHeight: 1.75 }}
            />
          </Field>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            paddingTop: 12, borderTop: '1px solid ' + t.lineSoft,
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 10.5, color: t.faint }}>
              <Users size={12} aria-hidden="true" />
              {recipients.length === 0
                ? 'No recipients selected'
                : `${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`}
            </span>
            <div style={{ flex: 1 }} />
            {sent !== null && (
              <span role="status" style={{ fontSize: 10.5, color: t.up }}>Delivered to {sent}</span>
            )}
            <Btn primary onClick={send} disabled={!ready || sending}>
              {sending
                ? 'Sending…'
                : <><Send size={12} aria-hidden="true" /> Send to {recipients.length}</>}
            </Btn>
          </div>
        </div>
      </Panel>
    </Grid>
  );
}

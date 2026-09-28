import { useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useT, MONO } from '../ui/edgeUtils';
import { Btn, Field, Input } from '../ui/edge';
import { isPlatformAdmin, PLATFORM_ADMIN_EMAIL } from '../../services/adminService';

/**
 * The console's door.
 *
 * This is a real Supabase sign-in, not a password compared in the browser —
 * the old panel kept `admin123` in localStorage and let anyone past who could
 * open devtools. The credential is checked by the auth server; the console
 * then opens only if the resulting session carries the `platform_admin` claim
 * AND is the allow-listed address, which is exactly what /api/admin re-checks
 * on every request. A correct password on any other account gets nothing.
 */
export default function AdminLogin({ wrongAccount }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) throw new Error(authError.message);

      if (!isPlatformAdmin(data.user)) {
        // Signed in, but not the operator. Drop the session rather than leave
        // the browser holding a token the console will not use.
        await supabase.auth.signOut();
        throw new Error('This account cannot open the platform console.');
      }
      // AdminApp is watching onAuthStateChange; it takes over from here.
    } catch (err) {
      setError(err.message === 'Invalid login credentials'
        ? 'That email and password do not match an account.'
        : err.message || 'Could not sign in.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: t.shell, fontFamily: MONO, padding: 20,
    }}>
      <form
        onSubmit={submit}
        style={{
          width: '100%', maxWidth: 360, background: t.panel,
          border: '1px solid ' + t.line, borderRadius: 12,
          boxShadow: t.shadow, overflow: 'hidden',
        }}
      >
        <div style={{ padding: '22px 22px 18px', borderBottom: '1px solid ' + t.lineSoft }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
            background: t.panelAlt, border: '1px solid ' + t.line, marginBottom: 14, color: t.dim,
          }}>
            <ShieldCheck size={15} aria-hidden="true" />
          </div>
          <h1 style={{ margin: 0, fontSize: 14, fontWeight: 500, color: t.text, letterSpacing: '-0.01em' }}>
            StartupBuddy Platform Console
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 10.5, color: t.faint, lineHeight: 1.6 }}>
            Every tenant, their revenue and their contacts. Restricted to the
            platform operator.
          </p>
        </div>

        <div style={{ padding: 22, display: 'grid', gap: 13 }}>
          {wrongAccount && (
            <Notice t={t}>
              You are signed in as <strong style={{ fontWeight: 500 }}>{wrongAccount}</strong>, which
              is not the operator account. Sign in below to switch.
            </Notice>
          )}

          <Field label="Email">
            <Input
              type="email" value={email} required autoFocus autoComplete="username"
              placeholder={PLATFORM_ADMIN_EMAIL}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="Password">
            <Input
              type="password" value={password} required autoComplete="current-password"
              placeholder="••••••••"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {error && (
            <div role="alert" style={{
              fontSize: 10.5, color: t.down, lineHeight: 1.6,
              padding: '8px 10px', borderRadius: 7,
              border: '1px solid ' + t.line, background: t.panelAlt,
            }}>{error}</div>
          )}

          <Btn type="submit" primary full disabled={busy || !email || !password}>
            {busy
              ? <><Loader2 size={12} aria-hidden="true" style={{ animation: 'edgeSpin 1s linear infinite' }} /> Verifying…</>
              : 'Open console'}
          </Btn>

          <p style={{ margin: 0, fontSize: 9.5, color: t.ghost, lineHeight: 1.7, textAlign: 'center' }}>
            Signing in here replaces any workspace session in this browser.
          </p>
        </div>

        <style>{'@keyframes edgeSpin{to{transform:rotate(360deg)}}'}</style>
      </form>
    </div>
  );
}

function Notice({ t, children }) {
  return (
    <div style={{
      fontSize: 10.5, color: t.dim, lineHeight: 1.6,
      padding: '9px 11px', borderRadius: 7,
      border: '1px solid ' + t.line, background: t.panelAlt,
    }}>{children}</div>
  );
}

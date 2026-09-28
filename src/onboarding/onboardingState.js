import { supabase } from '../lib/supabase';

/* ══════════════════════════════════════════════════════════════════════════
   Where a new founder is in onboarding, so a reload resumes the same step.

   The company is created at the Company step (the unchanged
   create_organization RPC), which is before the cofounder, head-start and
   setting-up steps — so the app needs to know the person is not finished
   even though they now have an org. The step is kept on the user
   (user_metadata.startupbuddy_onboarding) and mirrored in localStorage,
   because during an email sign-up the auth state the app reads is the one
   from signUp(), which predates the metadata write.

   No flag means onboarding is done — which is every existing user.
   ══════════════════════════════════════════════════════════════════════════ */

export const STEP_KEY = 'startupbuddy_onboarding';
const lsKey = (uid) => `startupbuddy.onboarding.${uid}`;
export const INTRO_CALL_KEY = (uid) => `startupbuddy.introcall.${uid}`;

const ACTIVE = new Set(['cofounder', 'headstart', 'setup']);

/** The step to resume at, or null when onboarding is finished (or never applied). */
export function onboardingStep(user) {
    if (!user) return null;
    let local = null;
    try { local = localStorage.getItem(lsKey(user.id)); } catch { /* private mode */ }
    const meta = user.user_metadata?.[STEP_KEY] || null;
    // 'done' anywhere wins; otherwise the furthest-along of the two.
    if (meta === 'done' || local === 'done') return null;
    const order = ['cofounder', 'headstart', 'setup'];
    const pick = [meta, local].filter((s) => ACTIVE.has(s)).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
    return pick || null;
}

/** Records the step locally at once, and on the user (best effort). */
export async function setOnboardingStep(uid, step) {
    try { localStorage.setItem(lsKey(uid), step); } catch { /* private mode */ }
    try { await supabase.auth.updateUser({ data: { [STEP_KEY]: step } }); } catch { /* the local copy carries it */ }
}

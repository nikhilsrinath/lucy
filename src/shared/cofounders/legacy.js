/**
 * The cofounders that were retired, and who each one became.
 *
 * This is the only file that still knows the old ids: a stored choice
 * (auth user_metadata.startupbuddy_cofounder) is mapped on read, on the
 * server and in the app, and the app rewrites it the next time its owner
 * opens StartupBuddy (src/design/useCofounder.js).
 */
export const RETIRED = {
  mira: 'elon',
  neel: 'elon',
  sam: 'elon',
  anaya: 'elon',
  arjun: 'steve',
  vikram: 'steve',
  tara: 'mark',
  dia: 'mark',
  rohan: 'mark',
};

export const COFOUNDER_IDS = ['steve', 'elon', 'mark'];
export const DEFAULT_COFOUNDER_ID = 'steve';

const has = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

/** The cofounder a stored id means today: { id, migrated } — id is null for anything unknown. */
export function resolveCofounderId(stored) {
  if (typeof stored !== 'string') return { id: null, migrated: false };
  if (COFOUNDER_IDS.includes(stored)) return { id: stored, migrated: false };
  if (has(RETIRED, stored)) return { id: RETIRED[stored], migrated: true };
  return { id: null, migrated: false };
}

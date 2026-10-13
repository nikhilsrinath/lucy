/**
 * The vocabulary of meaning frames (frame.js): what a verb DOES and what kind
 * of THING a noun names — each with the many ways people say it.
 *
 * A sentence pattern knows one sentence. These two tables know words, so
 * "fire an employee", "get rid of one of my staff" and "can u pls remove a
 * guy from my team" are the same act on the same kind of thing without
 * anybody having written those sentences down.
 *
 * Adding a way of saying something is a word here. Adding something Buddy can
 * do is a line in capabilities.js.
 */

/** What a verb does. Phrasal verbs included; the longest match wins. */
export const ACTS = {
  CREATE: ['add', 'create', 'make', 'new', 'register', 'set up', 'setup', 'hire', 'onboard', 'on board', 'bring on', 'bring in', 'recruit', 'enrol', 'enroll', 'sign up', 'put in', 'include', 'insert', 'open'],
  REMOVE: [
    'remove', 'delete', 'fire', 'sack', 'terminate', 'let go of', 'lay off', 'layoff', 'get rid of', 'take off', 'take out', 'take', 'drop', 'scrap',
    'offboard', 'off board', 'kick out', 'dismiss', 'discard', 'erase', 'archive', 'trash', 'eliminate', 'relieve', 'discontinue', 'retire',
  ],
  CHANGE: ['change', 'update', 'edit', 'modify', 'set', 'correct', 'fix', 'revise', 'rename', 'adjust'],
  FINISH: ['finish', 'complete', 'close', 'wrap up', 'tick off', 'check off'],
  REOPEN: ['reopen', 're-open', 'uncomplete'],
  MOVE: ['move', 'push', 'shift', 'reschedule', 'postpone', 'prepone', 'delay', 'defer', 'extend', 'bump', 'push back', 'bring forward'],
  ASSIGN: ['assign', 'reassign', 'give', 'hand over', 'hand', 'delegate', 'allocate'],
  BILL: ['bill', 'invoice', 'charge'],
};

/** Verbs that are only ever said of a person: "fire Ravi" needs no noun to mean an employee. */
export const PERSON_ACTS = /^(?:fire|sack|terminate|lay off|layoff|offboard|off board|dismiss|let go of|relieve|hire|recruit|onboard|on board)$/i;

/**
 * Kinds of thing. `one` names a single record ("an employee"); `group` names
 * where they live ("from the team", "off the price list"). `label` is how
 * Buddy refers to them; `page` is where they are managed.
 */
export const THINGS = {
  employee: {
    one: ['employee', 'team member', 'teammate', 'staff member', 'staff', 'person', 'guy', 'girl', 'joinee', 'joiner', 'new joiner', 'new joinee', 'new hire', 'hire', 'recruit', 'intern', 'member', 'colleague', 'worker', 'contractor', 'freelancer', 'people', 'resource'],
    group: ['team', 'staff', 'company', 'payroll', 'organisation', 'organization', 'workforce', 'roster', 'employees', 'team members', 'people'],
    label: 'team members', page: 'employees',
  },
  client: {
    one: ['client', 'customer', 'lead', 'prospect', 'account'],
    group: ['clients', 'customers', 'crm', 'client list', 'customer list', 'leads', 'pipeline'],
    label: 'clients', page: 'clients',
  },
  vendor: {
    one: ['vendor', 'supplier'],
    group: ['vendors', 'suppliers', 'vendor list', 'supplier list'],
    label: 'vendors', page: 'vendors',
  },
  catalog: {
    one: ['product', 'item', 'catalogue item', 'catalog item', 'service', 'sku', 'item name', 'product name'],
    group: ['catalogue', 'catalog', 'price list', 'pricelist', 'catalogue items', 'catalog items', 'items', 'products', 'item list', 'product list', 'rate card'],
    label: 'catalogue items', page: 'products',
  },
  task: {
    one: ['task', 'todo', 'to-do', 'to do', 'action item'],
    group: ['tasks', 'task list', 'todo list', 'to-do list'],
    label: 'tasks', page: 'tasks',
  },
  project: { one: ['project'], group: ['projects', 'project list'], label: 'projects', page: 'projects' },
  announcement: { one: ['announcement', 'notice'], group: ['announcements', 'notice board', 'noticeboard'], label: 'announcements', page: 'announcements' },
  department: { one: ['department', 'dept'], group: ['departments'], label: 'departments', page: 'employees' },
  banking: {
    one: ['bank account', 'bank account number', 'bank details', 'bank detail', 'account number', 'ifsc', 'ifsc code', 'upi id', 'upi', 'gstin', 'gst number', 'pan', 'pan number', 'bank'],
    group: [], label: 'bank details and tax ids', page: 'settings',
  },
  permission: {
    one: ['admin', 'owner', 'permission', 'permissions', 'access', 'role and permissions', 'user role', 'login', 'viewer', 'access rights'],
    group: [], label: 'roles and permissions', page: 'settings',
  },
  plan: { one: ['plan', 'subscription', 'billing plan'], group: [], label: 'the plan', page: 'usage' },
};

/**
 * Understood, but not something chat does: said plainly, with the page
 * opened, and no model call. `'*'` covers every act on that kind.
 */
export const UNSUPPORTED = {
  'REMOVE:project': 'delete projects',
  'REMOVE:announcement': 'take down announcements',
  'REMOVE:department': 'remove departments',
  'CREATE:department': 'add departments',
  'CHANGE:department': 'change departments',
  '*:banking': 'change bank details or tax ids',
  '*:permission': 'change roles and permissions',
  '*:plan': 'change the plan',
};

/** Said in place of a name: "someone", "one", "a name". They ask "which?", they do not answer it. */
export const GENERIC = /^(?:someone|somebody|something|anyone|anybody|anything|one|ones|name|names|entry|record|few|couple)$/i;

/** Words in front of a noun that say nothing about which one. */
export const DETERMINER = '(?:a|an|the|my|our|your|one of (?:my|our|the)|one more|one|another|some|any|new|this|that|these|those|existing|old|more|few|certain|particular|single)';

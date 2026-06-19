// Wren IA registry — admin portal sections
// Used by wren-shell-v2.js and demo editions
// Each section has tabs; edition-specific overrides in EDITION_TABS

const ADMIN_SECTIONS = {
  dashboard:      { id: 'dashboard',      icon: '🏠', label: 'Dashboard',     tabs: ['today', 'alerts', 'summary'] },
  admissions:     { id: 'admissions',     icon: '🌱', label: 'Admissions',    tabs: ['pipeline', 'list', 'trends', 'forecast', 'occupancy', 'ai-scoring'] },
  'action-plans': { id: 'action-plans',   icon: '⭐', label: 'Action Plans',  tabs: ['management', 'baby-room', 'pre-school', 'shared-with-parents'] },
  staff:          { id: 'staff',          icon: '👥', label: 'Staff',         tabs: ['list', 'calendar', 'rota', 'bradford', 'training', 'documents', 'observations', 'performance', 'reports'] },
  children:       { id: 'children',       icon: '👶', label: 'Children',      tabs: ['list', 'reports'] },
  curriculum:     { id: 'curriculum',     icon: '📚', label: 'Curriculum',    tabs: ['planning', 'next-steps', 'events', 'trips', 'calendar'] },
  finance:        { id: 'finance',        icon: '💷', label: 'Finance',       tabs: ['dashboard', 'forecast', 'invoices', 'reconcile', 'payments', 'funding', 'wages', 'payroll'] },
  communications: { id: 'communications', icon: '💬', label: 'Comms',         tabs: ['inbox', 'messaging', 'newsletters', 'aria', 'content-creator', 'message-review'] },
  safeguarding:   { id: 'safeguarding',   icon: '🛡️', label: 'Safeguarding',  tabs: ['concerns', 'sign-off-queue', 'log', 'audit'] },
  inspection:     { id: 'inspection',     icon: '📋', label: 'Inspection',    tabs: ['overview', 'action-items', 'briefings', 'gap-analysis', 'evidence', 'history'], requiresRole: 'manager' },
  insights:       { id: 'insights',       icon: '📊', label: 'Insights',      tabs: ['overview', 'chat', 'dashboards', 'documents', 'anomalies', 'forecasts'], requiresRole: 'manager' },
  operations:     { id: 'operations',     icon: '🔧', label: 'Operations',    tabs: ['kitchen', 'repairs', 'clock-in-out', 'compliance', 'health-safety'] },
  system:         { id: 'system',         icon: '⚙️', label: 'System',        tabs: ['settings', 'integrations', 'backups', 'tech', 'support', 'docs', 'security', 'audit-log'], requiresRole: 'manager' },
};

// Edition-specific tab overrides
const EDITION_TABS = {
  primary: {
    children:   ['list', 'reports', 'assessment', 'phonics', 'sats', 'pupil-premium', 'send', 'ehcp'],
    curriculum: ['planning', 'timetable', 'homework', 'events', 'trips', 'calendar'],
    'action-plans': ['management', 'year-groups', 'shared-with-parents'],
  },
  secondary: {
    children:   ['list', 'reports', 'assessment', 'progress-8', 'options', 'destinations', 'behaviour', 'send', 'ehcp'],
    curriculum: ['planning', 'timetable', 'homework', 'cover', 'exams', 'events', 'trips', 'calendar'],
    'action-plans': ['management', 'year-groups', 'shared-with-parents'],
  },
};

if (typeof module !== 'undefined') module.exports = { ADMIN_SECTIONS, EDITION_TABS };

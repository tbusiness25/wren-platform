// Wren IA registry — HR portal sections
// Staff self-service only — no child/parent data

const HR_SECTIONS = {
  profile:     { id: 'profile',     icon: '👤', label: 'My Profile',   tabs: ['details', 'documents', 'emergency'] },
  absences:    { id: 'absences',    icon: '🤒', label: 'My Absences',  tabs: ['overview', 'request', 'history'] },
  cpd:         { id: 'cpd',         icon: '🎓', label: 'My CPD',       tabs: ['log', 'matrix', 'certificates'] },
  documents:   { id: 'documents',   icon: '📂', label: 'My Documents', tabs: ['contracts', 'payslips', 'policies'] },
  rota:        { id: 'rota',        icon: '📅', label: 'My Rota',      tabs: ['week', 'month', 'swaps'] },
  'action-plan': { id: 'action-plan', icon: '⭐', label: 'Action Plan', tabs: ['current', 'history'] },
  messages:    { id: 'messages',    icon: '💬', label: 'My Messages',  tabs: ['inbox', 'sent'] },
};

if (typeof module !== 'undefined') module.exports = { HR_SECTIONS };

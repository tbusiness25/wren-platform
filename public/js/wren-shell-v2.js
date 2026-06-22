/* Wren Shell v2 — unified shell: SPA (admin) + MPA (hr/eyfs/ladn/primary/secondary) */
if (window.__wrenShellLoaded === 'app') { console.error('[wren-shell-v2] CONFLICT: wren-app-shell.js is already loaded on this page. Only one shell per page!'); }
window.__wrenShellLoaded = 'v2';
;(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const BUILD              = '20260511b';
  const TOKEN_KEY          = 'wrenToken';
  const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000;
  const SESSION_WARN_MS    = (4 * 60 * 60 - 60) * 1000;
  const BASE               = window.WREN_BASE || '/admin';

  // ── Edition / mode detection ─────────────────────────────────────────────────
  const editionMeta = document.querySelector('meta[name="wren-edition"]');
  const EDITION     = window.WREN_EDITION || (editionMeta ? editionMeta.content : 'admin');
  const IS_ADMIN    = EDITION === 'admin' || !!window.WREN_SECTIONS;

  // ── MPA nav definitions ──────────────────────────────────────────────────────
  const NAV_MPA = {
    hr: {
      practitioner: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        { icon: '👤', label: 'My Profile',   href: '/my-profile.html' },
        { icon: '🏖️', label: 'Absences',     href: '/my-absences.html' },
        { icon: '🤝', label: 'Supervisions', href: '/my-supervisions.html' },
        { icon: '⏰', label: 'TOIL',         href: '/my-toil.html' },
        { icon: '🎓', label: 'CPD',          href: '/my-cpd.html' },
        { icon: '💚', label: 'Wellbeing',    href: '/my-wellbeing.html' },
        { icon: '📄', label: 'Policies',     href: '/policies.html' },
      ],
      room_leader: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        { icon: '👤', label: 'My Profile',   href: '/my-profile.html' },
        { icon: '🏖️', label: 'Absences',     href: '/my-absences.html' },
        { icon: '🤝', label: 'Supervisions', href: '/my-supervisions.html' },
        { icon: '⏰', label: 'TOIL',         href: '/my-toil.html' },
        { icon: '🎓', label: 'CPD',          href: '/my-cpd.html' },
        { icon: '💚', label: 'Wellbeing',    href: '/my-wellbeing.html' },
        { icon: '📄', label: 'Policies',     href: '/policies.html' },
      ],
      manager: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        { icon: '👤', label: 'My Space', children: [
          { label: 'My Profile',      href: '/my-profile.html' },
          { label: 'My Supervisions', href: '/my-supervisions.html' },
          { label: 'My Absences',     href: '/my-absences.html' },
          { label: 'My TOIL',         href: '/my-toil.html' },
          { label: 'My CPD',          href: '/my-cpd.html' },
          { label: 'AI CPD Creator',  href: '/cpd/ai-creator.html' },
          { label: 'My Wellbeing',    href: '/my-wellbeing.html' },
        ]},
        { icon: '👥', label: 'Team', children: [
          { label: 'All Staff',        href: '/staff.html' },
          { label: 'Supervisions',     href: '/supervisions.html' },
          { label: 'Action Plans',     href: '/action-plans.html' },
          { label: 'Absence Approval', href: '/absence-mgmt.html' },
          { label: 'TOIL Adjustments', href: '/toil.html' },
          { label: 'CPD Matrix',       href: '/cpd-matrix.html' },
          { label: 'Policies Admin',   href: '/policies-admin.html' },
          { label: 'Performance',      href: '/performance.html' },
        ]},
        { icon: '📄', label: 'Policies', href: '/policies.html' },
        { icon: '📅', label: 'Rota',     href: '/rota.html' },
        { icon: '🔧', label: 'Repairs',  href: '/repairs.html' },
      ],
    },
    eyfs: {
      practitioner: [
        { icon: '💬', label: 'Comms', children: [
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Next Steps',    href: '/next-steps.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
          { label: 'Activity Bank', href: '/activity-bank.html' },
          { label: 'Memory Box',    href: '/memory-box.html' },
        ]},
        { icon: '👶', label: 'Children & Families', children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', children: [
          { label: 'Outings',      href: '/outings.html' },
          { label: 'Clock In/Out', href: '/clock.html' },
        ]},
        { icon: '👤', label: 'My Account', children: [
          { label: 'My Profile', href: '/profile.html' },
          { label: 'HR & CPD →', href: 'https://hr.example.com/' },
        ]},
      ],
      room_leader: [
        { icon: '💬', label: 'Comms', children: [
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Next Steps',    href: '/next-steps.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
          { label: 'Memory Box',    href: '/memory-box.html' },
        ]},
        { icon: '👶', label: 'Children & Families', children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', children: [
          { label: 'Outings',       href: '/outings.html' },
          { label: 'Clock In/Out',  href: '/clock.html' },
          { label: 'Action Plans',  href: '/action-plans.html' },
        ]},
        { icon: '👤', label: 'My Account', children: [
          { label: 'My Profile', href: '/profile.html' },
          { label: 'HR & CPD →', href: 'https://hr.example.com/' },
        ]},
      ],
      manager: [
        { icon: '💬', label: 'Comms', children: [
          { label: 'Messages',       href: '/messages.html' },
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
          { label: 'Aria calls',     href: '/aria.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Next Steps',    href: '/next-steps.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
          { label: 'Activity Bank', href: '/activity-bank.html' },
          { label: 'SEN',           href: '/sen.html' },
          { label: 'Reports',       href: '/reports.html' },
          { label: 'Memory Box',    href: '/memory-box.html' },
        ]},
        { icon: '👶', label: 'Children & Families', children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', children: [
          { label: 'Outings',       href: '/outings.html' },
          { label: 'Clock In/Out',  href: '/clock.html' },
          { label: 'Action Plans',  href: '/action-plans.html' },
        ]},
        { icon: '👤', label: 'My Account', children: [
          { label: 'My Profile',  href: '/profile.html' },
          { label: 'HR portal →', href: 'https://hr.example.com/' },
        ]},
      ],
    },
    primary: {
      practitioner: [
        { icon: '🎓', label: 'Pupils & teaching', children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Assessments',       href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Phonics',           href: '/phonics.html' },
          { label: 'Seating Plan',      href: '/seating-plan.html' },
          { label: 'Wren Points',       href: '/points-class.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Action Plans',      href: '/action-plans.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
        ]},
        { icon: '📅', label: 'Operations', children: [
          { label: 'Calendar',          href: '/calendar.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Rota',              href: '/rota.html' },
          { label: 'Resources library', href: '/resources-library.html' },
          { label: 'Classroom Tools',   href: '/classroom-tools.html' },
        ]},
        { icon: '⚙️', label: 'Personal', children: [
          { label: 'CPD',     href: '/cpd.html' },
          { label: 'Profile', href: '/profile.html' },
        ]},
      ],
      manager: [
        { icon: '🏠', label: 'Admin Dashboard', href: '/admin.html' },
        { icon: '🎓', label: 'Pupils & teaching', children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Assessments',       href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Phonics',           href: '/phonics.html' },
          { label: 'Seating Plan',      href: '/seating-plan.html' },
          { label: 'Wren Points',       href: '/points-class.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Action Plans',      href: '/action-plans.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
          { label: 'SEND Register',     href: '/send.html' },
          { label: 'EHCP Tracker',      href: '/ehcp.html' },
          { label: 'Exclusions',        href: '/exclusions.html' },
          { label: 'Pupil Premium',     href: '/pupil-premium.html' },
        ]},
        { icon: '📅', label: 'Operations', children: [
          { label: 'Calendar',          href: '/calendar.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Rota',              href: '/rota.html' },
          { label: 'Resources library', href: '/resources-library.html' },
          { label: 'Classroom Tools',   href: '/classroom-tools.html' },
        ]},
        { icon: '👥', label: 'Staff', children: [
          { label: 'Staff',           href: '/staff.html' },
          { label: 'HR',              href: '/hr.html' },
          { label: 'CPD',             href: '/cpd.html' },
          { label: 'NQT / ECT',       href: '/nqt-ect.html' },
          { label: 'Performance Mgmt',href: '/performance.html' },
        ]},
        { icon: '🏫', label: 'Compliance', children: [
          { label: 'Ofsted Prep',       href: '/ofsted-prep.html' },
          { label: 'CTF Import/Export', href: '/ctf-import.html' },
          { label: 'DfE Census',        href: '/census.html' },
        ]},
        { icon: '⚙️', label: 'System', children: [
          { label: 'Profile',         href: '/profile.html' },
          { label: 'IT Settings',     href: '/it-settings.html' },
          { label: 'Points Settings', href: '/points-admin.html' },
        ]},
      ],
    },
    secondary: {
      practitioner: [
        { icon: '🎓', label: 'Pupils & teaching', children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Markbook',          href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Wren Points',       href: '/points-class.html' },
          { label: 'Google Classroom',  href: '/classroom-student.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
        ]},
        { icon: '📅', label: 'Operations', children: [
          { label: 'Timetable',         href: '/timetable.html' },
          { label: 'Lesson Swaps',      href: '/swaps.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Resources library', href: '/resources-library.html' },
        ]},
        { icon: '⚙️', label: 'Personal', children: [
          { label: 'CPD',     href: '/cpd.html' },
          { label: 'Profile', href: '/profile.html' },
        ]},
      ],
      manager: [
        { icon: '📊', label: 'MIS Dashboard', href: '/admin.html' },
        { icon: '🎓', label: 'Pupils & teaching', children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Markbook',          href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Exam entries',      href: '/exam-entries.html' },
          { label: 'Progress 8',        href: '/progress8.html' },
          { label: 'Destinations',      href: '/destinations.html' },
          { label: 'Options',           href: '/options.html' },
          { label: 'Wren Points',       href: '/points-class.html' },
          { label: 'Google Classroom',  href: '/classroom-student.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
          { label: 'SEND',              href: '/send.html' },
          { label: 'Exclusions',        href: '/exclusions.html' },
          { label: 'Detentions',        href: '/detentions.html' },
        ]},
        { icon: '📅', label: 'Operations', children: [
          { label: 'Timetable',         href: '/timetable.html' },
          { label: 'Cover',             href: '/cover.html' },
          { label: 'Lesson Swaps',      href: '/swaps.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Resources library', href: '/resources-library.html' },
        ]},
        { icon: '👥', label: 'Staff', children: [
          { label: 'Staff', href: '/staff.html' },
          { label: 'HR',    href: '/hr.html' },
          { label: 'CPD',   href: '/cpd.html' },
        ]},
        { icon: '⚙️', label: 'System', children: [
          { label: 'Profile',            href: '/profile.html' },
          { label: 'IT Settings',        href: '/it-settings.html' },
          { label: 'Points Settings',    href: '/points-admin.html' },
          { label: 'Classroom Settings', href: '/classroom-settings.html' },
        ]},
      ],
    },
  };
  // ladn uses eyfs nav
  NAV_MPA.ladn = NAV_MPA.eyfs;

  // ── Admin SPA section registry ────────────────────────────────────────────────
  const SECTIONS = window.WREN_SECTIONS || {
    dashboard:      { id: 'dashboard',      icon: '🏠', label: 'Dashboard',    tabs: ['today', 'alerts', 'summary'] },
    cockpit:        { id: 'cockpit',        icon: '🛩️', label: 'Cockpit',      tabs: ['kanban', 'health', 'timeline', 'swot'], requiresRole: 'manager' },
    admissions:     { id: 'admissions',     icon: '🌱', label: 'Admissions',   tabs: ['pipeline', 'list', 'trends', 'forecast', 'occupancy', 'ai-scoring'] },
    'action-plans': { id: 'action-plans',   icon: '⭐', label: 'Action Plans', tabs: ['management', 'baby-room', 'pre-school', 'shared-with-parents'] },
    staff:          { id: 'staff',          icon: '👥', label: 'Staff',        tabs: ['list', 'calendar', 'rota', 'bradford', 'training', 'documents', 'observations', 'performance', 'reports', 'work-patterns', 'sickness-patterns'] },
    children:       { id: 'children',       icon: '👶', label: 'Children',     tabs: ['list', 'reports'] },
    'next-steps':   { id: 'next-steps',     icon: '➡️', label: 'Next Steps',  tabs: ['list', 'completed', 'overdue'] },
    curriculum:     { id: 'curriculum',     icon: '📚', label: 'Curriculum',   tabs: ['planning', 'next-steps', 'events', 'trips', 'calendar'] },
    finance:        { id: 'finance',        icon: '💷', label: 'Finance',      tabs: ['dashboard', 'salary-per-room', 'funded-hours-recon', 'forecast', 'invoices', 'reconcile', 'payments', 'funding', 'wages', 'payroll'] },
    communications: { id: 'communications', icon: '💬', label: 'Comms',        tabs: ['inbox', 'messaging', 'newsletters', 'aria', 'content-creator', 'message-review', 'surveys', 'permission-slips', 'templates'] },
    safeguarding:   { id: 'safeguarding',   icon: '🛡️', label: 'Safeguarding', tabs: ['concerns', 'sign-off-queue', 'log', 'audit'] },
    inspection:     { id: 'inspection',     icon: '📋', label: 'Inspection',   tabs: ['overview', 'action-items', 'briefings', 'gap-analysis', 'evidence', 'history'], requiresRole: 'manager' },
    operations:     { id: 'operations',     icon: '🔧', label: 'Operations',   tabs: ['kitchen', 'repairs', 'clock-in-out', 'compliance', 'health-safety'] },
    cpd:            { id: 'cpd',            icon: '🎓', label: 'CPD',          tabs: ['academy', 'records'], requiresRole: 'manager' },
    review:         { id: 'review',         icon: '✅', label: 'Review',       tabs: ['queue', 'decisions'], requiresRole: 'manager' },
    system:         { id: 'system',         icon: '⚙️', label: 'System',       tabs: ['settings', 'integrations', 'backups', 'tech', 'support', 'docs', 'security', 'permissions', 'approvals', 'audit-log'], requiresRole: 'manager' },
  };

  // ── Session timers ────────────────────────────────────────────────────────────
  let sessionTimer, sessionWarnTimer;
  let _loadSection; // hoisted; assigned in buildShellSPA

  // ── Wren public API ───────────────────────────────────────────────────────────
  window.Wren = {
    edition: EDITION,
    user: null,

    api(url, opts = {}) {
      const token = sessionStorage.getItem(TOKEN_KEY);
      const deviceToken = localStorage.getItem('wrenDevice') || '';
      opts.headers = Object.assign({}, opts.headers, {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(deviceToken ? { 'X-Wren-Device': deviceToken } : {}),
      });
      if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
      return fetch(url, opts).then(r => {
        if (r.status === 401) { Wren.logout(); return; }
        if (!r.ok) return r.json().then(d => Promise.reject(d));
        return r.json();
      });
    },

    toast(message, type = 'info', duration = 3500) {
      let container = document.getElementById('wren-toasts');
      if (!container) {
        container = document.createElement('div');
        container.id = 'wren-toasts';
        document.body.appendChild(container);
      }
      const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
      const toast = document.createElement('div');
      toast.className = `wren-toast wren-toast-${type}`;
      toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${message}</span>`;
      container.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('visible'));
      setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
      }, duration);
    },

    modal(title, content, buttons = []) {
      document.querySelectorAll('.wren-modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'wren-modal-overlay';
      const btnHtml = buttons.map((b, i) =>
        `<button class="btn ${b.class || 'btn-ghost'}" data-idx="${i}">${b.label}</button>`
      ).join('');
      overlay.innerHTML = `
        <div class="wren-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-header">
            <span class="modal-title" id="modal-title">${title}</span>
            <button class="modal-close" aria-label="Close">✕</button>
          </div>
          <div class="modal-body">${typeof content === 'string' ? content : ''}</div>
          ${buttons.length ? `<div class="modal-footer">${btnHtml}</div>` : ''}
        </div>`;
      if (typeof content !== 'string') overlay.querySelector('.modal-body').appendChild(content);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('open'));
      overlay.querySelector('.modal-close').onclick = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 200); };
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.querySelector('.modal-close').click(); });
      buttons.forEach((b, i) => {
        overlay.querySelector(`[data-idx="${i}"]`).onclick = () => {
          if (b.action) b.action();
          if (b.close !== false) overlay.querySelector('.modal-close').click();
        };
      });
      return overlay;
    },

    logout() {
      sessionStorage.removeItem(TOKEN_KEY);
      window.location.href = '/login.html';
    },

    getToken() { return sessionStorage.getItem(TOKEN_KEY); },

    setToken(token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      Wren._parseUser();
      Wren._resetSessionTimer();
    },

    _parseUser() {
      const token = sessionStorage.getItem(TOKEN_KEY);
      if (!token) return;
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (!payload || !payload.id) throw new Error('malformed');
        if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('expired');
        Wren.user = payload;
      } catch {
        sessionStorage.removeItem(TOKEN_KEY);
        if (!window.location.pathname.includes('login.html')) {
          window.location.replace('/login.html');
        }
      }
    },

    _resetSessionTimer() {
      clearTimeout(sessionTimer);
      clearTimeout(sessionWarnTimer);
      const warn = document.getElementById('wren-session-warning');
      if (warn) warn.hidden = true;
      sessionWarnTimer = setTimeout(() => {
        const w = document.getElementById('wren-session-warning');
        if (w) w.hidden = false;
      }, SESSION_WARN_MS);
      sessionTimer = setTimeout(() => {
        Wren.toast('Session expired — please sign in again', 'warning');
        Wren.logout();
      }, SESSION_TIMEOUT_MS);
    },

    navigate(section, tab) {
      if (!IS_ADMIN) {
        window.location.href = '/' + section + '.html';
        return;
      }
      const def = SECTIONS[section];
      if (!def) { Wren.navigate('dashboard', null); return; }
      const resolvedTab = tab || def.tabs[0];
      const url = `${BASE}/${section}/${resolvedTab}`;
      // Legacy standalone page (chrome-only, no #section-content): full-navigate into the SPA
      // rather than pushState + _loadSection into a container that doesn't exist.
      if (!document.getElementById('section-content')) { window.location.href = url; return; }
      if (window.location.pathname !== url) {
        history.pushState({ section, tab: resolvedTab }, '', url);
      }
      _loadSection(section, resolvedTab);
    },

    openDrawer(content, title = '') { if (typeof _openDrawerFn === 'function') _openDrawerFn(content, title); },
    closeDrawer()                   { if (typeof _closeDrawerFn === 'function') _closeDrawerFn(); },
  };

  // drawer fn refs — assigned by whichever buildShell* runs
  let _openDrawerFn, _closeDrawerFn;

  // ── Route parsing (admin SPA) ─────────────────────────────────────────────────
  function _parseRoute() {
    const m = window.location.pathname.match(/^\/admin\/([^/?#]+)(?:\/([^/?#]+))?/);
    if (!m) return { section: 'dashboard', tab: null };
    return { section: m[1], tab: m[2] || null };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // buildShellSPA — admin SPA shell (unchanged from original v2)
  // ─────────────────────────────────────────────────────────────────────────────
  function buildShellSPA() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) { if (!window.location.pathname.includes('login')) window.location.replace('/login.html'); return; }

    Wren._parseUser();
    Wren._resetSessionTimer();
    const user = Wren.user;
    if (!user) return;

    const role  = user.role || 'practitioner';
    const isMgr = ['manager', 'deputy_manager', 'admin'].includes(role);

    document.body.classList.add('v2-shell');

    // Distinguish the canonical admin SPA (app.html — served under /admin/* and shipping a
    // static #section-content) from the 65 legacy standalone .html pages that also load this
    // shell. On legacy pages we build chrome only; injecting an SPA section there rendered a
    // dashboard stacked on top of the page's own content (the double-render bug).
    const isSPA = !!document.getElementById('section-content') || /^\/admin(\/|$)/.test(window.location.pathname);

    const warnBar = document.createElement('div');
    warnBar.id = 'wren-session-warning';
    warnBar.hidden = true;
    warnBar.setAttribute('role', 'alert');
    warnBar.innerHTML = `⏱ Your session expires in 1&nbsp;minute. <a href="#" onclick="Wren._resetSessionTimer();this.closest('#wren-session-warning').hidden=true;return false">Stay signed in</a>`;
    document.body.appendChild(warnBar);

    const topbar = document.createElement('header');
    topbar.id = 'wren-topbar';
    topbar.setAttribute('role', 'banner');
    topbar.innerHTML = `
      <button id="wren-hamburger" class="topbar-icon-btn" aria-label="Toggle navigation" aria-expanded="false" aria-controls="wren-sidebar">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>
      <a href="${BASE}/dashboard" class="topbar-logo" aria-label="Wren home" onclick="Wren.navigate('dashboard');return false">
        <div class="wren-logo"><span class="logo-w">w</span><span class="logo-ren">ren</span></div>
      </a>
      <span id="wren-section-title" class="topbar-section-title" aria-live="polite" aria-atomic="true"></span>
      <div class="topbar-spacer"></div>
      <button id="wren-search-btn" class="topbar-icon-btn topbar-search-btn" aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <span class="topbar-search-label">Search</span>
        <kbd class="topbar-kbd">Ctrl K</kbd>
      </button>
      <button id="wren-notif-btn" class="topbar-icon-btn" aria-label="Notifications" aria-haspopup="true">
        <span aria-hidden="true" style="font-size:1.1rem">🔔</span>
        <span id="wren-notif-count" class="v2-notif-badge" hidden aria-label="unread notifications"></span>
      </button>
      <button class="topbar-avatar" aria-label="Account menu" aria-haspopup="true" id="wren-account-btn">
        ${(user.name || '?').charAt(0).toUpperCase()}
      </button>`;
    document.body.prepend(topbar);

    // Keep --topbar-h in sync with real rendered topbar height (grows on inspection bar, etc.)
    // Use rAF for initial read — offsetHeight is 0 until the browser completes layout for the
    // newly-prepended position:fixed topbar, so an immediate call would set --topbar-h to 0px
    // and defeat the CSS fallback (var(--topbar-h, 56px) only uses fallback when unset, not 0).
    function _syncTopbarH() {
      const h = topbar.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
    }
    requestAnimationFrame(() => requestAnimationFrame(_syncTopbarH));
    new ResizeObserver(_syncTopbarH).observe(topbar);

    // Keep --quickbar-h in sync if #wren-quickbar exists (created by legacy wren-shell.js)
    function _watchQuickbar() {
      const qb = document.getElementById('wren-quickbar');
      if (!qb) return;
      document.body.classList.add('has-quickbar');
      function _syncQH() { document.documentElement.style.setProperty('--quickbar-h', qb.offsetHeight + 'px'); }
      _syncQH();
      new ResizeObserver(_syncQH).observe(qb);
    }
    if (document.getElementById('wren-quickbar')) {
      _watchQuickbar();
    } else {
      const _qbObserver = new MutationObserver(() => {
        if (document.getElementById('wren-quickbar')) { _qbObserver.disconnect(); _watchQuickbar(); }
      });
      _qbObserver.observe(document.body, { childList: true, subtree: false });
    }

    const visibleSections = Object.values(SECTIONS).filter(s => !(s.requiresRole === 'manager' && !isMgr));
    const sidebar = document.createElement('nav');
    sidebar.id = 'wren-sidebar';
    sidebar.setAttribute('role', 'navigation');
    sidebar.setAttribute('aria-label', 'Main navigation');
    sidebar.innerHTML = `
      <ul class="v2-section-list" role="list" aria-label="Sections">
        ${visibleSections.map(s => `
          <li role="none">
            <button class="v2-section-btn" data-section="${s.id}" aria-label="${s.label}" title="${s.label}" role="menuitem">
              <span class="v2-section-icon" aria-hidden="true">${s.icon}</span>
              <span class="v2-section-label">${s.label}</span>
            </button>
          </li>`).join('')}
      </ul>
      <div class="v2-sidebar-footer">
        <button class="v2-section-btn v2-signout-btn" onclick="Wren.logout()" aria-label="Sign out" title="Sign out" role="menuitem">
          <span class="v2-section-icon" aria-hidden="true">🚪</span>
          <span class="v2-section-label">Sign Out</span>
        </button>
      </div>`;
    document.body.insertBefore(sidebar, topbar.nextSibling);

    let mainEl = document.getElementById('wren-main');
    if (!mainEl) {
      mainEl = document.createElement('main');
      mainEl.id = 'wren-main';
      mainEl.setAttribute('role', 'main');
      mainEl.setAttribute('tabindex', '-1');
      if (isSPA) {
        let contentEl = document.getElementById('section-content');
        if (!contentEl) {
          contentEl = document.createElement('div');
          contentEl.id = 'section-content';
        }
        mainEl.appendChild(contentEl);
        document.body.appendChild(mainEl);
      } else {
        // Legacy standalone page: wrap its own existing content in #wren-main for layout,
        // rather than creating an empty #section-content and loading a section into it.
        document.body.appendChild(mainEl);
        const SHELL_IDS = new Set(['wren-topbar', 'wren-sidebar', 'wren-main', 'wren-session-warning', 'wren-quickbar']);
        [...document.body.children].forEach(el => {
          if (el === mainEl || SHELL_IDS.has(el.id)) return;
          if (['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE'].includes(el.tagName)) return;
          mainEl.appendChild(el);
        });
      }
    }

    sidebar.addEventListener('mouseenter', () => { if (window.innerWidth >= 768) sidebar.classList.add('v2-expanded'); });
    sidebar.addEventListener('mouseleave', () => { if (window.innerWidth >= 768) sidebar.classList.remove('v2-expanded'); });

    const hamburger = topbar.querySelector('#wren-hamburger');
    hamburger.addEventListener('click', () => {
      const open = sidebar.classList.toggle('v2-mobile-open');
      hamburger.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', e => {
      if (window.innerWidth >= 768) return;
      if (!sidebar.contains(e.target) && !hamburger.contains(e.target)) {
        sidebar.classList.remove('v2-mobile-open');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    });

    sidebar.addEventListener('keydown', e => {
      const btns = [...sidebar.querySelectorAll('.v2-section-btn')];
      const cur = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[Math.min(cur + 1, btns.length - 1)]?.focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); btns[Math.max(cur - 1, 0)]?.focus(); }
      if (e.key === 'Home')      { e.preventDefault(); btns[0]?.focus(); }
      if (e.key === 'End')       { e.preventDefault(); btns[btns.length - 1]?.focus(); }
    });

    sidebar.querySelectorAll('[data-section]').forEach(btn => {
      btn.addEventListener('click', () => {
        Wren.navigate(btn.dataset.section, null);
        if (window.innerWidth < 768) {
          sidebar.classList.remove('v2-mobile-open');
          hamburger.setAttribute('aria-expanded', 'false');
        }
      });
    });

    function _updateSidebarActive(sectionId) {
      sidebar.querySelectorAll('[data-section]').forEach(btn => {
        const active = btn.dataset.section === sectionId;
        btn.classList.toggle('v2-active', active);
        btn.setAttribute('aria-current', active ? 'page' : 'false');
      });
      const def = SECTIONS[sectionId];
      const titleEl = document.getElementById('wren-section-title');
      if (titleEl) titleEl.textContent = def ? def.label : '';
    }

    const _sectionCache = {};

    _loadSection = async function (sectionId, tabId) {
      const def = SECTIONS[sectionId];
      if (!def) { Wren.navigate('dashboard', null); return; }
      _updateSidebarActive(sectionId);
      const container = document.getElementById('section-content');
      if (!container) return;
      if (!_sectionCache[sectionId]) {
        container.innerHTML = `<div class="v2-section-loading"><div class="v2-sk-bar wide"></div><div class="v2-sk-tabs"></div><div class="v2-sk-body"></div></div>`;
      }
      try {
        let html;
        if (_sectionCache[sectionId]) {
          html = _sectionCache[sectionId];
        } else {
          const res = await fetch(`/sections/${sectionId}.html`, { cache: 'no-store', credentials: 'same-origin' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          html = await res.text();
          _sectionCache[sectionId] = html;
        }
        container.innerHTML = html;
        container.querySelectorAll('script').forEach(old => {
          const s = document.createElement('script');
          [...old.attributes].forEach(a => s.setAttribute(a.name, a.value));
          s.textContent = old.textContent;
          old.replaceWith(s);
        });
        _wireTabBar(container, sectionId, tabId || def.tabs[0]);
        document.dispatchEvent(new CustomEvent('wren:section-loaded', { detail: { section: sectionId } }));
      } catch (err) {
        console.error('Section load error:', err);
        container.innerHTML = `
          <div class="v2-section-error">
            <div style="font-size:2.5rem">⚠️</div>
            <h2>Section unavailable</h2>
            <p>Could not load <strong>${sectionId}</strong>. <a href="${BASE}/dashboard">Go to dashboard</a></p>
          </div>`;
      }
    };

    function _wireTabBar(container, sectionId, activeTabId) {
      const tabList = container.querySelector('[role="tablist"]');
      if (!tabList) return;
      // Sync --tabbar-h so sticky content knows how much space the tab bar takes
      const _syncTBH = () => document.documentElement.style.setProperty('--tabbar-h', tabList.offsetHeight + 'px');
      _syncTBH();
      new ResizeObserver(_syncTBH).observe(tabList);
      const tabs   = [...tabList.querySelectorAll('[role="tab"]')];
      const panels = [...container.querySelectorAll('[role="tabpanel"]')];
      const track      = container.querySelector('.tab-bar-track');
      const leftArrow  = container.querySelector('.tab-scroll-arrow.left');
      const rightArrow = container.querySelector('.tab-scroll-arrow.right');
      if (track && leftArrow && rightArrow) {
        const scroll = dir => track.scrollBy({ left: dir * 180, behavior: 'smooth' });
        leftArrow.addEventListener('click', () => scroll(-1));
        rightArrow.addEventListener('click', () => scroll(1));
        const upd = () => {
          leftArrow.style.visibility  = track.scrollLeft > 1 ? 'visible' : 'hidden';
          rightArrow.style.visibility = (track.scrollLeft + track.clientWidth + 1) < track.scrollWidth ? 'visible' : 'hidden';
        };
        track.addEventListener('scroll', upd, { passive: true });
        requestAnimationFrame(upd);
        new ResizeObserver(upd).observe(track);
      }
      function _activateTab(tabId) {
        const activeTab = tabs.find(t => t.dataset.tab === tabId);
        if (!activeTab) return;
        tabs.forEach(t => {
          const isActive = t.dataset.tab === tabId;
          t.classList.toggle('wren-tab-active', isActive);
          t.setAttribute('aria-selected', String(isActive));
          t.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        panels.forEach(p => {
          const isActive = p.dataset.tab === tabId;
          p.hidden = !isActive;
          if (isActive) {
            const fn = window[`wrenLoadTab_${sectionId}_${tabId}`];
            if (typeof fn === 'function') { fn(p); window[`wrenLoadTab_${sectionId}_${tabId}`] = null; }
          }
        });
        activeTab.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
        const newUrl = `${BASE}/${sectionId}/${tabId}`;
        if (window.location.pathname !== newUrl) history.replaceState({ section: sectionId, tab: tabId }, '', newUrl);
      }
      tabs.forEach(tab => tab.addEventListener('click', () => _activateTab(tab.dataset.tab)));
      tabList.addEventListener('keydown', e => {
        const cur = tabs.findIndex(t => t === document.activeElement);
        if (cur < 0) return;
        const map = { ArrowRight: 1, ArrowLeft: -1 };
        if (e.key in map) {
          e.preventDefault();
          const next = Math.max(0, Math.min(tabs.length - 1, cur + map[e.key]));
          tabs[next].focus();
          _activateTab(tabs[next].dataset.tab);
        } else if (e.key === 'Home') { e.preventDefault(); tabs[0].focus(); _activateTab(tabs[0].dataset.tab); }
        else if (e.key === 'End')   { e.preventDefault(); tabs[tabs.length-1].focus(); _activateTab(tabs[tabs.length-1].dataset.tab); }
      });
      const valid = tabs.find(t => t.dataset.tab === activeTabId);
      _activateTab(valid ? activeTabId : tabs[0]?.dataset.tab);
    }

    window.addEventListener('popstate', e => {
      const state = e.state || _parseRoute();
      _loadSection(state.section, state.tab);
    });

    function _openSearch() {
      if (document.getElementById('wren-search-overlay')) return;
      const overlay = document.createElement('div');
      overlay.id = 'wren-search-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Global search');
      overlay.innerHTML = `
        <div class="search-backdrop"></div>
        <div class="search-panel">
          <div class="search-input-row">
            <svg class="search-input-icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <input type="text" id="wren-search-input" class="search-input" placeholder="Search sections, tabs…" autocomplete="off" spellcheck="false" aria-label="Search">
            <kbd class="search-esc">Esc</kbd>
          </div>
          <div id="wren-search-results" class="search-results" role="listbox" aria-label="Search results">
            <p class="search-hint">Jump to any section or tab</p>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('open'));
      const input = overlay.querySelector('#wren-search-input');
      setTimeout(() => input.focus(), 30);
      function close() { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 180); }
      overlay.querySelector('.search-backdrop').addEventListener('click', close);
      function escHandler(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } }
      document.addEventListener('keydown', escHandler);
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const resultsEl = overlay.querySelector('#wren-search-results');
        if (!q) { resultsEl.innerHTML = '<p class="search-hint">Jump to any section or tab</p>'; return; }
        const hits = [];
        Object.values(SECTIONS).forEach(s => {
          if (s.label.toLowerCase().includes(q)) hits.push({ label: s.label, icon: s.icon, section: s.id, tab: s.tabs[0] });
          s.tabs.forEach(t => {
            if (t.includes(q) || t.replace(/-/g, ' ').includes(q)) hits.push({ label: `${s.label} → ${t.replace(/-/g, ' ')}`, icon: s.icon, section: s.id, tab: t });
          });
        });
        if (!hits.length) { resultsEl.innerHTML = '<p class="search-hint">No results</p>'; return; }
        resultsEl.innerHTML = hits.slice(0, 8).map((h, i) => `
          <button class="search-result" role="option" aria-selected="false" data-idx="${i}" data-section="${h.section}" data-tab="${h.tab}">
            <span class="search-result-icon">${h.icon}</span>
            <span class="search-result-label">${h.label}</span>
          </button>`).join('');
        resultsEl.querySelectorAll('[data-section]').forEach(btn => {
          btn.addEventListener('click', () => { close(); Wren.navigate(btn.dataset.section, btn.dataset.tab); });
        });
      });
    }

    topbar.querySelector('#wren-search-btn').addEventListener('click', _openSearch);
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); _openSearch(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
        e.preventDefault();
        if (typeof WrenInspection !== 'undefined') WrenInspection.openLauncher();
        else Wren.navigate('inspection', 'overview');
      }
    });

    _wireNotifications(topbar, user);
    _wireAccountMenu(topbar, user, role);
    _wireDrawer();

    ['click', 'keydown', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, () => { if (sessionStorage.getItem(TOKEN_KEY)) Wren._resetSessionTimer(); }, { passive: true });
    });

    _injectFonts();

    if (isSPA) {
      const { section, tab } = _parseRoute();
      const initSection = SECTIONS[section] ? section : 'dashboard';
      const initUrl = `${BASE}/${initSection}/${tab || SECTIONS[initSection].tabs[0]}`;
      if (window.location.pathname !== initUrl) {
        history.replaceState({ section: initSection, tab: tab || SECTIONS[initSection].tabs[0] }, '', initUrl);
      }
      _loadSection(initSection, tab || SECTIONS[initSection].tabs[0]);
    }

    (async function _initInspectionCountdown() {
      if (!isMgr) return;
      try {
        const data = await Wren.api('/api/inspection/active');
        if (!data?.inspection) return;
        const insp = data.inspection;
        if (insp.type !== 'pre_announced' || !insp.expected_arrival) return;
        const arrival = new Date(insp.expected_arrival);
        if (arrival < new Date()) return;
        const bar = document.createElement('div');
        bar.id = 'wren-inspection-bar';
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2000;background:#7c3aed;color:#fff;text-align:center;padding:6px 16px;font-size:0.8rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:12px';
        bar.onclick = () => Wren.navigate('inspection', 'overview');
        function _updateBar() {
          const diff = arrival - new Date();
          if (diff <= 0) { bar.remove(); return; }
          const h = Math.floor(diff / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          const s = Math.floor((diff % 60000) / 1000);
          const pad = n => String(n).padStart(2, '0');
          bar.innerHTML = `<span>📋 Inspection Mode — ${insp.inspector_name ? insp.inspector_name + ' — ' : ''}Arrival in</span><span style="font-variant-numeric:tabular-nums;font-size:1rem;letter-spacing:1px">${h}:${pad(m)}:${pad(s)}</span><span style="opacity:0.7;font-size:0.7rem">Click to open Inspection Mode</span>`;
        }
        _updateBar();
        document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || '0') + 34) + 'px';
        document.body.prepend(bar);
        const tick = setInterval(() => { if (!document.getElementById('wren-inspection-bar')) { clearInterval(tick); return; } _updateBar(); }, 1000);
      } catch {}
    })();

    window._wrenReady = true;
    document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user: Wren.user } }));
    _loadChatWidget('admin');
    if (!document.getElementById('wren-vc-btn')) {
      const _vcs = document.createElement('script');
      _vcs.src = '/js/wren-voice-capture.js?v=2026061601';
      document.head.appendChild(_vcs);
    }
  }

  // ── Chat widget loader ────────────────────────────────────────────────────────
  // The bird chatbot lives in wren-chat.js. shell-v2 previously only *called*
  // WrenChat.init() but never loaded the script, so the widget never appeared on
  // any shell-v2 page (the whole EY portal + admin SPA). Load it once, then init
  // with the given persona. Honours an opt-out <meta name="wren-app-chat" content="off">.
  function _loadChatWidget(persona) {
    try {
      const off = document.querySelector('meta[name="wren-app-chat"]');
      if (off && off.content === 'off') return;
    } catch (e) {}
    function _init() { if (window.WrenChat) WrenChat.init({ persona: persona, greeting: "Hi! I'm Wren." }); }
    if (window.WrenChat) { _init(); return; }
    if (document.getElementById('wren-chat-loader')) return;
    const s = document.createElement('script');
    s.id  = 'wren-chat-loader';
    s.src = '/js/wren-chat.js?v=2026061601';
    s.onload = _init;
    document.head.appendChild(s);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // buildShellMPA — MPA shell for hr / eyfs / ladn / primary / secondary
  // ─────────────────────────────────────────────────────────────────────────────
  function buildShellMPA() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token && !window.location.pathname.includes('login')) {
      window.location.replace('/login.html');
      return;
    }

    Wren._parseUser();
    Wren._resetSessionTimer();
    const user = Wren.user;
    if (!user) return;

    const role   = user.role || 'practitioner';
    const edKey  = EDITION === 'ladn' ? 'eyfs' : EDITION;
    const navCfg = NAV_MPA[edKey] || {};
    const navItems = navCfg[role] || navCfg['practitioner'] || navCfg['manager'] || [];

    document.body.classList.add('v2-shell', 'edition-' + EDITION);

    const warnBar = document.createElement('div');
    warnBar.id = 'wren-session-warning';
    warnBar.hidden = true;
    warnBar.setAttribute('role', 'alert');
    warnBar.innerHTML = `⏱ Your session expires in 1&nbsp;minute. <a href="#" onclick="Wren._resetSessionTimer();this.closest('#wren-session-warning').hidden=true;return false">Stay signed in</a>`;
    document.body.appendChild(warnBar);

    // Topbar
    const topbar = document.createElement('header');
    topbar.id = 'wren-topbar';
    topbar.setAttribute('role', 'banner');
    topbar.innerHTML = `
      <button id="wren-hamburger" class="topbar-icon-btn" aria-label="Toggle navigation" aria-expanded="false" aria-controls="wren-sidebar">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>
      <a href="/index.html" class="topbar-logo" aria-label="Wren home">
        <div class="wren-logo"><span class="logo-w">w</span><span class="logo-ren">ren</span></div>
      </a>
      <div class="topbar-spacer"></div>
      <button id="wren-notif-btn" class="topbar-icon-btn" aria-label="Notifications" aria-haspopup="true">
        <span aria-hidden="true" style="font-size:1.1rem">🔔</span>
        <span id="wren-notif-count" class="v2-notif-badge" hidden aria-label="unread notifications"></span>
      </button>
      <button class="topbar-avatar" aria-label="Account menu" aria-haspopup="true" id="wren-account-btn">
        ${(user.name || '?').charAt(0).toUpperCase()}
      </button>`;
    document.body.prepend(topbar);

    // Keep --topbar-h in sync with real rendered topbar height
    // rAF defers the initial read so offsetHeight is non-zero after browser layout.
    function _syncTopbarH() {
      const h = topbar.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
    }
    requestAnimationFrame(() => requestAnimationFrame(_syncTopbarH));
    new ResizeObserver(_syncTopbarH).observe(topbar);

    // Sync --tabbar-h for any .wren-tab-bar present on this page
    (function _watchTabbar() {
      const tb = document.querySelector('.wren-tab-bar');
      if (!tb) return;
      const _syncTBH = () => document.documentElement.style.setProperty('--tabbar-h', tb.offsetHeight + 'px');
      _syncTBH();
      new ResizeObserver(_syncTBH).observe(tb);
    })();

    // Keep --quickbar-h in sync if #wren-quickbar exists (created by legacy wren-shell.js)
    function _watchQuickbar() {
      const qb = document.getElementById('wren-quickbar');
      if (!qb) return;
      document.body.classList.add('has-quickbar');
      function _syncQH() { document.documentElement.style.setProperty('--quickbar-h', qb.offsetHeight + 'px'); }
      _syncQH();
      new ResizeObserver(_syncQH).observe(qb);
    }
    if (document.getElementById('wren-quickbar')) {
      _watchQuickbar();
    } else {
      const _qbObserver = new MutationObserver(() => {
        if (document.getElementById('wren-quickbar')) { _qbObserver.disconnect(); _watchQuickbar(); }
      });
      _qbObserver.observe(document.body, { childList: true, subtree: false });
    }

    // Sidebar
    const curPath = window.location.pathname;
    const sidebar = document.createElement('nav');
    sidebar.id = 'wren-sidebar';
    sidebar.setAttribute('role', 'navigation');
    sidebar.setAttribute('aria-label', 'Main navigation');

    const navHtml = navItems.map(item => {
      if (item.href) {
        const isActive = curPath === item.href || curPath.endsWith(item.href.replace(/^\//, ''));
        return `
          <li role="none">
            <a class="v2-section-btn v2-nav-link${isActive ? ' v2-active' : ''}"
               href="${item.href}" title="${item.label}" aria-label="${item.label}"${isActive ? ' aria-current="page"' : ''}>
              <span class="v2-section-icon" aria-hidden="true">${item.icon}</span>
              <span class="v2-section-label">${item.label}</span>
            </a>
          </li>`;
      } else if (item.children) {
        const hasActive = item.children.some(c => curPath === c.href || curPath.endsWith(c.href.replace(/^\//, '')));
        const childHtml = item.children.map(c => {
          const isCA = curPath === c.href || curPath.endsWith(c.href.replace(/^\//, ''));
          return `<li><a class="v2-child-link${isCA ? ' v2-active' : ''}" href="${c.href}"${isCA ? ' aria-current="page"' : ''}>${c.label}</a></li>`;
        }).join('');
        return `
          <li role="none" class="v2-mpa-group${hasActive ? ' v2-group-active' : ''}">
            <button class="v2-section-btn v2-group-btn" aria-expanded="${hasActive ? 'true' : 'false'}" title="${item.label}" aria-label="${item.label}">
              <span class="v2-section-icon" aria-hidden="true">${item.icon}</span>
              <span class="v2-section-label">${item.label}<span class="v2-mpa-chevron" aria-hidden="true">›</span></span>
            </button>
            <ul class="v2-mpa-children"${hasActive ? '' : ' hidden'}>
              ${childHtml}
            </ul>
          </li>`;
      }
      return '';
    }).join('');

    sidebar.innerHTML = `
      <ul class="v2-section-list" role="list" aria-label="Navigation">
        ${navHtml}
      </ul>
      <div class="v2-sidebar-footer">
        <button class="v2-section-btn v2-signout-btn" onclick="Wren.logout()" aria-label="Sign out" title="Sign out">
          <span class="v2-section-icon" aria-hidden="true">🚪</span>
          <span class="v2-section-label">Sign Out</span>
        </button>
      </div>`;
    document.body.insertBefore(sidebar, topbar.nextSibling);

    // Wrap #wren-content in #wren-main
    const contentEl = document.getElementById('wren-content');
    if (contentEl && !document.getElementById('wren-main')) {
      const mainEl = document.createElement('main');
      mainEl.id = 'wren-main';
      mainEl.setAttribute('role', 'main');
      contentEl.parentNode.insertBefore(mainEl, contentEl);
      mainEl.appendChild(contentEl);
    }

    // Group toggle (when sidebar is expanded)
    sidebar.querySelectorAll('.v2-group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group    = btn.closest('.v2-mpa-group');
        const children = group.querySelector('.v2-mpa-children');
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        children.hidden = expanded;
      });
    });

    // Hover expand (desktop)
    sidebar.addEventListener('mouseenter', () => { if (window.innerWidth >= 768) sidebar.classList.add('v2-expanded'); });
    sidebar.addEventListener('mouseleave', () => {
      if (window.innerWidth < 768) return;
      sidebar.classList.remove('v2-expanded');
      // Collapse non-active groups when sidebar collapses
      sidebar.querySelectorAll('.v2-mpa-group').forEach(g => {
        if (!g.classList.contains('v2-group-active')) {
          const btn = g.querySelector('.v2-group-btn');
          const ul  = g.querySelector('.v2-mpa-children');
          if (btn) btn.setAttribute('aria-expanded', 'false');
          if (ul)  ul.hidden = true;
        }
      });
    });

    // Mobile hamburger
    const hamburger = topbar.querySelector('#wren-hamburger');
    hamburger.addEventListener('click', () => {
      const open = sidebar.classList.toggle('v2-mobile-open');
      hamburger.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', e => {
      if (window.innerWidth >= 768) return;
      if (!sidebar.contains(e.target) && !hamburger.contains(e.target)) {
        sidebar.classList.remove('v2-mobile-open');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    });

    _wireNotifications(topbar, user);
    _wireAccountMenu(topbar, user, role);
    _wireDrawer();

    ['click', 'keydown', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, () => { if (sessionStorage.getItem(TOKEN_KEY)) Wren._resetSessionTimer(); }, { passive: true });
    });

    _injectFonts();

    window._wrenReady = true;
    document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user: Wren.user } }));
    _loadChatWidget(EDITION);
    if (!document.getElementById('wren-vc-btn')) {
      const _vcs = document.createElement('script');
      _vcs.src = '/js/wren-voice-capture.js?v=2026061601';
      document.head.appendChild(_vcs);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Shared helpers
  // ─────────────────────────────────────────────────────────────────────────────
  function _wireNotifications(topbar, user) {
    let _notifItems = [];

    async function _refreshNotifCount() {
      try {
        const data = await Wren.api('/api/notifications/unread');
        _notifItems = data.items || [];
        const cnt   = data.count || 0;
        const badge = document.getElementById('wren-notif-count');
        if (badge) { badge.textContent = cnt > 99 ? '99+' : String(cnt); badge.hidden = cnt === 0; }
      } catch {}
    }

    function _relTime(ts) {
      const m = Math.floor((Date.now() - new Date(ts)) / 60000);
      if (m < 1)  return 'Just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return new Date(ts).toLocaleDateString('en-GB');
    }

    Wren._toggleNotifPanel = function () {
      const existing = document.getElementById('wren-notif-panel');
      if (existing) { existing.remove(); return; }
      const catIcon = { repair: '🔧', message: '💬', calendar: '📅', 'action-plan': '📋', safeguarding: '🛡️', medicine: '💊', incident: '🚨', system: 'ℹ️', gmail: '📧', enquiry: '📩', 'waiting-list': '📝' };
      const panel = document.createElement('div');
      panel.id = 'wren-notif-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Notifications');
      panel.innerHTML = `
        <div class="notif-panel-header">
          <span>Notifications</span>
          <button class="notif-mark-all" onclick="Wren._markAllRead()">Mark all read</button>
        </div>
        <div id="wren-notif-list">
          ${_notifItems.length
            ? _notifItems.map(n => `
                <div class="notif-item ${n.read_at ? 'read' : ''}" data-nid="${n.id}" onclick="Wren._openNotif(${n.id},${JSON.stringify(n.link || '')})">
                  <span class="notif-cat">${catIcon[n.category] || '🔔'}</span>
                  <div class="notif-body">
                    <div class="notif-title">${n.title}</div>
                    ${n.body ? `<div class="notif-text">${n.body}</div>` : ''}
                    <div class="notif-time">${_relTime(n.created_at)}</div>
                  </div>
                </div>`).join('')
            : '<div class="notif-empty">All caught up 👍</div>'}
        </div>`;
      document.body.appendChild(panel);
      setTimeout(() => {
        document.addEventListener('click', e => {
          if (!panel.contains(e.target) && !document.getElementById('wren-notif-btn')?.contains(e.target)) panel.remove();
        }, { once: true });
      }, 50);
    };

    document.getElementById('wren-notif-btn').addEventListener('click', Wren._toggleNotifPanel);
    document.getElementById('wren-notif-btn').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Wren._toggleNotifPanel(); } });

    Wren._openNotif = async function (id, link) {
      try { await Wren.api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch {}
      document.getElementById('wren-notif-panel')?.remove();
      _refreshNotifCount();
      if (link) window.location.href = link;
    };

    Wren._markAllRead = async function () {
      try { await Wren.api('/api/notifications/read-all', { method: 'POST' }); } catch {}
      document.getElementById('wren-notif-panel')?.remove();
      _refreshNotifCount();
    };

    _refreshNotifCount();
    setInterval(_refreshNotifCount, 30000);
  }

  function _wireAccountMenu(topbar, user, role) {
    Wren._showUserMenu = function () {
      const existing = document.getElementById('user-menu-popup');
      if (existing) { existing.remove(); return; }
      const popup = document.createElement('div');
      popup.id = 'user-menu-popup';
      popup.setAttribute('role', 'menu');
      const ls = 'display:flex;align-items:center;gap:10px;padding:10px 12px;font-size:.875rem;color:var(--c-text);text-decoration:none;border-radius:6px;cursor:pointer;background:none;border:none;width:100%;text-align:left;font-family:inherit;transition:background .15s;white-space:nowrap;';
      const hs = `onmouseenter="this.style.background='rgba(74,154,191,.12)'" onmouseleave="this.style.background=''"`;
      const profileHref = IS_ADMIN ? '/my-profile.html' : (EDITION === 'hr' ? '/my-profile.html' : '/profile.html');
      popup.innerHTML = `
        <div style="padding:8px 12px 6px;border-bottom:1px solid var(--c-border);font-size:.82rem;color:var(--c-muted);font-weight:600">${user.name || 'User'} <span style="font-weight:400">(${role})</span></div>
        <a href="${profileHref}" style="${ls}" ${hs} role="menuitem">👤 My Profile</a>
        <a href="/ey-legacy/totp-setup.html"  style="${ls}" ${hs} role="menuitem">🔐 Two-Factor Auth</a>
        ${IS_ADMIN ? `
        <a href="/admin/system/settings"    style="${ls}" ${hs} role="menuitem">⚙️ Settings</a>
        <a href="/admin/system/tech"        style="${ls}" ${hs} role="menuitem">💻 IT Settings</a>
        <a href="/admin/system/permissions" style="${ls}" ${hs} role="menuitem">🛡️ Permissions</a>
        <a href="/admin/system/approvals"   style="${ls}" ${hs} role="menuitem">✅ Approvals</a>` : ''}
        <div style="border-top:1px solid var(--c-border);margin:4px 0"></div>
        <button onclick="Wren.logout()" style="${ls}color:var(--c-red);" ${hs} role="menuitem">🚪 Sign Out</button>`;
      popup.style.cssText = 'position:fixed;top:56px;right:12px;background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:8px;z-index:9000;min-width:210px;';
      document.body.appendChild(popup);
      setTimeout(() => document.addEventListener('click', e => { if (!popup.contains(e.target)) popup.remove(); }, { once: true }), 50);
    };
    document.getElementById('wren-account-btn').addEventListener('click', Wren._showUserMenu);
  }

  function _wireDrawer() {
    let _drawerEl = null;

    function _open(content, title) {
      _close();
      _drawerEl = document.createElement('div');
      _drawerEl.className = 'wren-drawer';
      _drawerEl.setAttribute('role', 'dialog');
      _drawerEl.setAttribute('aria-modal', 'true');
      _drawerEl.setAttribute('aria-label', title || 'Details');
      _drawerEl.innerHTML = `
        <div class="drawer-backdrop"></div>
        <div class="drawer-panel" tabindex="-1">
          <div class="drawer-header">
            <span class="drawer-title">${title || ''}</span>
            <button class="drawer-close" aria-label="Close">✕</button>
          </div>
          <div class="drawer-body"></div>
        </div>`;
      const body = _drawerEl.querySelector('.drawer-body');
      if (typeof content === 'string') body.innerHTML = content;
      else if (content instanceof Element) body.appendChild(content);
      document.body.appendChild(_drawerEl);
      document.body.classList.add('drawer-open');
      requestAnimationFrame(() => _drawerEl.classList.add('open'));
      _drawerEl.querySelector('.drawer-backdrop').addEventListener('click', _close);
      _drawerEl.querySelector('.drawer-close').addEventListener('click', _close);
      _drawerEl.querySelector('.drawer-panel').focus();
    }

    function _close() {
      if (!_drawerEl) return;
      _drawerEl.classList.remove('open');
      document.body.classList.remove('drawer-open');
      const el = _drawerEl;
      setTimeout(() => el.remove(), 260);
      _drawerEl = null;
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape' && _drawerEl) _close(); });

    _openDrawerFn  = _open;
    _closeDrawerFn = _close;
    Wren.openDrawer  = (c, t) => _open(c, t);
    Wren.closeDrawer = () => _close();
  }

  function _injectFonts() {
    if (document.querySelector('link[data-wren-fonts]')) return;
    const pc = document.createElement('link'); pc.rel = 'preconnect'; pc.href = 'https://fonts.gstatic.com'; pc.crossOrigin = 'anonymous'; document.head.appendChild(pc);
    const fl = document.createElement('link'); fl.rel = 'stylesheet'; fl.href = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap'; fl.setAttribute('data-wren-fonts', '1'); document.head.appendChild(fl);
  }

  // ── Entry point ───────────────────────────────────────────────────────────────
  const _init = IS_ADMIN ? buildShellSPA : buildShellMPA;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();

})();

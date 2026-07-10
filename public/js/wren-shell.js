/* Wren Shell — shared across all editions and portals */
;(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────
  const editionMeta = document.querySelector('meta[name="wren-edition"]');
  const EDITION = editionMeta ? editionMeta.content : 'eyfs';
  const hideModulesEl = document.querySelector('meta[name="wren-hide-modules"]');
  const HIDE_MODULES = hideModulesEl ? hideModulesEl.content.split(',').map(s => s.trim()) : [];
  const TOKEN_KEY = 'wrenToken';
  const SIDEBAR_KEY = 'wrenSidebarCollapsed';
  const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000;  // 4 hours (admin/EY); JWT itself lasts 12h
  const SESSION_WARN_MS    = (4 * 60 * 60 - 60) * 1000; // warn at 3h59m (1 min before logout)  //  9 minutes

  let sessionTimer, sessionWarnTimer;

  // ── Wren public API ─────────────────────────────────────────────────────
  window.Wren = {
    edition: EDITION,
    user: null,

    // Authenticated fetch — adds Bearer token automatically
    api(url, opts = {}) {
      const token = sessionStorage.getItem(TOKEN_KEY);
      opts.headers = Object.assign({}, opts.headers, {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      });
      if (opts.body && typeof opts.body !== 'string') {
        opts.body = JSON.stringify(opts.body);
      }
      return fetch(url, opts).then(r => {
        if (r.status === 401) { Wren.logout(); return; }
        if (!r.ok) return r.json().then(d => Promise.reject(d));
        return r.json();
      });
    },

    // Toast notifications
    toast(message, type = 'info', duration = 3500) {
      const container = document.getElementById('wren-toasts') || (() => {
        const el = document.createElement('div');
        el.id = 'wren-toasts';
        document.body.appendChild(el);
        return el;
      })();
      const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
      const toast = document.createElement('div');
      toast.className = `wren-toast ${type}`;
      toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${message}</span>`;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        toast.style.transition = '.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, duration);
    },

    // Modal
    modal(title, content, buttons = []) {
      document.querySelectorAll('.wren-modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'wren-modal-overlay';
      const btnHtml = buttons.map((b, i) =>
        `<button class="btn ${b.class || 'btn-ghost'}" data-idx="${i}">${b.label}</button>`
      ).join('');
      overlay.innerHTML = `
        <div class="wren-modal" role="dialog">
          <div class="modal-header">
            <span class="modal-title">${title}</span>
            <button class="modal-close" title="Close">✕</button>
          </div>
          <div class="modal-body">${typeof content === 'string' ? content : ''}</div>
          ${buttons.length ? `<div class="modal-footer">${btnHtml}</div>` : ''}
        </div>
      `;
      if (typeof content !== 'string') overlay.querySelector('.modal-body').appendChild(content);
      document.body.appendChild(overlay);
      overlay.querySelector('.modal-close').onclick = () => overlay.remove();
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
      buttons.forEach((b, i) => {
        overlay.querySelector(`[data-idx="${i}"]`).onclick = () => {
          if (b.action) b.action();
          if (b.close !== false) overlay.remove();
        };
      });
      return overlay;
    },

    // Logout
    logout() {
      sessionStorage.removeItem(TOKEN_KEY);
      window.location.href = '/login.html';
    },

    getToken() {
      return sessionStorage.getItem(TOKEN_KEY);
    },

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
        if (!payload || !payload.id) throw new Error('malformed token');
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
      if (warn) warn.style.display = 'none';
      sessionWarnTimer = setTimeout(() => {
        const w = document.getElementById('wren-session-warning');
        if (w) w.style.display = 'block';
      }, SESSION_WARN_MS);
      sessionTimer = setTimeout(() => {
        Wren.toast('Session expired — please sign in again', 'warning');
        Wren.logout();
      }, SESSION_TIMEOUT_MS);
    }
  };

  // ── Nav definitions ──────────────────────────────────────────────────────
  //
  // ICON CONVENTION — one icon per concept, consistent across all editions:
  //   Observations  → 📝   Phonics      → 🔤   Safeguarding → 🛡️
  //   Reports       → 📊   Planning     → 📋   Curriculum   → 📚
  //   CPD           → 🎓   Profile      → 👤   Children     → 🧒
  //   Pupils        → 🎓 (context: secondary/primary keep 🎓 for pupils)
  //   HR / Rota     → 📁   Messages     → 💬   Finance      → 💰
  //   System/Config → 🧩   Comms        → 💬   Operations   → ⚙️
  //
  const NAV = {
    // EY portal (Nest) — child/curriculum/teaching data only, NO HR items.
    // REMOVED from this nav (redirect stubs in each edition → hr.example-nursery.co.uk):
    //   CPD (all roles) — belongs in Seed/HR (my-cpd.html)
    //   Supervisions (manager) — belongs in Seed/HR (supervisions.html)
    //   Staff (manager) — full staff mgmt belongs in Seed/HR (staff.html)
    eyfs: {
      practitioner: [
        { icon: '💬', label: 'Comms', openByDefault: true, children: [
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', openByDefault: false, children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html', featureKey: 'repairs_tracker' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', openByDefault: false, children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
          { label: 'Activity Bank', href: '/activity-bank.html' },
          { label: 'Memory Box',    href: '/memory-box.html', featureKey: 'memory_box' },
        ]},
        { icon: '👶', label: 'Children & Families', openByDefault: false, children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', openByDefault: false, children: [
          { label: 'Outings',       href: '/outings.html' },
          { label: 'Clock In/Out',  href: '/clock.html' },
        ]},
        { icon: '👤', label: 'My Account', openByDefault: false, children: [
          { label: 'My Profile',    href: '/profile.html' },
          { label: 'HR & CPD →',   href: 'https://hr.example-nursery.co.uk/' },
        ]},
      ],
      room_leader: [
        { icon: '💬', label: 'Comms', openByDefault: true, children: [
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', openByDefault: false, children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html', featureKey: 'repairs_tracker' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', openByDefault: false, children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
          { label: 'Memory Box',    href: '/memory-box.html', featureKey: 'memory_box' },
        ]},
        { icon: '👶', label: 'Children & Families', openByDefault: false, children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', openByDefault: false, children: [
          { label: 'Outings',       href: '/outings.html' },
          { label: 'Clock In/Out',  href: '/clock.html' },
          { label: 'Action Plans',  href: '/action-plans.html' },
        ]},
        { icon: '👤', label: 'My Account', openByDefault: false, children: [
          { label: 'My Profile',    href: '/profile.html' },
          { label: 'HR & CPD →',   href: 'https://hr.example-nursery.co.uk/' },
        ]},
      ],
      manager: [
        { icon: '💬', label: 'Comms', openByDefault: true, children: [
          { label: 'Messages',       href: '/messages.html' },
          { label: 'Diary',          href: '/diary.html' },
          { label: 'Communications', href: '/communications.html' },
          { label: 'Aria calls',     href: '/aria.html' },
        ]},
        { icon: '🚑', label: 'Health & Safety', openByDefault: false, children: [
          { label: 'Sleep Checks',  href: '/sleep-checks.html' },
          { label: 'Medicine',      href: '/medicine.html' },
          { label: 'Incidents',     href: '/incidents.html' },
          { label: 'Safeguarding',  href: '/safeguarding.html' },
          { label: 'Repairs',       href: '/repairs.html', featureKey: 'repairs_tracker' },
        ]},
        { icon: '🎓', label: 'Learning & Dev', openByDefault: false, children: [
          { label: 'Observations',  href: '/observations.html' },
          { label: 'Planning',      href: '/planning.html' },
          { label: 'Curriculum',    href: '/curriculum.html' },
          { label: 'Phonics',       href: '/phonics.html' },
          { label: 'First Words',   href: '/first-words.html' },
          { label: 'Activity Bank', href: '/activity-bank.html' },
          { label: 'SEN',           href: '/sen.html' },
          { label: 'Reports',       href: '/reports.html' },
          { label: 'Memory Box',    href: '/memory-box.html', featureKey: 'memory_box' },
        ]},
        { icon: '👶', label: 'Children & Families', openByDefault: false, children: [
          { label: 'Children',      href: '/learning.html' },
          { label: 'Child Profile', href: '/child-profile.html' },
        ]},
        { icon: '⚙️', label: 'Operations', openByDefault: false, children: [
          { label: 'Outings',       href: '/outings.html' },
          { label: 'Clock In/Out',  href: '/clock.html' },
          { label: 'Action Plans',  href: '/action-plans.html' },
        ]},
        { icon: '👤', label: 'My Account', openByDefault: false, children: [
          { label: 'My Profile',    href: '/profile.html' },
          { label: 'HR portal →',   href: 'https://hr.example-nursery.co.uk/' },
        ]},
      ],
    },
    // HR portal — staff self-service only, NO child/parent data
    'ladn-hr': {
      practitioner: [
        { icon: '🏠', label: 'Dashboard',    href: '/hr.html' },
        { icon: '📅', label: 'My Rota',      href: '/hr.html#rota' },
        { icon: '🏖️', label: 'My Absences',  href: '/hr.html#absences' },
        { icon: '⏰', label: 'My Hours',     href: '/hr.html#hours' },
        { icon: '🎓', label: 'CPD',          href: '/hr.html#cpd' },
        { icon: '🤝', label: 'Supervisions', href: '/hr.html#supervisions' },
        { icon: '📄', label: 'Documents',    href: '/hr.html#documents' },
        { icon: '👤', label: 'My Profile',   href: '/hr.html#profile' },
      ],
      room_leader: [
        { icon: '🏠', label: 'Dashboard',    href: '/hr.html' },
        { icon: '📅', label: 'My Rota',      href: '/hr.html#rota' },
        { icon: '🏖️', label: 'My Absences',  href: '/hr.html#absences' },
        { icon: '⏰', label: 'My Hours',     href: '/hr.html#hours' },
        { icon: '🎓', label: 'CPD',          href: '/hr.html#cpd' },
        { icon: '🤝', label: 'Supervisions', href: '/hr.html#supervisions' },
        { icon: '📄', label: 'Documents',    href: '/hr.html#documents' },
        { icon: '👤', label: 'My Profile',   href: '/hr.html#profile' },
      ],
      manager: [
        { icon: '🏠', label: 'Dashboard',    href: '/hr.html' },
        { icon: '📅', label: 'My Rota',      href: '/hr.html#rota' },
        { icon: '🏖️', label: 'My Absences',  href: '/hr.html#absences' },
        { icon: '⏰', label: 'My Hours',     href: '/hr.html#hours' },
        { icon: '🎓', label: 'CPD',          href: '/hr.html#cpd' },
        { icon: '🤝', label: 'Supervisions', href: '/hr.html#supervisions' },
        { icon: '📄', label: 'Documents',    href: '/hr.html#documents' },
        { icon: '👤', label: 'My Profile',   href: '/hr.html#profile' },
      ],
    },
    primary: {
      practitioner: [
        { icon: '🎓', label: 'Pupils & teaching', openByDefault: true, children: [
          { label: 'Pupils',             href: '/learning.html' },
          { label: 'Register',           href: '/attendance.html' },
          { label: 'Assessments',        href: '/assessments.html' },
          { label: 'Reports',            href: '/reports.html' },
          { label: 'Homework',           href: '/homework.html' },
          { label: 'Curriculum',         href: '/curriculum.html' },
          { label: 'Phonics',            href: '/phonics.html' },
          { label: 'Seating Plan',       href: '/seating-plan.html' },
          { label: 'Wren Points ⭐',     href: '/points-class.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', openByDefault: false, children: [
          { label: 'Behaviour',          href: '/behaviour.html' },
          { label: 'Action Plans',       href: '/action-plans.html' },
          { label: 'Incidents',          href: '/incidents.html' },
          { label: 'Safeguarding',       href: '/safeguarding.html' },
        ]},
        { icon: '📅', label: 'Operations', openByDefault: false, children: [
          { label: 'Calendar',           href: '/calendar.html' },
          { label: 'Classes',            href: '/classes.html' },
          { label: 'Rota',               href: '/rota.html' },
          { label: 'Resources library',  href: '/resources-library.html' },
          { label: 'Classroom Tools ✨', href: '/classroom-tools.html' },
        ]},
        { icon: '⚙️', label: 'Personal', openByDefault: false, children: [
          { label: 'CPD',                href: '/cpd.html' },
          { label: 'Profile',            href: '/profile.html' },
        ]},
      ],
      manager: [
        { icon: '🏠', label: 'Admin Dashboard', href: '/admin.html' },
        { icon: '🎓', label: 'Pupils & teaching', openByDefault: true, children: [
          { label: 'Pupils',             href: '/learning.html' },
          { label: 'Register',           href: '/attendance.html' },
          { label: 'Assessments',        href: '/assessments.html' },
          { label: 'Reports',            href: '/reports.html' },
          { label: 'Homework',           href: '/homework.html' },
          { label: 'Curriculum',         href: '/curriculum.html' },
          { label: 'Phonics',            href: '/phonics.html' },
          { label: 'Seating Plan',       href: '/seating-plan.html' },
          { label: 'Wren Points ⭐',     href: '/points-class.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', openByDefault: false, children: [
          { label: 'Behaviour',          href: '/behaviour.html' },
          { label: 'Action Plans',       href: '/action-plans.html' },
          { label: 'Incidents',          href: '/incidents.html' },
          { label: 'Safeguarding',       href: '/safeguarding.html' },
          { label: 'SEND Register',      href: '/send.html' },
          { label: 'EHCP Tracker',       href: '/ehcp.html' },
          { label: 'Exclusions',         href: '/exclusions.html' },
          { label: 'Pupil Premium',      href: '/pupil-premium.html' },
        ]},
        { icon: '📅', label: 'Operations', openByDefault: false, children: [
          { label: 'Calendar',           href: '/calendar.html' },
          { label: 'Classes',            href: '/classes.html' },
          { label: 'Rota',               href: '/rota.html' },
          { label: 'Resources library',  href: '/resources-library.html' },
          { label: 'Classroom Tools ✨', href: '/classroom-tools.html' },
        ]},
        { icon: '👥', label: 'Staff', openByDefault: false, children: [
          { label: 'Staff',              href: '/staff.html' },
          { label: 'HR',                 href: '/hr.html' },
          { label: 'CPD',                href: '/cpd.html' },
          { label: 'NQT / ECT',          href: '/nqt-ect.html' },
          { label: 'Performance Mgmt',   href: '/performance.html' },
        ]},
        { icon: '🏫', label: 'Compliance', openByDefault: false, children: [
          { label: 'Ofsted Prep',        href: '/ofsted-prep.html' },
          { label: 'CTF Import / Export',href: '/ctf-import.html' },
          { label: 'DfE Census',         href: '/census.html' },
        ]},
        { icon: '⚙️', label: 'System', openByDefault: false, children: [
          { label: 'Profile',            href: '/profile.html' },
          { label: 'IT Settings',        href: '/it-settings.html' },
          { label: 'Points Settings',    href: '/points-admin.html' },
        ]},
      ],
    },
    secondary: {
      practitioner: [
        { icon: '🎓', label: 'Pupils & teaching', openByDefault: true, children: [
          { label: 'Pupils',            href: '/learning.html' },
          { label: 'Register',          href: '/attendance.html' },
          { label: 'Markbook',          href: '/assessments.html' },
          { label: 'Reports',           href: '/reports.html' },
          { label: 'Homework',          href: '/homework.html' },
          { label: 'Curriculum',        href: '/curriculum.html' },
          { label: 'Wren Points ⭐',    href: '/points-class.html' },
          { label: 'Google Classroom',  href: '/classroom-student.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', openByDefault: false, children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
        ]},
        { icon: '📅', label: 'Operations', openByDefault: false, children: [
          { label: 'Timetable',         href: '/timetable.html' },
          { label: 'Lesson Swaps',      href: '/swaps.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Resources library', href: '/resources-library.html' },
        ]},
        { icon: '⚙️', label: 'Personal', openByDefault: false, children: [
          { label: 'CPD',               href: '/cpd.html' },
          { label: 'Profile',           href: '/profile.html' },
        ]},
      ],
      manager: [
        { icon: '📊', label: 'MIS Dashboard', href: '/admin.html' },
        { icon: '🎓', label: 'Pupils & teaching', openByDefault: true, children: [
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
          { label: 'Wren Points ⭐',    href: '/points-class.html' },
          { label: 'Google Classroom',  href: '/classroom-student.html' },
        ]},
        { icon: '🎭', label: 'Pastoral', openByDefault: false, children: [
          { label: 'Behaviour',         href: '/behaviour.html' },
          { label: 'Incidents',         href: '/incidents.html' },
          { label: 'Safeguarding',      href: '/safeguarding.html' },
          { label: 'SEND',              href: '/send.html' },
          { label: 'Exclusions',        href: '/exclusions.html' },
          { label: 'Detentions',        href: '/detentions.html' },
        ]},
        { icon: '📅', label: 'Operations', openByDefault: false, children: [
          { label: 'Timetable',         href: '/timetable.html' },
          { label: 'Cover',             href: '/cover.html' },
          { label: 'Lesson Swaps',      href: '/swaps.html' },
          { label: 'Classes',           href: '/classes.html' },
          { label: 'Resources library', href: '/resources-library.html' },
        ]},
        { icon: '👥', label: 'Staff', openByDefault: false, children: [
          { label: 'Staff',             href: '/staff.html' },
          { label: 'HR',                href: '/hr.html' },
          { label: 'CPD',               href: '/cpd.html' },
        ]},
        { icon: '⚙️', label: 'System', openByDefault: false, children: [
          { label: 'Profile',           href: '/profile.html' },
          { label: 'IT Settings',       href: '/it-settings.html' },
          { label: 'Points Settings',   href: '/points-admin.html' },
          { label: 'Classroom Settings',href: '/classroom-settings.html' },
        ]},
      ],
    },
    admin: {
      manager: [
        { icon: '🏠', label: 'Dashboard', href: '/index.html' },
        {
          // Admissions — single canonical page; tab state via URL hash
          icon: '👋', label: 'Admissions',
          children: [
            { label: 'Waiting List',   href: '/admissions/index.html', featureKey: 'enquiries_pipeline' },
            { label: '🤖 AI Scoring',  href: '/admissions/waiting-list-ai.html' },
          ],
        },
        {
          icon: '👥', label: 'Staff',
          children: [
            { label: '→ HR portal',    href: 'https://hr.example-nursery.co.uk/' },
            { label: '🤖 Absence AI',  href: '/staff/absence-mgmt.html' },
            { label: '📊 Staffing analysis', href: '/staff/smart-staffing.html' },
          ],
        },
        {
          // Children — Planning workspace replaces Planning + Activity Bank + Next Steps
          icon: '🧒', label: 'Children',
          children: [
            { label: 'All children',         href: '/children.html' },
            { label: '📋 Planning workspace', href: '/planning.html' },
            { label: 'Observations',         href: '/observations.html',    featureKey: 'ai_observation_writer' },
            { label: 'Phonics',              href: '/phonics.html' },
            { label: 'Intervention toolkit', href: '/intervention.html',    featureKey: 'ai_intervention_toolkit' },
            { label: 'Framework trackers',   href: '/children/trackers.html' },
            { label: 'Parent reports',       href: '/parent-reports.html',  featureKey: 'ai_report_writer' },
            { label: 'Memory box',           href: '/memory-box.html',      featureKey: 'memory_box' },
            { label: 'Leavers book',         href: '/leavers-book.html',    featureKey: 'leavers_book' },
          ],
        },
        {
          icon: '💬', label: 'Comms & content',
          children: [
            { label: 'Messages',        href: '/messages.html',       featureKey: 'parent_messaging' },
            { label: 'Message Review',  href: '/message-review.html', featureKey: 'parent_messaging' },
            { label: 'Aria calls',   href: '/aria.html' },
            { label: 'Newsletter',     href: '/newsletter.html' },
            { label: 'Newsletter AI',  href: '/newsletter-ai.html' },
            { label: 'Parent Study',   href: '/study.html' },
            { label: 'Reports',      href: '/reports.html',   featureKey: 'ai_report_writer' },
          ],
        },
        {
          icon: '💰', label: 'Finance & food',
          children: [
            { label: 'Invoices',    href: '/invoices.html',   featureKey: 'finance_invoicing' },
            { label: 'Funding',     href: '/funding.html' },
            { label: 'Kitchen',     href: '/kitchen.html' },
            { label: 'Compliance',  href: '/compliance.html' },
          ],
        },
        {
          icon: '⚙️', label: 'Operations',
          children: [
            { label: 'Clock in/out', href: '/clockin.html' },
            { label: 'Repairs',      href: '/repairs.html',   featureKey: 'repairs_tracker' },
            { label: 'Tasks',        href: '/tasks.html' },
            { label: 'Outings',          href: '/outings.html' },
            { label: 'Permission Slips', href: '/permission-slips.html' },
          ],
        },
        {
          icon: '🧩', label: 'System',
          children: [
            { label: 'Module builder',   href: '/modules.html' },
            { label: '📥 Import Wizard', href: '/import-wizard.html' },
            { label: 'Audit log',        href: '/audit.html' },
            { label: '🛡 Security',       href: '/security.html' },
            { label: '📧 Email Triage',   href: '/email-triage.html' },
            { label: '📡 Vapi Health',    href: '/vapi-health.html' },
            { label: '📊 State View',     href: '/state-view.html' },
            { label: '📞 Vapi Actions',   href: '/vapi-actions.html' },
            { label: 'Setup & features', href: '/setup.html' },
          ],
        },
      ],
    },
    hr: {
      practitioner: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        { icon: '👤', label: 'My Profile',   href: '/my-profile.html' },
        { icon: '🏖️', label: 'Absences',     href: '/my-absences.html' },
        { icon: '🤝', label: 'Supervisions', href: '/my-supervisions.html', featureKey: 'supervisions' },
        { icon: '⏰', label: 'TOIL',         href: '/my-toil.html', featureKey: 'toil_bank' },
        { icon: '🎓', label: 'CPD',          href: '/my-cpd.html' },
        { icon: '💚', label: 'Wellbeing',    href: '/my-wellbeing.html', featureKey: 'employee_wellbeing' },
        { icon: '📄', label: 'Policies',     href: '/policies.html', featureKey: 'policies_library' },
      ],
      room_leader: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        { icon: '👤', label: 'My Profile',   href: '/my-profile.html' },
        { icon: '🏖️', label: 'Absences',     href: '/my-absences.html' },
        { icon: '🤝', label: 'Supervisions', href: '/my-supervisions.html', featureKey: 'supervisions' },
        { icon: '⏰', label: 'TOIL',         href: '/my-toil.html', featureKey: 'toil_bank' },
        { icon: '🎓', label: 'CPD',          href: '/my-cpd.html' },
        { icon: '💚', label: 'Wellbeing',    href: '/my-wellbeing.html', featureKey: 'employee_wellbeing' },
        { icon: '📄', label: 'Policies',     href: '/policies.html', featureKey: 'policies_library' },
      ],
      manager: [
        { icon: '🏠', label: 'Dashboard',    href: '/index.html' },
        {
          icon: '👤', label: 'My Space',
          children: [
            { label: 'My Profile',       href: '/my-profile.html' },
            { label: 'My Supervisions',  href: '/my-supervisions.html', featureKey: 'supervisions' },
            { label: 'My Absences',      href: '/my-absences.html' },
            { label: 'My TOIL',          href: '/my-toil.html', featureKey: 'toil_bank' },
            { label: 'My CPD',           href: '/my-cpd.html' },
            { label: '🤖 AI CPD Creator', href: '/cpd/ai-creator.html' },
            { label: 'My Wellbeing',     href: '/my-wellbeing.html', featureKey: 'employee_wellbeing' },
          ],
        },
        {
          icon: '👥', label: 'Team',
          children: [
            { label: 'All Staff',          href: '/staff.html' },
            { label: 'Supervisions',       href: '/supervisions.html',   featureKey: 'supervisions' },
            { label: 'Action Plans',       href: '/action-plans.html' },
            { label: 'Absence Approval',   href: '/staff/absence-mgmt.html' },
            { label: 'TOIL Adjustments',   href: '/toil.html',           featureKey: 'toil_bank' },
            { label: 'CPD Matrix',         href: '/cpd-matrix.html',     featureKey: 'cpd_matrix' },
            { label: 'Policies Admin',     href: '/policies-admin.html', featureKey: 'policies_library' },
            { label: 'Performance',        href: '/performance.html',    featureKey: 'staff_performance' },
          ],
        },
        { icon: '📄', label: 'Policies',   href: '/policies.html', featureKey: 'policies_library' },
        { icon: '📅', label: 'Rota',       href: '/rota.html', featureKey: 'rota_builder' },
        { icon: '🔧', label: 'Repairs',    href: '/repairs.html', featureKey: 'repairs_tracker' },
      ],
    },
    parents: {
      parent: [
        { icon: '📖', label: 'Today',           href: '/index.html' },
        { icon: '📓', label: 'Diary',           href: '/diary.html' },
        { icon: '🌟', label: 'Learning',        href: '/learning.html' },
        { icon: '📸', label: 'Gallery',         href: '/gallery.html' },
        { icon: '💬', label: 'Messages',        href: '/messages.html' },
        { icon: '📚', label: 'Study',           href: '/welcome/study' },
        { icon: '🔤', label: 'Phonics journey', href: '/welcome/phonics' },
      ],
    }
  };

  // Quick-action bars — 6 icon shortcuts above the main content area
  const QUICKBAR = {
    eyfs: [
      { icon: '📧', label: 'Messages',     href: '/messages.html' },
      { icon: '🚑', label: 'Incidents',    href: '/incidents.html' },
      { icon: '🛡️', label: 'Safeguarding', href: '/safeguarding.html' },
      { icon: '🎓', label: 'Learning',     href: '/learning.html' },
      { icon: '👁️', label: 'Observations', href: '/observations.html' },
      { icon: '📋', label: 'Planning',     href: '/planning.html' },
    ],
    ladn: [
      { icon: '📧', label: 'Messages',     href: '/messages.html' },
      { icon: '🚑', label: 'Incidents',    href: '/incidents.html' },
      { icon: '🛡️', label: 'Safeguarding', href: '/safeguarding.html' },
      { icon: '🎓', label: 'Learning',     href: '/learning.html' },
      { icon: '👁️', label: 'Observations', href: '/observations.html' },
      { icon: '📋', label: 'Planning',     href: '/planning.html' },
    ],
  };

  // Normalise role for nav lookup (deputy_manager → manager, apprentice → practitioner)
  function normaliseRole(role) {
    if (['manager','deputy_manager','admin'].includes(role)) return 'manager';
    if (['room_leader'].includes(role)) return 'room_leader';
    return 'practitioner';
  }

  // ── Build UI shell ────────────────────────────────────────────────────────
  function buildShell() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const currentPath = window.location.pathname;
    const isLoginPage = currentPath.includes('login.html');

    // Inject session warning bar
    if (!document.getElementById('wren-session-warning')) {
      const bar = document.createElement('div');
      bar.id = 'wren-session-warning';
      bar.innerHTML = '⏱ Your session will expire in 1 minute. <a href="#" onclick="Wren._resetSessionTimer();this.closest(\'#wren-session-warning\').style.display=\'none\';return false">Stay signed in</a>';
      document.body.appendChild(bar);
    }

    if (!token) {
      if (!isLoginPage) {
        window.location.replace('/login.html');
        return;
      }
      return; // On login page, no shell needed
    }

    Wren._parseUser();
    Wren._resetSessionTimer();
    const user = Wren.user;
    if (!user) return;

    const role = user.role || 'practitioner';
    const normRole = normaliseRole(role);
    const editionNav = NAV[EDITION] || NAV.eyfs;
    const navItems = editionNav[normRole] || editionNav['practitioner'] || [];

    // Auto clock-in on first load today
    const clockKey = `wrenClocked_${new Date().toDateString()}`;
    if (!sessionStorage.getItem(clockKey)) {
      sessionStorage.setItem(clockKey, '1');
      Wren.api('/api/attendance/staff/clock-in', { method: 'POST' }).catch(() => {});
    }

    // Active path helper (used by both quickbar and sidebar)
    function _isActivePath(href) {
      return currentPath.endsWith(href.replace(/^\//, '')) ||
             (href === '/learning.html' && currentPath === '/') ||
             (href === '/index.html' && (currentPath === '/' || currentPath.endsWith('/index.html')));
    }

    // ── Topbar ──
    const topbar = document.createElement('div');
    topbar.id = 'wren-topbar';
    const isDemo = document.querySelector('meta[name="wren-demo"]');
    topbar.innerHTML = `
      <button id="sidebar-toggle" title="Toggle menu">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M3 12h18M3 6h18M3 18h18"/>
        </svg>
      </button>
      <div class="topbar-logo">
        <div class="wren-logo">
          <span class="logo-w">w</span><span class="logo-ren">ren</span>
          <span class="logo-edition">${EDITION.toUpperCase()}</span>
        </div>
      </div>
      ${isDemo ? '<span class="topbar-demo-badge">Demo</span>' : ''}
      <div class="topbar-spacer"></div>
      <div id="wren-notif-btn" class="topbar-notif-btn" title="Notifications" onclick="Wren._toggleNotifPanel()" style="position:relative;cursor:pointer;padding:6px 8px;border-radius:8px;display:flex;align-items:center;gap:4px">
        <span style="font-size:18px">🔔</span>
        <span id="wren-notif-count" style="display:none;position:absolute;top:2px;right:2px;background:#ef4444;color:#fff;border-radius:999px;font-size:10px;font-weight:700;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 3px"></span>
      </div>
      ${EDITION !== 'parents' && EDITION !== 'admin' ? `<a href="/now-mode" title="Now Mode — fullscreen class launcher (Ctrl+Shift+N)" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:rgba(74,154,191,.12);border:1px solid rgba(74,154,191,.3);border-radius:8px;color:#4a9abf;font-weight:700;font-size:.78rem;text-decoration:none;white-space:nowrap;cursor:pointer" onmouseover="this.style.background='rgba(74,154,191,.22)'" onmouseout="this.style.background='rgba(74,154,191,.12)'">📺 <span class="hidden md-inline">Now</span></a>` : ''}
      <div class="topbar-user">
        <span class="hidden md-inline">${user.name || ''}</span>
        <div class="user-avatar" title="Signed in as ${user.name || ''}" onclick="Wren._showUserMenu(this)">
          ${(user.name || '?').charAt(0).toUpperCase()}
        </div>
      </div>
    `;
    document.body.prepend(topbar);
    document.body.classList.add('edition-' + EDITION);

    // ── Now Mode keyboard shortcut ────────────────────────────────────────────
    if (EDITION !== 'parents' && EDITION !== 'admin') {
      document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && e.key === 'N') { e.preventDefault(); window.location.href = '/now-mode'; }
      });
    }

    // ── Quick-action bar (EY and admin editions) ──
    const _quickItems = QUICKBAR[EDITION];
    if (_quickItems) {
      const qbar = document.createElement('div');
      qbar.id = 'wren-quickbar';
      qbar.innerHTML = _quickItems.map(item => {
        const isActive = _isActivePath(item.href);
        return `<a class="quick-btn${isActive ? ' active' : ''}" href="${item.href}" title="${item.label}">
          <span class="quick-icon">${item.icon}</span>
          <span class="quick-label">${item.label}</span>
        </a>`;
      }).join('');
      topbar.insertAdjacentElement('afterend', qbar);
      document.body.classList.add('has-quickbar');
    }

    // ── Sidebar ──
    const sidebar = document.createElement('nav');
    sidebar.id = 'wren-sidebar';
    const collapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
    if (collapsed) sidebar.classList.add('collapsed');

    const visibleNavItems = HIDE_MODULES.length ? navItems.filter(item => !HIDE_MODULES.includes(item.label)) : navItems;

    function buildNavItem(item) {
      if (!item.children) {
        const fk = item.featureKey ? ` data-feature-key="${item.featureKey}"` : '';
        return `<a class="nav-item${_isActivePath(item.href) ? ' active' : ''}" href="${item.href}" title="${item.label}"${fk}>
          <span class="nav-icon">${item.icon}</span>
          <span class="nav-label">${item.label}</span>
        </a>`;
      }
      // Collapsible section
      const sectionKey = `wrenNav_${EDITION}_${item.label}`;
      const hasActiveChild = item.children.some(c => _isActivePath(c.href));
      const saved = localStorage.getItem(sectionKey);
      const defaultIfNew = item.openByDefault !== undefined ? item.openByDefault : true;
      const isOpen = hasActiveChild || (saved === null ? defaultIfNew : saved !== '0');
      const childrenHtml = item.children.map(child => {
        const fk = child.featureKey ? ` data-feature-key="${child.featureKey}"` : '';
        return `<a class="nav-child-item${_isActivePath(child.href) ? ' active' : ''}" href="${child.href}"${fk}>${child.label}</a>`;
      }).join('');
      return `<div class="nav-section-group${isOpen ? ' open' : ''}" data-section="${sectionKey}">
        <button class="nav-item nav-section-toggle" type="button" title="${item.label}">
          <span class="nav-icon">${item.icon}</span>
          <span class="nav-label">${item.label}</span>
          <svg class="nav-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="nav-children">${childrenHtml}</div>
      </div>`;
    }

    const sidebarHtml = visibleNavItems.map(buildNavItem).join('');

    sidebar.innerHTML = `<div class="nav-section">${sidebarHtml}</div>
      <div class="nav-section" style="margin-top:auto">
        <a class="nav-item" href="#" onclick="Wren.logout();return false" title="Sign out">
          <span class="nav-icon">🚪</span>
          <span class="nav-label">Sign Out</span>
        </a>
      </div>`;
    document.body.insertBefore(sidebar, document.getElementById('wren-main') || document.querySelector('main') || topbar.nextSibling);

    // Wire collapsible section toggles
    sidebar.querySelectorAll('.nav-section-group').forEach(group => {
      group.querySelector('.nav-section-toggle').addEventListener('click', () => {
        const isOpen = group.classList.toggle('open');
        localStorage.setItem(group.dataset.section, isOpen ? '1' : '0');
      });
    });

    // ── Toggle button ──
    topbar.querySelector('#sidebar-toggle').onclick = () => {
      sidebar.classList.toggle('collapsed');
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        sidebar.classList.toggle('mobile-open');
        sidebar.classList.remove('collapsed');
      } else {
        const c = sidebar.classList.contains('collapsed');
        localStorage.setItem(SIDEBAR_KEY, c ? '1' : '0');
        document.body.classList.toggle('sidebar-collapsed', c);
      }
    };

    // Auto-collapse on medium tablets (768-1024px) to save screen space
    const isMediumTablet = window.innerWidth >= 768 && window.innerWidth <= 1024;
    if (isMediumTablet && !localStorage.getItem(SIDEBAR_KEY)) {
      sidebar.classList.add('collapsed');
      document.body.classList.add('sidebar-collapsed');
    }

    // Sync body class
    if (collapsed && window.innerWidth > 768) {
      document.body.classList.add('sidebar-collapsed');
    }

    // Close mobile sidebar on nav click (not section toggle buttons)
    sidebar.querySelectorAll('a.nav-item, .nav-child-item').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          sidebar.classList.remove('mobile-open');
        }
      });
    });

    // ── Mobile bottom nav (top 4 items) ──
    if (visibleNavItems.length > 0 && EDITION !== 'admin' && !QUICKBAR[EDITION]) {
      const bottomNav = document.createElement('div');
      bottomNav.id = 'wren-bottom-nav';
      const topItems = visibleNavItems.slice(0, 4);
      const cols = topItems.length;
      bottomNav.innerHTML = `<div class="bottom-nav-inner" style="grid-template-columns:repeat(${cols},1fr)">
        ${topItems.map(item => {
          const isActive = currentPath.endsWith(item.href.replace(/^\//, ''));
          return `<a class="bottom-nav-item${isActive ? ' active' : ''}" href="${item.href}">
            <span class="nav-icon">${item.icon}</span>
            <span>${item.label}</span>
          </a>`;
        }).join('')}
      </div>`;
      document.body.appendChild(bottomNav);
    }

    // ── Wrap page content ──
    const content = document.getElementById('wren-content');
    if (content && !document.getElementById('wren-main')) {
      const main = document.createElement('main');
      main.id = 'wren-main';
      content.parentNode.insertBefore(main, content);
      main.appendChild(content);
    }

    // ── Inject theme.css (custom branding overrides) ─────────────────────────
    if (!document.querySelector('link[href="/theme.css"]')) {
      const themeLink = document.createElement('link');
      themeLink.rel = 'stylesheet';
      themeLink.href = '/theme.css';
      document.head.appendChild(themeLink);
    }

    // ── Inject Google Fonts (Playfair Display + DM Sans) ─────────────────────
    if (!document.querySelector('link[data-wren-fonts]')) {
      const fl = document.createElement('link');
      fl.rel = 'preconnect';
      fl.href = 'https://fonts.gstatic.com';
      fl.crossOrigin = 'anonymous';
      document.head.appendChild(fl);
      const gl = document.createElement('link');
      gl.rel = 'stylesheet';
      gl.href = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap';
      gl.setAttribute('data-wren-fonts', '1');
      document.head.appendChild(gl);
    }

    // ── Apply module filtering asynchronously ─────────────────────────────────
    // Maps module key → nav href for each edition (disabled modules hide nav items)
    const _moduleNavMap = {
      eyfs: {
        observations: '/observations.html', sleep_checks: '/sleep-checks.html',
        medicine: '/medicine.html',         safeguarding: '/safeguarding.html',
        incidents: '/incidents.html',       hr: '/hr.html',
        messaging: '/messages.html',        reports: '/reports.html',
      },
      primary: {
        assessments: '/assessments.html',   phonics: '/phonics.html',
        behaviour: '/behaviour.html',       incidents: '/incidents.html',
        safeguarding: '/safeguarding.html', send: '/send.html',
        hr: '/hr.html',                     curriculum: '/curriculum.html',
        reports: '/reports.html',           cpd: '/cpd.html',
      },
      secondary: {
        assessments: '/assessments.html',   behaviour: '/behaviour.html',
        exclusions: '/exclusions.html',     incidents: '/incidents.html',
        safeguarding: '/safeguarding.html', send: '/send.html',
        hr: '/hr.html',                     curriculum: '/curriculum.html',
        reports: '/reports.html',           cpd: '/cpd.html',
      },
    };
    (async () => {
      try {
        const modules = await Wren.api('/api/it-settings/modules');
        if (!modules || typeof modules !== 'object') return;
        const navMap = _moduleNavMap[EDITION] || {};
        for (const [mod, href] of Object.entries(navMap)) {
          if (modules[mod] === false) {
            sidebar.querySelectorAll(`.nav-item[href="${href}"], .nav-child-item[href="${href}"]`).forEach(el => el.style.display = 'none');
            document.querySelectorAll(`#wren-bottom-nav .bottom-nav-item[href="${href}"]`).forEach(el => el.style.display = 'none');
          }
        }
      } catch {}
    })();

    // Feature flag filtering — admin and hr editions
    // Fetch /api/features/public, cache 5 min, hide nav items with disabled featureKey
    if (EDITION === 'admin' || EDITION === 'hr') {
      (async () => {
        const _FCACHE = 'wrenFeatures';
        const _FTTL = 5 * 60 * 1000;
        let flags = null;
        try {
          const cached = sessionStorage.getItem(_FCACHE);
          if (cached) {
            const { ts, data } = JSON.parse(cached);
            if (Date.now() - ts < _FTTL) flags = data;
          }
        } catch {}
        if (!flags) {
          try {
            flags = await Wren.api('/api/features/public');
            if (flags && typeof flags === 'object') {
              try { sessionStorage.setItem(_FCACHE, JSON.stringify({ ts: Date.now(), data: flags })); } catch {}
            }
          } catch {}
        }
        if (!flags) return;
        // Hide sidebar items whose featureKey is disabled
        sidebar.querySelectorAll('[data-feature-key]').forEach(el => {
          const key = el.getAttribute('data-feature-key');
          if (flags[key] === false) el.style.display = 'none';
        });
        // Show setup wizard modal if setup_completed is false
        if (flags['setup_completed'] === false && !window.location.pathname.includes('setup.html')) {
          const existing = document.getElementById('wren-setup-prompt');
          if (!existing) {
            const bar = document.createElement('div');
            bar.id = 'wren-setup-prompt';
            bar.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#4a9abf;color:#fff;padding:12px 20px;border-radius:12px;z-index:9999;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3);font-size:.9rem;';
            bar.innerHTML = '⚙️ <strong>Complete setup</strong> — click to configure Wren';
            bar.onclick = () => window.location.href = '/setup.html';
            document.body.appendChild(bar);
          }
        }
      })();
    }

    // Dynamic Forms nav — EY portals only (ladn → portal=ey, eyfs → portal=ey)
    (async () => {
      const _portalByEd = { ladn: 'ey', eyfs: 'ey' };
      const _fPortal = _portalByEd[EDITION];
      if (!_fPortal) return;

      const _FCACHE = `wrenFormsNav_${_fPortal}_${role}`;
      const _FTTL = 5 * 60 * 1000;
      let _fMods = null;

      try {
        const _c = sessionStorage.getItem(_FCACHE);
        if (_c) {
          const { ts, data } = JSON.parse(_c);
          if (Date.now() - ts < _FTTL) _fMods = data;
        }
      } catch {}

      if (!_fMods) {
        try {
          _fMods = await Wren.api(`/api/modules?portal=${_fPortal}&role=${encodeURIComponent(role)}&active=true`);
          if (Array.isArray(_fMods) && _fMods.length) {
            try { sessionStorage.setItem(_FCACHE, JSON.stringify({ ts: Date.now(), data: _fMods })); } catch {}
          }
        } catch {}
      }

      if (!Array.isArray(_fMods) || !_fMods.length) return;

      const _fsec = document.createElement('div');
      _fsec.className = 'nav-section';
      _fsec.innerHTML = '<div class="nav-section-label">Forms</div>' +
        _fMods.map(m => {
          const _act = currentPath.includes(`/modules/${m.slug}`);
          return `<a class="nav-item${_act ? ' active' : ''}" href="/modules/${m.slug}" title="${m.name}">` +
            `<span class="nav-icon">${m.icon || '📄'}</span>` +
            `<span class="nav-label">${m.name}</span></a>`;
        }).join('');

      const _secs = sidebar.querySelectorAll('.nav-section');
      sidebar.insertBefore(_fsec, _secs[_secs.length - 1]);
    })();

    // Inject shared module renderer (async — pages that need it use it reactively)
    if (!document.getElementById('wren-module-renderer-script')) {
      const _mrs = document.createElement('script');
      _mrs.id  = 'wren-module-renderer-script';
      _mrs.src = '/js/wren-module-renderer.js';
      document.head.appendChild(_mrs);
    }

    // ── Notification bell ─────────────────────────────────────────────────────
    let _notifItems = [];

    async function _refreshNotifCount() {
      try {
        const data = await Wren.api('/api/notifications/unread');
        _notifItems = data.items || [];
        const cnt = data.count || 0;
        const badge = document.getElementById('wren-notif-count');
        if (badge) {
          badge.textContent = cnt > 99 ? '99+' : String(cnt);
          badge.style.display = cnt > 0 ? 'block' : 'none';
        }
      } catch {}
    }

    Wren._toggleNotifPanel = function() {
      const existing = document.getElementById('wren-notif-panel');
      if (existing) { existing.remove(); return; }
      const panel = document.createElement('div');
      panel.id = 'wren-notif-panel';
      panel.style.cssText = 'position:fixed;top:52px;right:8px;width:340px;max-height:480px;overflow-y:auto;background:#1e293b;border:1px solid #2d3748;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:8999';
      const catIcon = { repair:'🔧', message:'💬', calendar:'📅', 'action-plan':'📋', safeguarding:'🛡️', medicine:'💊', incident:'🚨', system:'ℹ️', gmail:'📧', enquiry:'📩', 'waiting-list':'📝' };
      const itemsHtml = _notifItems.length
        ? _notifItems.map(n => `
          <div data-nid="${n.id}" onclick="Wren._openNotif(${n.id},${JSON.stringify(n.link||'').replace(/'/g,"\\'")})" style="padding:12px 14px;border-bottom:1px solid #2d3748;cursor:pointer;display:flex;gap:10px;align-items:flex-start;opacity:${n.read_at?'.6':'1'};transition:background .15s" onmouseenter="this.style.background='#243347'" onmouseleave="this.style.background=''">
            <span style="font-size:20px;flex-shrink:0;margin-top:1px">${catIcon[n.category]||'🔔'}</span>
            <div style="flex:1;min-width:0">
              <div style="font-weight:${n.read_at?'400':'700'};font-size:13px;color:#f1f5f9">${n.title}</div>
              ${n.body ? `<div style="font-size:12px;color:#94a3b8;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n.body}</div>` : ''}
              <div style="font-size:11px;color:#64748b;margin-top:3px">${_relTime(n.created_at)}</div>
            </div>
          </div>`)
          .join('')
        : '<div style="padding:24px;text-align:center;color:#64748b;font-size:14px">All caught up 👍</div>';
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #2d3748">
          <span style="font-weight:700;color:#f1f5f9">Notifications</span>
          <div style="display:flex;gap:8px">
            <button onclick="Wren._markAllRead()" style="font-size:12px;color:#4a9abf;background:none;border:none;cursor:pointer;padding:0">Mark all read</button>
            <a href="/notifications.html" style="font-size:12px;color:#4a9abf;text-decoration:none">See all →</a>
          </div>
        </div>
        <div id="wren-notif-list">${itemsHtml}</div>
      `;
      document.body.appendChild(panel);
      setTimeout(() => document.addEventListener('click', e => {
        if (!panel.contains(e.target) && !document.getElementById('wren-notif-btn')?.contains(e.target)) panel.remove();
      }, { once: true }), 50);
    };

    Wren._openNotif = async function(id, link) {
      try { await Wren.api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch {}
      document.getElementById('wren-notif-panel')?.remove();
      _refreshNotifCount();
      if (link) window.location.href = link;
    };

    Wren._markAllRead = async function() {
      try {
        await Wren.api('/api/notifications/read-all', { method: 'POST' });
        document.getElementById('wren-notif-panel')?.remove();
        _refreshNotifCount();
      } catch {}
    };

    function _relTime(ts) {
      const diff = Date.now() - new Date(ts).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1)  return 'Just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return new Date(ts).toLocaleDateString('en-GB');
    }

    _refreshNotifCount();
    setInterval(_refreshNotifCount, 30000);

    // Signal pages that the shell is ready and user is authenticated
    window._wrenReady = true;
    document.dispatchEvent(new CustomEvent('wren:ready', { detail: { user: Wren.user } }));

    // Init chat widget with edition-appropriate persona
    if (typeof WrenChat !== 'undefined') {
      const _personaMap = { ladn: 'eyfs', eyfs: 'eyfs', primary: 'eyfs', secondary: 'eyfs', admin: 'admin', 'ladn-hr': 'hr', parents: 'parents' };
      WrenChat.init({ persona: _personaMap[EDITION] || 'eyfs', greeting: "Hi! I'm Wren. How can I help today?" });
    }
  }

  // User menu popup — avatar dropdown showing settings + sign out
  Wren._showUserMenu = function(el) {
    const existing = document.getElementById('user-menu-popup');
    if (existing) { existing.remove(); return; }
    const popup = document.createElement('div');
    popup.id = 'user-menu-popup';
    popup.style.cssText = 'position:fixed;top:56px;right:12px;background:#1e293b;border:1px solid #2d3748;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:8px;z-index:9000;min-width:210px;';
    const user = Wren.user || {};
    const isManager = ['manager','deputy_manager','admin'].includes(user.role);
    const isAdminEd = EDITION === 'admin';
    const isParents = EDITION === 'parents';
    const profileHref = (EDITION === 'hr' || isAdminEd) ? '/my-profile.html' : '/profile.html';
    const ls = 'display:flex;align-items:center;gap:10px;padding:10px 12px;font-size:.875rem;color:#f1f5f9;text-decoration:none;border-radius:6px;transition:background .15s;cursor:pointer;border:none;background:none;width:100%;text-align:left;font-family:inherit;';
    const hs = 'onmouseenter="this.style.background=\'rgba(74,154,191,.12)\'" onmouseleave="this.style.background=\'\'"';
    let html = `<div style="padding:8px 12px 6px;border-bottom:1px solid #2d3748;font-size:.82rem;color:#64748b;font-weight:600">${user.name || 'User'}</div>`;
    html += `<a href="${profileHref}" style="${ls}" ${hs}>👤 My Profile</a>`;
    if (!isParents) {
      html += `<a href="/ey-legacy/totp-setup.html" style="${ls}" ${hs}>🔐 Two-Factor Auth</a>`;
    }
    if (isAdminEd && isManager) {
      html += `<a href="/it-settings.html" style="${ls}" ${hs}>💻 IT Settings</a>`;
      html += `<a href="/settings/permissions.html" style="${ls}" ${hs}>🛡️ Permissions</a>`;
      html += `<a href="/settings/approvals.html" style="${ls}" ${hs}>✅ Approvals</a>`;
    }
    html += `<div style="border-top:1px solid #2d3748;margin:4px 0"></div>`;
    html += `<button onclick="Wren.logout()" style="${ls}color:#ef4444;" ${hs}>🚪 Sign Out</button>`;
    popup.innerHTML = html;
    document.body.appendChild(popup);
    setTimeout(() => document.addEventListener('click', e => { if (!popup.contains(e.target)) popup.remove(); }, { once: true }), 50);
  };

  // Reset timer on user activity
  ['click','keydown','touchstart','scroll'].forEach(ev => {
    document.addEventListener(ev, () => {
      if (sessionStorage.getItem(TOKEN_KEY)) Wren._resetSessionTimer();
    }, { passive: true });
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildShell);
  } else {
    buildShell();
  }

})();

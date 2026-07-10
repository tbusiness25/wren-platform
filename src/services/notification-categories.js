'use strict';

// Canonical list of notification event categories.
// channels: default channels for this category
// urgent: true = high priority, telegram preferred
// managerOnly: true = only shown in manager-role preset

const CATEGORIES = {
  staff_sick:                { label: 'Staff Called In Sick',         urgent: false, managerOnly: false },
  staff_late:                { label: 'Staff Clock-In Late',          urgent: false, managerOnly: false },
  staff_absent_unauthorised: { label: 'Unauthorised Staff Absence',   urgent: false, managerOnly: false },
  course_completed:          { label: 'CPD Course Completed',         urgent: false, managerOnly: false },
  course_due:                { label: 'CPD Course Expiring Soon',     urgent: false, managerOnly: false },
  medicine_given:            { label: 'Medicine Administered',        urgent: false, managerOnly: false },
  medicine_due:              { label: 'Medicine Scheduled',           urgent: false, managerOnly: false },
  safeguarding_logged:       { label: 'Safeguarding Concern Logged',  urgent: true,  managerOnly: false },
  safeguarding_assigned:     { label: 'Safeguarding Concern Assigned',urgent: true,  managerOnly: false },
  incident_reported:         { label: 'Incident Reported',           urgent: false, managerOnly: false },
  incident_severe:           { label: 'Severe Incident',              urgent: true,  managerOnly: false },
  parent_message_received:   { label: 'Parent Message',               urgent: false, managerOnly: false },
  parent_message_urgent:     { label: 'Urgent Parent Message',        urgent: true,  managerOnly: false },
  funding_decision:          { label: 'Funding Decision',             urgent: false, managerOnly: false },
  supervision_due:           { label: 'Supervision Due',              urgent: false, managerOnly: false },
  supervision_scheduled:     { label: 'Supervision Scheduled',        urgent: false, managerOnly: false },
  dbs_expiring:              { label: 'DBS Expiring',                 urgent: false, managerOnly: false },
  contract_action_required:  { label: 'Contract Action Required',     urgent: false, managerOnly: false },
  room_ratio_breach:         { label: 'Room Ratio Breach',            urgent: true,  managerOnly: false },
  child_arrived:             { label: 'Key Child Arrived',            urgent: false, managerOnly: false },
  child_departed:            { label: 'Key Child Departed',           urgent: false, managerOnly: false },
  payment_received:          { label: 'Payment Received',             urgent: false, managerOnly: false },
  payment_overdue:           { label: 'Payment Overdue',              urgent: false, managerOnly: false },
  system_critical:           { label: 'System Critical Alert',        urgent: true,  managerOnly: true  },
  doorbell_pressed:          { label: 'Doorbell — Front Entrance',    urgent: true,  managerOnly: false },
  termly_update_due:         { label: 'Termly Update Due (key child)', urgent: false, managerOnly: false },
  termly_update_summary:     { label: 'Termly Updates Outstanding',    urgent: false, managerOnly: true  },
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

function getCategoryMeta(category) {
  return CATEGORIES[category] || { label: category, urgent: false, managerOnly: false };
}

// Default presets by role — returns array of {event_category, channels, scope}
function defaultPresetForRole(role) {
  const urgentChans = ['telegram', 'inapp'];
  const normalChans = ['inapp'];

  const urgentCats = CATEGORY_KEYS.filter(k => CATEGORIES[k].urgent);

  if (role === 'manager') {
    return CATEGORY_KEYS.map(k => ({
      event_category: k,
      channels: urgentChans,
      enabled: true,
      scope: 'all',
    }));
  }

  if (role === 'room_leader') {
    return CATEGORY_KEYS
      .filter(k => !['payment_received','payment_overdue','system_critical'].includes(k))
      .map(k => ({
        event_category: k,
        channels: CATEGORIES[k].urgent ? urgentChans : normalChans,
        enabled: true,
        scope: 'all',
      }));
  }

  if (role === 'practitioner') {
    const included = [
      'course_due','course_completed',
      'supervision_due','supervision_scheduled',
      'parent_message_received','incident_reported','incident_severe',
      'medicine_given','medicine_due','safeguarding_assigned',
      'child_arrived','child_departed',
      'termly_update_due',
      'doorbell_pressed',
    ];
    return included.map(k => {
      let scope = 'all';
      if (['parent_message_received','incident_reported','incident_severe','medicine_given','medicine_due'].includes(k)) scope = 'my_room';
      if (['child_arrived','child_departed','termly_update_due'].includes(k)) scope = 'my_keychildren';
      return {
        event_category: k,
        channels: CATEGORIES[k]?.urgent ? urgentChans : normalChans,
        enabled: true,
        scope,
      };
    });
  }

  // apprentice — same as practitioner but inapp only
  if (role === 'apprentice') {
    const included = [
      'course_due','course_completed','supervision_due','supervision_scheduled',
      'parent_message_received','incident_severe','medicine_given','safeguarding_assigned',
    ];
    return included.map(k => ({
      event_category: k,
      channels: normalChans,
      enabled: true,
      scope: ['parent_message_received','medicine_given'].includes(k) ? 'my_room' : 'all',
    }));
  }

  return [];
}

module.exports = { CATEGORIES, CATEGORY_KEYS, getCategoryMeta, defaultPresetForRole };

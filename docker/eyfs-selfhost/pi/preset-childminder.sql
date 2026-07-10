-- Wren CHILDMINDER preset (2026-07-10) — applied by install-wren-pi.sh when
-- run with --childminder (or WREN_PRESET=childminder in .env).
-- Strips the portal to learning journal + parents + invoicing: no staff/rota/
-- HR, no H&S/buildings, no inspection machinery, no AI. Children, Safeguarding
-- and System are core and cannot be disabled. Reversible any time in
-- Roost → System → Setup & Features (Full nursery preset).
UPDATE demo_eyfs.feature_flags SET is_enabled=false WHERE key IN (
  'module_cockpit','module_admissions','module_action-plans','module_staff',
  'module_inspection','module_checklist','module_operations','module_cpd',
  'module_review','module_intelligence','module_assistant','module_data-governance',
  'rota_builder','toil_bank','supervisions','cpd_matrix','employee_wellbeing',
  'staff_performance','repairs_tracker','camera_integration',
  'ai_observation_writer','ai_report_writer','ai_intervention_toolkit',
  'leavers_book','enquiries_pipeline'
);
-- Keep on: module_family, module_next-steps, module_curriculum, module_finance,
-- module_communications, invoicing/payments, parent messaging/diary/sign-in,
-- planning, policies, memory box, waiting list.

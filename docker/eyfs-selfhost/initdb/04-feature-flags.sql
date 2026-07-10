-- Feature flags for a fresh self-hosted instance (2026-07-10).
-- Everything defaults ON; the first-run setup wizard (and Setup & Features in
-- Roost) toggles from here. module_<section> rows control which admin-portal
-- sections are visible at all. setup_completed=false shows the setup nudge.
INSERT INTO demo_eyfs.feature_flags (key, is_enabled) VALUES
 ('setup_completed', false),
 ('finance_invoicing', true), ('finance_payments', true),
 ('rota_builder', true), ('toil_bank', true), ('supervisions', true),
 ('cpd_matrix', true), ('policies_library', true), ('employee_wellbeing', true),
 ('staff_performance', true), ('waiting_list', true), ('enquiries_pipeline', true),
 ('parent_messaging', true), ('parent_daily_diary', true), ('parent_attendance_signin', true),
 ('camera_integration', false), ('ai_observation_writer', true), ('ai_report_writer', true),
 ('ai_intervention_toolkit', true), ('leavers_book', true), ('memory_box', true),
 ('planning_drag_drop', true), ('repairs_tracker', true),
 ('module_cockpit', true), ('module_admissions', true), ('module_action-plans', true),
 ('module_staff', true), ('module_family', true), ('module_next-steps', true),
 ('module_curriculum', true), ('module_finance', true), ('module_communications', true),
 ('module_inspection', true), ('module_checklist', true), ('module_operations', true),
 ('module_cpd', true), ('module_review', true), ('module_intelligence', true),
 ('module_assistant', true), ('module_data-governance', true)
ON CONFLICT (key) DO NOTHING;

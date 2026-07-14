-- Supervision rebuild migration — 2026-06-07
-- Safe: ALTER ... IF NOT EXISTS, upserts only. No DROP/TRUNCATE.

BEGIN;

-- 1. Add category + question_key columns to templates (grouping for targeted RAG)
ALTER TABLE ladn.supervision_question_templates
  ADD COLUMN IF NOT EXISTS category    text;
ALTER TABLE ladn.supervision_question_templates
  ADD COLUMN IF NOT EXISTS question_key text;

-- 2. Structured summary store — one row per (supervision, question_key)
CREATE TABLE IF NOT EXISTS ladn.supervision_structured (
  id             serial PRIMARY KEY,
  supervision_id integer NOT NULL REFERENCES ladn.supervisions(id) ON DELETE CASCADE,
  staff_id       integer REFERENCES ladn.staff(id),
  question_key   text    NOT NULL,
  category       text,
  summary_text   text,
  rag            text,           -- green/amber/red where applicable (e.g. wellbeing)
  flag           boolean DEFAULT false,  -- e.g. safeguarding disclosure present
  ordinal        integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supervision_id, question_key)
);
CREATE INDEX IF NOT EXISTS idx_sup_structured_staff ON ladn.supervision_structured(staff_id);
CREATE INDEX IF NOT EXISTS idx_sup_structured_sup   ON ladn.supervision_structured(supervision_id);

-- 3. Upsert the full grounded question set (keyed by template_name+ordinal unique constraint).
--    EYFS 2025 statutory supervision: safeguarding/child-protection, children's wellbeing &
--    development, staff wellbeing & manageable workload, CPD/training, coaching/effectiveness.
--    Grouped by the owner's named topics + a statutory safeguarding/disclosures check.

INSERT INTO ladn.supervision_question_templates
  (template_name, ordinal, question_key, category, question_text, is_required, is_active, keywords)
VALUES
  -- Wellbeing & mental health
  ('standard', 1,  'wellbeing',        'Wellbeing',
   'How are you feeling in yourself at the moment — your mental health and general wellbeing?',
   true, true, ARRAY['wellbeing','mental health','stress','feeling','low','anxious','overwhelmed','home life']),
  ('standard', 2,  'wellbeing_support','Wellbeing',
   'Is anything outside work, or any pressure at work, affecting how you are coping? What support would help?',
   false, true, ARRAY['support','coping','pressure','home','tired','burnout','help']),

  -- Working in a team / relationships with colleagues
  ('standard', 3,  'teamwork',         'Team',
   'How are you finding working in your team and room? How are relationships with colleagues?',
   false, true, ARRAY['team','colleagues','room','dynamics','working with','relationships']),

  -- Workload
  ('standard', 4,  'workload',         'Workload',
   'Is your workload manageable? Are there tasks or times of day that feel like too much?',
   true, true, ARRAY['workload','manageable','too much','busy','capacity','ratios','overloaded']),

  -- Performance
  ('standard', 5,  'performance',      'Performance',
   'How do you feel your performance has been since we last met? What is going well and what is harder?',
   false, true, ARRAY['performance','going well','strengths','progress','feedback']),

  -- Tasks & responsibilities
  ('standard', 6,  'tasks',            'Tasks',
   'How are you getting on with your current tasks and responsibilities (planning, observations, records)?',
   false, true, ARRAY['tasks','responsibilities','planning','records','duties','keeping up']),

  -- Using initiative
  ('standard', 7,  'initiative',       'Initiative',
   'Where have you been able to use your own initiative? Where would you like more autonomy or trust?',
   false, true, ARRAY['initiative','autonomy','lead','ownership','proactive','stepped up']),

  -- Key children
  ('standard', 8,  'key_children',     'Key Children',
   'How are your key children doing? Any developmental concerns, observations, or worries about a child?',
   true, true, ARRAY['key children','key child','development','observation','concern about a child','progress']),

  -- Relationships with parents
  ('standard', 9,  'parents',          'Parents',
   'How are your relationships with the parents and families of your key children? Any difficult conversations?',
   false, true, ARRAY['parents','families','difficult parent','communication','handover','relationship with parents']),

  -- SEN
  ('standard', 10, 'sen',              'SEN',
   'Do any of your children have SEN or additional needs? Do you feel confident and well supported with these?',
   false, true, ARRAY['sen','send','additional needs','senco','ehcp','support plan','inclusion']),

  -- Safeguarding / disclosures (statutory)
  ('standard', 11, 'safeguarding',     'Safeguarding',
   'Do you have any safeguarding or child-protection concerns, or has anything been disclosed to you?',
   true, true, ARRAY['safeguarding','child protection','disclosure','concern','dsl','cpoms','referral','worried about']),

  -- CPD & training
  ('standard', 12, 'cpd_review',       'CPD & Training',
   'How is your CPD and training going? What have you completed, and what is outstanding or due to renew?',
   true, true, ARRAY['cpd','training','course','completed','renew','safeguarding training','first aid','outstanding']),
  ('standard', 13, 'cpd_aspirations',  'CPD & Training',
   'What would you like to learn or develop next? Any career aspirations or qualifications you want to pursue?',
   false, true, ARRAY['learn','develop','career','aspiration','qualification','progression','want to']),

  -- SMART targets
  ('standard', 14, 'targets_review',   'SMART Targets',
   'How did you get on with the targets we agreed last time? What progress or blockers?',
   true, true, ARRAY['targets','goals','agreed','progress','blockers','last time','objectives']),
  ('standard', 15, 'targets_new',      'SMART Targets',
   'What SMART targets shall we set for the next period (specific, measurable, with a deadline)?',
   true, true, ARRAY['smart','new target','next period','deadline','objective','goal for next']),

  -- Manager observations + agreed actions (closing)
  ('standard', 16, 'manager_feedback', 'Manager Feedback',
   'Manager observations and feedback for this practitioner.',
   false, true, ARRAY['i have noticed','observed','my feedback','manager feedback']),
  ('standard', 17, 'agreed_actions',   'Actions',
   'Actions agreed in this supervision — who does what, by when?',
   true, true, ARRAY['action','agreed','will do','by when','follow up','next steps'])
ON CONFLICT (template_name, ordinal) DO UPDATE SET
  question_key = EXCLUDED.question_key,
  category     = EXCLUDED.category,
  question_text= EXCLUDED.question_text,
  is_required  = EXCLUDED.is_required,
  is_active    = EXCLUDED.is_active,
  keywords     = EXCLUDED.keywords;

COMMIT;

-- =============================================================================
-- demo_eyfs comprehensive seed — v3
-- STABLE section: rooms, staff, children (idempotent, first-boot only)
-- MUTABLE section: all time-varying data — wiped + re-seeded on /api/demo/reset
-- =============================================================================

SET search_path TO demo_eyfs;

-- ═══════════════════════════════════════════════════════════════════════════
-- STABLE DATA
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Rooms ────────────────────────────────────────────────────────────────────
INSERT INTO rooms (id, name, min_age_months, max_age_months, capacity)
VALUES
  (1, 'Baby Room',   3,  18, 10),
  (2, 'Pre-school', 30,  60, 22),
  (3, 'Toddlers',   18,  36, 12)
ON CONFLICT (id) DO UPDATE
  SET name=EXCLUDED.name, capacity=EXCLUDED.capacity;

-- ── Staff ─────────────────────────────────────────────────────────────────────
-- bcrypt of '1234' (cost 10)
DO $$
DECLARE h TEXT := '$2a$10$ZTdD2SEQs5QJJzSlQ2oKSuoc/GaMYlWGt4kVjmlgBRHq2ms9tadny';
BEGIN
  INSERT INTO staff (id, first_name, last_name, email, role, room_id, pin_hash,
                     contracted_hours, dbs_expiry, is_active, employment_type,
                     contract_start)
  VALUES
    (1,  'Olivia',        'Davis',       'olivia@demo.wren',    'manager',        NULL, h, 40, '2027-09-01', true, 'full_time',  '2019-09-01'),
    (2,  'Sophie',        'Williams',    'sophie@demo.wren',    'room_leader',    2,    h, 37, '2027-06-15', true, 'full_time',  '2020-04-01'),
    (3,  'Hannah',        'Moore',       'hannah@demo.wren',    'practitioner',   1,    h, 30, '2026-11-20', true, 'full_time',  '2021-09-01'),
    (4,  'Jake',          'Peters',      'jake@demo.wren',      'practitioner',   1,    h, 25, '2027-03-10', true, 'part_time',  '2022-06-01'),
    (5,  'Maya',          'Singh',       'maya@demo.wren',      'deputy_manager', NULL, h, 40, '2026-08-25', true, 'full_time',  '2020-01-06'),
    (6,  'Lucy',          'Hammond',     'lucy@demo.wren',      'practitioner',   2,    h, 30, '2027-01-14', true, 'full_time',  '2022-09-01'),
    (7,  'Callum',        'Fraser',      'callum@demo.wren',    'room_leader',    3,    h, 37, '2026-10-05', true, 'full_time',  '2021-04-01'),
    (8,  'Priya',         'Nair',        'priya@demo.wren',     'practitioner',   3,    h, 25, '2027-02-28', true, 'part_time',  '2023-01-09'),
    (9,  'Admin',         'Demo',        'admin@demo.wren',     'manager',        NULL, h, 40, '2027-09-01', true, 'full_time',  '2020-09-01'),
    (10, 'Practitioner',  'Demo',        'prac@demo.wren',      'practitioner',   2,    h, 30, '2027-01-01', true, 'full_time',  '2022-09-01'),
    (11, 'Grace',         'Osei',        'grace@demo.wren',     'practitioner',   2,    h, 25, '2026-09-30', true, 'part_time',  '2023-09-01'),
    (12, 'Tom',           'Hutchins',    'tom@demo.wren',       'admin',          NULL, h, 20, '2026-12-15', true, 'part_time',  '2024-01-08')
  ON CONFLICT (id) DO UPDATE
    SET pin_hash=EXCLUDED.pin_hash,
        room_id=EXCLUDED.room_id,
        contracted_hours=EXCLUDED.contracted_hours;

  UPDATE staff SET pin_hash=h
  WHERE (pin_hash IS NULL OR pin_hash='') AND is_active=true;
END $$;

-- ── Children ──────────────────────────────────────────────────────────────────
-- Children 1-10 (demo records; @example.com parents are placeholders).
INSERT INTO children
  (id, first_name, last_name, date_of_birth, room_id, key_person_id,
   is_active, photo_consent, media_consent, funded_hours, funded_hours_type,
   parent_1_name, parent_1_email, parent_1_phone)
VALUES
  (1, 'Amelia','Thompson','2024-03-15',1,1,true,true, false,0,NULL,'Sarah Thompson','sarah@example.com','07700900001'),
  (2, 'Noah',  'Patel',   '2024-01-20',1,1,true,true, false,0,NULL,'Priya Patel',   'priya@example.com','07700900002'),
  (3, 'Isla',  'Chen',    '2023-11-08',2,1,true,true, false,0,NULL,'Li Chen',       'li@example.com',   '07700900003'),
  (4, 'Oliver','Williams','2023-09-14',2,1,true,false,false,0,NULL,'Emma Williams', 'emma@example.com', '07700900004'),
  (5, 'Zoe',   'Ahmed',   '2024-02-28',1,5,true,true, false,0,NULL,'Fatima Ahmed',  'fatima@example.com','07700900005'),
  (6, 'Ethan', 'Johnson', '2022-07-10',2,1,true,true, false,0,NULL,'Mark Johnson',  'mark@example.com', '07700900006'),
  (7, 'Sophie','Brown',   '2022-04-22',2,1,true,true, false,0,NULL,'Claire Brown',  'claire@example.com','07700900007'),
  (8, 'Luca',  'Rossi',   '2021-11-30',2,4,true,true, false,0,NULL,'Marco Rossi',   'marco@example.com','07700900008'),
  (9, 'Mia',   'Taylor',  '2022-08-15',2,8,true,true, false,0,NULL,'James Taylor',  'james@example.com','07700900009'),
  (10,'Archie','Davis',   '2022-05-03',2,8,true,false,false,0,NULL,'Rachel Davis',  'rachel@example.com','07700900010')
ON CONFLICT (id) DO NOTHING;

-- Reassign room 3 (Toddlers)
UPDATE children SET room_id=3, key_person_id=7
WHERE id IN (3,4) AND room_id=1;

UPDATE children SET room_id=3, key_person_id=8
WHERE id IN (9,10) AND room_id=2;

-- Children 11-30
INSERT INTO children
  (id, first_name, last_name, date_of_birth, room_id, key_person_id,
   is_active, start_date, photo_consent, media_consent, funded_hours, funded_hours_type,
   parent_1_name, parent_1_email, parent_1_phone, ethnicity)
VALUES
-- Baby Room (room 1, born 2024–2025)
(11,'Leo',    'Patel',     '2024-07-18',1,3,true,'2025-09-01',true,true,  15,'15hr','Priya Patel',      'parent@demo.wren','07700 900101','Asian British'),
(12,'Freya',  'O''Brien',  '2024-04-22',1,4,true,'2025-09-01',true,true,  15,'15hr','Claire O''Brien',  'parent@demo.wren','07700 900102','White British'),
(13,'Remi',   'Adeyemi',   '2024-09-03',1,3,true,'2025-11-01',true,true,   0,NULL,  'Ngozi Adeyemi',    'parent@demo.wren','07700 900103','Black African'),
(14,'Evie',   'Clarke',    '2024-11-14',1,6,true,'2026-01-06',true,true,   0,NULL,  'Jessica Clarke',   'parent@demo.wren','07700 900104','White British'),
(15,'Eli',    'Hussain',   '2024-06-30',1,4,true,'2025-09-01',true,true,  15,'15hr','Fatima Hussain',   'parent@demo.wren','07700 900105','Asian British'),
(16,'Nora',   'Garcia',    '2024-03-08',1,3,true,'2025-06-01',true,false, 15,'15hr','Maria Garcia',     'parent@demo.wren','07700 900106','White Other'),
(17,'Theo',   'Obi',       '2024-12-01',1,6,true,'2026-02-03',true,true,   0,NULL,  'Adaeze Obi',       'parent@demo.wren','07700 900107','Black British'),
(18,'Iris',   'Lewis',     '2024-08-19',1,4,true,'2025-09-01',true,true,  15,'15hr','Sian Lewis',       'parent@demo.wren','07700 900108','White Welsh'),
(19,'Juno',   'Kim',       '2024-05-27',1,3,true,'2025-09-01',true,true,  15,'15hr','Ji-Yeon Kim',      'parent@demo.wren','07700 900109','Asian British'),
(20,'Ezra',   'Brown',     '2024-10-11',1,6,true,'2025-12-01',true,true,   0,NULL,  'Sarah Brown',      'parent@demo.wren','07700 900110','Mixed British'),
-- Toddlers (room 3, born 2023)
(21,'Poppy',  'Walsh',     '2023-02-14',3,7,true,'2024-09-02',true,true,  15,'15hr','Karen Walsh',      'parent@demo.wren','07700 900111','White British'),
(22,'Milo',   'Singh',     '2023-05-03',3,8,true,'2024-09-02',true,true,  15,'15hr','Harpreet Singh',   'parent@demo.wren','07700 900112','Asian British'),
(23,'Imogen', 'Roberts',   '2023-07-22',3,7,true,'2024-09-02',true,true,   0,NULL,  'Helen Roberts',    'parent@demo.wren','07700 900113','White British'),
(24,'Finn',   'Okonkwo',   '2023-01-09',3,8,true,'2024-01-08',true,true,  15,'15hr','Chidinma Okonkwo', 'parent@demo.wren','07700 900114','Black British'),
(25,'Violet', 'Davies',    '2023-09-17',3,7,true,'2024-09-02',true,true,   0,NULL,  'Bethan Davies',    'parent@demo.wren','07700 900115','White Welsh'),
-- Pre-school (room 2, born 2021–2022)
(26,'Reuben', 'Al-Rashid', '2021-09-28',2,2,true,'2024-09-02',true,true,  30,'30hr','Leila Al-Rashid',  'parent@demo.wren','07700 900116','Arab British'),
(27,'Margot', 'Turner',    '2022-04-05',2,2,true,'2024-09-02',true,true,  15,'15hr','Nicola Turner',    'parent@demo.wren','07700 900117','White British'),
(28,'Casper', 'Nwosu',     '2021-12-19',2,6,true,'2024-01-08',true,true,  30,'30hr','Emeka Nwosu',      'parent@demo.wren','07700 900118','Black African'),
(29,'Elara',  'Johansson', '2022-02-28',2,11,true,'2024-09-02',true,true, 15,'15hr','Anna Johansson',   'parent@demo.wren','07700 900119','White Other'),
(30,'Felix',  'Mitchell',  '2021-07-07',2,6,true,'2024-04-22',true,true,  30,'30hr','Rachel Mitchell',  'parent@demo.wren','07700 900120','White British')
ON CONFLICT (id) DO NOTHING;

-- ── Parent portal access ──────────────────────────────────────────────────────
-- password hash of 'demo' (bcrypt cost 10)
INSERT INTO parent_portal_access (id, child_id, email, is_active, password_hash)
SELECT
  s.id + 3, s.id, 'parent@demo.wren', true,
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LBurHNlYG4y'
FROM generate_series(4,30) s(id)
ON CONFLICT (id) DO NOTHING;

-- ── Sequences ─────────────────────────────────────────────────────────────────
SELECT setval(pg_get_serial_sequence('children','id'),          GREATEST(30,(SELECT MAX(id) FROM children)));
SELECT setval(pg_get_serial_sequence('staff','id'),             GREATEST(12,(SELECT MAX(id) FROM staff)));
SELECT setval(pg_get_serial_sequence('parent_portal_access','id'),GREATEST(33,(SELECT MAX(id) FROM parent_portal_access)));


-- =============================================================================
-- MUTABLE DATA — wiped and re-seeded on every /api/demo/reset call
-- The reset endpoint runs everything from this point down.
-- =============================================================================

-- ── Wipe mutable tables (FK-safe order) ──────────────────────────────────────
DELETE FROM messages;
DELETE FROM message_threads;
DELETE FROM observations;
DELETE FROM daily_diary;
DELETE FROM attendance;
DELETE FROM behaviour_log;
DELETE FROM invoices;
DELETE FROM payments;
DELETE FROM safeguarding_concerns;
DELETE FROM safeguarding_actions;
DELETE FROM safeguarding_log;
DELETE FROM action_plans;
DELETE FROM supervisions;
DELETE FROM supervision_targets;
DELETE FROM cpd_records;
DELETE FROM absence_requests;
DELETE FROM staff_compliance;
DELETE FROM curriculum_plans;
DELETE FROM weekly_plans;
DELETE FROM incidents;
DELETE FROM newsletters;

-- ── Reset sequences ───────────────────────────────────────────────────────────
ALTER SEQUENCE IF EXISTS observations_id_seq    RESTART WITH 1;
ALTER SEQUENCE IF EXISTS daily_diary_id_seq     RESTART WITH 1;
ALTER SEQUENCE IF EXISTS attendance_id_seq      RESTART WITH 1;
ALTER SEQUENCE IF EXISTS invoices_id_seq        RESTART WITH 1;
ALTER SEQUENCE IF EXISTS supervisions_id_seq    RESTART WITH 1;
ALTER SEQUENCE IF EXISTS cpd_records_id_seq     RESTART WITH 1;
ALTER SEQUENCE IF EXISTS action_plans_id_seq    RESTART WITH 1;
ALTER SEQUENCE IF EXISTS message_threads_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS messages_id_seq        RESTART WITH 1;
ALTER SEQUENCE IF EXISTS curriculum_plans_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS weekly_plans_id_seq    RESTART WITH 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- OBSERVATIONS — 6 per child × 30 children = 180+
-- Pure SQL approach avoids PL/pgSQL multidimensional array issues
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO observations
  (child_id, staff_id, title, observation_text, observation_type,
   eyfs_areas, next_steps, shared_with_parents, created_at)
WITH tmpl(idx, title, obs_text, areas, nextstep, obs_type) AS (VALUES
  (1,'Exploratory play observation',
   'Showed sustained engagement, exploring materials purposefully and narrating their actions with increasing vocabulary. Demonstrated clear understanding of cause and effect.',
   ARRAY['Understanding the World','Communication and Language'],
   'Extend exploration with new materials; introduce variables for prediction.','note'),
  (2,'Mark making and early writing',
   'Selected mark-making tools independently and produced intentional marks with an emerging tripod grip. Named their creation and asked for it to be displayed.',
   ARRAY['Literacy','Physical Development'],
   'Offer patterned paper and rollers; model writing for a purpose.','note'),
  (3,'Mathematical thinking in action',
   'Counted objects accurately and showed cardinality — saying the final number without recounting. Asked ''what comes after?'' showing growing number sense.',
   ARRAY['Mathematics'],
   'Introduce number bonds to 5 using concrete objects.','learning_story'),
  (4,'Phonological awareness activity',
   'Sorted initial-sound objects confidently, self-correcting errors. Used phonetically plausible spelling in spontaneous writing attempts.',
   ARRAY['Literacy'],
   'Move to CVC word building with known phoneme sets.','learning_story'),
  (5,'Physical development — gross motor',
   'Navigated the outdoor course with growing confidence, demonstrating risk assessment by pausing to check footholds. Encouraged peers throughout.',
   ARRAY['Physical Development','Personal Social and Emotional Development'],
   'Introduce balance beam and one-leg challenge activities.','note'),
  (6,'Fine motor skills focus',
   'Completed threading activity with focused concentration, progressing from large to small beads. Identified a repeating colour pattern independently.',
   ARRAY['Physical Development','Mathematics'],
   'Offer weaving boards and natural materials for fine motor extension.','note'),
  (7,'Role play and imaginative play',
   'Maintained an imaginative narrative for 18 minutes, assigning roles and using descriptive language including time connectives and because-clauses.',
   ARRAY['Communication and Language','Expressive Arts and Design'],
   'Add recipe cards and story maps to extend narrative complexity.','learning_story'),
  (8,'Story time engagement',
   'Recalled events from yesterday''s story unprompted and predicted the ending. Used book vocabulary: ''the author'', ''the illustrator'', ''the plot''.',
   ARRAY['Literacy','Communication and Language'],
   'Introduce story-sequencing picture cards for independent retelling.','note'),
  (9,'Outdoor learning observation',
   'Carefully observed and recorded features of a minibeast found under a log. Drew a detailed diagram and labelled it using phonetically plausible spelling.',
   ARRAY['Understanding the World','Literacy'],
   'Create a class nature journal; introduce classification keys.','learning_story'),
  (10,'Creative arts exploration',
   'Spent 40 minutes at the creative table, purposefully mixing colours and describing effects: ''it went dark because I added too much blue''.',
   ARRAY['Expressive Arts and Design'],
   'Introduce watercolour and texture printing; add colour-mixing vocabulary cards.','note'),
  (11,'PSED — self-regulation moment',
   'Paused mid-frustration, took a breath (a strategy we have been practising together), then said ''I need a minute''. Returned after 90 seconds ready to try again.',
   ARRAY['Personal Social and Emotional Development'],
   'Continue feelings vocabulary throughout the day. Add calm-corner strategy cards.','learning_story'),
  (12,'Communication and language focus',
   'Used a wide range of descriptive vocabulary and complex sentence structures. Asked clarifying questions and built on peers'' contributions in group discussion.',
   ARRAY['Communication and Language'],
   'Introduce Socratic questioning in small group time.','note'),
  (13,'Understanding the World — nature',
   'Identified seasonal changes during our walk, recalling observations from last term. Described the life cycle of a butterfly correctly from memory.',
   ARRAY['Understanding the World'],
   'Create a seasonal observation diary with photographs and annotations.','learning_story'),
  (14,'Construction and problem solving',
   'Built a stable structure after two collapses, each time adjusting base width. Verbally reasoned about why the change would help: strong engineering thinking.',
   ARRAY['Mathematics','Physical Development'],
   'Provide unit blocks and loose parts; introduce plans and blueprints.','learning_story'),
  (15,'Music and movement session',
   'Moved confidently to the beat, changing speed in response to musical changes. Led a small group in creating a repeated rhythm pattern with instruments.',
   ARRAY['Expressive Arts and Design','Physical Development'],
   'Extend to composition: create a short 4-bar piece using untuned percussion.','note')
),
slots AS (
  SELECT c, o,
    ((c + o*3 - 1) % 15) + 1 AS tmpl_idx,
    CASE
      WHEN c IN (1,2,5,11,12,13,14,15,16,17,18,19,20) THEN (ARRAY[3,4,3,4,3,4,3,4,3,4,3,4,3])[((c-1)%13)+1]
      WHEN c IN (3,4,21,22,23,24,25)                  THEN (ARRAY[7,8,7,8,7,8,7])[((c-1)%7)+1]
      ELSE                                                  (ARRAY[2,6,11,2,6,11,2,6,11,2,6,11,2])[((c-1)%13)+1]
    END AS sid,
    (7-o)*7 + (c%5) AS days_ago
  FROM generate_series(1,30) c
  CROSS JOIN generate_series(1,6) o
)
SELECT
  s.c, s.sid,
  t.title, t.obs_text,
  t.obs_type, t.areas, t.nextstep,
  (s.c * 7 + s.o) % 4 != 0,
  NOW() - (s.days_ago || ' days')::interval
FROM slots s
JOIN tmpl t ON t.idx = s.tmpl_idx;

-- Richer hand-crafted narrative observations on top of bulk
INSERT INTO observations
  (child_id, staff_id, title, observation_text, observation_type, eyfs_areas,
   next_steps, shared_with_parents, created_at)
VALUES
(1, 3, 'Reading first decodable book',
 'Amelia read her first decodable book cover to cover independently. She decoded every word using phonics knowledge and self-corrected twice. At the end she said "I''m a reader!" An exceptional milestone.',
 'learning_story', ARRAY['Literacy'], 'Issue the next decodable book. Share this milestone with parents tonight.', true, NOW()-'1 day'::interval),

(2, 4, 'Self-regulation during frustration',
 'Noah''s tower fell for the second time. He paused, took a breath (which we have been practising), and said "I need a moment." After 90 seconds he returned and rebuilt methodically — a significant self-regulation achievement.',
 'learning_story', ARRAY['Personal Social and Emotional Development'], 'Continue feelings vocabulary. Create a calm-corner strategy card with Noah.', true, NOW()-'3 days'::interval),

(11, 3, 'First steps — milestone',
 'Leo took 9 unaided steps today! He has been cruising confidently for two weeks. He completed his journey with a wide grin and immediately clapped for himself. Wonderful milestone.',
 'learning_story', ARRAY['Physical Development'], 'Ensure safe walking space. Share video clip with parent today.', true, NOW()-'5 days'::interval),

(26, 2, 'Story creation — complex narrative',
 'Reuben dictated a five-sentence story about a boy who could talk to fish. He used time connectives ("one morning", "suddenly", "in the end"), direct speech, and a satisfying resolution. He is ready for story-map planning.',
 'learning_story', ARRAY['Literacy','Communication and Language'], 'Introduce story map template. Support independent written story next week.', true, NOW()-'2 days'::interval),

(28, 6, 'Number bonds — cardinality to 10',
 'Casper sorted a collection of 10 acorns into two groups independently and labelled both groups: "4 + 6 = 10". He then found a different split ("5 and 5") and explained why both were "making ten".',
 'learning_story', ARRAY['Mathematics'], 'Introduce number bonds to 20 using Numicon.', true, NOW()-'4 days'::interval),

(21, 7, 'Toddler — schema play (transporting)',
 'Poppy spent 25 minutes filling a bucket, carrying it to a new location, emptying it, and returning. She repeated this circuit 8 times with absolute focus — a clear transporting schema in action.',
 'note', ARRAY['Physical Development','Understanding the World'], 'Provide varied containers and destinations. Observe for connecting schema.', true, NOW()-'6 days'::interval),

(24, 8, 'Toddler — first two-word combination',
 'Finn said "more juice" clearly and intentionally at snack time — his first reliably observed two-word combination. He repeated it twice and made eye contact to check it had been understood. Language development on track.',
 'learning_story', ARRAY['Communication and Language'], 'Model three-word sentences. Add Makaton signing for "more" and "please".', true, NOW()-'8 days'::interval);

SELECT setval(pg_get_serial_sequence('observations','id'), (SELECT MAX(id) FROM observations) + 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- DAILY DIARY — 8 weeks, all 30 children (weekdays)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO daily_diary
  (child_id, staff_id, date, mood, meals, activities, notes, shared_with_parents)
SELECT
  c.child_id,
  -- map to staff by room
  CASE WHEN c.child_id BETWEEN 1 AND 5 OR c.child_id BETWEEN 11 AND 20
       THEN (ARRAY[3,4,3,4,3,3,4,3,4,3,3,4,3,4,3,3,4,3,4,3])[c.child_id]
       WHEN c.child_id BETWEEN 21 AND 25
       THEN (ARRAY[7,8,7,8,7])[c.child_id-20]
       ELSE (ARRAY[2,6,2,11,6,2,6,2,11,6,6])[c.child_id-25]
  END AS staff_id,
  d.day::date,
  (ARRAY['happy','content','settled','excited','tired','happy','content'])[
    (c.child_id + d.dow) % 7 + 1] AS mood,
  CASE (c.child_id + d.dow) % 3
    WHEN 0 THEN 'Good appetite — ate most of their lunch'
    WHEN 1 THEN 'Ate well at snack; smaller portion at lunchtime'
    ELSE      'Excellent appetite — asked for seconds at lunch'
  END AS meals,
  CASE d.dow % 5
    WHEN 0 THEN 'Morning: carpet time, phonics. Afternoon: outdoor play, construction'
    WHEN 1 THEN 'Morning: water play, number activities. Afternoon: creative arts, story time'
    WHEN 2 THEN 'Morning: writing table, small world. Afternoon: music, movement'
    WHEN 3 THEN 'Morning: outdoor learning, science. Afternoon: role play, books'
    ELSE      'Morning: PE, maths games. Afternoon: cooking, self-directed play'
  END AS activities,
  CASE (c.child_id + d.dow) % 4
    WHEN 0 THEN 'Settled well. Enjoyed time with friends.'
    WHEN 1 THEN 'Needed a little settling at drop-off but was happy within a few minutes.'
    WHEN 2 THEN 'Fantastic day — very engaged throughout.'
    ELSE      'Good energy. Tried something new in the outdoor area.'
  END AS notes,
  true AS shared_with_parents
FROM
  generate_series(1,30) AS c(child_id),
  (SELECT d::date AS day, EXTRACT(DOW FROM d)::int AS dow
   FROM generate_series(CURRENT_DATE-'56 days'::interval,
                        CURRENT_DATE-'1 day'::interval,
                        '1 day'::interval) AS d
   WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5) AS d;

-- Baby-room entries with nappy/sleep data
INSERT INTO daily_diary
  (child_id, staff_id, date, mood, meals, activities, notes,
   nappy, sleep_from, sleep_to, sleep_quality, shared_with_parents)
VALUES
(11,3,CURRENT_DATE-5,'happy',  'Ate porridge and fruit well','Heuristic basket, sensory tray, buggy walk',
  'Leo had a wonderful day — discovered he can stack two rings.',                        'wet',        '11:00','12:30','settled',true),
(12,4,CURRENT_DATE-5,'content','Good milk feeds at 10am and 2pm','Floor play with mirrors, tummy time',
  'Freya practised standing and took tentative steps along the sofa.',                   'wet-soiled', '10:30','12:00','deep',   true),
(13,3,CURRENT_DATE-4,'settled','Ate well — all lunch finished','Treasure basket, music and movement, messy play',
  'Remi spent nearly 30 minutes pouring and filling in the sensory bin.',                'wet',        '11:15','12:45','settled',true),
(14,6,CURRENT_DATE-4,'happy',  'Half lunch, snack well','Outdoor exploration, painting, book corner',
  'Evie spent ages in the mirror naming body parts: "Nose! Eye! Ear!"',                  'wet',        '12:00','13:30','settled',true),
(15,4,CURRENT_DATE-3,'excited','Full lunch plus extra bread','Water play, construction, story corner',
  'Eli pointed at pictures and vocalised purposefully throughout story time.',            'wet-soiled', '10:45','12:15','deep',   true),
(16,3,CURRENT_DATE-3,'happy',  'Good portions at all meals','Heuristic play, outdoor buggy, singing',
  'Nora waved bye-bye for the first time at home time — parents delighted.',             'wet',        '11:00','12:30','settled',true),
(17,6,CURRENT_DATE-2,'content','Ate well','Sensory tray, soft play, story time',
  'Theo is showing more interest in faces — lots of eye contact and smiling today.',      'wet',        '11:30','13:00','settled',true),
(11,3,CURRENT_DATE-2,'happy',  'Good appetite','Construction, sensory bin, outdoor walk',
  'Leo took 5 steps independently! Very proud moment captured on camera.',               'wet',        '10:45','12:15','deep',   true),
(12,4,CURRENT_DATE-1,'excited','Excellent — ate everything','Water play, music, mirror play',
  'Freya is walking! 8 unaided steps today — she clapped for herself at the end.',       'wet-soiled', '11:00','12:30','settled',true);

SELECT setval(pg_get_serial_sequence('daily_diary','id'), (SELECT MAX(id) FROM daily_diary) + 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- ATTENDANCE — 60 days, all 30 children, am+pm sessions
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO attendance (child_id, date, session, absent, absence_reason)
SELECT
  c.child_id,
  d.day::date,
  sess.session,
  -- ~8% absence rate with a few absence reasons
  CASE WHEN (c.child_id * 7 + d.dow * 3 + sess.n) % 12 = 0 THEN true ELSE false END,
  CASE WHEN (c.child_id * 7 + d.dow * 3 + sess.n) % 12 = 0
    THEN (ARRAY['Illness','Illness','Illness','Family appointment','Holiday','Illness'])[
           (c.child_id + d.dow) % 6 + 1]
    ELSE NULL
  END
FROM
  generate_series(1,30) AS c(child_id),
  (SELECT d::date AS day, EXTRACT(DOW FROM d)::int AS dow
   FROM generate_series(CURRENT_DATE-'60 days'::interval,
                        CURRENT_DATE-'1 day'::interval,
                        '1 day'::interval) AS d
   WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5) AS d,
  (VALUES ('am',1),('pm',2)) AS sess(session,n);

SELECT setval(pg_get_serial_sequence('attendance','id'), (SELECT MAX(id) FROM attendance) + 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- INVOICES — 12 months × 30 children
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  child_row  RECORD;
  m          INT;
  yr         INT;
  mo         INT;
  ps         DATE;
  pe         DATE;
  due        NUMERIC;
  paid       NUMERIC;
  st         TEXT;
  pd         DATE;
  inv_num    TEXT;
  fn_hrs     INT;
  fn_deduct  INT;
BEGIN
  FOR child_row IN SELECT id, room_id, funded_hours FROM demo_eyfs.children WHERE is_active ORDER BY id LOOP
    fn_hrs    := COALESCE(child_row.funded_hours, 0);
    fn_deduct := fn_hrs * 600;  -- £6/hr deduction in pence

    FOR m IN 0..11 LOOP
      ps  := date_trunc('month', CURRENT_DATE - ((11-m) || ' months')::interval)::date;
      pe  := (ps + '1 month'::interval - '1 day'::interval)::date;
      yr  := EXTRACT(YEAR FROM ps);
      mo  := EXTRACT(MONTH FROM ps);

      -- Base fee: Baby/Toddler £1,200, Pre-school £900; adjust for funded hours
      due := CASE child_row.room_id
               WHEN 1 THEN 120000
               WHEN 3 THEN 110000
               ELSE 90000
             END - fn_deduct;
      due := due::numeric / 100;  -- convert pence to pounds

      -- Status: older months are paid, current month may be outstanding
      IF m < 10 THEN
        st   := 'paid';
        paid := due;
        pd   := ps + '14 days'::interval;
      ELSIF m = 10 THEN
        st   := 'paid';
        paid := due;
        pd   := ps + '7 days'::interval;
      ELSE
        st   := CASE (child_row.id % 3) WHEN 0 THEN 'outstanding' WHEN 1 THEN 'sent' ELSE 'paid' END;
        paid := CASE st WHEN 'paid' THEN due ELSE 0 END;
        pd   := CASE st WHEN 'paid' THEN ps + '5 days'::interval ELSE NULL END;
      END IF;

      inv_num := 'WRN-' || yr || '-' || lpad(mo::text,2,'0') || '-' || lpad(child_row.id::text,4,'0');

      INSERT INTO invoices
        (child_id, period_start, period_end, period_year, period_month,
         amount_due, amount_paid, status, issued_date, paid_date,
         invoice_number, funding_deduction_pence)
      VALUES
        (child_row.id, ps, pe, yr, mo,
         due, paid, st, ps, pd,
         inv_num, fn_deduct);
    END LOOP;
  END LOOP;
END $$;

SELECT setval(pg_get_serial_sequence('invoices','id'), (SELECT MAX(id) FROM invoices) + 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- SAFEGUARDING CONCERNS
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO safeguarding_concerns
  (child_id, reported_by, concern_date, category, description, immediate_action,
   status, dsl_notes, dsl_reviewed_by, dsl_reviewed_at, is_confidential)
VALUES
(3, 3, NOW()-'45 days'::interval, 'Physical',
 'Child arrived with an unexplained bruise on their left forearm. Parent stated the child had fallen from a climbing frame at a local park at the weekend. The bruise was documented with a body-map photograph.',
 'Body-map completed. Parent spoken to at collection. No further marks observed.',
 'closed', 'Discussed with manager. Parent''s explanation consistent with injury type. No previous concerns. Monitor and file.', 1, NOW()-'44 days'::interval, false),

(7, 2, NOW()-'30 days'::interval, 'Neglect',
 'Child appeared hungry at morning drop-off on three consecutive days. On the third day, child said "I didn''t have breakfast". Child was pale and fatigued. Spoken to key person who confirmed pattern.',
 'Child given breakfast snack each morning. Parent contacted by phone by manager.',
 'action_taken', 'Spoke with parent — they acknowledged difficulties. Referred to Early Help. CAF assessment opened. Review in 4 weeks.', 5, NOW()-'29 days'::interval, false),

(14, 6, NOW()-'18 days'::interval, 'Emotional',
 'Child (Evie, 17 months) has shown a marked change in behaviour over the past week — increased clinginess, distress at drop-off, and disturbed settling. Key person noted Evie appears anxious when certain topics arise.',
 'Increased key-person contact. Gentle transition support implemented.',
 'under_review', 'Parent informed of behaviour change sensitively. No disclosures. Continue close observation and record all incidents.', 1, NOW()-'17 days'::interval, true),

(22, 7, NOW()-'7 days'::interval, 'Physical',
 'Milo arrived with a reddened cheek. Parent explained he had bumped into a door frame at home that morning. Mark was consistent with this account. Milo appeared happy and settled.',
 'Body-map photograph taken. Parent''s account recorded. No previous concerns on file.',
 'under_review', 'First concern for this child. Account plausible. Monitor closely — record any further marks.', 5, NOW()-'6 days'::interval, false),

(28, 6, NOW()-'2 days'::interval, 'Online/Digital',
 'Parent reported in a message that their child has been accessing a family member''s phone unsupervised and may have encountered inappropriate online content. Parent sought advice on age-appropriate guidance.',
 'Spoken to parent. Signposted to NSPCC Share Aware and CEOP resources.',
 'new', 'Low-risk concern at this stage but logged as required. DSL to follow up with parent next week.', NULL, NULL, false);

-- ═══════════════════════════════════════════════════════════════════════════
-- ACTION PLANS
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO action_plans
  (title, area, priority, status, owner_staff_id, description, success_criteria,
   target_date, actions, created_by)
VALUES

('Improve outdoor learning provision',
 'Curriculum', 'high', 'in_progress', 2,
 'Audit and enhance the outdoor learning environment to ensure it offers challenge, risk, and rich learning opportunities across all EYFS areas.',
 'All outdoor areas rated ''good'' or better in next environment audit. Observations show outdoor learning referenced in 30%+ of learning stories.',
 CURRENT_DATE + 60,
 '[{"text":"Complete outdoor environment audit using Enabling Environments framework","done":true,"due":"2026-03-15"},
   {"text":"Source mud kitchen and balance beam for pre-school outdoor area","done":true,"due":"2026-03-30"},
   {"text":"Create outdoor learning resource packs linked to current theme","done":false,"due":"2026-04-15"},
   {"text":"Deliver staff CPD session on outdoor pedagogy","done":false,"due":"2026-04-30"},
   {"text":"Repeat environment audit and compare scores","done":false,"due":"2026-05-20"}]'::jsonb,
 1),

('Raise baseline attainment in Communication and Language',
 'Assessment', 'high', 'in_progress', 5,
 'Data shows 22% of children entering pre-school are below expected level in CL. Targeted intervention to close gap before end of academic year.',
 'By July, 85% of pre-school children reach expected level in CL. Gap reduced to <10% below expected.',
 CURRENT_DATE + 45,
 '[{"text":"Identify children below expected level using observations and Tapestry data","done":true,"due":"2026-02-28"},
   {"text":"Implement daily small-group language circle for targeted children","done":true,"due":"2026-03-10"},
   {"text":"Purchase and deploy ''Talk Boost'' intervention programme","done":false,"due":"2026-04-01"},
   {"text":"Train key persons in Elklan Level 3 communication strategies","done":false,"due":"2026-04-30"},
   {"text":"Re-assess CL baseline for targeted group and report progress","done":false,"due":"2026-06-01"}]'::jsonb,
 5),

('Embed consistent safeguarding practice across all staff',
 'Safeguarding', 'high', 'in_progress', 1,
 'Ensure all staff have up-to-date safeguarding training and can demonstrate consistent application of procedures.',
 '100% of staff complete Level 2 safeguarding refresher. All procedures documented and signed off. Spot-check quiz score average >90%.',
 CURRENT_DATE + 30,
 '[{"text":"Audit safeguarding training certificates — identify gaps","done":true,"due":"2026-03-01"},
   {"text":"Book all staff onto EALING DSL Level 2 refresher (online)","done":true,"due":"2026-03-15"},
   {"text":"Update safeguarding policy and circulate for staff signatures","done":false,"due":"2026-04-01"},
   {"text":"Deliver internal quiz and record scores","done":false,"due":"2026-04-15"},
   {"text":"Review and close action plan — report to Ofsted self-evaluation","done":false,"due":"2026-04-30"}]'::jsonb,
 1),

('Improve parental engagement in learning',
 'Partnerships', 'medium', 'not_started', 2,
 'Parent engagement surveys show only 45% of parents feel well-informed about their child''s EYFS learning. Target 75%+ by summer.',
 'Parent engagement survey score increases to 75%+. 60%+ of parents contribute a ''learning at home'' observation per term.',
 CURRENT_DATE + 90,
 '[{"text":"Send parent engagement survey (baseline)","done":false,"due":"2026-04-15"},
   {"text":"Launch ''Learning at Home'' observation postcard scheme","done":false,"due":"2026-04-22"},
   {"text":"Host parent workshop: Understanding the EYFS","done":false,"due":"2026-05-01"},
   {"text":"Publish first edition of Wren newsletter to all parents","done":false,"due":"2026-05-15"},
   {"text":"Analyse survey results and share with staff","done":false,"due":"2026-06-15"}]'::jsonb,
 1),

('Staff wellbeing and retention initiative',
 'HR', 'medium', 'in_progress', 5,
 'Staff turnover last year was 25%. A structured wellbeing programme and clearer CPD pathways are expected to improve retention.',
 'Staff satisfaction survey score >7/10. Zero unplanned leavers in summer term. All staff have individual CPD plans.',
 CURRENT_DATE + 75,
 '[{"text":"Deliver staff wellbeing survey","done":true,"due":"2026-03-01"},
   {"text":"Create individual CPD plans with all staff in supervision","done":true,"due":"2026-03-31"},
   {"text":"Introduce flexible rota options for part-time staff","done":false,"due":"2026-04-14"},
   {"text":"Schedule monthly team lunch (informal wellbeing time)","done":false,"due":"2026-04-30"},
   {"text":"Repeat wellbeing survey and compare","done":false,"due":"2026-06-30"}]'::jsonb,
 5);

-- ═══════════════════════════════════════════════════════════════════════════
-- SUPERVISIONS — one per active staff member this term
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO supervisions
  (staff_id, supervisor_id, scheduled_date, conducted_date, status,
   wellbeing_score, discussion_notes, agreed_targets, manager_notes, type)
VALUES
(2, 1, CURRENT_DATE-30, CURRENT_DATE-29, 'completed', 8,
 'Sophie discussed the new outdoor environment project with enthusiasm. She raised a concern about ratios during outdoor sessions when staff are on breaks — noted and action to be taken.',
 '[{"target":"Complete outdoor audit by 15 March","due":"2026-03-15"},{"target":"Attend outdoor pedagogy CPD","due":"2026-04-30"}]'::jsonb,
 'Sophie is performing well. Strong room leader. Watch ratios issue — escalate if it recurs.', 'supervision'),

(3, 5, CURRENT_DATE-28, CURRENT_DATE-27, 'completed', 9,
 'Hannah is enjoying working with the younger babies. She mentioned she is keen to extend her NVQ to Level 4. Discussed pathway options.',
 '[{"target":"Research Level 4 EYP qualification options","due":"2026-04-01"},{"target":"Complete SEND awareness online module","due":"2026-03-31"}]'::jsonb,
 'Strong practitioner. Support Level 4 application — discuss funding options with manager.', 'supervision'),

(4, 5, CURRENT_DATE-25, CURRENT_DATE-24, 'completed', 7,
 'Jake reported feeling stretched on the days he covers both baby and toddler rooms. Acknowledged he likes the variety but would benefit from clearer daily allocation.',
 '[{"target":"Work with manager to agree consistent daily rota","due":"2026-03-25"},{"target":"Complete first aid refresher","due":"2026-04-15"}]'::jsonb,
 'Good attitude. Rota ambiguity is genuine — review deployment schedule.', 'supervision'),

(6, 1, CURRENT_DATE-22, CURRENT_DATE-21, 'completed', 8,
 'Lucy described a positive term. She has been leading the phonics planning for pre-school and is proud of early results. No concerns raised.',
 '[{"target":"Deliver phonics parent workshop in May","due":"2026-05-01"},{"target":"Peer-observe Sophie in pre-school this term","due":"2026-04-30"}]'::jsonb,
 'Lucy is thriving as a phonics lead. Explore promotion pathway.', 'supervision'),

(7, 1, CURRENT_DATE-20, CURRENT_DATE-19, 'completed', 7,
 'Callum is settling in well after joining in September. He flagged that the toddler room resource audit is overdue — agreed this is a priority.',
 '[{"target":"Complete toddler room resource audit","due":"2026-03-31"},{"target":"Attend Heuristic Play CPD","due":"2026-04-15"}]'::jsonb,
 'Good integration. Proactive attitude. Support with audit.', 'supervision'),

(8, 5, CURRENT_DATE-18, CURRENT_DATE-17, 'completed', 9,
 'Priya is very positive. She mentioned she enjoys working with the toddler group particularly. Wellbeing score high — no concerns.',
 '[{"target":"Lead treasure basket observations this half term","due":"2026-04-01"},{"target":"Complete EYFS refresher module","due":"2026-04-30"}]'::jsonb,
 'Very strong early-career practitioner. Consider mentoring role for new staff.', 'supervision'),

(10, 5, CURRENT_DATE-15, CURRENT_DATE-14, 'completed', 6,
 'Practitioner Demo mentioned feeling uncertain about how much written observation work is expected. Agreed clearer guidance and a reduced observation target for this half term while settling in.',
 '[{"target":"Complete 3 observations per week for first half term","due":"2026-04-30"},{"target":"Attend internal pedagogy session","due":"2026-04-15"}]'::jsonb,
 'Needs support with documentation expectations. Schedule check-in in 4 weeks.', 'supervision'),

(11, 1, CURRENT_DATE-12, CURRENT_DATE-11, 'completed', 8,
 'Grace reported a positive term. She raised a question about the new curriculum planning format — unsure which template to use. Clarified immediately.',
 '[{"target":"Use updated weekly plan template from shared drive","due":"2026-03-18"},{"target":"Observe Sophie delivering phonics session","due":"2026-03-31"}]'::jsonb,
 'Settling in well. Practical and positive. Small guidance on documentation needed.', 'supervision'),

(12, 1, CURRENT_DATE-10, CURRENT_DATE-9, 'completed', 8,
 'Tom is managing admin workload well. He flagged that the invoice reconciliation process is slow without a batch payment view — will look at Wren Finance tab functionality.',
 '[{"target":"Trial new finance dashboard for invoice reconciliation","due":"2026-03-31"},{"target":"Update parent contact details database","due":"2026-04-15"}]'::jsonb,
 'Tom is a strong admin. Finance dashboard feedback flagged for product team.', 'supervision');

-- ═══════════════════════════════════════════════════════════════════════════
-- CPD RECORDS
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO cpd_records
  (staff_id, course_name, provider, completion_date, expiry_date,
   is_mandatory, hours, notes)
VALUES
-- Mandatory
(1, 'Designated Safeguarding Lead (DSL) Level 3',  'EALING LSCB',          '2024-09-01','2026-09-01',true,  6, 'Refreshed DSL status. Certificate filed.'),
(1, 'Paediatric First Aid',                         'St John Ambulance',    '2024-03-15','2027-03-15',true, 12, 'Full 2-day course. Certificate in staff file.'),
(1, 'GDPR for Education Settings',                  'NCFE Online',          '2025-01-10', NULL,        true,  2, 'Annual refresher completed online.'),
(5, 'Safeguarding Level 2',                         'EALING LSCB',          '2024-10-01','2026-10-01',true,  3, 'Completed online. Score: 94%.'),
(5, 'Paediatric First Aid',                         'St John Ambulance',    '2023-11-20','2026-11-20',true, 12, NULL),
(2, 'Safeguarding Level 2',                         'EALING LSCB',          '2025-01-15','2027-01-15',true,  3, NULL),
(2, 'Paediatric First Aid',                         'St John Ambulance',    '2024-06-10','2027-06-10',true, 12, NULL),
(3, 'Safeguarding Level 2',                         'EALING LSCB',          '2025-02-01','2027-02-01',true,  3, NULL),
(3, 'Paediatric First Aid',                         'Heartstart UK',        '2024-09-05','2027-09-05',true, 12, NULL),
(4, 'Safeguarding Level 2',                         'EALING LSCB',          '2024-11-10','2026-11-10',true,  3, NULL),
(4, 'Paediatric First Aid',                         'St John Ambulance',    '2023-09-12','2026-09-12',true, 12, NULL),
(6, 'Safeguarding Level 2',                         'EALING LSCB',          '2025-01-20','2027-01-20',true,  3, NULL),
(6, 'Paediatric First Aid',                         'Heartstart UK',        '2024-07-01','2027-07-01',true, 12, NULL),
(7, 'Safeguarding Level 2',                         'EALING LSCB',          '2024-10-08','2026-10-08',true,  3, NULL),
(7, 'Paediatric First Aid',                         'St John Ambulance',    '2024-01-15','2027-01-15',true, 12, NULL),
(8, 'Safeguarding Level 2',                         'EALING LSCB',          '2025-03-01','2027-03-01',true,  3, NULL),
(8, 'Paediatric First Aid',                         'Heartstart UK',        '2025-02-10','2028-02-10',true, 12, NULL),
-- CPD / professional development
(1, 'Leading Improvement in Early Years',           'SSAT National',        '2025-03-10', NULL,        false,  8, 'Highly recommended. Action plan template shared with staff.'),
(1, 'EYFS Framework Update 2024',                   'DfE Webinar',          '2024-09-05', NULL,        false,  1, NULL),
(2, 'Heuristic Play and Schema Theory',             'EALING Early Years Hub','2025-02-14',NULL,        false,  3, 'Inspired outdoor resource changes.'),
(3, 'SEND in the Early Years',                      'nasen Online',         '2025-01-18', NULL,        false,  4, NULL),
(5, 'Attachment and Trauma-Informed Practice',      'CAMHS Partnership',    '2024-11-22', NULL,        false,  6, 'Excellent. Informed supervision approach.'),
(6, 'Read Write Inc. Phonics Level 1',              'Ruth Miskin Training',  '2024-09-12',NULL,        false,  7, 'Now leading phonics provision. Certificate in CPD folder.'),
(7, 'Key Person Approach in Practice',              'EALING Early Years Hub','2025-01-30',NULL,        false,  3, NULL),
(11,'EYFS Refresher — Expressive Arts and Design',  'Online CPD Bank',      '2025-03-15', NULL,        false,  2, NULL);

SELECT setval(pg_get_serial_sequence('cpd_records','id'), (SELECT MAX(id) FROM cpd_records) + 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- STAFF COMPLIANCE (DBS, qualifications, references)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO staff_compliance (staff_id, check_type, issued_date, expiry_date, status, notes)
VALUES
(1, 'DBS Enhanced',      '2024-01-10','2027-01-10','valid',   'Update service — cert number in staff file'),
(1, 'Right to Work',     '2019-09-01', NULL,        'valid',   'UK passport verified'),
(1, 'Level 5 EYP',       '2018-07-01', NULL,        'valid',   'Foundation Degree + EYPS'),
(2, 'DBS Enhanced',      '2024-06-15','2027-06-15','valid',   NULL),
(2, 'Right to Work',     '2020-04-01', NULL,        'valid',   'UK passport'),
(2, 'Level 3 EYE',       '2019-06-01', NULL,        'valid',   'CACHE Level 3'),
(3, 'DBS Enhanced',      '2023-11-20','2026-11-20','expiring', 'Due for renewal — book within 4 weeks'),
(3, 'Right to Work',     '2021-09-01', NULL,        'valid',   'UK passport'),
(3, 'Level 3 EYE',       '2021-07-01', NULL,        'valid',   NULL),
(4, 'DBS Enhanced',      '2024-03-10','2027-03-10','valid',   NULL),
(4, 'Right to Work',     '2022-06-01', NULL,        'valid',   'UK passport'),
(4, 'Level 2 EYE',       '2022-07-01', NULL,        'valid',   'Working towards Level 3'),
(5, 'DBS Enhanced',      '2023-08-25','2026-08-25','expiring', 'Due Q3 2026 — calendar reminder set'),
(5, 'Right to Work',     '2020-01-06', NULL,        'valid',   NULL),
(5, 'Level 4 EYP',       '2019-09-01', NULL,        'valid',   'Foundation Degree'),
(6, 'DBS Enhanced',      '2024-01-14','2027-01-14','valid',   NULL),
(6, 'Right to Work',     '2022-09-01', NULL,        'valid',   NULL),
(6, 'Level 3 EYE',       '2022-07-01', NULL,        'valid',   'BTEC Level 3'),
(7, 'DBS Enhanced',      '2023-10-05','2026-10-05','valid',   NULL),
(7, 'Right to Work',     '2021-04-01', NULL,        'valid',   NULL),
(7, 'Level 3 EYE',       '2020-07-01', NULL,        'valid',   NULL),
(8, 'DBS Enhanced',      '2024-02-28','2027-02-28','valid',   NULL),
(8, 'Right to Work',     '2023-01-09', NULL,        'valid',   'Passport + BRP verified'),
(8, 'Level 2 EYE',       '2023-07-01', NULL,        'valid',   'Working towards Level 3 — enrolment confirmed'),
(11,'DBS Enhanced',      '2023-09-30','2026-09-30','valid',   NULL),
(11,'Right to Work',     '2023-09-01', NULL,        'valid',   NULL),
(12,'DBS Enhanced',      '2023-12-15','2026-12-15','valid',   NULL),
(12,'Right to Work',     '2024-01-08', NULL,        'valid',   NULL);

-- ═══════════════════════════════════════════════════════════════════════════
-- ABSENCE REQUESTS
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO absence_requests
  (staff_id, start_date, end_date, absence_type, status, duration_days, notes, approved_by)
VALUES
(3,  CURRENT_DATE-20, CURRENT_DATE-18, 'holiday',      'approved', 3, 'Annual leave — pre-booked',            1),
(4,  CURRENT_DATE-14, CURRENT_DATE-14, 'sick',         'approved', 1, 'Self-certified — stomach bug',         5),
(6,  CURRENT_DATE-30, CURRENT_DATE-28, 'holiday',      'approved', 3, 'Annual leave — family holiday',        1),
(7,  CURRENT_DATE-10, CURRENT_DATE-10, 'sick',         'approved', 1, 'Self-certified — migraine',            5),
(2,  CURRENT_DATE+14, CURRENT_DATE+16, 'holiday',      'approved', 3, 'Annual leave — booked in advance',     1),
(8,  CURRENT_DATE+7,  CURRENT_DATE+7,  'medical',      'pending',  1, 'Hospital appointment — morning only',  NULL),
(11, CURRENT_DATE-5,  CURRENT_DATE-5,  'emergency',    'approved', 1, 'Family emergency — approved same day', 5),
(4,  CURRENT_DATE-60, CURRENT_DATE-56, 'holiday',      'approved', 5, 'Annual leave — summer block',          1);

-- ═══════════════════════════════════════════════════════════════════════════
-- CURRICULUM PLANS — spring term, all 3 rooms
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO curriculum_plans
  (room_id, staff_id, title, term, week_number, week_start, status, theme,
   published_to_parents, created_at)
VALUES
(1, 3, 'Spring Term Week 1 — Baby Room',       'Spring', 1, CURRENT_DATE-35, 'published', 'Our Senses',        true,  NOW()-'35 days'::interval),
(1, 3, 'Spring Term Week 2 — Baby Room',       'Spring', 2, CURRENT_DATE-28, 'published', 'Water and Bubbles', true,  NOW()-'28 days'::interval),
(1, 3, 'Spring Term Week 3 — Baby Room',       'Spring', 3, CURRENT_DATE-21, 'published', 'Animals and Sounds',true,  NOW()-'21 days'::interval),
(1, 4, 'Spring Term Week 4 — Baby Room',       'Spring', 4, CURRENT_DATE-14, 'published', 'Spring is Coming',  true,  NOW()-'14 days'::interval),
(1, 3, 'Spring Term Week 5 — Baby Room',       'Spring', 5, CURRENT_DATE-7,  'draft',     'Growing Things',    false, NOW()-'7 days'::interval),
(2, 2, 'Spring Term Week 1 — Pre-school',      'Spring', 1, CURRENT_DATE-35, 'published', 'People Who Help Us',true,  NOW()-'35 days'::interval),
(2, 2, 'Spring Term Week 2 — Pre-school',      'Spring', 2, CURRENT_DATE-28, 'published', 'Traditional Tales', true,  NOW()-'28 days'::interval),
(2, 6, 'Spring Term Week 3 — Pre-school',      'Spring', 3, CURRENT_DATE-21, 'published', 'Growth and Change', true,  NOW()-'21 days'::interval),
(2, 2, 'Spring Term Week 4 — Pre-school',      'Spring', 4, CURRENT_DATE-14, 'published', 'Space Explorers',   true,  NOW()-'14 days'::interval),
(2, 2, 'Spring Term Week 5 — Pre-school',      'Spring', 5, CURRENT_DATE-7,  'review',    'Minibeasts',        false, NOW()-'7 days'::interval),
(3, 7, 'Spring Term Week 1 — Toddlers',        'Spring', 1, CURRENT_DATE-35, 'published', 'Me and My Body',    true,  NOW()-'35 days'::interval),
(3, 7, 'Spring Term Week 2 — Toddlers',        'Spring', 2, CURRENT_DATE-28, 'published', 'Colours Everywhere',true,  NOW()-'28 days'::interval),
(3, 8, 'Spring Term Week 3 — Toddlers',        'Spring', 3, CURRENT_DATE-21, 'published', 'In the Garden',     true,  NOW()-'21 days'::interval),
(3, 7, 'Spring Term Week 4 — Toddlers',        'Spring', 4, CURRENT_DATE-14, 'published', 'Transport',         true,  NOW()-'14 days'::interval),
(3, 7, 'Spring Term Week 5 — Toddlers',        'Spring', 5, CURRENT_DATE-7,  'draft',     'Animals',           false, NOW()-'7 days'::interval);

SELECT setval(pg_get_serial_sequence('curriculum_plans','id'), (SELECT MAX(id) FROM curriculum_plans) + 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- WEEKLY PLANS (curriculum activities grid)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO weekly_plans
  (room_id, week_commencing, theme, day, activity_type, activity_title,
   role_of_adult, staff_id, resources, eyfs_areas, ai_generated, created_by)
SELECT
  rm.room_id,
  CURRENT_DATE - '28 days'::interval AS week_commencing,
  rm.theme,
  dy.day,
  at.activity_type,
  at.title,
  'Facilitate and observe',
  rm.staff_id,
  at.resources,
  at.areas::text[],
  false,
  rm.staff_id
FROM
  (VALUES
    (1,'Water and Bubbles',3),
    (2,'Traditional Tales',2),
    (3,'Colours Everywhere',7)
  ) AS rm(room_id, theme, staff_id),
  (VALUES ('Monday'),('Tuesday'),('Wednesday'),('Thursday'),('Friday')) AS dy(day),
  (VALUES
    ('continuous','Child-initiated exploration',   'Sand/water tray, loose parts',         ARRAY['Understanding the World','Physical Development']),
    ('adult_led', 'Focused phonics/language group','Phonic cards, story props',             ARRAY['Literacy','Communication and Language']),
    ('outdoor',   'Outdoor investigation',         'Clipboards, magnifiers, bug pots',      ARRAY['Understanding the World','Physical Development']),
    ('creative',  'Creative arts session',         'Paint, collage materials',              ARRAY['Expressive Arts and Design']),
    ('maths',     'Maths games and number play',   'Numicon, counting collections',         ARRAY['Mathematics'])
  ) AS at(activity_type, title, resources, areas);

SELECT setval(pg_get_serial_sequence('weekly_plans','id'), (SELECT MAX(id) FROM weekly_plans) + 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- MESSAGE THREADS & MESSAGES (parent comms)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO message_threads (child_id, subject, last_message_at, recipient_type)
VALUES
(1,  'Learning update — Spring term',   NOW()-'1 day'::interval,   'parent'),
(2,  'Phonics progress query',          NOW()-'3 days'::interval,  'parent'),
(3,  'Settling in check',               NOW()-'5 days'::interval,  'parent'),
(11, 'Baby room update — this week',    NOW()-'2 days'::interval,  'parent'),
(12, 'Walking milestone!',              NOW()-'1 day'::interval,   'parent'),
(21, 'Toddler transition discussion',   NOW()-'7 days'::interval,  'parent'),
(26, 'Pre-school ready assessment',     NOW()-'4 days'::interval,  'parent'),
(28, 'Number work at home ideas',       NOW()-'6 days'::interval,  'parent'),
(7,  'Early Help referral update',      NOW()-'8 days'::interval,  'parent'),
(14, 'Settling-in concern — follow up', NOW()-'3 days'::interval,  'parent');

SELECT setval(pg_get_serial_sequence('message_threads','id'), (SELECT MAX(id) FROM message_threads) + 1);

INSERT INTO messages (thread_id, sender_type, sender_id, parent_email, body, is_read, created_at)
VALUES
-- Thread 1 — child 1 learning update
(1,'staff', 3, 'parent@demo.wren',
 'Hi Amelia''s family — just a quick update to say Amelia has been making wonderful progress this week! She read her first decodable book independently today and was absolutely beaming. We''re so proud of her. We''ve sent a short video to the app.',
 true, NOW()-'2 days'::interval),
(1,'parent',NULL,'parent@demo.wren',
 'Thank you so much! She has been practising at home too — reading everything she can see. Such a proud moment. 😊',
 true, NOW()-'1 day'::interval),

-- Thread 2 — Noah phonics
(2,'parent',NULL,'parent@demo.wren',
 'Hello — I was wondering how Noah is getting on with his phonics? He seems to be enjoying it at home but struggles with blending. Any tips?',
 true, NOW()-'4 days'::interval),
(2,'staff', 6, 'parent@demo.wren',
 'Hi there! Noah is doing really well — he knows all his Phase 1 phonemes securely. For blending at home, try the ''sound talk'' game: say words in robot sounds (c-a-t) and ask him to say the word. Keep it playful and short! Happy to show you at pick-up.',
 true, NOW()-'3 days'::interval),

-- Thread 4 — Leo baby room update
(4,'staff', 3, 'parent@demo.wren',
 'A lovely week for Leo! He is really enjoying the heuristic basket and has been showing great cause-and-effect understanding — banging objects and watching what happens. He also took his first unaided steps this morning! 🎉 Video attached.',
 true, NOW()-'2 days'::interval),
(4,'parent',NULL,'parent@demo.wren',
 'Oh my goodness!! We have been waiting for this! Thank you so much for catching it on camera. We are so thrilled.',
 false, NOW()-'1 day'::interval),

-- Thread 5 — Freya walking
(5,'staff', 4, 'parent@demo.wren',
 'Freya walked today! Eight full steps unaided — she was so proud of herself. We captured it on camera and will share it via the app this afternoon. What an exciting milestone!',
 true, NOW()-'1 day'::interval),

-- Thread 7 — Reuben school ready
(7,'staff', 2, 'parent@demo.wren',
 'As we approach the summer term, I wanted to share how well Reuben is progressing. He is meeting or exceeding expected levels in all EYFS areas. We''d love to arrange a meeting to talk about his transition to Reception — are you free in the next two weeks?',
 false, NOW()-'4 days'::interval),

-- Thread 9 — early help update
(9,'staff', 5, 'parent@demo.wren',
 'I wanted to give you a brief update on our Early Help discussions. The CAF assessment has been opened and we have a named Early Help worker who will contact you this week. Please don''t hesitate to call me if you have any questions.',
 true, NOW()-'8 days'::interval),
(9,'parent',NULL,'parent@demo.wren',
 'Thank you for letting me know. I appreciate all the support. I will look out for their call.',
 true, NOW()-'7 days'::interval);

SELECT setval(pg_get_serial_sequence('messages','id'), (SELECT MAX(id) FROM messages) + 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- NEWSLETTERS (2 sent this term)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO newsletters (title, term, status, sent_by, sent_at)
VALUES
('Spring Newsletter — February 2026', 'Spring 2026', 'sent',  1, NOW()-'42 days'::interval),
('Spring Newsletter — March 2026',    'Spring 2026', 'sent',  1, NOW()-'14 days'::interval),
('Summer Term Preview — April 2026',  'Summer 2026', 'draft', 5, NULL);

-- ═══════════════════════════════════════════════════════════════════════════
-- BEHAVIOUR LOG (positive recognition + a few entries to note)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO behaviour_log
  (child_id, staff_id, log_date, behaviour_type, category, description,
   points, parent_notified)
VALUES
(26, 2,  CURRENT_DATE-10, 'positive', 'Kindness',         'Reuben comforted a younger child who was upset at drop-off — unprompted and sustained for several minutes.',         5, true),
(28, 6,  CURRENT_DATE-8,  'positive', 'Curiosity',        'Casper spent 20 minutes independently investigating floating/sinking with different objects, recording his findings.',  4, true),
(21, 7,  CURRENT_DATE-7,  'positive', 'Perseverance',     'Poppy attempted the puzzle 4 times before completing it and celebrated with a fist pump!',                            3, true),
(27, 2,  CURRENT_DATE-6,  'positive', 'Sharing',          'Margot offered her favourite crayon to a peer who was looking for red — without any adult prompt.',                    3, true),
(3,  7,  CURRENT_DATE-5,  'negative', 'Emotional regulation', 'Isla became distressed when her construction was dismantled by a peer. Supported to use words to express feelings. Key person to monitor.',  0, true),
(22, 8,  CURRENT_DATE-4,  'positive', 'Communication',    'Milo asked for help using a full sentence today: "Can you help me please?" — a big step forward in communication.',    4, true),
(6,  6,  CURRENT_DATE-3,  'positive', 'Independence',     'Ethan tidied away his place at lunch entirely independently and reminded three peers to do the same.',                 3, true),
(30, 2,  CURRENT_DATE-2,  'positive', 'Creativity',       'Felix created a detailed story map independently, adding five scenes and narrating each one to his key person.',        5, true),
(7,  7,  CURRENT_DATE-2,  'negative', 'Separation anxiety','Sophie B. had difficulty separating from her parent today — third consecutive morning. Key person to speak with parent at collection.',  0, false),
(29, 11, CURRENT_DATE-1,  'positive', 'Maths thinking',   'Elara sorted a collection of objects by two attributes (colour AND size) independently — emerging logical classification.',  4, true);

-- ═══════════════════════════════════════════════════════════════════════════
-- INCIDENTS (operations)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO incidents
  (child_id, reported_by, incident_date, incident_type, description,
   first_aid_given, parent_notified, parent_notified_at, witness_name, status)
VALUES
(2, 3, CURRENT_DATE-14, 'Minor injury',
 'Noah bumped his head on the edge of the table while standing up quickly. Small red mark above right eyebrow. Ice pack applied for 5 minutes. Child settled immediately.',
 'Ice pack applied for 5 minutes. Child observed throughout session. Mark had faded by end of day.',
 true, NOW()-'14 days'::interval, 'Hannah Moore', 'closed'),

(11,4, CURRENT_DATE-8,  'Minor injury',
 'Leo crawled into the door frame and bumped his forehead. Small graze visible. Cleaned with sterile wipe and barrier cream applied.',
 'First aid applied. Graze cleaned and dressed.',
 true, NOW()-'8 days'::interval, 'Jake Peters', 'closed'),

(3, 7, CURRENT_DATE-5,  'Near miss',
 'Isla ran towards the gate as it was opened for a parent — gate closed before she reached it. No injury sustained.',
 'N/A — no injury.',
 false, NOW()-'5 days'::interval, 'Callum Fraser', 'closed'),

(26,2, CURRENT_DATE-3,  'Minor injury',
 'Reuben slipped on the outdoor rubber surface during water play and grazed his palm. Cleaned and dressed with plaster.',
 'Palm cleaned with sterile wipe. Plaster applied.',
 true, NOW()-'3 days'::interval, 'Lucy Hammond', 'closed');

-- ═══════════════════════════════════════════════════════════════════════════
-- ENQUIRIES (admissions pipeline) — vary stages for funnel view
-- ═══════════════════════════════════════════════════════════════════════════
-- Clear and re-seed to ensure fresh pipeline data
DELETE FROM enquiries;

INSERT INTO enquiries
  (child_first_name, child_last_name, child_dob, room_needed,
   parent_name, parent_email, parent_phone, source, stage,
   preferred_start_date, preferred_days, funded_hours_type,
   ai_score, notes, created_at)
VALUES
-- New / initial enquiry
('Aya',     'Hashimoto',  '2024-08-10', 'Baby Room',   'Yuki Hashimoto',   'parent@demo.wren','07700 900201','Website referral','new',          '2026-09-01', ARRAY['Mon','Tue','Wed','Thu'], '15hr', 72, NULL, NOW()-'2 days'::interval),
('Leon',    'Dubois',     '2024-06-22', 'Baby Room',   'Claire Dubois',    'parent@demo.wren','07700 900202','Social media',    'new',          '2026-09-01', ARRAY['Tue','Wed','Thu'],       '15hr', 68, NULL, NOW()-'3 days'::interval),
('Cece',    'Okafor',     '2023-11-15', 'Toddlers',    'Nkem Okafor',      'parent@demo.wren','07700 900203','Word of mouth',   'enquiry',      '2026-05-01', ARRAY['Mon','Tue','Wed','Thu','Fri'],'30hr',81,NULL, NOW()-'1 day'::interval),
-- Tour booked
('Matteo',  'Ferrari',    '2023-09-04', 'Toddlers',    'Giulia Ferrari',   'parent@demo.wren','07700 900204','Google',          'tour_booked',  '2026-06-01', ARRAY['Mon','Wed','Fri'],       '15hr', 74, 'Tour booked for 14/05 at 10:30', NOW()-'5 days'::interval),
('Seren',   'Price',      '2022-12-01', 'Pre-school',  'Nia Price',        'parent@demo.wren','07700 900205','Nursery direct',  'tour_booked',  '2026-05-06', ARRAY['Mon','Tue','Wed','Thu','Fri'],'30hr',90,'Highly motivated family. Sibling already at nursery.', NOW()-'7 days'::interval),
('Tobias',  'Bauer',      '2023-03-18', 'Toddlers',    'Anna Bauer',       'parent@demo.wren','07700 900206','Childcare choices','enquiry',     '2026-09-01', ARRAY['Mon','Tue','Wed'],       '15hr', 65, NULL, NOW()-'6 days'::interval),
-- Tour done / viewing booked
('Amara',   'Diallo',     '2022-10-25', 'Pre-school',  'Fatou Diallo',     'parent@demo.wren','07700 900207','Word of mouth',   'viewing_booked','2026-05-19',ARRAY['Mon','Tue','Wed','Thu','Fri'],'30hr',88,'Tour done 06/05. Parent very keen — offer discussion next.', NOW()-'10 days'::interval),
('Ezra',    'Solomon',    '2023-07-08', 'Toddlers',    'Ruth Solomon',     'parent@demo.wren','07700 900208','Website',         'tour_done',    '2026-06-02', ARRAY['Tue','Thu'],             '15hr', 71, 'Tour completed 05/05. Following up this week.', NOW()-'9 days'::interval),
('Nadia',   'Petrov',     '2024-01-30', 'Baby Room',   'Irina Petrov',     'parent@demo.wren','07700 900209','Google',          'tour_booked',  '2026-09-01', ARRAY['Mon','Tue','Wed','Thu'], '15hr', 69, 'Tour booked 15/05 at 11am.', NOW()-'8 days'::interval),
-- Offer made / waiting list
('Lyra',    'Osei',       '2022-08-14', 'Pre-school',  'Kwame Osei',       'parent@demo.wren','07700 900210','Word of mouth',   'offer_made',   '2026-05-06', ARRAY['Mon','Tue','Wed','Thu','Fri'],'30hr',95,'Offer letter sent 02/05. Awaiting signed acceptance.', NOW()-'15 days'::interval),
('James',   'Thornton',   '2023-05-21', 'Toddlers',    'Sarah Thornton',   'parent@demo.wren','07700 900211','Website',         'offer_made',   '2026-06-02', ARRAY['Mon','Wed','Fri'],       NULL,  77, 'Offer sent 29/04.', NOW()-'12 days'::interval),
-- Registered / active
('Isla',    'Mehta',      '2022-11-10', 'Pre-school',  'Priya Mehta',      'parent@demo.wren','07700 900212','Sibling',         'registered',   '2026-05-19', ARRAY['Mon','Tue','Wed','Thu','Fri'],'30hr',92,'Contract signed. Start date confirmed.', NOW()-'20 days'::interval),
('Noah',    'Laurent',    '2024-03-05', 'Baby Room',   'Sophie Laurent',   'parent@demo.wren','07700 900213','Word of mouth',   'registered',   '2026-09-01', ARRAY['Mon','Tue','Wed'],       '15hr', 84, 'Contract signed. September start.', NOW()-'18 days'::interval),
-- Lost / declined
('Harry',   'Singh',      '2023-02-17', 'Toddlers',    'Gurpreet Singh',   'parent@demo.wren','07700 900214','Google',          'lost',         NULL,         ARRAY['Mon','Tue'],             '15hr', 60, NULL, NOW()-'25 days'::interval),
('Ella',    'Novak',      '2022-07-03', 'Pre-school',  'Jana Novak',       'parent@demo.wren','07700 900215','Childcare choices','declined',    NULL,         ARRAY['Mon','Tue','Wed','Thu','Fri'],'30hr',55,NULL, NOW()-'30 days'::interval);

SELECT setval(pg_get_serial_sequence('enquiries','id'), (SELECT COALESCE(MAX(id),0)+1 FROM enquiries));

-- ═══════════════════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  'demo_eyfs seed complete' AS status,
  (SELECT COUNT(*) FROM children)         AS children,
  (SELECT COUNT(*) FROM staff)            AS staff,
  (SELECT COUNT(*) FROM rooms)            AS rooms,
  (SELECT COUNT(*) FROM observations)     AS observations,
  (SELECT COUNT(*) FROM daily_diary)      AS diary_entries,
  (SELECT COUNT(*) FROM attendance)       AS attendance_rows,
  (SELECT COUNT(*) FROM invoices)         AS invoices,
  (SELECT COUNT(*) FROM action_plans)     AS action_plans,
  (SELECT COUNT(*) FROM supervisions)     AS supervisions,
  (SELECT COUNT(*) FROM cpd_records)      AS cpd_records,
  (SELECT COUNT(*) FROM safeguarding_concerns) AS safeguarding,
  (SELECT COUNT(*) FROM message_threads)  AS message_threads,
  (SELECT COUNT(*) FROM enquiries)        AS enquiries;

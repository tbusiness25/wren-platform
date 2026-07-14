-- Create schemas for each edition + production
CREATE SCHEMA IF NOT EXISTS ladn;
CREATE SCHEMA IF NOT EXISTS demo_eyfs;
CREATE SCHEMA IF NOT EXISTS demo_primary;
CREATE SCHEMA IF NOT EXISTS demo_secondary;

-- Function to create all tables in a given schema
CREATE OR REPLACE FUNCTION create_wren_tables(schema_name TEXT) RETURNS void AS $$
DECLARE
  s TEXT := schema_name;
BEGIN
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      min_age_months INT DEFAULT 0,
      max_age_months INT DEFAULT 216,
      capacity INT DEFAULT 30,
      year_group TEXT,
      key_stage TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.staff (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      preferred_name TEXT,
      email TEXT UNIQUE,
      phone TEXT,
      role TEXT NOT NULL DEFAULT ''practitioner''
        CHECK (role IN (''manager'',''deputy_manager'',''room_leader'',''practitioner'',''apprentice'',''admin'',''cook'')),
      room_id INT REFERENCES %I.rooms(id),
      pin_hash TEXT,
      employment_type TEXT DEFAULT ''permanent'',
      contracted_hours NUMERIC(5,2),
      contract_start DATE,
      contract_end DATE,
      is_active BOOLEAN DEFAULT true,
      address_line1 TEXT,
      address_line2 TEXT,
      postcode TEXT,
      date_of_birth DATE,
      ni_number TEXT,
      dbs_number TEXT,
      dbs_expiry DATE,
      emergency_contact_name TEXT,
      emergency_contact_phone TEXT,
      emergency_contact_relation TEXT,
      profile_photo TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.children (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      preferred_name TEXT,
      date_of_birth DATE,
      room_id INT REFERENCES %I.rooms(id),
      key_person_id INT REFERENCES %I.staff(id),
      year_group TEXT,
      is_active BOOLEAN DEFAULT true,
      start_date DATE,
      leave_date DATE,
      photo_url TEXT,
      photo_consent BOOLEAN DEFAULT false,
      media_consent BOOLEAN DEFAULT false,
      parent_1_name TEXT,
      parent_1_email TEXT,
      parent_1_phone TEXT,
      parent_2_name TEXT,
      parent_2_email TEXT,
      parent_2_phone TEXT,
      emergency_contact_1_name TEXT,
      emergency_contact_1_phone TEXT,
      emergency_contact_1_relation TEXT,
      emergency_contact_2_name TEXT,
      emergency_contact_2_phone TEXT,
      address_line1 TEXT,
      postcode TEXT,
      gp_name TEXT,
      gp_phone TEXT,
      nhs_number TEXT,
      allergies TEXT,
      dietary_requirements TEXT,
      medical_notes TEXT,
      send_needs BOOLEAN DEFAULT false,
      looked_after BOOLEAN DEFAULT false,
      pupil_premium BOOLEAN DEFAULT false,
      funded_hours NUMERIC(5,2) DEFAULT 0,
      funded_hours_type TEXT,
      collection_password TEXT,
      ethnicity TEXT,
      religion TEXT,
      home_language TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.attendance (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      session TEXT DEFAULT ''full_day'',
      sign_in_time TIMESTAMPTZ,
      sign_out_time TIMESTAMPTZ,
      signed_in_by INT REFERENCES %I.staff(id),
      signed_out_by INT REFERENCES %I.staff(id),
      absent BOOLEAN DEFAULT false,
      absence_reason TEXT,
      notes TEXT,
      UNIQUE(child_id, date, session)
    );

    CREATE TABLE IF NOT EXISTS %I.staff_attendance (
      id SERIAL PRIMARY KEY,
      staff_id INT REFERENCES %I.staff(id) ON DELETE CASCADE,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      clock_in TIMESTAMPTZ,
      clock_out TIMESTAMPTZ,
      source TEXT DEFAULT ''manual'',
      notes TEXT,
      UNIQUE(staff_id, date)
    );

    CREATE TABLE IF NOT EXISTS %I.observations (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      staff_id INT REFERENCES %I.staff(id),
      title TEXT,
      observation_text TEXT NOT NULL,
      observation_type TEXT DEFAULT ''learning_story''
        CHECK (observation_type IN (''learning_story'',''milestone'',''note'',''2year_check'',''assessment'')),
      eyfs_areas TEXT[],
      subject_areas TEXT[],
      photo_urls TEXT[],
      voice_note_url TEXT,
      shared_with_parents BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.daily_diary (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      staff_id INT REFERENCES %I.staff(id),
      date DATE DEFAULT CURRENT_DATE,
      mood TEXT,
      meals TEXT,
      naps TEXT,
      activities TEXT,
      notes TEXT,
      photo_urls TEXT[],
      shared_with_parents BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.sleep_checks (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      staff_id INT REFERENCES %I.staff(id),
      check_time TIMESTAMPTZ DEFAULT NOW(),
      is_sleeping BOOLEAN DEFAULT true,
      position TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.medicine_records (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      staff_id INT REFERENCES %I.staff(id),
      medicine_name TEXT NOT NULL,
      dose TEXT,
      time_given TIMESTAMPTZ,
      parent_consent BOOLEAN DEFAULT false,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.incidents (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      reported_by INT REFERENCES %I.staff(id),
      incident_date DATE DEFAULT CURRENT_DATE,
      incident_time TIME,
      incident_type TEXT,
      location TEXT,
      description TEXT,
      injury_description TEXT,
      first_aid_given TEXT,
      parent_notified BOOLEAN DEFAULT false,
      parent_notified_at TIMESTAMPTZ,
      manager_reviewed BOOLEAN DEFAULT false,
      manager_reviewed_at TIMESTAMPTZ,
      status TEXT DEFAULT ''open'',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.safeguarding_log (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id),
      reported_by INT REFERENCES %I.staff(id),
      concern_date DATE DEFAULT CURRENT_DATE,
      concern_type TEXT,
      description TEXT,
      action_taken TEXT,
      referred_to TEXT,
      status TEXT DEFAULT ''open'',
      confidential BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.absence_requests (
      id SERIAL PRIMARY KEY,
      staff_id INT REFERENCES %I.staff(id) ON DELETE CASCADE,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      absence_type TEXT,
      status TEXT DEFAULT ''pending'' CHECK (status IN (''pending'',''approved'',''declined'',''cancelled'')),
      duration_hours NUMERIC(6,2),
      duration_days NUMERIC(5,2),
      notes TEXT,
      approved_by INT REFERENCES %I.staff(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.enquiries (
      id SERIAL PRIMARY KEY,
      child_first_name TEXT,
      child_last_name TEXT,
      child_dob DATE,
      room_needed TEXT,
      start_date_requested DATE,
      parent_name TEXT,
      parent_email TEXT,
      parent_phone TEXT,
      source TEXT,
      stage TEXT DEFAULT ''enquiry''
        CHECK (stage IN (''enquiry'',''viewing_booked'',''waiting_list'',''registration'',''active'',''lost'',''withdrawn'')),
      notes TEXT,
      lost_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.waiting_list (
      id SERIAL PRIMARY KEY,
      child_first_name TEXT NOT NULL,
      child_last_name TEXT NOT NULL,
      child_dob DATE,
      room_needed TEXT,
      expected_start_date DATE,
      parent_name TEXT,
      parent_email TEXT,
      parent_phone TEXT,
      source TEXT,
      status TEXT DEFAULT ''waiting'',
      notes TEXT,
      date_added TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.parent_portal_access (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      token_hash TEXT,
      is_active BOOLEAN DEFAULT true,
      last_login TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(child_id, email)
    );

    CREATE TABLE IF NOT EXISTS %I.cpd_records (
      id SERIAL PRIMARY KEY,
      staff_id INT REFERENCES %I.staff(id) ON DELETE CASCADE,
      course_name TEXT NOT NULL,
      provider TEXT,
      completion_date DATE,
      expiry_date DATE,
      is_mandatory BOOLEAN DEFAULT false,
      hours NUMERIC(5,2),
      certificate_url TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.curriculum_plans (
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES %I.rooms(id),
      staff_id INT REFERENCES %I.staff(id),
      title TEXT,
      term TEXT,
      week_number INT,
      week_start DATE,
      status TEXT DEFAULT ''draft'',
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.phonics_tracker (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      sound TEXT NOT NULL,
      phase INT,
      status TEXT DEFAULT ''not_introduced''
        CHECK (status IN (''not_introduced'',''introduced'',''secure'',''mastered'')),
      updated_by INT REFERENCES %I.staff(id),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(child_id, sound)
    );

    CREATE TABLE IF NOT EXISTS %I.reports (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id),
      staff_id INT REFERENCES %I.staff(id),
      report_type TEXT,
      content JSONB,
      ai_generated BOOLEAN DEFAULT false,
      shared_with_parents BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- SIMS parity tables
    CREATE TABLE IF NOT EXISTS %I.safeguarding_concerns (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id),
      reported_by INT REFERENCES %I.staff(id),
      witnessed_by INT REFERENCES %I.staff(id),
      concern_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      category TEXT NOT NULL,
      subcategory TEXT,
      description TEXT NOT NULL,
      immediate_action TEXT,
      is_referral BOOLEAN DEFAULT false,
      referral_agency TEXT,
      referral_date DATE,
      referral_reference TEXT,
      is_confidential BOOLEAN DEFAULT true,
      status TEXT DEFAULT ''new''
        CHECK (status IN (''new'',''under_review'',''action_taken'',''referred'',''closed'')),
      dsl_notes TEXT,
      dsl_reviewed_by INT REFERENCES %I.staff(id),
      dsl_reviewed_at TIMESTAMPTZ,
      closed_by INT REFERENCES %I.staff(id),
      closed_at TIMESTAMPTZ,
      close_reason TEXT,
      attachments JSONB DEFAULT ''[]'',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.safeguarding_actions (
      id SERIAL PRIMARY KEY,
      concern_id INT REFERENCES %I.safeguarding_concerns(id) ON DELETE CASCADE,
      action_by INT REFERENCES %I.staff(id),
      action_text TEXT NOT NULL,
      due_date DATE,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.cp_register (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) ON DELETE CASCADE,
      plan_type TEXT NOT NULL
        CHECK (plan_type IN (''child_protection'',''child_in_need'',''lac'',''early_help'')),
      start_date DATE NOT NULL,
      review_date DATE,
      end_date DATE,
      is_active BOOLEAN DEFAULT true,
      social_worker_name TEXT,
      social_worker_email TEXT,
      social_worker_phone TEXT,
      health_visitor_name TEXT,
      notes TEXT,
      created_by INT REFERENCES %I.staff(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.safeguarding_training (
      id SERIAL PRIMARY KEY,
      staff_id INT REFERENCES %I.staff(id) ON DELETE CASCADE,
      training_type TEXT,
      completed_date DATE,
      expiry_date DATE,
      provider TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS %I.behaviour_log (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id),
      staff_id INT REFERENCES %I.staff(id),
      log_date DATE DEFAULT CURRENT_DATE,
      behaviour_type TEXT CHECK (behaviour_type IN (''positive'',''negative'')),
      category TEXT,
      description TEXT,
      points INT DEFAULT 0,
      parent_notified BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.sen_register (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id) UNIQUE,
      sen_type TEXT CHECK (sen_type IN (''ehcp'',''sen_support'',''monitoring'')),
      primary_need TEXT,
      secondary_need TEXT,
      ehcp_date DATE,
      review_date DATE,
      annual_review_date DATE,
      external_professionals JSONB DEFAULT ''[]'',
      provision_map TEXT,
      is_active BOOLEAN DEFAULT true,
      created_by INT REFERENCES %I.staff(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.assessments (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id),
      staff_id INT REFERENCES %I.staff(id),
      subject TEXT,
      assessment_date DATE DEFAULT CURRENT_DATE,
      period TEXT,
      attainment TEXT,
      attainment_value INT,
      progress TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS %I.timetable (
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES %I.rooms(id),
      staff_id INT REFERENCES %I.staff(id),
      day_of_week INT CHECK (day_of_week BETWEEN 0 AND 6),
      start_time TIME,
      end_time TIME,
      subject TEXT,
      effective_from DATE DEFAULT CURRENT_DATE,
      effective_to DATE,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS %I.exclusions (
      id SERIAL PRIMARY KEY,
      child_id INT REFERENCES %I.children(id),
      exclusion_type TEXT CHECK (exclusion_type IN (''fixed_period'',''permanent'')),
      start_date DATE,
      end_date DATE,
      reason TEXT,
      governor_review_date DATE,
      return_arrangements TEXT,
      reported_to_la BOOLEAN DEFAULT false,
      created_by INT REFERENCES %I.staff(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_%I_obs_child ON %I.observations(child_id);
    CREATE INDEX IF NOT EXISTS idx_%I_att ON %I.attendance(child_id, date);
    CREATE INDEX IF NOT EXISTS idx_%I_sleep ON %I.sleep_checks(child_id);
    CREATE INDEX IF NOT EXISTS idx_%I_staff_active ON %I.staff(is_active);
    CREATE INDEX IF NOT EXISTS idx_%I_children_active ON %I.children(is_active, room_id);
  ', s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s,
     s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s,
     s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s,
     s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s,
     s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s,
     s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s);
END;
$$ LANGUAGE plpgsql;

-- Create tables in all schemas
SELECT create_wren_tables('ladn');
SELECT create_wren_tables('demo_eyfs');
SELECT create_wren_tables('demo_primary');
SELECT create_wren_tables('demo_secondary');

SELECT 'Schema setup complete' as status;

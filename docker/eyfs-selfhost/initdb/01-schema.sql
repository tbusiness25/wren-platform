--
-- PostgreSQL database dump
--

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: demo_eyfs; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS demo_eyfs;

--
-- Extensions and shared sequences required by demo_eyfs column defaults.
-- In the original multi-tenant database these lived in a separate schema; for
-- this standalone self-host bundle they are recreated inside demo_eyfs / public
-- so the schema is fully self-contained.
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE SEQUENCE IF NOT EXISTS demo_eyfs.action_plans_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.assessments_primary_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.assessments_secondary_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.attendance_register_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.behaviour_log_primary_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.child_funding_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.first_words_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.framework_tracker_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.funding_terms_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.mandatory_training_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.menu_groups_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.menu_items_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.messages_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.message_threads_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.newsletter_sections_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.newsletters_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.observation_standards_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.outings_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.resources_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.staff_entitlement_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.supervisions_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.supervision_targets_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.survey_responses_id_seq;
CREATE SEQUENCE IF NOT EXISTS demo_eyfs.term_plans_id_seq;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: absence_requests; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.absence_requests (
    id integer NOT NULL,
    staff_id integer,
    start_date date NOT NULL,
    end_date date NOT NULL,
    absence_type text,
    status text DEFAULT 'pending'::text,
    duration_hours numeric(6,2),
    duration_days numeric(5,2),
    notes text,
    approved_by integer,
    created_at timestamp with time zone DEFAULT now(),
    request_type text DEFAULT 'holiday'::text,
    days_count numeric DEFAULT 1,
    CONSTRAINT absence_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'cancelled'::text])))
);


--
-- Name: absence_requests_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.absence_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: absence_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.absence_requests_id_seq OWNED BY demo_eyfs.absence_requests.id;


--
-- Name: action_plan_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.action_plan_audit (
    id integer NOT NULL,
    plan_id integer,
    item_id integer,
    actor_id integer,
    actor_type character varying(20),
    action character varying(40),
    before_value jsonb,
    after_value jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: action_plan_audit_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.action_plan_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: action_plan_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.action_plan_audit_id_seq OWNED BY demo_eyfs.action_plan_audit.id;


--
-- Name: action_plan_comments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.action_plan_comments (
    id integer NOT NULL,
    item_id integer,
    author_type character varying(20),
    author_id integer NOT NULL,
    body text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT action_plan_comments_author_type_check CHECK (((author_type)::text = ANY (ARRAY[('staff'::character varying)::text, ('parent'::character varying)::text, ('manager'::character varying)::text])))
);


--
-- Name: action_plan_comments_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.action_plan_comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: action_plan_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.action_plan_comments_id_seq OWNED BY demo_eyfs.action_plan_comments.id;


--
-- Name: action_plan_items; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.action_plan_items (
    id integer NOT NULL,
    plan_id integer,
    title text NOT NULL,
    description text,
    priority character varying(10) DEFAULT 'medium'::character varying,
    status character varying(15) DEFAULT 'todo'::character varying,
    deadline date,
    category character varying(80),
    tags text[],
    assigned_staff_id integer,
    "position" integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    completed_at timestamp without time zone,
    completed_by_staff_id integer,
    notify_assignee boolean DEFAULT true,
    CONSTRAINT action_plan_items_priority_check CHECK (((priority)::text = ANY (ARRAY[('high'::character varying)::text, ('medium'::character varying)::text, ('low'::character varying)::text]))),
    CONSTRAINT action_plan_items_status_check CHECK (((status)::text = ANY (ARRAY[('todo'::character varying)::text, ('in-progress'::character varying)::text, ('completed'::character varying)::text, ('blocked'::character varying)::text])))
);


--
-- Name: action_plan_items_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.action_plan_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: action_plan_items_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.action_plan_items_id_seq OWNED BY demo_eyfs.action_plan_items.id;


--
-- Name: action_plans; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.action_plans (
    id integer DEFAULT nextval('demo_eyfs.action_plans_id_seq'::regclass) NOT NULL,
    title text NOT NULL,
    area text,
    priority text DEFAULT 'medium'::text,
    status text DEFAULT 'open'::text,
    owner_staff_id integer,
    description text,
    success_criteria text,
    actions jsonb,
    target_date date,
    completed_date date,
    review_notes text,
    linked_to text,
    linked_id integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    supervision_id integer,
    progress_notes jsonb DEFAULT '[]'::jsonb,
    evidence_attachments jsonb DEFAULT '[]'::jsonb,
    actual_completion_date date,
    visible_to_parents boolean DEFAULT false
);


--
-- Name: assessments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.assessments (
    id integer NOT NULL,
    child_id integer,
    staff_id integer,
    subject text,
    assessment_date date DEFAULT CURRENT_DATE,
    period text,
    attainment text,
    attainment_value integer,
    progress text,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: assessments_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.assessments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assessments_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.assessments_id_seq OWNED BY demo_eyfs.assessments.id;


--
-- Name: assessments_primary; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.assessments_primary (
    id integer DEFAULT nextval('demo_eyfs.assessments_primary_id_seq'::regclass) NOT NULL,
    child_id integer NOT NULL,
    academic_year text DEFAULT '2025-2026'::text,
    term text,
    subject text NOT NULL,
    grade text NOT NULL,
    assessment_type text DEFAULT 'formative'::text,
    notes text,
    assessed_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: assessments_secondary; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.assessments_secondary (
    id integer DEFAULT nextval('demo_eyfs.assessments_secondary_id_seq'::regclass) NOT NULL,
    child_id integer NOT NULL,
    academic_year text DEFAULT '2025-2026'::text,
    term text,
    subject text NOT NULL,
    grade text,
    score numeric,
    assessment_type text DEFAULT 'formative'::text,
    notes text,
    assessed_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: attendance; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.attendance (
    id integer NOT NULL,
    child_id integer,
    date date DEFAULT CURRENT_DATE NOT NULL,
    session text DEFAULT 'full_day'::text,
    sign_in_time timestamp with time zone,
    sign_out_time timestamp with time zone,
    signed_in_by integer,
    signed_out_by integer,
    absent boolean DEFAULT false,
    absence_reason text,
    notes text
);


--
-- Name: attendance_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.attendance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attendance_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.attendance_id_seq OWNED BY demo_eyfs.attendance.id;


--
-- Name: attendance_register; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.attendance_register (
    id integer DEFAULT nextval('demo_eyfs.attendance_register_id_seq'::regclass) NOT NULL,
    child_id integer NOT NULL,
    date date NOT NULL,
    session text NOT NULL,
    code text NOT NULL,
    notes text,
    recorded_by integer,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT attendance_register_session_check CHECK ((session = ANY (ARRAY['am'::text, 'pm'::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.audit_log (
    id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_type text DEFAULT 'staff'::text NOT NULL,
    actor_id integer,
    actor_email text,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    edition text,
    ip text,
    user_agent text,
    diff jsonb,
    meta jsonb
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.audit_log_id_seq OWNED BY demo_eyfs.audit_log.id;


--
-- Name: backup_config; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.backup_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_schema text DEFAULT 'ladn'::text NOT NULL,
    destination_type text DEFAULT 'none'::text NOT NULL,
    destination_name text,
    rclone_remote_name text,
    encryption_passphrase_enc text,
    schedule_layer1_cron text DEFAULT '0 */6 * * *'::text,
    schedule_layer2_time text DEFAULT '02:00'::text,
    schedule_layer3_day text DEFAULT 'sunday'::text,
    retention_layer1_days integer DEFAULT 7,
    retention_layer2_days integer DEFAULT 90,
    retention_layer3_days integer DEFAULT 365,
    layer3_type text DEFAULT 'usb'::text,
    layer3_b2_bucket text,
    layer3_usb_label text DEFAULT 'WREN-BACKUP'::text,
    enabled boolean DEFAULT true,
    last_layer1_at timestamp with time zone,
    last_layer2_at timestamp with time zone,
    last_layer3_at timestamp with time zone,
    last_status text DEFAULT 'never'::text,
    last_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: backup_runs; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.backup_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_id uuid,
    layer integer NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    bytes_written bigint,
    files_count integer,
    status text DEFAULT 'running'::text,
    error text,
    destination_path text,
    trigger_type text DEFAULT 'cron'::text,
    triggered_by integer,
    CONSTRAINT backup_runs_layer_check CHECK ((layer = ANY (ARRAY[1, 2, 3]))),
    CONSTRAINT backup_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'warn'::text, 'fail'::text])))
);


--
-- Name: behaviour_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.behaviour_log (
    id integer NOT NULL,
    child_id integer,
    staff_id integer,
    log_date date DEFAULT CURRENT_DATE,
    behaviour_type text,
    category text,
    description text,
    points integer DEFAULT 0,
    parent_notified boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT behaviour_log_behaviour_type_check CHECK ((behaviour_type = ANY (ARRAY['positive'::text, 'negative'::text])))
);


--
-- Name: behaviour_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.behaviour_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: behaviour_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.behaviour_log_id_seq OWNED BY demo_eyfs.behaviour_log.id;


--
-- Name: behaviour_log_primary; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.behaviour_log_primary (
    id integer DEFAULT nextval('demo_eyfs.behaviour_log_primary_id_seq'::regclass) NOT NULL,
    child_id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    type text NOT NULL,
    category text,
    description text NOT NULL,
    action_taken text,
    parent_notified boolean DEFAULT false,
    logged_by integer,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT behaviour_log_primary_type_check CHECK ((type = ANY (ARRAY['positive'::text, 'negative'::text])))
);


--
-- Name: calendar_feed_tokens; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.calendar_feed_tokens (
    id integer NOT NULL,
    token character varying(64) NOT NULL,
    scope character varying(32) NOT NULL,
    entity_type character varying(32),
    entity_id integer,
    created_at timestamp with time zone DEFAULT now(),
    regenerated_at timestamp with time zone DEFAULT now()
);


--
-- Name: calendar_feed_tokens_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.calendar_feed_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calendar_feed_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.calendar_feed_tokens_id_seq OWNED BY demo_eyfs.calendar_feed_tokens.id;


--
-- Name: certificates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.certificates (
    id integer NOT NULL,
    uuid character varying(36) DEFAULT (gen_random_uuid())::character varying NOT NULL,
    staff_id integer,
    course_id integer,
    attempt_id integer,
    issued_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone,
    revoked_at timestamp without time zone,
    version integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: certificates_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.certificates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: certificates_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.certificates_id_seq OWNED BY demo_eyfs.certificates.id;


--
-- Name: child_about_me; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_about_me (
    id integer NOT NULL,
    child_id integer NOT NULL,
    religion text,
    first_language text,
    interests text,
    skills text,
    fears text,
    comforts text,
    dietary_requirements text,
    food_allergies text,
    medication text,
    eal boolean DEFAULT false,
    send boolean DEFAULT false,
    looked_after boolean DEFAULT false,
    pupil_premium boolean DEFAULT false,
    safeguarding_flag boolean DEFAULT false,
    individual_education_plan boolean DEFAULT false,
    individual_behaviour_plan boolean DEFAULT false,
    completed_at timestamp with time zone,
    completed_by text,
    last_updated_at timestamp with time zone DEFAULT now(),
    other_languages text,
    special_days text,
    lives_with text,
    weekly_schedule text,
    other_childcare_setting text,
    key_person_other_setting text,
    sleep_location character varying(50),
    comforter text,
    nappy_size character varying(20),
    nappy_type character varying(30),
    potty_training character varying(30),
    sleep_pattern text,
    breakfast_source character varying(50),
    breakfast_notes text,
    lunch_source character varying(50),
    lunch_notes text,
    tea_source character varying(50),
    tea_notes text,
    milk_type character varying(50),
    food_preferences text,
    medical_notes text,
    gender_identity character varying(50),
    pronouns character varying(30),
    ethnicity character varying(50),
    under_2_funded boolean DEFAULT false,
    two_year_funded boolean DEFAULT false,
    three_four_year_funded boolean DEFAULT false,
    thirty_hour_funded boolean DEFAULT false,
    one_to_one_care boolean DEFAULT false,
    children_of_concern boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: child_about_me_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.child_about_me_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: child_about_me_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.child_about_me_id_seq OWNED BY demo_eyfs.child_about_me.id;


--
-- Name: child_funding; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_funding (
    id integer DEFAULT nextval('demo_eyfs.child_funding_id_seq'::regclass) NOT NULL,
    child_id integer,
    term_id integer,
    funding_type character varying(50) DEFAULT 'none'::character varying,
    stretched_funding boolean DEFAULT false,
    declaration_signed boolean DEFAULT false,
    declaration_signed_date date,
    declaration_method character varying(30),
    declaration_token character varying(100),
    declaration_sent_at timestamp with time zone,
    pupil_premium boolean DEFAULT false,
    deprivation_weighting character varying(5),
    universal_hours_week numeric(5,2) DEFAULT 0,
    extended_hours_week numeric(5,2) DEFAULT 0,
    total_hours_week numeric(5,2),
    weeks_in_term numeric(4,1) DEFAULT 0,
    total_hours_term numeric(7,2),
    hours_used numeric(7,2) DEFAULT 0,
    hours_balance numeric(7,2),
    thirty_hour_code character varying(20),
    thirty_hour_code_expiry date,
    eypp_eligible boolean DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: child_phonics_progress; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_phonics_progress (
    id integer NOT NULL,
    child_id integer NOT NULL,
    sound_id integer NOT NULL,
    status character varying(20) DEFAULT 'not_started'::character varying,
    first_assessed_at timestamp with time zone,
    last_assessed_at timestamp with time zone,
    assessed_by integer,
    notes text
);


--
-- Name: child_phonics_progress_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.child_phonics_progress_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: child_phonics_progress_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.child_phonics_progress_id_seq OWNED BY demo_eyfs.child_phonics_progress.id;


--
-- Name: child_tags; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_tags (
    id integer NOT NULL,
    child_id integer NOT NULL,
    tag text NOT NULL,
    tag_category text,
    added_by integer,
    added_at timestamp with time zone DEFAULT now()
);


--
-- Name: child_tags_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.child_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: child_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.child_tags_id_seq OWNED BY demo_eyfs.child_tags.id;


--
-- Name: children; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.children (
    id integer NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    preferred_name text,
    date_of_birth date,
    room_id integer,
    key_person_id integer,
    year_group text,
    is_active boolean DEFAULT true,
    start_date date,
    leave_date date,
    photo_url text,
    photo_consent boolean DEFAULT false,
    media_consent boolean DEFAULT false,
    parent_1_name text,
    parent_1_email text,
    parent_1_phone text,
    parent_2_name text,
    parent_2_email text,
    parent_2_phone text,
    emergency_contact_1_name text,
    emergency_contact_1_phone text,
    emergency_contact_1_relation text,
    emergency_contact_2_name text,
    emergency_contact_2_phone text,
    address_line1 text,
    postcode text,
    gp_name text,
    gp_phone text,
    nhs_number text,
    allergies text,
    dietary_requirements text,
    medical_notes text,
    send_needs boolean DEFAULT false,
    looked_after boolean DEFAULT false,
    pupil_premium boolean DEFAULT false,
    funded_hours numeric(5,2) DEFAULT 0,
    funded_hours_type text,
    collection_password text,
    ethnicity text,
    religion text,
    home_language text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    class_group character varying(50),
    deprivation_band character varying(20),
    eypp_eligible boolean DEFAULT false,
    form_group character varying(50),
    funded_hours_15 numeric(5,2),
    funded_hours_30 numeric(5,2),
    key_stage character varying(10),
    sen_needs text[],
    sen_notes text,
    sen_provisions text[],
    sen_review_date date,
    thirty_hour_code character varying(20),
    thirty_hour_code_expiry date,
    two_year_funded boolean DEFAULT false,
    two_year_funding_type character varying(50),
    upn character varying(20),
    allergens text[],
    allergen_notes text
);


--
-- Name: children_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.children_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: children_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.children_id_seq OWNED BY demo_eyfs.children.id;


--
-- Name: comms_email_queue; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.comms_email_queue (
    id integer NOT NULL,
    thread_id text,
    subject text,
    body_html text,
    sender_email text,
    sender_name text,
    recipient_email text,
    direction text DEFAULT 'inbound'::text,
    status text DEFAULT 'unread'::text,
    parent_id integer,
    child_id integer,
    created_at timestamp with time zone DEFAULT now(),
    sent_at timestamp with time zone,
    read_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now(),
    handled_by integer
);


--
-- Name: comms_email_queue_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.comms_email_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comms_email_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.comms_email_queue_id_seq OWNED BY demo_eyfs.comms_email_queue.id;


--
-- Name: comms_emails; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.comms_emails (
    id integer NOT NULL,
    thread_id text,
    subject text,
    body_html text,
    sender_email text,
    sender_name text,
    recipient_email text,
    direction text DEFAULT 'inbound'::text,
    status text DEFAULT 'unread'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: comms_emails_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.comms_emails_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comms_emails_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.comms_emails_id_seq OWNED BY demo_eyfs.comms_emails.id;


--
-- Name: compliance_events; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.compliance_events (
    id integer NOT NULL,
    title text NOT NULL,
    category text,
    cron text,
    rrule text,
    next_due date,
    lead_days integer DEFAULT 3,
    notes text,
    url text,
    is_active boolean DEFAULT true
);


--
-- Name: compliance_events_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.compliance_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: compliance_events_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.compliance_events_id_seq OWNED BY demo_eyfs.compliance_events.id;


--
-- Name: contract_signature_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.contract_signature_log (
    id integer NOT NULL,
    contract_id integer,
    event character varying(40),
    event_at timestamp with time zone DEFAULT now(),
    ip character varying(45),
    user_agent text,
    detail jsonb
);


--
-- Name: contract_signature_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.contract_signature_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_signature_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.contract_signature_log_id_seq OWNED BY demo_eyfs.contract_signature_log.id;


--
-- Name: contract_templates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.contract_templates (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    doc_type character varying(60) DEFAULT 'contract_template'::character varying NOT NULL,
    content_md text,
    version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    pdf_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    template_type character varying(40) DEFAULT 'permanent_practitioner'::character varying NOT NULL,
    variables jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: contract_templates_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.contract_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.contract_templates_id_seq OWNED BY demo_eyfs.contract_templates.id;


--
-- Name: coshh_register; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.coshh_register (
    id integer NOT NULL,
    substance_name text NOT NULL,
    trade_name text,
    category text,
    hazard_type text[],
    storage_location text,
    max_quantity text,
    supplier text,
    sds_url text,
    first_aid_response text,
    disposal_method text,
    ppe_required text[],
    ppe_notes text,
    review_date date,
    reviewed_by integer,
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: coshh_register_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.coshh_register_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coshh_register_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.coshh_register_id_seq OWNED BY demo_eyfs.coshh_register.id;


--
-- Name: course_attempts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.course_attempts (
    id integer NOT NULL,
    staff_id integer,
    course_id integer,
    started_at timestamp without time zone DEFAULT now(),
    completed_at timestamp without time zone,
    score_pct integer,
    passed boolean,
    answers_json jsonb,
    attempt_number integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: course_attempts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.course_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: course_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.course_attempts_id_seq OWNED BY demo_eyfs.course_attempts.id;


--
-- Name: course_quiz_questions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.course_quiz_questions (
    id integer NOT NULL,
    course_id integer,
    section_id integer,
    order_index integer DEFAULT 0 NOT NULL,
    question_text text NOT NULL,
    options jsonb NOT NULL,
    correct_index integer NOT NULL,
    explanation text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: course_quiz_questions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.course_quiz_questions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: course_quiz_questions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.course_quiz_questions_id_seq OWNED BY demo_eyfs.course_quiz_questions.id;


--
-- Name: course_sections; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.course_sections (
    id integer NOT NULL,
    course_id integer,
    order_index integer DEFAULT 0 NOT NULL,
    title character varying(255),
    content_md text,
    section_type character varying(40) DEFAULT 'content'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: course_sections_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.course_sections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: course_sections_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.course_sections_id_seq OWNED BY demo_eyfs.course_sections.id;


--
-- Name: courses; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.courses (
    id integer NOT NULL,
    slug character varying(120) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    category character varying(60),
    target_audience text,
    learning_outcomes text[],
    duration_minutes integer DEFAULT 25,
    cpd_hours numeric(4,2),
    status character varying(20) DEFAULT 'draft'::character varying,
    statutory_refs text[],
    content_summary text,
    version integer DEFAULT 1,
    is_mandatory boolean DEFAULT false,
    pass_mark_pct integer DEFAULT 80,
    created_by character varying(100),
    reviewed_by character varying(100),
    last_reviewed_at timestamp without time zone,
    published_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: courses_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.courses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: courses_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.courses_id_seq OWNED BY demo_eyfs.courses.id;


--
-- Name: cp_register; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cp_register (
    id integer NOT NULL,
    child_id integer,
    plan_type text NOT NULL,
    start_date date NOT NULL,
    review_date date,
    end_date date,
    is_active boolean DEFAULT true,
    social_worker_name text,
    social_worker_email text,
    social_worker_phone text,
    health_visitor_name text,
    notes text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT cp_register_plan_type_check CHECK ((plan_type = ANY (ARRAY['child_protection'::text, 'child_in_need'::text, 'lac'::text, 'early_help'::text])))
);


--
-- Name: cp_register_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.cp_register_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cp_register_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.cp_register_id_seq OWNED BY demo_eyfs.cp_register.id;


--
-- Name: cpd_records; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cpd_records (
    id integer NOT NULL,
    staff_id integer,
    course_name text NOT NULL,
    provider text,
    completion_date date,
    expiry_date date,
    is_mandatory boolean DEFAULT false,
    hours numeric(5,2),
    certificate_url text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    course_content text,
    course_level character varying(50),
    learning_objectives text[],
    quiz_questions jsonb,
    quiz_score integer,
    quiz_completed_at timestamp with time zone
);


--
-- Name: cpd_records_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.cpd_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cpd_records_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.cpd_records_id_seq OWNED BY demo_eyfs.cpd_records.id;


--
-- Name: curriculum_activities; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.curriculum_activities (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    category text,
    eyfs_areas text[],
    age_range text,
    resources_needed text,
    parent_tip text,
    interests text[],
    color text,
    is_library boolean DEFAULT false,
    created_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: curriculum_activities_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.curriculum_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: curriculum_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.curriculum_activities_id_seq OWNED BY demo_eyfs.curriculum_activities.id;


--
-- Name: curriculum_plans; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.curriculum_plans (
    id integer NOT NULL,
    room_id integer,
    staff_id integer,
    title text,
    term text,
    week_number integer,
    week_start date,
    status text DEFAULT 'draft'::text,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    grid_data jsonb,
    week_commencing date,
    published_to_parents boolean DEFAULT false,
    theme text,
    notes text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: curriculum_plans_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.curriculum_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: curriculum_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.curriculum_plans_id_seq OWNED BY demo_eyfs.curriculum_plans.id;


--
-- Name: daily_diary; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.daily_diary (
    id integer NOT NULL,
    child_id integer,
    staff_id integer,
    date date DEFAULT CURRENT_DATE,
    mood text,
    meals text,
    naps text,
    activities text,
    notes text,
    photo_urls text[],
    shared_with_parents boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    lunch text,
    sleep_from time without time zone,
    sleep_to time without time zone,
    sleep_quality text,
    nappy text,
    nappy_time time without time zone,
    nappy_notes text,
    milk_amount_ml integer,
    milk_time time without time zone,
    milk_type text
);


--
-- Name: daily_diary_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.daily_diary_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_diary_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.daily_diary_id_seq OWNED BY demo_eyfs.daily_diary.id;


--
-- Name: decision_confidence; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.decision_confidence (
    category character varying(50) NOT NULL,
    scenario_fingerprint character varying(64) NOT NULL,
    sample_count integer DEFAULT 0 NOT NULL,
    consistent_decisions integer DEFAULT 0 NOT NULL,
    current_confidence numeric(3,2) DEFAULT 0.00 NOT NULL,
    last_updated timestamp without time zone DEFAULT now()
);


--
-- Name: decision_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.decision_log (
    id bigint NOT NULL,
    category character varying(50) NOT NULL,
    scenario_fingerprint character varying(64),
    input_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    options_presented jsonb DEFAULT '[]'::jsonb,
    decision_made jsonb,
    outcome jsonb DEFAULT '{}'::jsonb,
    auto_confidence numeric(3,2) DEFAULT 0.00,
    was_auto boolean DEFAULT false,
    undo_at timestamp without time zone,
    undo_reason text,
    decided_by_staff_id integer,
    decided_by_ai_model text,
    feedback text,
    feedback_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    decided_at timestamp without time zone,
    source_table character varying(60),
    source_id integer,
    related_child_id integer,
    related_staff_id integer,
    CONSTRAINT decision_log_auto_confidence_check CHECK (((auto_confidence >= (0)::numeric) AND (auto_confidence <= (1)::numeric))),
    CONSTRAINT decision_log_category_check CHECK (((category)::text = ANY (ARRAY[('email_reply'::character varying)::text, ('email_triage_alert'::character varying)::text, ('telegram_command'::character varying)::text, ('chat_message'::character varying)::text, ('waiting_list_match'::character varying)::text, ('enquiry_routing'::character varying)::text, ('absence_request_decision'::character varying)::text, ('rota_cover_decision'::character varying)::text, ('observation_suggest'::character varying)::text, ('observation_enhance'::character varying)::text, ('cpd_suggestion'::character varying)::text, ('action_plan_assignment'::character varying)::text, ('safeguarding_flag'::character varying)::text, ('medicine_reminder'::character varying)::text, ('task_action'::character varying)::text, ('system_other'::character varying)::text])))
);


--
-- Name: decision_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.decision_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: decision_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.decision_log_id_seq OWNED BY demo_eyfs.decision_log.id;


--
-- Name: document_workspace_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.document_workspace_audit (
    id integer NOT NULL,
    workspace_id integer,
    event character varying(40),
    event_at timestamp with time zone DEFAULT now() NOT NULL,
    detail jsonb
);


--
-- Name: document_workspace_audit_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.document_workspace_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_workspace_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.document_workspace_audit_id_seq OWNED BY demo_eyfs.document_workspace_audit.id;


--
-- Name: document_workspaces; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.document_workspaces (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    doc_type character varying(40) NOT NULL,
    base_doc_path text,
    base_content_md text,
    update_doc_path text,
    update_content_md text,
    merge_doc_path text,
    merge_content_md text,
    mode character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'analysing'::character varying NOT NULL,
    ai_analysis jsonb,
    ai_questions jsonb,
    user_answers jsonb,
    proposed_output_md text,
    committed_to_table character varying(60),
    committed_to_id integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_workspaces_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.document_workspaces_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_workspaces_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.document_workspaces_id_seq OWNED BY demo_eyfs.document_workspaces.id;


--
-- Name: enquiries; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.enquiries (
    id integer NOT NULL,
    child_first_name text,
    child_last_name text,
    child_dob date,
    room_needed text,
    start_date_requested date,
    parent_name text,
    parent_email text,
    parent_phone text,
    source text,
    stage text DEFAULT 'enquiry'::text,
    notes text,
    lost_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    preferred_room text,
    preferred_start_date date,
    preferred_days text[],
    funded_hours_type text,
    assigned_to integer,
    ai_score integer,
    ai_score_reason text,
    ai_score_updated_at timestamp with time zone,
    ai_score_override boolean DEFAULT false,
    ai_score_override_reason text,
    ai_score_override_by integer,
    CONSTRAINT enquiries_stage_check CHECK ((stage = ANY (ARRAY['new'::text, 'tour_booked'::text, 'tour_done'::text, 'on_waiting_list'::text, 'offer_made'::text, 'offer_accepted'::text, 'registered'::text, 'declined'::text, 'lost'::text, 'enquiry'::text, 'viewing_booked'::text, 'waiting_list'::text, 'registration'::text, 'active'::text, 'withdrawn'::text])))
);


--
-- Name: enquiries_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.enquiries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enquiries_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.enquiries_id_seq OWNED BY demo_eyfs.enquiries.id;


--
-- Name: environment_assessments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.environment_assessments (
    id integer NOT NULL,
    scale character varying(20) NOT NULL,
    room_id integer,
    assessed_at date NOT NULL,
    assessor_id integer,
    scores jsonb DEFAULT '{}'::jsonb NOT NULL,
    overall_avg numeric,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT environment_assessments_scale_check CHECK (((scale)::text = ANY ((ARRAY['iters_3'::character varying, 'ecers_3'::character varying, 'fccers_3'::character varying, 'sacers_u'::character varying])::text[])))
);


--
-- Name: environment_assessments_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.environment_assessments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: environment_assessments_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.environment_assessments_id_seq OWNED BY demo_eyfs.environment_assessments.id;


--
-- Name: exclusions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.exclusions (
    id integer NOT NULL,
    child_id integer,
    exclusion_type text,
    start_date date,
    end_date date,
    reason text,
    governor_review_date date,
    return_arrangements text,
    reported_to_la boolean DEFAULT false,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT exclusions_exclusion_type_check CHECK ((exclusion_type = ANY (ARRAY['fixed_period'::text, 'permanent'::text])))
);


--
-- Name: exclusions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.exclusions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: exclusions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.exclusions_id_seq OWNED BY demo_eyfs.exclusions.id;


--
-- Name: finance_accounts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.finance_accounts (
    id integer NOT NULL,
    provider_id integer NOT NULL,
    external_id character varying(100) NOT NULL,
    code character varying(20),
    name character varying(200) NOT NULL,
    type character varying(50),
    class character varying(50),
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: finance_accounts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.finance_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.finance_accounts_id_seq OWNED BY demo_eyfs.finance_accounts.id;


--
-- Name: finance_invoices; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.finance_invoices (
    id integer NOT NULL,
    provider_id integer NOT NULL,
    external_id character varying(100) NOT NULL,
    invoice_number character varying(50),
    contact_name character varying(200),
    invoice_date date,
    due_date date,
    amount_due numeric(12,2),
    amount_paid numeric(12,2),
    total numeric(12,2),
    status character varying(20),
    reference character varying(200),
    is_la_funding boolean DEFAULT false NOT NULL,
    la_funding_confidence character varying(20),
    child_id integer
);


--
-- Name: finance_invoices_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.finance_invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.finance_invoices_id_seq OWNED BY demo_eyfs.finance_invoices.id;


--
-- Name: finance_monthly_balances; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.finance_monthly_balances (
    id integer NOT NULL,
    provider_id integer NOT NULL,
    account_id integer NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency character(3) DEFAULT 'GBP'::bpchar NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_monthly_balances_month_check CHECK (((month >= 1) AND (month <= 12)))
);


--
-- Name: finance_monthly_balances_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.finance_monthly_balances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_monthly_balances_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.finance_monthly_balances_id_seq OWNED BY demo_eyfs.finance_monthly_balances.id;


--
-- Name: finance_payments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.finance_payments (
    id integer NOT NULL,
    provider_id integer NOT NULL,
    external_id character varying(100) NOT NULL,
    payment_date date,
    amount numeric(12,2),
    invoice_id integer,
    reference character varying(200),
    bank_account_id integer
);


--
-- Name: finance_payments_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.finance_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.finance_payments_id_seq OWNED BY demo_eyfs.finance_payments.id;


--
-- Name: finance_providers; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.finance_providers (
    id integer NOT NULL,
    provider character varying(20) NOT NULL,
    oauth_access_token text,
    oauth_refresh_token text,
    oauth_expires_at timestamp with time zone,
    tenant_id character varying(100),
    display_name character varying(200),
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sync_at timestamp with time zone,
    last_sync_status character varying(20),
    last_sync_error text,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT finance_providers_provider_check CHECK (((provider)::text = ANY ((ARRAY['xero'::character varying, 'quickbooks'::character varying, 'akaunting'::character varying, 'none'::character varying])::text[])))
);


--
-- Name: finance_providers_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.finance_providers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_providers_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.finance_providers_id_seq OWNED BY demo_eyfs.finance_providers.id;


--
-- Name: finance_sync_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.finance_sync_log (
    id integer NOT NULL,
    provider_id integer,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    status character varying(20),
    rows_synced integer,
    error_message text,
    triggered_by character varying(20)
);


--
-- Name: finance_sync_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.finance_sync_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_sync_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.finance_sync_log_id_seq OWNED BY demo_eyfs.finance_sync_log.id;


--
-- Name: fire_drills; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.fire_drills (
    id integer NOT NULL,
    drill_date date NOT NULL,
    drill_time time without time zone,
    evacuation_time_seconds integer,
    all_accounted boolean DEFAULT true,
    issues_raised text,
    action_taken text,
    next_drill_due date,
    conducted_by integer,
    signed_off_by integer,
    signed_off_at timestamp with time zone,
    children_count integer,
    staff_count integer,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: fire_drills_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.fire_drills_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fire_drills_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.fire_drills_id_seq OWNED BY demo_eyfs.fire_drills.id;


--
-- Name: fire_equipment_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.fire_equipment_log (
    id integer NOT NULL,
    equipment_type text NOT NULL,
    location text,
    last_serviced date,
    next_service date,
    service_company text,
    status text DEFAULT 'ok'::text,
    notes text,
    created_by integer,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT fire_equipment_log_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'due'::text, 'overdue'::text, 'failed'::text])))
);


--
-- Name: fire_equipment_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.fire_equipment_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fire_equipment_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.fire_equipment_log_id_seq OWNED BY demo_eyfs.fire_equipment_log.id;


--
-- Name: first_words; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.first_words (
    id integer DEFAULT nextval('demo_eyfs.first_words_id_seq'::regclass) NOT NULL,
    child_id integer,
    word text NOT NULL,
    date_observed date DEFAULT CURRENT_DATE,
    context text,
    observed_by integer,
    photo_url text,
    audio_url text,
    shared_with_parents boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: food_intake_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.food_intake_log (
    id integer NOT NULL,
    child_id integer,
    date date DEFAULT CURRENT_DATE NOT NULL,
    meal_type character varying(20) NOT NULL,
    recipe_id integer,
    amount_eaten_pct integer DEFAULT 0,
    notes text,
    recorded_by character varying(100),
    recorded_at timestamp without time zone DEFAULT now()
);


--
-- Name: food_intake_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.food_intake_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: food_intake_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.food_intake_log_id_seq OWNED BY demo_eyfs.food_intake_log.id;


--
-- Name: framework_statements; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.framework_statements (
    id integer NOT NULL,
    framework character varying(30) NOT NULL,
    area character varying(100) NOT NULL,
    aspect character varying(100),
    age_range character varying(50),
    statement_code character varying(50),
    statement_text text NOT NULL,
    ordinal integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: framework_statements_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.framework_statements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: framework_statements_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.framework_statements_id_seq OWNED BY demo_eyfs.framework_statements.id;


--
-- Name: framework_tracker; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.framework_tracker (
    id integer DEFAULT nextval('demo_eyfs.framework_tracker_id_seq'::regclass) NOT NULL,
    child_id integer,
    framework character varying(30) DEFAULT 'birth_to_5'::character varying,
    area character varying(100) NOT NULL,
    aspect character varying(100),
    age_range character varying(30),
    statement text NOT NULL,
    status character varying(20) DEFAULT 'not_yet'::character varying,
    linked_observation_id integer,
    assessed_by integer,
    assessed_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    statement_id integer
);


--
-- Name: funding_terms; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.funding_terms (
    id integer DEFAULT nextval('demo_eyfs.funding_terms_id_seq'::regclass) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    year integer,
    start_date date NOT NULL,
    end_date date NOT NULL,
    funding_eligible_date date,
    term_months text[] DEFAULT '{}'::text[],
    colour character varying(10) DEFAULT '#4a9abf'::character varying,
    holiday_dates jsonb DEFAULT '[]'::jsonb,
    partial_week_entitlement character varying(50) DEFAULT 'Full Week Entitlement'::character varying,
    rate_under_2 numeric(6,4) DEFAULT 0,
    rate_2yr_disadvantaged numeric(6,4) DEFAULT 0,
    rate_2yr_working_parents numeric(6,4) DEFAULT 0,
    rate_3yr_universal numeric(6,4) DEFAULT 0,
    rate_3yr_extended numeric(6,4) DEFAULT 0,
    inv_rate_under_2 numeric(6,4) DEFAULT 0,
    inv_rate_2yr_disadvantaged numeric(6,4) DEFAULT 0,
    inv_rate_2yr_working_parents numeric(6,4) DEFAULT 0,
    inv_rate_3yr_universal numeric(6,4) DEFAULT 0,
    inv_rate_3yr_extended numeric(6,4) DEFAULT 0,
    eypp_rate numeric(6,4) DEFAULT 0,
    deprivation_band_a numeric(6,4) DEFAULT 0,
    deprivation_band_b numeric(6,4) DEFAULT 0,
    deprivation_band_c numeric(6,4) DEFAULT 0,
    deprivation_band_d numeric(6,4) DEFAULT 0,
    consumables_charge numeric(6,2) DEFAULT 0,
    consumables_description text,
    is_current boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: gias_cache; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.gias_cache (
    id integer NOT NULL,
    cache_key text NOT NULL,
    result_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    fetched_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval)
);


--
-- Name: gias_cache_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.gias_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gias_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.gias_cache_id_seq OWNED BY demo_eyfs.gias_cache.id;


--
-- Name: gocardless_mandates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.gocardless_mandates (
    id integer NOT NULL,
    child_id integer,
    bill_payer_email text,
    redirect_flow_id text,
    mandate_id text,
    status text DEFAULT 'active'::text,
    gc_account_holder text,
    gc_bank_name text,
    gc_account_number_end text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: gocardless_mandates_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.gocardless_mandates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gocardless_mandates_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.gocardless_mandates_id_seq OWNED BY demo_eyfs.gocardless_mandates.id;


--
-- Name: hr_absences; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.hr_absences (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    absence_type text,
    start_date date NOT NULL,
    end_date date,
    duration_hours numeric(8,4),
    duration_days numeric(6,2),
    reason text,
    is_certified boolean,
    is_paid boolean,
    bradford_factor_contribution numeric(8,4),
    source text DEFAULT 'demo_seed'::text,
    external_ref text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: hr_absences_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.hr_absences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_absences_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.hr_absences_id_seq OWNED BY demo_eyfs.hr_absences.id;


--
-- Name: hr_holiday_entitlement; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.hr_holiday_entitlement (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    year_start date NOT NULL,
    year_end date,
    entitlement_days numeric(6,2),
    taken_days numeric(6,2),
    upcoming_days numeric(6,2),
    awaiting_approval_days numeric(6,2),
    remaining_days numeric(6,2),
    carried_over_days numeric(6,2),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: hr_holiday_entitlement_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.hr_holiday_entitlement_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_holiday_entitlement_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.hr_holiday_entitlement_id_seq OWNED BY demo_eyfs.hr_holiday_entitlement.id;


--
-- Name: hr_import_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.hr_import_audit (
    id integer NOT NULL,
    imported_at timestamp with time zone DEFAULT now(),
    filename text NOT NULL,
    file_hash text,
    rows_processed integer DEFAULT 0,
    rows_matched integer DEFAULT 0,
    rows_inserted integer DEFAULT 0,
    rows_skipped integer DEFAULT 0,
    importer_notes text
);


--
-- Name: hr_import_audit_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.hr_import_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_import_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.hr_import_audit_id_seq OWNED BY demo_eyfs.hr_import_audit.id;


--
-- Name: hr_overtime; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.hr_overtime (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    date timestamp with time zone,
    hours numeric(6,2),
    rate numeric(6,2),
    approved boolean,
    paid boolean,
    reason text,
    external_ref text,
    source text DEFAULT 'demo_seed'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: hr_overtime_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.hr_overtime_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_overtime_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.hr_overtime_id_seq OWNED BY demo_eyfs.hr_overtime.id;


--
-- Name: hr_toil_entries; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.hr_toil_entries (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    accrued_date timestamp with time zone,
    hours numeric(6,2),
    reason text,
    used_date timestamp with time zone,
    status text,
    source text DEFAULT 'demo_seed'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: hr_toil_entries_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.hr_toil_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_toil_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.hr_toil_entries_id_seq OWNED BY demo_eyfs.hr_toil_entries.id;


--
-- Name: incidents; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.incidents (
    id integer NOT NULL,
    child_id integer,
    reported_by integer,
    incident_date date DEFAULT CURRENT_DATE,
    incident_time time without time zone,
    incident_type text,
    location text,
    description text,
    injury_description text,
    first_aid_given text,
    parent_notified boolean DEFAULT false,
    parent_notified_at timestamp with time zone,
    manager_reviewed boolean DEFAULT false,
    manager_reviewed_at timestamp with time zone,
    status text DEFAULT 'open'::text,
    created_at timestamp with time zone DEFAULT now(),
    body_map_data jsonb,
    body_map_area character varying(50),
    first_aid_by integer,
    follow_up_notes text,
    follow_up_required boolean DEFAULT false,
    manager_sign_off_at timestamp with time zone,
    manager_signed_by integer,
    parent_notified_by character varying(50),
    parent_signature_requested boolean DEFAULT false,
    parent_signature_token character varying(100),
    parent_signed_at timestamp with time zone,
    riddor_reportable boolean DEFAULT false,
    riddor_submitted_at timestamp with time zone,
    witness_name character varying(100)
);


--
-- Name: incidents_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.incidents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.incidents_id_seq OWNED BY demo_eyfs.incidents.id;


--
-- Name: ingredients; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.ingredients (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    allergens text[],
    supplier_default character varying(100),
    unit_default character varying(30),
    sainsburys_sku character varying(50),
    sainsburys_url text,
    sainsburys_last_price_pence integer,
    sainsburys_last_check timestamp without time zone,
    nutrition_per_100g_json jsonb,
    suitable_for_vegetarian boolean DEFAULT true,
    suitable_for_vegan boolean DEFAULT false,
    suitable_for_halal boolean DEFAULT true,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: ingredients_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.ingredients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ingredients_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.ingredients_id_seq OWNED BY demo_eyfs.ingredients.id;


--
-- Name: inspection_access_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.inspection_access_log (
    id bigint NOT NULL,
    inspection_id integer,
    staff_id integer,
    action text NOT NULL,
    entity_type text,
    entity_id text,
    accessed_at timestamp with time zone DEFAULT now(),
    ip text,
    notes text
);


--
-- Name: inspection_access_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.inspection_access_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inspection_access_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.inspection_access_log_id_seq OWNED BY demo_eyfs.inspection_access_log.id;


--
-- Name: inspection_action_items; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.inspection_action_items (
    id integer NOT NULL,
    inspection_id integer,
    category text NOT NULL,
    description text NOT NULL,
    rag_status text NOT NULL,
    evidence_link text,
    resolved_at timestamp with time zone,
    resolved_by integer,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT inspection_action_items_rag_status_check CHECK ((rag_status = ANY (ARRAY['green'::text, 'amber'::text, 'red'::text])))
);


--
-- Name: inspection_action_items_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.inspection_action_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inspection_action_items_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.inspection_action_items_id_seq OWNED BY demo_eyfs.inspection_action_items.id;


--
-- Name: inspection_briefings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.inspection_briefings (
    id integer NOT NULL,
    inspection_id integer,
    staff_id integer,
    role text,
    pdf_path text,
    generated_at timestamp with time zone DEFAULT now(),
    acknowledged_at timestamp with time zone
);


--
-- Name: inspection_briefings_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.inspection_briefings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inspection_briefings_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.inspection_briefings_id_seq OWNED BY demo_eyfs.inspection_briefings.id;


--
-- Name: inspection_modes; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.inspection_modes (
    id integer NOT NULL,
    type text NOT NULL,
    notified_at timestamp with time zone DEFAULT now(),
    expected_arrival timestamp with time zone,
    actual_arrival timestamp with time zone,
    inspector_name text,
    inspector_org text,
    framework_used text DEFAULT 'ofsted-eyfs-2025'::text,
    status text DEFAULT 'active'::text NOT NULL,
    outcome_judgement text,
    outcome_summary text,
    evidence_pack_path text,
    closed_at timestamp with time zone,
    closed_by integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT inspection_modes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'complete'::text, 'cancelled'::text]))),
    CONSTRAINT inspection_modes_type_check CHECK ((type = ANY (ARRAY['pre_announced'::text, 'unannounced'::text, 'la'::text, 'dfe'::text, 'other'::text])))
);


--
-- Name: inspection_modes_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.inspection_modes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inspection_modes_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.inspection_modes_id_seq OWNED BY demo_eyfs.inspection_modes.id;


--
-- Name: interventions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.interventions (
    id integer NOT NULL,
    child_id integer NOT NULL,
    concern text NOT NULL,
    plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    next_review_date date,
    reviews jsonb DEFAULT '[]'::jsonb,
    CONSTRAINT interventions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'succeeded'::text, 'escalated'::text, 'abandoned'::text])))
);


--
-- Name: interventions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.interventions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: interventions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.interventions_id_seq OWNED BY demo_eyfs.interventions.id;


--
-- Name: invoice_number_seq; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.invoice_number_seq (
    id integer NOT NULL,
    prefix text DEFAULT 'INV'::text NOT NULL,
    year integer NOT NULL,
    next_val integer DEFAULT 1 NOT NULL
);


--
-- Name: invoice_number_seq_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.invoice_number_seq_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_number_seq_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.invoice_number_seq_id_seq OWNED BY demo_eyfs.invoice_number_seq.id;


--
-- Name: invoices; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.invoices (
    id integer NOT NULL,
    child_id integer,
    period_start date,
    period_end date,
    amount_due numeric(10,2),
    amount_paid numeric(10,2) DEFAULT 0,
    status text DEFAULT 'unpaid'::text,
    issued_date date DEFAULT CURRENT_DATE,
    paid_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    invoice_number text,
    period_year integer,
    period_month integer,
    period_label text,
    sent_at timestamp with time zone,
    funding_deduction_pence integer DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.invoices_id_seq OWNED BY demo_eyfs.invoices.id;


--
-- Name: mandatory_training; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.mandatory_training (
    id integer DEFAULT nextval('demo_eyfs.mandatory_training_id_seq'::regclass) NOT NULL,
    staff_id integer,
    training_type text NOT NULL,
    completed_date date,
    expiry_date date,
    provider text,
    certificate_url text,
    reminder_sent boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: medicine_records; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.medicine_records (
    id integer NOT NULL,
    child_id integer,
    staff_id integer,
    medicine_name text NOT NULL,
    dose text,
    time_given timestamp with time zone,
    parent_consent boolean DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    consent_method character varying(50),
    given_by_id integer,
    manager_sign_off_at timestamp with time zone,
    manager_signed_by integer,
    medicine_dose character varying(100),
    medicine_route character varying(50),
    parent_consent_obtained boolean DEFAULT false,
    parent_notified_at timestamp with time zone,
    prescriber_name character varying(100),
    reason text,
    side_effects_noted text,
    stock_returned boolean DEFAULT false
);


--
-- Name: medicine_records_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.medicine_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: medicine_records_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.medicine_records_id_seq OWNED BY demo_eyfs.medicine_records.id;


--
-- Name: medium_term_plans; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.medium_term_plans (
    id integer NOT NULL,
    room_id integer,
    term_name text,
    academic_year text,
    theme text,
    learning_intentions jsonb DEFAULT '{}'::jsonb,
    key_vocab jsonb DEFAULT '{}'::jsonb,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: medium_term_plans_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.medium_term_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: medium_term_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.medium_term_plans_id_seq OWNED BY demo_eyfs.medium_term_plans.id;


--
-- Name: memory_box_entries; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.memory_box_entries (
    id integer NOT NULL,
    child_id integer NOT NULL,
    title text NOT NULL,
    description text,
    happened_on date NOT NULL,
    milestone_type text,
    photo_upload_ids integer[],
    added_by integer,
    created_at timestamp with time zone DEFAULT now(),
    is_shared_with_parent boolean DEFAULT true
);


--
-- Name: memory_box_entries_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.memory_box_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_box_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.memory_box_entries_id_seq OWNED BY demo_eyfs.memory_box_entries.id;


--
-- Name: menu_groups; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.menu_groups (
    id integer DEFAULT nextval('demo_eyfs.menu_groups_id_seq'::regclass) NOT NULL,
    name text,
    date_from date,
    date_to date,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: menu_items; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.menu_items (
    id integer DEFAULT nextval('demo_eyfs.menu_items_id_seq'::regclass) NOT NULL,
    menu_group_id integer,
    day_of_week integer,
    meal_type text,
    description text,
    allergens text[],
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: menu_plans; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.menu_plans (
    id integer NOT NULL,
    week_start_date date NOT NULL,
    room character varying(20) DEFAULT 'preschool'::character varying NOT NULL,
    day_of_week integer NOT NULL,
    meal_type character varying(20) NOT NULL,
    recipe_id integer,
    override_serves_n integer,
    status character varying(20) DEFAULT 'draft'::character varying,
    approved_by character varying(100),
    approved_at timestamp without time zone,
    served_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: menu_plans_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.menu_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: menu_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.menu_plans_id_seq OWNED BY demo_eyfs.menu_plans.id;


--
-- Name: menu_recipes; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.menu_recipes (
    id integer NOT NULL,
    slug character varying(150) NOT NULL,
    name character varying(300) NOT NULL,
    description text,
    age_groups text[],
    serves_n integer DEFAULT 22,
    prep_minutes integer,
    cook_minutes integer,
    instructions text,
    ingredients_json jsonb,
    allergens text[],
    allergen_codes_display text[],
    tags text[],
    photo_paths text[],
    nutrition_per_serving_json jsonb,
    nutrition_source character varying(40) DEFAULT 'ai_estimated'::character varying,
    is_published boolean DEFAULT false,
    created_by character varying(100),
    reviewed_by character varying(100),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: menu_recipes_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.menu_recipes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: menu_recipes_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.menu_recipes_id_seq OWNED BY demo_eyfs.menu_recipes.id;


--
-- Name: message_threads; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.message_threads (
    id integer DEFAULT nextval('demo_eyfs.message_threads_id_seq'::regclass) NOT NULL,
    child_id integer,
    subject text,
    last_message_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    recipient_type text DEFAULT 'nursery'::text,
    recipient_staff_id integer
);


--
-- Name: messages; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.messages (
    id integer DEFAULT nextval('demo_eyfs.messages_id_seq'::regclass) NOT NULL,
    thread_id integer,
    sender_type text NOT NULL,
    sender_id integer,
    parent_email text,
    body text NOT NULL,
    is_read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['staff'::text, 'parent'::text])))
);


--
-- Name: n8n_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.n8n_audit (
    id bigint NOT NULL,
    event_type text NOT NULL,
    workflow_name text,
    n8n_execution_id text,
    triggered_by text,
    payload_summary jsonb DEFAULT '{}'::jsonb,
    occurred_at timestamp with time zone DEFAULT now()
);


--
-- Name: n8n_audit_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.n8n_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: n8n_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.n8n_audit_id_seq OWNED BY demo_eyfs.n8n_audit.id;


--
-- Name: newsletter_sections; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.newsletter_sections (
    id integer DEFAULT nextval('demo_eyfs.newsletter_sections_id_seq'::regclass) NOT NULL,
    newsletter_id integer,
    section_order integer DEFAULT 0,
    section_type character varying(50) DEFAULT 'text'::character varying NOT NULL,
    title character varying(255),
    raw_notes text,
    ai_draft text,
    final_content text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: newsletters; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.newsletters (
    id integer DEFAULT nextval('demo_eyfs.newsletters_id_seq'::regclass) NOT NULL,
    term text,
    academic_year text DEFAULT '2025-2026'::text,
    status text DEFAULT 'draft'::text,
    subject text,
    html_content text,
    manager_intro text,
    sent_at timestamp with time zone,
    sent_to_count integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sections jsonb DEFAULT '[]'::jsonb,
    rendered_html text,
    sent_by integer,
    from_name character varying(255) DEFAULT 'Nursery Manager'::character varying,
    title character varying(255),
    CONSTRAINT newsletters_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'ready'::text, 'sent'::text])))
);


--
-- Name: next_steps; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.next_steps (
    id integer NOT NULL,
    observation_id integer,
    child_id integer NOT NULL,
    staff_id integer,
    description text NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    framework_statement_id integer,
    due_by date,
    planned_activity_id integer,
    completed_observation_id integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: next_steps_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.next_steps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: next_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.next_steps_id_seq OWNED BY demo_eyfs.next_steps.id;


--
-- Name: notification_deliveries; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.notification_deliveries (
    id integer NOT NULL,
    notification_id integer,
    channel character varying(20),
    status character varying(20),
    attempted_at timestamp without time zone,
    delivered_at timestamp without time zone,
    error_message text,
    recipient_id integer,
    CONSTRAINT notification_deliveries_channel_check CHECK (((channel)::text = ANY (ARRAY[('inapp'::character varying)::text, ('telegram'::character varying)::text, ('email'::character varying)::text, ('sms'::character varying)::text]))),
    CONSTRAINT notification_deliveries_status_check CHECK (((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('sent'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text])))
);


--
-- Name: notification_deliveries_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.notification_deliveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_deliveries_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.notification_deliveries_id_seq OWNED BY demo_eyfs.notification_deliveries.id;


--
-- Name: notification_preferences; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.notification_preferences (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    event_category character varying(40) NOT NULL,
    channels character varying(20)[] DEFAULT ARRAY['inapp'::text] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    scope character varying(20) DEFAULT 'all'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_preferences_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.notification_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.notification_preferences_id_seq OWNED BY demo_eyfs.notification_preferences.id;


--
-- Name: notifications; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.notifications (
    id integer NOT NULL,
    recipient_type character varying(20),
    recipient_id integer,
    category character varying(40) DEFAULT 'system'::character varying NOT NULL,
    title text NOT NULL,
    body text,
    link text,
    related_table character varying(60),
    related_id integer,
    priority character varying(15) DEFAULT 'normal'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    read_at timestamp without time zone,
    dismissed_at timestamp without time zone,
    CONSTRAINT notifications_priority_check CHECK (((priority)::text = ANY (ARRAY[('low'::character varying)::text, ('normal'::character varying)::text, ('high'::character varying)::text, ('urgent'::character varying)::text]))),
    CONSTRAINT notifications_recipient_type_check CHECK (((recipient_type)::text = ANY (ARRAY[('staff'::character varying)::text, ('parent'::character varying)::text, ('all-staff'::character varying)::text, ('all-managers'::character varying)::text])))
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.notifications_id_seq OWNED BY demo_eyfs.notifications.id;


--
-- Name: observation_standards; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.observation_standards (
    id integer DEFAULT nextval('demo_eyfs.observation_standards_id_seq'::regclass) NOT NULL,
    key character varying(100) NOT NULL,
    value numeric NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: observations; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.observations (
    id integer NOT NULL,
    child_id integer,
    staff_id integer,
    title text,
    observation_text text NOT NULL,
    observation_type text DEFAULT 'learning_story'::text,
    eyfs_areas text[],
    subject_areas text[],
    photo_urls text[],
    voice_note_url text,
    shared_with_parents boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    next_steps text,
    analysis text,
    baseline boolean DEFAULT false,
    planned_activity boolean DEFAULT false,
    termly_update boolean DEFAULT false,
    parental boolean DEFAULT false,
    linked_framework_ids integer[] DEFAULT '{}'::integer[],
    additional_comments text,
    staff_notes text,
    obs_tags text[] DEFAULT '{}'::text[],
    CONSTRAINT observations_observation_type_check CHECK ((observation_type = ANY (ARRAY['learning_story'::text, 'milestone'::text, 'note'::text, '2year_check'::text, 'assessment'::text])))
);


--
-- Name: observations_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.observations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: observations_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.observations_id_seq OWNED BY demo_eyfs.observations.id;


--
-- Name: outings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.outings (
    id integer DEFAULT nextval('demo_eyfs.outings_id_seq'::regclass) NOT NULL,
    date date NOT NULL,
    destination text NOT NULL,
    outing_type text,
    purpose text,
    learning_intention text,
    staff_ids integer[],
    child_ids integer[],
    risk_assessment_completed boolean DEFAULT false,
    risk_assessment_url text,
    transport_method text,
    departure_time time without time zone,
    return_time time without time zone,
    notes text,
    room_id integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: parent_module_attempts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_module_attempts (
    id integer NOT NULL,
    module_id integer NOT NULL,
    parent_email character varying(255) NOT NULL,
    child_id integer,
    score integer,
    max_score integer,
    completed_at timestamp with time zone,
    time_taken_seconds integer,
    answers_json jsonb DEFAULT '[]'::jsonb
);


--
-- Name: parent_module_attempts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.parent_module_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: parent_module_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.parent_module_attempts_id_seq OWNED BY demo_eyfs.parent_module_attempts.id;


--
-- Name: parent_permissions_child_overrides; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_permissions_child_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    child_id integer NOT NULL,
    attribute_key text NOT NULL,
    portal boolean,
    api boolean,
    changed_by integer,
    changed_at timestamp with time zone DEFAULT now(),
    reason text
);


--
-- Name: parent_permissions_matrix; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_permissions_matrix (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attribute_key text NOT NULL,
    attribute_label text NOT NULL,
    category text,
    description text,
    affects_audiences text[] DEFAULT '{}'::text[],
    default_portal boolean DEFAULT true,
    default_api boolean DEFAULT false,
    default_ics boolean DEFAULT false,
    default_email boolean DEFAULT true,
    sort_order integer DEFAULT 100
);


--
-- Name: parent_permissions_overrides; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_permissions_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attribute_key text NOT NULL,
    portal boolean,
    api boolean,
    ics boolean,
    email boolean,
    changed_by integer,
    changed_at timestamp with time zone DEFAULT now(),
    reason text
);


--
-- Name: parent_portal_access; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_portal_access (
    id integer NOT NULL,
    child_id integer,
    email text NOT NULL,
    token_hash text,
    is_active boolean DEFAULT true,
    last_login timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    password_hash text
);


--
-- Name: parent_portal_access_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.parent_portal_access_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: parent_portal_access_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.parent_portal_access_id_seq OWNED BY demo_eyfs.parent_portal_access.id;


--
-- Name: parent_rewards; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_rewards (
    id integer NOT NULL,
    parent_email character varying(255) NOT NULL,
    reward_type character varying(60) NOT NULL,
    source_table character varying(60),
    source_id integer,
    awarded_at timestamp with time zone DEFAULT now(),
    is_seen boolean DEFAULT false
);


--
-- Name: parent_rewards_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.parent_rewards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: parent_rewards_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.parent_rewards_id_seq OWNED BY demo_eyfs.parent_rewards.id;


--
-- Name: parent_study_modules; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_study_modules (
    id integer NOT NULL,
    slug character varying(120) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    format character varying(40) DEFAULT 'quiz'::character varying,
    content_json jsonb DEFAULT '{}'::jsonb,
    thumbnail_url text,
    duration_minutes integer DEFAULT 10,
    age_range_min_months integer,
    age_range_max_months integer,
    tags text[],
    status character varying(20) DEFAULT 'draft'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    published_at timestamp with time zone
);


--
-- Name: parent_study_modules_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.parent_study_modules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: parent_study_modules_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.parent_study_modules_id_seq OWNED BY demo_eyfs.parent_study_modules.id;


--
-- Name: payments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.payments (
    id integer NOT NULL,
    invoice_id integer,
    child_id integer,
    bill_payer_email text,
    amount_pence integer,
    currency text DEFAULT 'gbp'::text,
    payment_method text,
    provider_payment_id text,
    stripe_checkout_session_id text,
    gocardless_mandate_id integer,
    status text DEFAULT 'pending'::text,
    description text,
    receipt_email_sent boolean DEFAULT false,
    reconciled_at timestamp with time zone,
    reconciliation_note text,
    reconciliation_status text DEFAULT 'unreconciled'::text,
    confidence_score integer,
    bank_statement_line_id integer,
    manual_notes text,
    cash_reference text,
    gc_mandate_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.payments_id_seq OWNED BY demo_eyfs.payments.id;


--
-- Name: permission_slip_responses; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.permission_slip_responses (
    id integer NOT NULL,
    slip_id integer NOT NULL,
    child_id integer NOT NULL,
    parent_name text,
    parent_email text,
    response text DEFAULT 'pending'::text NOT NULL,
    signature_data text,
    signed_at timestamp with time zone,
    medical_notes text,
    photo_consent boolean,
    token text DEFAULT encode(public.gen_random_bytes(24), 'hex'::text),
    notified_at timestamp with time zone,
    reminded_at timestamp with time zone,
    ip_address text,
    user_agent text,
    hash_self text,
    hash_previous text,
    revoked_at timestamp with time zone,
    revoke_reason text
);


--
-- Name: permission_slip_responses_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.permission_slip_responses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: permission_slip_responses_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.permission_slip_responses_id_seq OWNED BY demo_eyfs.permission_slip_responses.id;


--
-- Name: permission_slips; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.permission_slips (
    id integer NOT NULL,
    outing_id integer,
    title text NOT NULL,
    description text,
    trip_date date,
    departure_time text,
    return_time text,
    destination text,
    transport text,
    cost numeric(8,2),
    recipients jsonb DEFAULT '{"type": "all_active"}'::jsonb,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    sent_at timestamp with time zone,
    deadline date,
    status text DEFAULT 'draft'::text,
    requires_medical_confirmation boolean DEFAULT true,
    requires_photo_consent boolean DEFAULT false
);


--
-- Name: permission_slips_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.permission_slips_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: permission_slips_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.permission_slips_id_seq OWNED BY demo_eyfs.permission_slips.id;


--
-- Name: phonics_game_sessions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.phonics_game_sessions (
    id integer NOT NULL,
    child_id integer NOT NULL,
    game_type character varying(40) NOT NULL,
    phase integer,
    score integer DEFAULT 0,
    max_score integer DEFAULT 0,
    duration_seconds integer DEFAULT 0,
    sounds_practiced integer[],
    played_at timestamp with time zone DEFAULT now()
);


--
-- Name: phonics_game_sessions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.phonics_game_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phonics_game_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.phonics_game_sessions_id_seq OWNED BY demo_eyfs.phonics_game_sessions.id;


--
-- Name: phonics_sounds; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.phonics_sounds (
    id integer NOT NULL,
    phase integer NOT NULL,
    sound character varying(20) NOT NULL,
    grapheme character varying(30),
    example_word character varying(60),
    example_image_url text,
    audio_url text,
    teaching_tips text,
    is_digraph boolean DEFAULT false,
    display_order integer DEFAULT 0
);


--
-- Name: phonics_sounds_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.phonics_sounds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phonics_sounds_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.phonics_sounds_id_seq OWNED BY demo_eyfs.phonics_sounds.id;


--
-- Name: phonics_tracker; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.phonics_tracker (
    id integer NOT NULL,
    child_id integer,
    sound text NOT NULL,
    phase integer,
    status text DEFAULT 'not_introduced'::text,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT phonics_tracker_status_check CHECK ((status = ANY (ARRAY['not_introduced'::text, 'introduced'::text, 'secure'::text, 'mastered'::text])))
);


--
-- Name: phonics_tracker_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.phonics_tracker_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phonics_tracker_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.phonics_tracker_id_seq OWNED BY demo_eyfs.phonics_tracker.id;


--
-- Name: planned_activities; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.planned_activities (
    id integer NOT NULL,
    plan_date date NOT NULL,
    room_id integer,
    slot text NOT NULL,
    activity_id integer,
    custom_title text,
    custom_notes text,
    led_by integer,
    created_at timestamp with time zone DEFAULT now(),
    scope character varying(20) DEFAULT 'group'::character varying,
    child_id integer,
    next_step_id integer,
    source_observation_id integer,
    status character varying(20) DEFAULT 'planned'::character varying,
    happened_observation_id integer,
    title text,
    description text
);


--
-- Name: planned_activities_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.planned_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planned_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.planned_activities_id_seq OWNED BY demo_eyfs.planned_activities.id;


--
-- Name: planning_activities; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.planning_activities (
    id integer NOT NULL,
    title character varying NOT NULL,
    description text,
    age_group character varying,
    duration_minutes integer,
    eyfs_areas text[],
    learning_objectives text[],
    materials_needed text[],
    setup_instructions text,
    step_by_step text,
    extension_ideas text,
    sen_adaptations text,
    risk_notes text,
    photo_paths text[],
    created_by character varying,
    tags text[],
    difficulty character varying,
    times_used integer DEFAULT 0,
    last_used_at timestamp with time zone,
    favourited_by text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT planning_activities_age_group_check CHECK (((age_group)::text = ANY ((ARRAY['baby'::character varying, 'toddler'::character varying, 'preschool'::character varying, 'mixed'::character varying])::text[]))),
    CONSTRAINT planning_activities_difficulty_check CHECK (((difficulty)::text = ANY ((ARRAY['easy'::character varying, 'moderate'::character varying, 'challenging'::character varying])::text[])))
);


--
-- Name: planning_activities_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.planning_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planning_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.planning_activities_id_seq OWNED BY demo_eyfs.planning_activities.id;


--
-- Name: planning_preferences; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.planning_preferences (
    id integer NOT NULL,
    room_id integer,
    planning_levels jsonb DEFAULT '["long_term", "medium_term", "weekly"]'::jsonb,
    custom_levels jsonb DEFAULT '[]'::jsonb,
    ai_auto_plan boolean DEFAULT false,
    differentiate_sen boolean DEFAULT true,
    preferred_frameworks text[] DEFAULT ARRAY['eyfs'::text],
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: planning_preferences_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.planning_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planning_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.planning_preferences_id_seq OWNED BY demo_eyfs.planning_preferences.id;


--
-- Name: policies; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.policies (
    id integer NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    category text,
    required_roles text[] DEFAULT ARRAY['practitioner'::text, 'room_leader'::text, 'manager'::text],
    is_active boolean DEFAULT true,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: policies_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.policies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: policies_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.policies_id_seq OWNED BY demo_eyfs.policies.id;


--
-- Name: policy_acknowledgments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.policy_acknowledgments (
    id integer NOT NULL,
    policy_id integer NOT NULL,
    staff_id integer NOT NULL,
    acknowledged_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_version integer NOT NULL
);


--
-- Name: policy_acknowledgments_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.policy_acknowledgments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: policy_acknowledgments_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.policy_acknowledgments_id_seq OWNED BY demo_eyfs.policy_acknowledgments.id;


--
-- Name: refresh_tokens; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.refresh_tokens (
    id integer NOT NULL,
    token_hash text NOT NULL,
    parent_email text NOT NULL,
    child_id integer,
    issued_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false,
    device_hint text
);


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.refresh_tokens_id_seq OWNED BY demo_eyfs.refresh_tokens.id;


--
-- Name: regulatory_alerts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.regulatory_alerts (
    id integer NOT NULL,
    source_id integer,
    detected_at timestamp with time zone DEFAULT now(),
    alert_type character varying(30),
    title text NOT NULL,
    summary text,
    url text,
    raw_content text,
    ai_analysis jsonb,
    status character varying(20) DEFAULT 'new'::character varying,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    related_workspace_id integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: regulatory_alerts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.regulatory_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: regulatory_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.regulatory_alerts_id_seq OWNED BY demo_eyfs.regulatory_alerts.id;


--
-- Name: regulatory_policy_links; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.regulatory_policy_links (
    id integer NOT NULL,
    source_id integer,
    policy_id integer NOT NULL,
    relationship character varying(30),
    confidence character varying(10),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: regulatory_policy_links_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.regulatory_policy_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: regulatory_policy_links_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.regulatory_policy_links_id_seq OWNED BY demo_eyfs.regulatory_policy_links.id;


--
-- Name: regulatory_sources; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.regulatory_sources (
    id integer NOT NULL,
    source_key character varying(50) NOT NULL,
    name character varying(200) NOT NULL,
    publisher character varying(100) NOT NULL,
    url text NOT NULL,
    feed_url text,
    feed_type character varying(20),
    poll_interval_hours integer DEFAULT 24,
    category character varying(40),
    importance character varying(20) DEFAULT 'normal'::character varying,
    is_active boolean DEFAULT true,
    last_polled_at timestamp with time zone,
    last_seen_hash text,
    last_known_version text,
    last_error text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: regulatory_sources_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.regulatory_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: regulatory_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.regulatory_sources_id_seq OWNED BY demo_eyfs.regulatory_sources.id;


--
-- Name: repairs; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.repairs (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    location text,
    priority text DEFAULT 'medium'::text,
    status text DEFAULT 'reported'::text,
    reported_by integer,
    assigned_to integer,
    reported_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone,
    resolution_notes text,
    photo_uploads jsonb DEFAULT '[]'::jsonb,
    category character varying(40),
    severity character varying(15) DEFAULT 'normal'::character varying,
    photo_path text,
    resolved_by_staff_id integer,
    external_contractor character varying(120),
    cost_estimate numeric(10,2),
    cost_actual numeric(10,2),
    CONSTRAINT repairs_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT repairs_status_check CHECK ((status = ANY (ARRAY['reported'::text, 'in_progress'::text, 'resolved'::text, 'cancelled'::text])))
);


--
-- Name: repairs_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.repairs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: repairs_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.repairs_id_seq OWNED BY demo_eyfs.repairs.id;


--
-- Name: reports; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.reports (
    id integer NOT NULL,
    child_id integer,
    staff_id integer,
    report_type text,
    content jsonb,
    ai_generated boolean DEFAULT false,
    shared_with_parents boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: reports_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reports_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.reports_id_seq OWNED BY demo_eyfs.reports.id;


--
-- Name: resources; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.resources (
    id integer DEFAULT nextval('demo_eyfs.resources_id_seq'::regclass) NOT NULL,
    title text NOT NULL,
    content_html text,
    source_url text,
    category text DEFAULT 'general'::text,
    published boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: risk_assessment_hazards; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.risk_assessment_hazards (
    id integer NOT NULL,
    risk_assessment_id integer NOT NULL,
    hazard text NOT NULL,
    who_at_risk text,
    existing_controls text,
    residual_risk text,
    additional_controls text,
    responsible_person text,
    display_order integer DEFAULT 0,
    CONSTRAINT risk_assessment_hazards_residual_risk_check CHECK ((residual_risk = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))
);


--
-- Name: risk_assessment_hazards_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.risk_assessment_hazards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: risk_assessment_hazards_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.risk_assessment_hazards_id_seq OWNED BY demo_eyfs.risk_assessment_hazards.id;


--
-- Name: risk_assessment_templates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.risk_assessment_templates (
    id integer NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    description text,
    hazards_template jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: risk_assessment_templates_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.risk_assessment_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: risk_assessment_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.risk_assessment_templates_id_seq OWNED BY demo_eyfs.risk_assessment_templates.id;


--
-- Name: risk_assessments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.risk_assessments (
    id integer NOT NULL,
    template_id integer,
    title text NOT NULL,
    category text NOT NULL,
    location text,
    activity text,
    persons_at_risk text[],
    assessment_date date DEFAULT CURRENT_DATE,
    review_date date,
    status text DEFAULT 'draft'::text,
    severity_before text,
    severity_after text,
    outing_id integer,
    created_by integer,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    approved_by integer,
    approved_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT risk_assessments_severity_after_check CHECK ((severity_after = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT risk_assessments_severity_before_check CHECK ((severity_before = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT risk_assessments_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'reviewed'::text, 'approved'::text, 'archived'::text])))
);


--
-- Name: risk_assessments_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.risk_assessments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: risk_assessments_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.risk_assessments_id_seq OWNED BY demo_eyfs.risk_assessments.id;


--
-- Name: rooms; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.rooms (
    id integer NOT NULL,
    name text NOT NULL,
    display_name text,
    min_age_months integer DEFAULT 0,
    max_age_months integer DEFAULT 216,
    capacity integer DEFAULT 30,
    year_group text,
    key_stage text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: rooms_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.rooms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rooms_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.rooms_id_seq OWNED BY demo_eyfs.rooms.id;


--
-- Name: rota_shifts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.rota_shifts (
    id integer NOT NULL,
    rota_week_id integer NOT NULL,
    staff_id integer NOT NULL,
    shift_date date NOT NULL,
    planned_start time without time zone,
    planned_end time without time zone,
    room_id integer,
    break_mins integer DEFAULT 30,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: rota_shifts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.rota_shifts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rota_shifts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.rota_shifts_id_seq OWNED BY demo_eyfs.rota_shifts.id;


--
-- Name: rota_weeks; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.rota_weeks (
    id integer NOT NULL,
    week_start date NOT NULL,
    published_at timestamp with time zone,
    published_by integer,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: rota_weeks_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.rota_weeks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rota_weeks_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.rota_weeks_id_seq OWNED BY demo_eyfs.rota_weeks.id;


--
-- Name: safeguarding_access_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_access_audit (
    id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer,
    user_name text,
    ip_address text,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    prev_state_hash text,
    new_state_hash text,
    hash_previous text NOT NULL,
    hash_self text NOT NULL
);


--
-- Name: safeguarding_access_audit_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.safeguarding_access_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safeguarding_access_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.safeguarding_access_audit_id_seq OWNED BY demo_eyfs.safeguarding_access_audit.id;


--
-- Name: safeguarding_actions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_actions (
    id integer NOT NULL,
    concern_id integer,
    action_by integer,
    action_text text NOT NULL,
    due_date date,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: safeguarding_actions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.safeguarding_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safeguarding_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.safeguarding_actions_id_seq OWNED BY demo_eyfs.safeguarding_actions.id;


--
-- Name: safeguarding_categories; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_categories (
    id text NOT NULL,
    label text NOT NULL,
    group_name text NOT NULL,
    description text,
    is_statutory boolean DEFAULT false
);


--
-- Name: safeguarding_concern_persons; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_concern_persons (
    concern_id integer NOT NULL,
    person_id integer NOT NULL,
    person_type text NOT NULL,
    role text NOT NULL,
    visible_to_other_subjects boolean DEFAULT false,
    notes text,
    CONSTRAINT safeguarding_concern_persons_person_type_check CHECK ((person_type = ANY (ARRAY['child'::text, 'adult'::text, 'staff'::text]))),
    CONSTRAINT safeguarding_concern_persons_role_check CHECK ((role = ANY (ARRAY['subject'::text, 'witness'::text, 'alleged_perpetrator'::text, 'linked'::text])))
);


--
-- Name: safeguarding_concerns; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_concerns (
    id integer NOT NULL,
    child_id integer,
    reported_by integer,
    witnessed_by integer,
    concern_date timestamp with time zone DEFAULT now() NOT NULL,
    category text NOT NULL,
    subcategory text,
    description text NOT NULL,
    immediate_action text,
    is_referral boolean DEFAULT false,
    referral_agency text,
    referral_date date,
    referral_reference text,
    is_confidential boolean DEFAULT true,
    status text DEFAULT 'new'::text,
    dsl_notes text,
    dsl_reviewed_by integer,
    dsl_reviewed_at timestamp with time zone,
    closed_by integer,
    closed_at timestamp with time zone,
    close_reason text,
    attachments jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    body_map_data jsonb,
    CONSTRAINT safeguarding_concerns_status_check CHECK ((status = ANY (ARRAY['new'::text, 'under_review'::text, 'action_taken'::text, 'referred'::text, 'closed'::text])))
);


--
-- Name: safeguarding_concerns_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.safeguarding_concerns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safeguarding_concerns_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.safeguarding_concerns_id_seq OWNED BY demo_eyfs.safeguarding_concerns.id;


--
-- Name: safeguarding_escalation_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_escalation_log (
    id integer NOT NULL,
    concern_id integer,
    from_level text,
    to_level text,
    escalated_by integer,
    escalated_to text,
    reason text,
    sla_hours integer,
    due_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: safeguarding_escalation_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.safeguarding_escalation_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safeguarding_escalation_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.safeguarding_escalation_log_id_seq OWNED BY demo_eyfs.safeguarding_escalation_log.id;


--
-- Name: safeguarding_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_log (
    id integer NOT NULL,
    child_id integer,
    reported_by integer,
    concern_date date DEFAULT CURRENT_DATE,
    concern_type text,
    description text,
    action_taken text,
    referred_to text,
    status text DEFAULT 'open'::text,
    confidential boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: safeguarding_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.safeguarding_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safeguarding_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.safeguarding_log_id_seq OWNED BY demo_eyfs.safeguarding_log.id;


--
-- Name: safeguarding_training; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_training (
    id integer NOT NULL,
    staff_id integer,
    training_type text,
    completed_date date,
    expiry_date date,
    provider text,
    notes text
);


--
-- Name: safeguarding_training_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.safeguarding_training_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safeguarding_training_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.safeguarding_training_id_seq OWNED BY demo_eyfs.safeguarding_training.id;


--
-- Name: safeguarding_transfers; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.safeguarding_transfers (
    id integer NOT NULL,
    child_id integer NOT NULL,
    destination_school text NOT NULL,
    destination_urn text,
    transfer_date date,
    initiated_by integer,
    bundle_hash text,
    bundle_encrypted boolean DEFAULT false,
    received_confirmed boolean DEFAULT false,
    received_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: safeguarding_transfers_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.safeguarding_transfers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safeguarding_transfers_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.safeguarding_transfers_id_seq OWNED BY demo_eyfs.safeguarding_transfers.id;


--
-- Name: security_check_results; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.security_check_results (
    id integer NOT NULL,
    check_key text NOT NULL,
    ran_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'pass'::text,
    finding text,
    remediation text,
    evidence_json jsonb,
    duration_ms integer,
    triggered_by text
);


--
-- Name: security_check_results_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.security_check_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_check_results_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.security_check_results_id_seq OWNED BY demo_eyfs.security_check_results.id;


--
-- Name: security_checks; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.security_checks (
    id integer NOT NULL,
    check_key text NOT NULL,
    category text DEFAULT 'general'::text,
    title text NOT NULL,
    description text,
    frequency_hours integer DEFAULT 24,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: security_checks_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.security_checks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.security_checks_id_seq OWNED BY demo_eyfs.security_checks.id;


--
-- Name: sen_register; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.sen_register (
    id integer NOT NULL,
    child_id integer,
    sen_type text,
    primary_need text,
    secondary_need text,
    ehcp_date date,
    review_date date,
    annual_review_date date,
    external_professionals jsonb DEFAULT '[]'::jsonb,
    provision_map text,
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    support_plan text,
    targets jsonb,
    specialist_frameworks text[],
    specialist_notes text,
    parent_involvement_notes text,
    external_agency text,
    eycp_outcome text,
    graduated_approach text,
    CONSTRAINT sen_register_sen_type_check CHECK ((sen_type = ANY (ARRAY['ehcp'::text, 'sen_support'::text, 'monitoring'::text])))
);


--
-- Name: sen_register_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.sen_register_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sen_register_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.sen_register_id_seq OWNED BY demo_eyfs.sen_register.id;


--
-- Name: settings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.settings (
    key text NOT NULL,
    value text,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: shopping_lists; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.shopping_lists (
    id integer NOT NULL,
    week_start_date date NOT NULL,
    room character varying(20) DEFAULT 'preschool'::character varying NOT NULL,
    generated_at timestamp without time zone DEFAULT now(),
    status character varying(20) DEFAULT 'pending'::character varying,
    supplier character varying(100) DEFAULT 'Sainsburys'::character varying,
    items_json jsonb,
    order_total_pence integer,
    sainsburys_order_id text,
    ordered_by character varying(100),
    ordered_at timestamp without time zone,
    delivered_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: shopping_lists_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.shopping_lists_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopping_lists_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.shopping_lists_id_seq OWNED BY demo_eyfs.shopping_lists.id;


--
-- Name: sleep_checks; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.sleep_checks (
    id integer NOT NULL,
    child_id integer,
    staff_id integer,
    check_time timestamp with time zone DEFAULT now(),
    is_sleeping boolean DEFAULT true,
    "position" text,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: sleep_checks_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.sleep_checks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sleep_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.sleep_checks_id_seq OWNED BY demo_eyfs.sleep_checks.id;


--
-- Name: staff; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff (
    id integer NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    preferred_name text,
    email text,
    phone text,
    role text DEFAULT 'practitioner'::text NOT NULL,
    room_id integer,
    pin_hash text,
    employment_type text DEFAULT 'permanent'::text,
    contracted_hours numeric(5,2),
    contract_start date,
    contract_end date,
    is_active boolean DEFAULT true,
    address_line1 text,
    address_line2 text,
    postcode text,
    date_of_birth date,
    ni_number text,
    dbs_number text,
    dbs_expiry date,
    emergency_contact_name text,
    emergency_contact_phone text,
    emergency_contact_relation text,
    profile_photo text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    scope character varying(50) DEFAULT 'all'::character varying,
    scope_value character varying(100) DEFAULT NULL::character varying,
    password_hash text,
    tax_code text,
    payroll_reference text,
    contract_type text,
    hours_per_week numeric(6,2),
    holiday_entitlement_days numeric(6,2),
    pension_eligible boolean,
    pension_employer_contribution numeric(6,4),
    pension_employee_contribution numeric(6,4),
    dbs_initial_date date,
    dbs_check_date date,
    dbs_followup_date date,
    right_to_work_status text,
    right_to_work_check_date date,
    right_to_work_expiry_date date,
    visa_number text,
    visa_expiry_date date,
    terminated boolean DEFAULT false,
    termination_date date,
    brighthr_imported_at timestamp with time zone,
    telegram_linked_at timestamp with time zone,
    telegram_link_code character varying(20),
    telegram_link_code_expires timestamp with time zone,
    telegram_chat_id character varying(50),
    CONSTRAINT staff_role_check CHECK ((role = ANY (ARRAY['manager'::text, 'deputy_manager'::text, 'room_leader'::text, 'practitioner'::text, 'apprentice'::text, 'admin'::text, 'cook'::text])))
);


--
-- Name: staff_attendance; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_attendance (
    id integer NOT NULL,
    staff_id integer,
    date date DEFAULT CURRENT_DATE NOT NULL,
    clock_in timestamp with time zone,
    clock_out timestamp with time zone,
    source text DEFAULT 'manual'::text,
    notes text,
    scheduled_start time without time zone,
    scheduled_end time without time zone,
    hours_worked numeric(5,2),
    break_start timestamp with time zone,
    break_end timestamp with time zone
);


--
-- Name: staff_attendance_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_attendance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_attendance_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_attendance_id_seq OWNED BY demo_eyfs.staff_attendance.id;


--
-- Name: staff_clock_events; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_clock_events (
    id integer NOT NULL,
    staff_id integer,
    event_type character varying(20) NOT NULL,
    method character varying(30) DEFAULT 'fob'::character varying,
    fob_uid character varying(50),
    door_name character varying(100),
    event_time timestamp with time zone DEFAULT now() NOT NULL,
    confidence numeric(5,2),
    source_raw jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_clock_events_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_clock_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_clock_events_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_clock_events_id_seq OWNED BY demo_eyfs.staff_clock_events.id;


--
-- Name: staff_compliance; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_compliance (
    id integer NOT NULL,
    staff_id integer,
    check_type text,
    issued_date date,
    expiry_date date,
    certificate_number text,
    status text DEFAULT 'valid'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_compliance_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_compliance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_compliance_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_compliance_id_seq OWNED BY demo_eyfs.staff_compliance.id;


--
-- Name: staff_contracts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_contracts (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    start_date date,
    end_date date,
    employment_type text,
    contracted_hours numeric,
    annual_salary_pennies bigint,
    job_title text,
    department text,
    brighthr_ref text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    template_id integer,
    contract_data jsonb,
    generated_pdf_path text,
    sent_at timestamp with time zone,
    sent_to_email text,
    sign_token character varying(64),
    staff_signature_data text,
    staff_signature_at timestamp with time zone,
    staff_signature_ip character varying(45),
    employer_signature_data text,
    employer_signature_at timestamp with time zone,
    employer_signature_by integer,
    signed_pdf_path text,
    handbook_version_sent character varying(20),
    status character varying(20) DEFAULT 'draft'::character varying,
    pay_rate_type character varying(20),
    pay_rate_pennies bigint,
    working_pattern jsonb,
    holiday_entitlement_days numeric(5,2),
    probation_period_weeks integer,
    notice_period_weeks integer,
    pension_eligible boolean,
    pension_employer_contribution_pct numeric(5,2),
    pension_employee_contribution_pct numeric(5,2)
);


--
-- Name: staff_contracts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_contracts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_contracts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_contracts_id_seq OWNED BY demo_eyfs.staff_contracts.id;


--
-- Name: staff_entitlement; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_entitlement (
    id integer DEFAULT nextval('demo_eyfs.staff_entitlement_id_seq'::regclass) NOT NULL,
    staff_id integer,
    annual_leave_days numeric(4,1) DEFAULT 28,
    carried_over_days numeric(4,1) DEFAULT 0,
    used_days numeric(4,1) DEFAULT 0,
    year text DEFAULT '2025-2026'::text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_fobs; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_fobs (
    id integer NOT NULL,
    staff_id integer,
    fob_uid character varying(50) NOT NULL,
    label character varying(100),
    is_active boolean DEFAULT true,
    registered_at timestamp with time zone DEFAULT now(),
    deactivated_at timestamp with time zone
);


--
-- Name: staff_fobs_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_fobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_fobs_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_fobs_id_seq OWNED BY demo_eyfs.staff_fobs.id;


--
-- Name: staff_handbook_versions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_handbook_versions (
    id integer NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    title text DEFAULT 'Staff Handbook'::text NOT NULL,
    content_md text,
    pdf_path text,
    is_current boolean DEFAULT false NOT NULL,
    published_by integer,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    effective_date date,
    source_doc_path text,
    changes_summary text,
    approved_by integer
);


--
-- Name: staff_handbook_versions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_handbook_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_handbook_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_handbook_versions_id_seq OWNED BY demo_eyfs.staff_handbook_versions.id;


--
-- Name: staff_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_id_seq OWNED BY demo_eyfs.staff.id;


--
-- Name: staff_performance_flags; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_performance_flags (
    id integer NOT NULL,
    staff_id integer,
    flag_type character varying(100) NOT NULL,
    flag_data jsonb DEFAULT '{}'::jsonb,
    period_start date NOT NULL,
    period_end date NOT NULL,
    generated_at timestamp with time zone DEFAULT now(),
    acknowledged_at timestamp with time zone,
    acknowledged_by integer
);


--
-- Name: staff_performance_flags_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_performance_flags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_performance_flags_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_performance_flags_id_seq OWNED BY demo_eyfs.staff_performance_flags.id;


--
-- Name: staff_room_allocations; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_room_allocations (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    room_id integer NOT NULL,
    percentage numeric(5,2) NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    CONSTRAINT staff_room_allocations_percentage_check CHECK (((percentage > (0)::numeric) AND (percentage <= (100)::numeric)))
);


--
-- Name: staff_room_allocations_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_room_allocations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_room_allocations_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_room_allocations_id_seq OWNED BY demo_eyfs.staff_room_allocations.id;


--
-- Name: staff_shifts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_shifts (
    id integer NOT NULL,
    staff_id integer,
    shift_date date NOT NULL,
    clock_in_time timestamp with time zone,
    clock_out_time timestamp with time zone,
    total_minutes integer,
    method character varying(30),
    status character varying(20) DEFAULT 'open'::character varying,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_shifts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_shifts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_shifts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_shifts_id_seq OWNED BY demo_eyfs.staff_shifts.id;


--
-- Name: supervision_question_templates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.supervision_question_templates (
    id integer NOT NULL,
    template_name character varying(100) DEFAULT 'standard'::character varying NOT NULL,
    ordinal integer NOT NULL,
    question_text text NOT NULL,
    keywords text[],
    is_active boolean DEFAULT true NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supervision_question_templates_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.supervision_question_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supervision_question_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.supervision_question_templates_id_seq OWNED BY demo_eyfs.supervision_question_templates.id;


--
-- Name: supervision_targets; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.supervision_targets (
    id integer DEFAULT nextval('demo_eyfs.supervision_targets_id_seq'::regclass) NOT NULL,
    staff_id integer,
    supervision_id integer,
    target_text text NOT NULL,
    area text,
    due_date date,
    achieved boolean DEFAULT false,
    achieved_date date,
    progress_notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: supervisions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.supervisions (
    id integer DEFAULT nextval('demo_eyfs.supervisions_id_seq'::regclass) NOT NULL,
    staff_id integer,
    scheduled_date date,
    conducted_date date,
    status text DEFAULT 'scheduled'::text,
    supervisor_id integer,
    pre_questionnaire_responses jsonb,
    wellbeing_score numeric(3,1),
    manager_notes text,
    transcript text,
    audio_url text,
    ai_summary text,
    wellbeing_rag text,
    wellbeing_rag_reason text,
    agreed_targets jsonb,
    manager_actions jsonb,
    next_supervision_date date,
    staff_signature_at timestamp with time zone,
    manager_signature_at timestamp with time zone,
    form_token text,
    created_at timestamp with time zone DEFAULT now(),
    type character varying DEFAULT 'monthly_1to1'::character varying,
    agenda_items jsonb DEFAULT '[]'::jsonb,
    discussion_notes text,
    action_items jsonb DEFAULT '[]'::jsonb,
    audio_recording_path text,
    ai_summary_generated_at timestamp with time zone,
    staff_signoff boolean DEFAULT false,
    supervisor_signoff boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now(),
    mode character varying(20) DEFAULT 'form'::character varying NOT NULL,
    notes_json jsonb,
    audio_path text,
    duration_seconds integer,
    finalized_at timestamp with time zone
);


--
-- Name: survey_responses; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.survey_responses (
    id integer DEFAULT nextval('demo_eyfs.survey_responses_id_seq'::regclass) NOT NULL,
    survey_type text NOT NULL,
    responses jsonb NOT NULL,
    submitted_at timestamp with time zone DEFAULT now()
);


--
-- Name: tag_definitions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.tag_definitions (
    id integer NOT NULL,
    tag text NOT NULL,
    category text NOT NULL,
    colour text DEFAULT '#64748b'::text,
    description text,
    is_active boolean DEFAULT true
);


--
-- Name: tag_definitions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.tag_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tag_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.tag_definitions_id_seq OWNED BY demo_eyfs.tag_definitions.id;


--
-- Name: term_plans; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.term_plans (
    id integer DEFAULT nextval('demo_eyfs.term_plans_id_seq'::regclass) NOT NULL,
    room_id integer,
    term_name text NOT NULL,
    academic_year text DEFAULT '2025-2026'::text,
    theme text,
    learning_intentions text[],
    key_books text[],
    songs text[],
    events jsonb,
    created_at timestamp with time zone DEFAULT now(),
    eyfs_grid jsonb DEFAULT '{}'::jsonb
);


--
-- Name: timetable; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.timetable (
    id integer NOT NULL,
    room_id integer,
    staff_id integer,
    day_of_week integer,
    start_time time without time zone,
    end_time time without time zone,
    subject text,
    effective_from date DEFAULT CURRENT_DATE,
    effective_to date,
    notes text,
    CONSTRAINT timetable_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6)))
);


--
-- Name: timetable_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.timetable_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: timetable_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.timetable_id_seq OWNED BY demo_eyfs.timetable.id;


--
-- Name: toil_entries; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.toil_entries (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    type text NOT NULL,
    hours numeric(6,2) NOT NULL,
    occurred_on date NOT NULL,
    reason text,
    approved_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT toil_entries_type_check CHECK ((type = ANY (ARRAY['earned'::text, 'used'::text, 'adjustment'::text])))
);


--
-- Name: toil_entries_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.toil_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: toil_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.toil_entries_id_seq OWNED BY demo_eyfs.toil_entries.id;


--
-- Name: transcriptions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.transcriptions (
    id integer NOT NULL,
    staff_id integer,
    created_at timestamp with time zone DEFAULT now(),
    duration_seconds numeric(5,2),
    text text NOT NULL,
    context text,
    audio_url text
);


--
-- Name: transcriptions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.transcriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transcriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.transcriptions_id_seq OWNED BY demo_eyfs.transcriptions.id;


--
-- Name: user_preferences; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.user_preferences (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    preference_key character varying(100) NOT NULL,
    preference_value text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_preferences_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.user_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.user_preferences_id_seq OWNED BY demo_eyfs.user_preferences.id;


--
-- Name: vapi_calls; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.vapi_calls (
    id integer NOT NULL,
    call_id text,
    caller_number text,
    caller_name text,
    started_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    duration_seconds integer,
    transcript text,
    summary text,
    urgency text DEFAULT 'normal'::text,
    reviewed_at timestamp with time zone,
    reviewed_by integer,
    follow_up_task_id integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: vapi_calls_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.vapi_calls_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vapi_calls_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.vapi_calls_id_seq OWNED BY demo_eyfs.vapi_calls.id;


--
-- Name: waiting_list; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.waiting_list (
    id integer NOT NULL,
    child_first_name text NOT NULL,
    child_last_name text NOT NULL,
    child_dob date,
    room_needed text,
    expected_start_date date,
    parent_name text,
    parent_email text,
    parent_phone text,
    source text,
    status text DEFAULT 'waiting'::text,
    notes text,
    date_added timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    enquiry_id integer,
    priority integer,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: waiting_list_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.waiting_list_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: waiting_list_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.waiting_list_id_seq OWNED BY demo_eyfs.waiting_list.id;


--
-- Name: weekly_menus; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.weekly_menus (
    id integer NOT NULL,
    week_start date,
    day_of_week text,
    meal_type text,
    description text,
    allergens text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: weekly_menus_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.weekly_menus_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: weekly_menus_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.weekly_menus_id_seq OWNED BY demo_eyfs.weekly_menus.id;


--
-- Name: weekly_plans; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.weekly_plans (
    id integer NOT NULL,
    room_id integer,
    week_commencing date,
    theme text,
    day text,
    activity_type text,
    activity_title text,
    role_of_adult text,
    staff_id integer,
    resources text,
    eyfs_areas text[],
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    differentiation jsonb DEFAULT '[]'::jsonb,
    ai_generated boolean DEFAULT false,
    eyfs_area text
);


--
-- Name: weekly_plans_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.weekly_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: weekly_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.weekly_plans_id_seq OWNED BY demo_eyfs.weekly_plans.id;


--
-- Name: wellbeing_checkins; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.wellbeing_checkins (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    mood_score integer,
    workload_score integer,
    supported_score integer,
    notes text,
    is_concern boolean DEFAULT false,
    checked_in_at timestamp with time zone DEFAULT now(),
    CONSTRAINT wellbeing_checkins_mood_score_check CHECK (((mood_score >= 1) AND (mood_score <= 5))),
    CONSTRAINT wellbeing_checkins_supported_score_check CHECK (((supported_score >= 1) AND (supported_score <= 5))),
    CONSTRAINT wellbeing_checkins_workload_score_check CHECK (((workload_score >= 1) AND (workload_score <= 5)))
);


--
-- Name: wellbeing_checkins_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.wellbeing_checkins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wellbeing_checkins_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.wellbeing_checkins_id_seq OWNED BY demo_eyfs.wellbeing_checkins.id;


--
-- Name: wren_settings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.wren_settings (
    key character varying(100) NOT NULL,
    value jsonb DEFAULT 'null'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: wren_workflow_executions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.wren_workflow_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instance_id uuid,
    template_name text,
    triggered_by text,
    triggered_by_staff_id integer,
    status text DEFAULT 'pending'::text,
    n8n_execution_id text,
    payload jsonb DEFAULT '{}'::jsonb,
    result jsonb DEFAULT '{}'::jsonb,
    error text,
    started_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone
);


--
-- Name: wren_workflow_instances; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.wren_workflow_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid,
    school_schema text DEFAULT 'ladn'::text NOT NULL,
    enabled boolean DEFAULT false,
    overrides jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: wren_workflow_templates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.wren_workflow_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    edition text[] DEFAULT '{}'::text[],
    category text,
    trigger_type text DEFAULT 'manual'::text,
    trigger_config jsonb DEFAULT '{}'::jsonb,
    workflow_json jsonb DEFAULT '{}'::jsonb,
    audit_required boolean DEFAULT true,
    who_can_run text DEFAULT 'admin'::text,
    who_can_edit text DEFAULT 'admin'::text,
    is_builtin boolean DEFAULT true,
    enabled_by_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: absence_requests id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.absence_requests ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.absence_requests_id_seq'::regclass);


--
-- Name: action_plan_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.action_plan_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.action_plan_audit_id_seq'::regclass);


--
-- Name: action_plan_comments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.action_plan_comments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.action_plan_comments_id_seq'::regclass);


--
-- Name: action_plan_items id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.action_plan_items ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.action_plan_items_id_seq'::regclass);


--
-- Name: assessments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assessments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.assessments_id_seq'::regclass);


--
-- Name: attendance id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.attendance ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.attendance_id_seq'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.audit_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.audit_log_id_seq'::regclass);


--
-- Name: behaviour_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.behaviour_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.behaviour_log_id_seq'::regclass);


--
-- Name: calendar_feed_tokens id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.calendar_feed_tokens ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.calendar_feed_tokens_id_seq'::regclass);


--
-- Name: certificates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.certificates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.certificates_id_seq'::regclass);


--
-- Name: child_about_me id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_about_me ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_about_me_id_seq'::regclass);


--
-- Name: child_phonics_progress id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_phonics_progress ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_phonics_progress_id_seq'::regclass);


--
-- Name: child_tags id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_tags ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_tags_id_seq'::regclass);


--
-- Name: children id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.children ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.children_id_seq'::regclass);


--
-- Name: comms_email_queue id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_email_queue ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.comms_email_queue_id_seq'::regclass);


--
-- Name: comms_emails id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_emails ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.comms_emails_id_seq'::regclass);


--
-- Name: compliance_events id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.compliance_events ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.compliance_events_id_seq'::regclass);


--
-- Name: contract_signature_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contract_signature_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.contract_signature_log_id_seq'::regclass);


--
-- Name: contract_templates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contract_templates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.contract_templates_id_seq'::regclass);


--
-- Name: coshh_register id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.coshh_register ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.coshh_register_id_seq'::regclass);


--
-- Name: course_attempts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_attempts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.course_attempts_id_seq'::regclass);


--
-- Name: course_quiz_questions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_quiz_questions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.course_quiz_questions_id_seq'::regclass);


--
-- Name: course_sections id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_sections ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.course_sections_id_seq'::regclass);


--
-- Name: courses id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.courses ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.courses_id_seq'::regclass);


--
-- Name: cp_register id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cp_register ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.cp_register_id_seq'::regclass);


--
-- Name: cpd_records id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_records ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.cpd_records_id_seq'::regclass);


--
-- Name: curriculum_activities id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.curriculum_activities ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.curriculum_activities_id_seq'::regclass);


--
-- Name: curriculum_plans id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.curriculum_plans ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.curriculum_plans_id_seq'::regclass);


--
-- Name: daily_diary id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.daily_diary ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.daily_diary_id_seq'::regclass);


--
-- Name: decision_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.decision_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.decision_log_id_seq'::regclass);


--
-- Name: document_workspace_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.document_workspace_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.document_workspace_audit_id_seq'::regclass);


--
-- Name: document_workspaces id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.document_workspaces ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.document_workspaces_id_seq'::regclass);


--
-- Name: enquiries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enquiries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.enquiries_id_seq'::regclass);


--
-- Name: environment_assessments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.environment_assessments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.environment_assessments_id_seq'::regclass);


--
-- Name: exclusions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.exclusions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.exclusions_id_seq'::regclass);


--
-- Name: finance_accounts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_accounts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.finance_accounts_id_seq'::regclass);


--
-- Name: finance_invoices id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_invoices ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.finance_invoices_id_seq'::regclass);


--
-- Name: finance_monthly_balances id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_monthly_balances ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.finance_monthly_balances_id_seq'::regclass);


--
-- Name: finance_payments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_payments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.finance_payments_id_seq'::regclass);


--
-- Name: finance_providers id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_providers ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.finance_providers_id_seq'::regclass);


--
-- Name: finance_sync_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_sync_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.finance_sync_log_id_seq'::regclass);


--
-- Name: fire_drills id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.fire_drills ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.fire_drills_id_seq'::regclass);


--
-- Name: fire_equipment_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.fire_equipment_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.fire_equipment_log_id_seq'::regclass);


--
-- Name: food_intake_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.food_intake_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.food_intake_log_id_seq'::regclass);


--
-- Name: framework_statements id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.framework_statements ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.framework_statements_id_seq'::regclass);


--
-- Name: gias_cache id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gias_cache ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.gias_cache_id_seq'::regclass);


--
-- Name: gocardless_mandates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gocardless_mandates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.gocardless_mandates_id_seq'::regclass);


--
-- Name: hr_absences id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_absences ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.hr_absences_id_seq'::regclass);


--
-- Name: hr_holiday_entitlement id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_holiday_entitlement ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.hr_holiday_entitlement_id_seq'::regclass);


--
-- Name: hr_import_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_import_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.hr_import_audit_id_seq'::regclass);


--
-- Name: hr_overtime id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_overtime ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.hr_overtime_id_seq'::regclass);


--
-- Name: hr_toil_entries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_toil_entries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.hr_toil_entries_id_seq'::regclass);


--
-- Name: incidents id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.incidents ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.incidents_id_seq'::regclass);


--
-- Name: ingredients id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ingredients ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.ingredients_id_seq'::regclass);


--
-- Name: inspection_access_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.inspection_access_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.inspection_access_log_id_seq'::regclass);


--
-- Name: inspection_action_items id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.inspection_action_items ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.inspection_action_items_id_seq'::regclass);


--
-- Name: inspection_briefings id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.inspection_briefings ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.inspection_briefings_id_seq'::regclass);


--
-- Name: inspection_modes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.inspection_modes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.inspection_modes_id_seq'::regclass);


--
-- Name: interventions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.interventions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.interventions_id_seq'::regclass);


--
-- Name: invoice_number_seq id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoice_number_seq ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.invoice_number_seq_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoices ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.invoices_id_seq'::regclass);


--
-- Name: medicine_records id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.medicine_records ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.medicine_records_id_seq'::regclass);


--
-- Name: medium_term_plans id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.medium_term_plans ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.medium_term_plans_id_seq'::regclass);


--
-- Name: memory_box_entries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.memory_box_entries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.memory_box_entries_id_seq'::regclass);


--
-- Name: menu_plans id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_plans ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.menu_plans_id_seq'::regclass);


--
-- Name: menu_recipes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_recipes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.menu_recipes_id_seq'::regclass);


--
-- Name: n8n_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.n8n_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.n8n_audit_id_seq'::regclass);


--
-- Name: next_steps id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.next_steps ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.next_steps_id_seq'::regclass);


--
-- Name: notification_deliveries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_deliveries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.notification_deliveries_id_seq'::regclass);


--
-- Name: notification_preferences id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_preferences ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.notification_preferences_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notifications ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.notifications_id_seq'::regclass);


--
-- Name: observations id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observations ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.observations_id_seq'::regclass);


--
-- Name: parent_module_attempts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_module_attempts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_module_attempts_id_seq'::regclass);


--
-- Name: parent_portal_access id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_portal_access ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_portal_access_id_seq'::regclass);


--
-- Name: parent_rewards id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_rewards ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_rewards_id_seq'::regclass);


--
-- Name: parent_study_modules id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_study_modules ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_study_modules_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.payments_id_seq'::regclass);


--
-- Name: permission_slip_responses id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permission_slip_responses ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.permission_slip_responses_id_seq'::regclass);


--
-- Name: permission_slips id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permission_slips ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.permission_slips_id_seq'::regclass);


--
-- Name: phonics_game_sessions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_game_sessions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.phonics_game_sessions_id_seq'::regclass);


--
-- Name: phonics_sounds id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_sounds ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.phonics_sounds_id_seq'::regclass);


--
-- Name: phonics_tracker id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_tracker ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.phonics_tracker_id_seq'::regclass);


--
-- Name: planned_activities id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planned_activities ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.planned_activities_id_seq'::regclass);


--
-- Name: planning_activities id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planning_activities ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.planning_activities_id_seq'::regclass);


--
-- Name: planning_preferences id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planning_preferences ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.planning_preferences_id_seq'::regclass);


--
-- Name: policies id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.policies ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.policies_id_seq'::regclass);


--
-- Name: policy_acknowledgments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.policy_acknowledgments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.policy_acknowledgments_id_seq'::regclass);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.refresh_tokens_id_seq'::regclass);


--
-- Name: regulatory_alerts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_alerts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.regulatory_alerts_id_seq'::regclass);


--
-- Name: regulatory_policy_links id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_policy_links ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.regulatory_policy_links_id_seq'::regclass);


--
-- Name: regulatory_sources id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_sources ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.regulatory_sources_id_seq'::regclass);


--
-- Name: repairs id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.repairs ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.repairs_id_seq'::regclass);


--
-- Name: reports id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reports ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.reports_id_seq'::regclass);


--
-- Name: risk_assessment_hazards id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.risk_assessment_hazards ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.risk_assessment_hazards_id_seq'::regclass);


--
-- Name: risk_assessment_templates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.risk_assessment_templates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.risk_assessment_templates_id_seq'::regclass);


--
-- Name: risk_assessments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.risk_assessments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.risk_assessments_id_seq'::regclass);


--
-- Name: rooms id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rooms ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.rooms_id_seq'::regclass);


--
-- Name: rota_shifts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_shifts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.rota_shifts_id_seq'::regclass);


--
-- Name: rota_weeks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_weeks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.rota_weeks_id_seq'::regclass);


--
-- Name: safeguarding_access_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_access_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.safeguarding_access_audit_id_seq'::regclass);


--
-- Name: safeguarding_actions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_actions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.safeguarding_actions_id_seq'::regclass);


--
-- Name: safeguarding_concerns id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_concerns ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.safeguarding_concerns_id_seq'::regclass);


--
-- Name: safeguarding_escalation_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_escalation_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.safeguarding_escalation_log_id_seq'::regclass);


--
-- Name: safeguarding_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.safeguarding_log_id_seq'::regclass);


--
-- Name: safeguarding_training id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_training ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.safeguarding_training_id_seq'::regclass);


--
-- Name: safeguarding_transfers id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_transfers ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.safeguarding_transfers_id_seq'::regclass);


--
-- Name: security_check_results id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_check_results ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.security_check_results_id_seq'::regclass);


--
-- Name: security_checks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_checks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.security_checks_id_seq'::regclass);


--
-- Name: sen_register id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sen_register ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.sen_register_id_seq'::regclass);


--
-- Name: shopping_lists id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.shopping_lists ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.shopping_lists_id_seq'::regclass);


--
-- Name: sleep_checks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sleep_checks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.sleep_checks_id_seq'::regclass);


--
-- Name: staff id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_id_seq'::regclass);


--
-- Name: staff_attendance id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_attendance ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_attendance_id_seq'::regclass);


--
-- Name: staff_clock_events id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_clock_events ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_clock_events_id_seq'::regclass);


--
-- Name: staff_compliance id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_compliance ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_compliance_id_seq'::regclass);


--
-- Name: staff_contracts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_contracts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_contracts_id_seq'::regclass);


--
-- Name: staff_fobs id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_fobs ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_fobs_id_seq'::regclass);


--
-- Name: staff_handbook_versions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_handbook_versions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_handbook_versions_id_seq'::regclass);


--
-- Name: staff_performance_flags id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_performance_flags ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_performance_flags_id_seq'::regclass);


--
-- Name: staff_room_allocations id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_room_allocations ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_room_allocations_id_seq'::regclass);


--
-- Name: staff_shifts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_shifts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_shifts_id_seq'::regclass);


--
-- Name: supervision_question_templates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervision_question_templates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.supervision_question_templates_id_seq'::regclass);


--
-- Name: tag_definitions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.tag_definitions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.tag_definitions_id_seq'::regclass);


--
-- Name: timetable id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.timetable ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.timetable_id_seq'::regclass);


--
-- Name: toil_entries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.toil_entries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.toil_entries_id_seq'::regclass);


--
-- Name: transcriptions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.transcriptions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.transcriptions_id_seq'::regclass);


--
-- Name: user_preferences id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.user_preferences ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.user_preferences_id_seq'::regclass);


--
-- Name: vapi_calls id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.vapi_calls ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.vapi_calls_id_seq'::regclass);


--
-- Name: waiting_list id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.waiting_list ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.waiting_list_id_seq'::regclass);


--
-- Name: weekly_menus id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.weekly_menus ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.weekly_menus_id_seq'::regclass);


--
-- Name: weekly_plans id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.weekly_plans ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.weekly_plans_id_seq'::regclass);


--
-- Name: wellbeing_checkins id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wellbeing_checkins ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.wellbeing_checkins_id_seq'::regclass);


--
-- Name: absence_requests absence_requests_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.absence_requests
    ADD CONSTRAINT absence_requests_pkey PRIMARY KEY (id);


--
-- Name: action_plan_audit action_plan_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.action_plan_audit
    ADD CONSTRAINT action_plan_audit_pkey PRIMARY KEY (id);


--
-- Name: action_plan_comments action_plan_comments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.action_plan_comments
    ADD CONSTRAINT action_plan_comments_pkey PRIMARY KEY (id);


--
-- Name: action_plan_items action_plan_items_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.action_plan_items
    ADD CONSTRAINT action_plan_items_pkey PRIMARY KEY (id);


--
-- Name: assessments assessments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assessments
    ADD CONSTRAINT assessments_pkey PRIMARY KEY (id);


--
-- Name: attendance attendance_child_id_date_session_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.attendance
    ADD CONSTRAINT attendance_child_id_date_session_key UNIQUE (child_id, date, session);


--
-- Name: attendance attendance_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.attendance
    ADD CONSTRAINT attendance_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: backup_config backup_config_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.backup_config
    ADD CONSTRAINT backup_config_pkey PRIMARY KEY (id);


--
-- Name: backup_config backup_config_school_schema_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.backup_config
    ADD CONSTRAINT backup_config_school_schema_key UNIQUE (school_schema);


--
-- Name: backup_runs backup_runs_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.backup_runs
    ADD CONSTRAINT backup_runs_pkey PRIMARY KEY (id);


--
-- Name: behaviour_log behaviour_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.behaviour_log
    ADD CONSTRAINT behaviour_log_pkey PRIMARY KEY (id);


--
-- Name: calendar_feed_tokens calendar_feed_tokens_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.calendar_feed_tokens
    ADD CONSTRAINT calendar_feed_tokens_pkey PRIMARY KEY (id);


--
-- Name: calendar_feed_tokens calendar_feed_tokens_token_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.calendar_feed_tokens
    ADD CONSTRAINT calendar_feed_tokens_token_key UNIQUE (token);


--
-- Name: certificates certificates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.certificates
    ADD CONSTRAINT certificates_pkey PRIMARY KEY (id);


--
-- Name: certificates certificates_uuid_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.certificates
    ADD CONSTRAINT certificates_uuid_key UNIQUE (uuid);


--
-- Name: child_about_me child_about_me_child_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_about_me
    ADD CONSTRAINT child_about_me_child_id_key UNIQUE (child_id);


--
-- Name: child_about_me child_about_me_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_about_me
    ADD CONSTRAINT child_about_me_pkey PRIMARY KEY (id);


--
-- Name: child_funding child_funding_child_id_term_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_funding
    ADD CONSTRAINT child_funding_child_id_term_id_key UNIQUE (child_id, term_id);


--
-- Name: child_phonics_progress child_phonics_progress_child_id_sound_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_phonics_progress
    ADD CONSTRAINT child_phonics_progress_child_id_sound_id_key UNIQUE (child_id, sound_id);


--
-- Name: child_phonics_progress child_phonics_progress_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_phonics_progress
    ADD CONSTRAINT child_phonics_progress_pkey PRIMARY KEY (id);


--
-- Name: child_tags child_tags_child_id_tag_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_tags
    ADD CONSTRAINT child_tags_child_id_tag_key UNIQUE (child_id, tag);


--
-- Name: child_tags child_tags_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_tags
    ADD CONSTRAINT child_tags_pkey PRIMARY KEY (id);


--
-- Name: children children_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.children
    ADD CONSTRAINT children_pkey PRIMARY KEY (id);


--
-- Name: comms_email_queue comms_email_queue_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_email_queue
    ADD CONSTRAINT comms_email_queue_pkey PRIMARY KEY (id);


--
-- Name: comms_emails comms_emails_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_emails
    ADD CONSTRAINT comms_emails_pkey PRIMARY KEY (id);


--
-- Name: compliance_events compliance_events_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.compliance_events
    ADD CONSTRAINT compliance_events_pkey PRIMARY KEY (id);


--
-- Name: contract_signature_log contract_signature_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contract_signature_log
    ADD CONSTRAINT contract_signature_log_pkey PRIMARY KEY (id);


--
-- Name: contract_templates contract_templates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contract_templates
    ADD CONSTRAINT contract_templates_pkey PRIMARY KEY (id);


--
-- Name: coshh_register coshh_register_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.coshh_register
    ADD CONSTRAINT coshh_register_pkey PRIMARY KEY (id);


--
-- Name: course_attempts course_attempts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_attempts
    ADD CONSTRAINT course_attempts_pkey PRIMARY KEY (id);


--
-- Name: course_quiz_questions course_quiz_questions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_quiz_questions
    ADD CONSTRAINT course_quiz_questions_pkey PRIMARY KEY (id);


--
-- Name: course_sections course_sections_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_sections
    ADD CONSTRAINT course_sections_pkey PRIMARY KEY (id);


--
-- Name: courses courses_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.courses
    ADD CONSTRAINT courses_pkey PRIMARY KEY (id);


--
-- Name: courses courses_slug_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.courses
    ADD CONSTRAINT courses_slug_key UNIQUE (slug);


--
-- Name: cp_register cp_register_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cp_register
    ADD CONSTRAINT cp_register_pkey PRIMARY KEY (id);


--
-- Name: cpd_records cpd_records_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_records
    ADD CONSTRAINT cpd_records_pkey PRIMARY KEY (id);


--
-- Name: curriculum_activities curriculum_activities_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.curriculum_activities
    ADD CONSTRAINT curriculum_activities_pkey PRIMARY KEY (id);


--
-- Name: curriculum_plans curriculum_plans_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.curriculum_plans
    ADD CONSTRAINT curriculum_plans_pkey PRIMARY KEY (id);


--
-- Name: daily_diary daily_diary_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.daily_diary
    ADD CONSTRAINT daily_diary_pkey PRIMARY KEY (id);


--
-- Name: decision_confidence decision_confidence_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.decision_confidence
    ADD CONSTRAINT decision_confidence_pkey PRIMARY KEY (category, scenario_fingerprint);


--
-- Name: decision_log decision_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.decision_log
    ADD CONSTRAINT decision_log_pkey PRIMARY KEY (id);


--
-- Name: document_workspace_audit document_workspace_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.document_workspace_audit
    ADD CONSTRAINT document_workspace_audit_pkey PRIMARY KEY (id);


--
-- Name: document_workspaces document_workspaces_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.document_workspaces
    ADD CONSTRAINT document_workspaces_pkey PRIMARY KEY (id);


--
-- Name: enquiries enquiries_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enquiries
    ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);


--
-- Name: environment_assessments environment_assessments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.environment_assessments
    ADD CONSTRAINT environment_assessments_pkey PRIMARY KEY (id);


--
-- Name: exclusions exclusions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.exclusions
    ADD CONSTRAINT exclusions_pkey PRIMARY KEY (id);


--
-- Name: finance_accounts finance_accounts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_accounts
    ADD CONSTRAINT finance_accounts_pkey PRIMARY KEY (id);


--
-- Name: finance_accounts finance_accounts_provider_id_external_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_accounts
    ADD CONSTRAINT finance_accounts_provider_id_external_id_key UNIQUE (provider_id, external_id);


--
-- Name: finance_invoices finance_invoices_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_invoices
    ADD CONSTRAINT finance_invoices_pkey PRIMARY KEY (id);


--
-- Name: finance_invoices finance_invoices_provider_id_external_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_invoices
    ADD CONSTRAINT finance_invoices_provider_id_external_id_key UNIQUE (provider_id, external_id);


--
-- Name: finance_monthly_balances finance_monthly_balances_account_id_year_month_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_monthly_balances
    ADD CONSTRAINT finance_monthly_balances_account_id_year_month_key UNIQUE (account_id, year, month);


--
-- Name: finance_monthly_balances finance_monthly_balances_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_monthly_balances
    ADD CONSTRAINT finance_monthly_balances_pkey PRIMARY KEY (id);


--
-- Name: finance_payments finance_payments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_payments
    ADD CONSTRAINT finance_payments_pkey PRIMARY KEY (id);


--
-- Name: finance_payments finance_payments_provider_id_external_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_payments
    ADD CONSTRAINT finance_payments_provider_id_external_id_key UNIQUE (provider_id, external_id);


--
-- Name: finance_providers finance_providers_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_providers
    ADD CONSTRAINT finance_providers_pkey PRIMARY KEY (id);


--
-- Name: finance_providers finance_providers_provider_tenant_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_providers
    ADD CONSTRAINT finance_providers_provider_tenant_id_key UNIQUE (provider, tenant_id);


--
-- Name: finance_sync_log finance_sync_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_sync_log
    ADD CONSTRAINT finance_sync_log_pkey PRIMARY KEY (id);


--
-- Name: fire_drills fire_drills_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.fire_drills
    ADD CONSTRAINT fire_drills_pkey PRIMARY KEY (id);


--
-- Name: fire_equipment_log fire_equipment_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.fire_equipment_log
    ADD CONSTRAINT fire_equipment_log_pkey PRIMARY KEY (id);


--
-- Name: food_intake_log food_intake_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.food_intake_log
    ADD CONSTRAINT food_intake_log_pkey PRIMARY KEY (id);


--
-- Name: framework_statements framework_statements_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.framework_statements
    ADD CONSTRAINT framework_statements_pkey PRIMARY KEY (id);


--
-- Name: framework_tracker framework_tracker_child_framework_area_aspect_stmt_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.framework_tracker
    ADD CONSTRAINT framework_tracker_child_framework_area_aspect_stmt_key UNIQUE (child_id, framework, area, aspect, statement);


--
-- Name: gias_cache gias_cache_cache_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gias_cache
    ADD CONSTRAINT gias_cache_cache_key_key UNIQUE (cache_key);


--
-- Name: gias_cache gias_cache_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gias_cache
    ADD CONSTRAINT gias_cache_pkey PRIMARY KEY (id);


--
-- Name: gocardless_mandates gocardless_mandates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gocardless_mandates
    ADD CONSTRAINT gocardless_mandates_pkey PRIMARY KEY (id);


--
-- Name: hr_absences hr_absences_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_absences
    ADD CONSTRAINT hr_absences_pkey PRIMARY KEY (id);


--
-- Name: hr_absences hr_absences_staff_id_start_date_end_date_absence_type_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_absences
    ADD CONSTRAINT hr_absences_staff_id_start_date_end_date_absence_type_key UNIQUE (staff_id, start_date, end_date, absence_type);


--
-- Name: hr_holiday_entitlement hr_holiday_entitlement_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_holiday_entitlement
    ADD CONSTRAINT hr_holiday_entitlement_pkey PRIMARY KEY (id);


--
-- Name: hr_holiday_entitlement hr_holiday_entitlement_staff_id_year_start_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_holiday_entitlement
    ADD CONSTRAINT hr_holiday_entitlement_staff_id_year_start_key UNIQUE (staff_id, year_start);


--
-- Name: hr_import_audit hr_import_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_import_audit
    ADD CONSTRAINT hr_import_audit_pkey PRIMARY KEY (id);


--
-- Name: hr_overtime hr_overtime_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_overtime
    ADD CONSTRAINT hr_overtime_pkey PRIMARY KEY (id);


--
-- Name: hr_toil_entries hr_toil_entries_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_toil_entries
    ADD CONSTRAINT hr_toil_entries_pkey PRIMARY KEY (id);


--
-- Name: hr_toil_entries hr_toil_entries_staff_id_accrued_date_hours_used_date_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_toil_entries
    ADD CONSTRAINT hr_toil_entries_staff_id_accrued_date_hours_used_date_key UNIQUE NULLS NOT DISTINCT (staff_id, accrued_date, hours, used_date);


--
-- Name: incidents incidents_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.incidents
    ADD CONSTRAINT incidents_pkey PRIMARY KEY (id);


--
-- Name: ingredients ingredients_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ingredients
    ADD CONSTRAINT ingredients_pkey PRIMARY KEY (id);


--
-- Name: inspection_access_log inspection_access_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.inspection_access_log
    ADD CONSTRAINT inspection_access_log_pkey PRIMARY KEY (id);


--
-- Name: inspection_action_items inspection_action_items_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.inspection_action_items
    ADD CONSTRAINT inspection_action_items_pkey PRIMARY KEY (id);


--
-- Name: inspection_briefings inspection_briefings_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.inspection_briefings
    ADD CONSTRAINT inspection_briefings_pkey PRIMARY KEY (id);


--
-- Name: inspection_modes inspection_modes_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.inspection_modes
    ADD CONSTRAINT inspection_modes_pkey PRIMARY KEY (id);


--
-- Name: interventions interventions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.interventions
    ADD CONSTRAINT interventions_pkey PRIMARY KEY (id);


--
-- Name: invoice_number_seq invoice_number_seq_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoice_number_seq
    ADD CONSTRAINT invoice_number_seq_pkey PRIMARY KEY (id);


--
-- Name: invoice_number_seq invoice_number_seq_prefix_year_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoice_number_seq
    ADD CONSTRAINT invoice_number_seq_prefix_year_key UNIQUE (prefix, year);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: medicine_records medicine_records_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.medicine_records
    ADD CONSTRAINT medicine_records_pkey PRIMARY KEY (id);


--
-- Name: medium_term_plans medium_term_plans_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.medium_term_plans
    ADD CONSTRAINT medium_term_plans_pkey PRIMARY KEY (id);


--
-- Name: memory_box_entries memory_box_entries_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.memory_box_entries
    ADD CONSTRAINT memory_box_entries_pkey PRIMARY KEY (id);


--
-- Name: menu_plans menu_plans_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_plans
    ADD CONSTRAINT menu_plans_pkey PRIMARY KEY (id);


--
-- Name: menu_plans menu_plans_week_start_date_room_day_of_week_meal_type_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_plans
    ADD CONSTRAINT menu_plans_week_start_date_room_day_of_week_meal_type_key UNIQUE (week_start_date, room, day_of_week, meal_type);


--
-- Name: menu_recipes menu_recipes_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_recipes
    ADD CONSTRAINT menu_recipes_pkey PRIMARY KEY (id);


--
-- Name: menu_recipes menu_recipes_slug_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_recipes
    ADD CONSTRAINT menu_recipes_slug_key UNIQUE (slug);


--
-- Name: n8n_audit n8n_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.n8n_audit
    ADD CONSTRAINT n8n_audit_pkey PRIMARY KEY (id);


--
-- Name: next_steps next_steps_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.next_steps
    ADD CONSTRAINT next_steps_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_staff_id_event_category_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_preferences
    ADD CONSTRAINT notification_preferences_staff_id_event_category_key UNIQUE (staff_id, event_category);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: observation_standards observation_standards_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observation_standards
    ADD CONSTRAINT observation_standards_key_key UNIQUE (key);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: parent_module_attempts parent_module_attempts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_module_attempts
    ADD CONSTRAINT parent_module_attempts_pkey PRIMARY KEY (id);


--
-- Name: parent_permissions_child_overrides parent_permissions_child_overrides_child_id_attribute_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_permissions_child_overrides
    ADD CONSTRAINT parent_permissions_child_overrides_child_id_attribute_key_key UNIQUE (child_id, attribute_key);


--
-- Name: parent_permissions_child_overrides parent_permissions_child_overrides_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_permissions_child_overrides
    ADD CONSTRAINT parent_permissions_child_overrides_pkey PRIMARY KEY (id);


--
-- Name: parent_permissions_matrix parent_permissions_matrix_attribute_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_permissions_matrix
    ADD CONSTRAINT parent_permissions_matrix_attribute_key_key UNIQUE (attribute_key);


--
-- Name: parent_permissions_matrix parent_permissions_matrix_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_permissions_matrix
    ADD CONSTRAINT parent_permissions_matrix_pkey PRIMARY KEY (id);


--
-- Name: parent_permissions_overrides parent_permissions_overrides_attribute_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_permissions_overrides
    ADD CONSTRAINT parent_permissions_overrides_attribute_key_key UNIQUE (attribute_key);


--
-- Name: parent_permissions_overrides parent_permissions_overrides_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_permissions_overrides
    ADD CONSTRAINT parent_permissions_overrides_pkey PRIMARY KEY (id);


--
-- Name: parent_portal_access parent_portal_access_child_id_email_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_portal_access
    ADD CONSTRAINT parent_portal_access_child_id_email_key UNIQUE (child_id, email);


--
-- Name: parent_portal_access parent_portal_access_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_portal_access
    ADD CONSTRAINT parent_portal_access_pkey PRIMARY KEY (id);


--
-- Name: parent_rewards parent_rewards_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_rewards
    ADD CONSTRAINT parent_rewards_pkey PRIMARY KEY (id);


--
-- Name: parent_study_modules parent_study_modules_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_study_modules
    ADD CONSTRAINT parent_study_modules_pkey PRIMARY KEY (id);


--
-- Name: parent_study_modules parent_study_modules_slug_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_study_modules
    ADD CONSTRAINT parent_study_modules_slug_key UNIQUE (slug);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: permission_slip_responses permission_slip_responses_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permission_slip_responses
    ADD CONSTRAINT permission_slip_responses_pkey PRIMARY KEY (id);


--
-- Name: permission_slip_responses permission_slip_responses_slip_id_child_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permission_slip_responses
    ADD CONSTRAINT permission_slip_responses_slip_id_child_id_key UNIQUE (slip_id, child_id);


--
-- Name: permission_slip_responses permission_slip_responses_token_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permission_slip_responses
    ADD CONSTRAINT permission_slip_responses_token_key UNIQUE (token);


--
-- Name: permission_slips permission_slips_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permission_slips
    ADD CONSTRAINT permission_slips_pkey PRIMARY KEY (id);


--
-- Name: phonics_game_sessions phonics_game_sessions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_game_sessions
    ADD CONSTRAINT phonics_game_sessions_pkey PRIMARY KEY (id);


--
-- Name: phonics_sounds phonics_sounds_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_sounds
    ADD CONSTRAINT phonics_sounds_pkey PRIMARY KEY (id);


--
-- Name: phonics_tracker phonics_tracker_child_id_sound_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_tracker
    ADD CONSTRAINT phonics_tracker_child_id_sound_key UNIQUE (child_id, sound);


--
-- Name: phonics_tracker phonics_tracker_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_tracker
    ADD CONSTRAINT phonics_tracker_pkey PRIMARY KEY (id);


--
-- Name: planned_activities planned_activities_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planned_activities
    ADD CONSTRAINT planned_activities_pkey PRIMARY KEY (id);


--
-- Name: planning_activities planning_activities_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planning_activities
    ADD CONSTRAINT planning_activities_pkey PRIMARY KEY (id);


--
-- Name: planning_preferences planning_preferences_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planning_preferences
    ADD CONSTRAINT planning_preferences_pkey PRIMARY KEY (id);


--
-- Name: planning_preferences planning_preferences_room_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planning_preferences
    ADD CONSTRAINT planning_preferences_room_id_key UNIQUE (room_id);


--
-- Name: policies policies_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.policies
    ADD CONSTRAINT policies_pkey PRIMARY KEY (id);


--
-- Name: policy_acknowledgments policy_acknowledgments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.policy_acknowledgments
    ADD CONSTRAINT policy_acknowledgments_pkey PRIMARY KEY (id);


--
-- Name: policy_acknowledgments policy_acknowledgments_policy_id_staff_id_policy_version_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.policy_acknowledgments
    ADD CONSTRAINT policy_acknowledgments_policy_id_staff_id_policy_version_key UNIQUE (policy_id, staff_id, policy_version);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: regulatory_alerts regulatory_alerts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_alerts
    ADD CONSTRAINT regulatory_alerts_pkey PRIMARY KEY (id);


--
-- Name: regulatory_policy_links regulatory_policy_links_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_policy_links
    ADD CONSTRAINT regulatory_policy_links_pkey PRIMARY KEY (id);


--
-- Name: regulatory_policy_links regulatory_policy_links_source_id_policy_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_policy_links
    ADD CONSTRAINT regulatory_policy_links_source_id_policy_id_key UNIQUE (source_id, policy_id);


--
-- Name: regulatory_sources regulatory_sources_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_sources
    ADD CONSTRAINT regulatory_sources_pkey PRIMARY KEY (id);


--
-- Name: regulatory_sources regulatory_sources_source_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_sources
    ADD CONSTRAINT regulatory_sources_source_key_key UNIQUE (source_key);


--
-- Name: repairs repairs_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.repairs
    ADD CONSTRAINT repairs_pkey PRIMARY KEY (id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: risk_assessment_hazards risk_assessment_hazards_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.risk_assessment_hazards
    ADD CONSTRAINT risk_assessment_hazards_pkey PRIMARY KEY (id);


--
-- Name: risk_assessment_templates risk_assessment_templates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.risk_assessment_templates
    ADD CONSTRAINT risk_assessment_templates_pkey PRIMARY KEY (id);


--
-- Name: risk_assessments risk_assessments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.risk_assessments
    ADD CONSTRAINT risk_assessments_pkey PRIMARY KEY (id);


--
-- Name: rooms rooms_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rooms
    ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);


--
-- Name: rota_shifts rota_shifts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_shifts
    ADD CONSTRAINT rota_shifts_pkey PRIMARY KEY (id);


--
-- Name: rota_shifts rota_shifts_rota_week_id_staff_id_shift_date_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_shifts
    ADD CONSTRAINT rota_shifts_rota_week_id_staff_id_shift_date_key UNIQUE (rota_week_id, staff_id, shift_date);


--
-- Name: rota_weeks rota_weeks_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_weeks
    ADD CONSTRAINT rota_weeks_pkey PRIMARY KEY (id);


--
-- Name: rota_weeks rota_weeks_week_start_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_weeks
    ADD CONSTRAINT rota_weeks_week_start_key UNIQUE (week_start);


--
-- Name: safeguarding_access_audit safeguarding_access_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_access_audit
    ADD CONSTRAINT safeguarding_access_audit_pkey PRIMARY KEY (id);


--
-- Name: safeguarding_actions safeguarding_actions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_actions
    ADD CONSTRAINT safeguarding_actions_pkey PRIMARY KEY (id);


--
-- Name: safeguarding_categories safeguarding_categories_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_categories
    ADD CONSTRAINT safeguarding_categories_pkey PRIMARY KEY (id);


--
-- Name: safeguarding_concern_persons safeguarding_concern_persons_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_concern_persons
    ADD CONSTRAINT safeguarding_concern_persons_pkey PRIMARY KEY (concern_id, person_id, role);


--
-- Name: safeguarding_concerns safeguarding_concerns_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_concerns
    ADD CONSTRAINT safeguarding_concerns_pkey PRIMARY KEY (id);


--
-- Name: safeguarding_escalation_log safeguarding_escalation_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_escalation_log
    ADD CONSTRAINT safeguarding_escalation_log_pkey PRIMARY KEY (id);


--
-- Name: safeguarding_log safeguarding_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_log
    ADD CONSTRAINT safeguarding_log_pkey PRIMARY KEY (id);


--
-- Name: safeguarding_training safeguarding_training_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_training
    ADD CONSTRAINT safeguarding_training_pkey PRIMARY KEY (id);


--
-- Name: safeguarding_transfers safeguarding_transfers_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_transfers
    ADD CONSTRAINT safeguarding_transfers_pkey PRIMARY KEY (id);


--
-- Name: security_check_results security_check_results_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_check_results
    ADD CONSTRAINT security_check_results_pkey PRIMARY KEY (id);


--
-- Name: security_checks security_checks_check_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_checks
    ADD CONSTRAINT security_checks_check_key_key UNIQUE (check_key);


--
-- Name: security_checks security_checks_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_checks
    ADD CONSTRAINT security_checks_pkey PRIMARY KEY (id);


--
-- Name: sen_register sen_register_child_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sen_register
    ADD CONSTRAINT sen_register_child_id_key UNIQUE (child_id);


--
-- Name: sen_register sen_register_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sen_register
    ADD CONSTRAINT sen_register_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: shopping_lists shopping_lists_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.shopping_lists
    ADD CONSTRAINT shopping_lists_pkey PRIMARY KEY (id);


--
-- Name: sleep_checks sleep_checks_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sleep_checks
    ADD CONSTRAINT sleep_checks_pkey PRIMARY KEY (id);


--
-- Name: staff_attendance staff_attendance_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_attendance
    ADD CONSTRAINT staff_attendance_pkey PRIMARY KEY (id);


--
-- Name: staff_attendance staff_attendance_staff_id_date_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_attendance
    ADD CONSTRAINT staff_attendance_staff_id_date_key UNIQUE (staff_id, date);


--
-- Name: staff_clock_events staff_clock_events_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_clock_events
    ADD CONSTRAINT staff_clock_events_pkey PRIMARY KEY (id);


--
-- Name: staff_compliance staff_compliance_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_compliance
    ADD CONSTRAINT staff_compliance_pkey PRIMARY KEY (id);


--
-- Name: staff_contracts staff_contracts_brighthr_ref_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_contracts
    ADD CONSTRAINT staff_contracts_brighthr_ref_key UNIQUE (brighthr_ref);


--
-- Name: staff_contracts staff_contracts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_contracts
    ADD CONSTRAINT staff_contracts_pkey PRIMARY KEY (id);


--
-- Name: staff_contracts staff_contracts_sign_token_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_contracts
    ADD CONSTRAINT staff_contracts_sign_token_key UNIQUE (sign_token);


--
-- Name: staff staff_email_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff
    ADD CONSTRAINT staff_email_key UNIQUE (email);


--
-- Name: staff_fobs staff_fobs_fob_uid_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_fobs
    ADD CONSTRAINT staff_fobs_fob_uid_key UNIQUE (fob_uid);


--
-- Name: staff_fobs staff_fobs_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_fobs
    ADD CONSTRAINT staff_fobs_pkey PRIMARY KEY (id);


--
-- Name: staff_handbook_versions staff_handbook_versions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_handbook_versions
    ADD CONSTRAINT staff_handbook_versions_pkey PRIMARY KEY (id);


--
-- Name: staff_performance_flags staff_performance_flags_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_performance_flags
    ADD CONSTRAINT staff_performance_flags_pkey PRIMARY KEY (id);


--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (id);


--
-- Name: staff_room_allocations staff_room_allocations_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_room_allocations
    ADD CONSTRAINT staff_room_allocations_pkey PRIMARY KEY (id);


--
-- Name: staff_room_allocations staff_room_allocations_staff_id_room_id_effective_from_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_room_allocations
    ADD CONSTRAINT staff_room_allocations_staff_id_room_id_effective_from_key UNIQUE (staff_id, room_id, effective_from);


--
-- Name: staff_shifts staff_shifts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_shifts
    ADD CONSTRAINT staff_shifts_pkey PRIMARY KEY (id);


--
-- Name: staff_shifts staff_shifts_staff_id_shift_date_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_shifts
    ADD CONSTRAINT staff_shifts_staff_id_shift_date_key UNIQUE (staff_id, shift_date);


--
-- Name: supervision_question_templates supervision_question_templates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervision_question_templates
    ADD CONSTRAINT supervision_question_templates_pkey PRIMARY KEY (id);


--
-- Name: supervision_question_templates supervision_question_templates_template_name_ordinal_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervision_question_templates
    ADD CONSTRAINT supervision_question_templates_template_name_ordinal_key UNIQUE (template_name, ordinal);


--
-- Name: tag_definitions tag_definitions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.tag_definitions
    ADD CONSTRAINT tag_definitions_pkey PRIMARY KEY (id);


--
-- Name: tag_definitions tag_definitions_tag_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.tag_definitions
    ADD CONSTRAINT tag_definitions_tag_key UNIQUE (tag);


--
-- Name: timetable timetable_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.timetable
    ADD CONSTRAINT timetable_pkey PRIMARY KEY (id);


--
-- Name: toil_entries toil_entries_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.toil_entries
    ADD CONSTRAINT toil_entries_pkey PRIMARY KEY (id);


--
-- Name: transcriptions transcriptions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.transcriptions
    ADD CONSTRAINT transcriptions_pkey PRIMARY KEY (id);


--
-- Name: certificates uniq_cert_staff_course; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.certificates
    ADD CONSTRAINT uniq_cert_staff_course UNIQUE (staff_id, course_id);


--
-- Name: framework_statements uq_demo_fs_framework_area_aspect_code; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.framework_statements
    ADD CONSTRAINT uq_demo_fs_framework_area_aspect_code UNIQUE (framework, area, aspect, statement_code);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_preferences user_preferences_staff_id_preference_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.user_preferences
    ADD CONSTRAINT user_preferences_staff_id_preference_key_key UNIQUE (staff_id, preference_key);


--
-- Name: vapi_calls vapi_calls_call_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.vapi_calls
    ADD CONSTRAINT vapi_calls_call_id_key UNIQUE (call_id);


--
-- Name: vapi_calls vapi_calls_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.vapi_calls
    ADD CONSTRAINT vapi_calls_pkey PRIMARY KEY (id);


--
-- Name: waiting_list waiting_list_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.waiting_list
    ADD CONSTRAINT waiting_list_pkey PRIMARY KEY (id);


--
-- Name: weekly_menus weekly_menus_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.weekly_menus
    ADD CONSTRAINT weekly_menus_pkey PRIMARY KEY (id);


--
-- Name: weekly_plans weekly_plans_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.weekly_plans
    ADD CONSTRAINT weekly_plans_pkey PRIMARY KEY (id);


--
-- Name: wellbeing_checkins wellbeing_checkins_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wellbeing_checkins
    ADD CONSTRAINT wellbeing_checkins_pkey PRIMARY KEY (id);


--
-- Name: wren_settings wren_settings_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wren_settings
    ADD CONSTRAINT wren_settings_pkey PRIMARY KEY (key);


--
-- Name: wren_workflow_executions wren_workflow_executions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wren_workflow_executions
    ADD CONSTRAINT wren_workflow_executions_pkey PRIMARY KEY (id);


--
-- Name: wren_workflow_instances wren_workflow_instances_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wren_workflow_instances
    ADD CONSTRAINT wren_workflow_instances_pkey PRIMARY KEY (id);


--
-- Name: wren_workflow_templates wren_workflow_templates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wren_workflow_templates
    ADD CONSTRAINT wren_workflow_templates_pkey PRIMARY KEY (id);


--
-- Name: cp_child_demo_eyfs; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cp_child_demo_eyfs ON demo_eyfs.cp_register USING btree (child_id) WHERE (is_active = true);


--
-- Name: demo_eyfs_medium_term_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX demo_eyfs_medium_term_idx ON demo_eyfs.medium_term_plans USING btree (room_id, term_name, academic_year);


--
-- Name: demo_eyfs_term_plans_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX demo_eyfs_term_plans_idx ON demo_eyfs.term_plans USING btree (room_id, term_name, academic_year);


--
-- Name: idx_cft_entity; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_cft_entity ON demo_eyfs.calendar_feed_tokens USING btree (entity_type, entity_id, scope);


--
-- Name: idx_cft_token; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_cft_token ON demo_eyfs.calendar_feed_tokens USING btree (token);


--
-- Name: idx_csl_demo_contract; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_csl_demo_contract ON demo_eyfs.contract_signature_log USING btree (contract_id);


--
-- Name: idx_de_next_steps_child_status; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_de_next_steps_child_status ON demo_eyfs.next_steps USING btree (child_id, status);


--
-- Name: idx_de_next_steps_observation; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_de_next_steps_observation ON demo_eyfs.next_steps USING btree (observation_id);


--
-- Name: idx_demo_eyfs_att; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_eyfs_att ON demo_eyfs.attendance USING btree (child_id, date);


--
-- Name: idx_demo_eyfs_children_active; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_eyfs_children_active ON demo_eyfs.children USING btree (is_active, room_id);


--
-- Name: idx_demo_eyfs_ingredients_name; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX idx_demo_eyfs_ingredients_name ON demo_eyfs.ingredients USING btree (lower((name)::text));


--
-- Name: idx_demo_eyfs_obs_child; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_eyfs_obs_child ON demo_eyfs.observations USING btree (child_id);


--
-- Name: idx_demo_eyfs_obs_tags; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_eyfs_obs_tags ON demo_eyfs.observations USING gin (obs_tags);


--
-- Name: idx_demo_eyfs_planned_act_date; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_eyfs_planned_act_date ON demo_eyfs.planned_activities USING btree (plan_date, room_id);


--
-- Name: idx_demo_eyfs_sleep; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_eyfs_sleep ON demo_eyfs.sleep_checks USING btree (child_id);


--
-- Name: idx_demo_eyfs_staff_active; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_eyfs_staff_active ON demo_eyfs.staff USING btree (is_active);


--
-- Name: idx_demo_food_log_child; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_food_log_child ON demo_eyfs.food_intake_log USING btree (child_id, date);


--
-- Name: idx_demo_fs_area; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_fs_area ON demo_eyfs.framework_statements USING btree (area);


--
-- Name: idx_demo_fs_framework; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_fs_framework ON demo_eyfs.framework_statements USING btree (framework);


--
-- Name: idx_demo_pa_age; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_pa_age ON demo_eyfs.planning_activities USING btree (age_group);


--
-- Name: idx_demo_pa_eyfs; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_pa_eyfs ON demo_eyfs.planning_activities USING gin (eyfs_areas);


--
-- Name: idx_demo_recipes_allergens; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_recipes_allergens ON demo_eyfs.menu_recipes USING gin (allergens);


--
-- Name: idx_demo_recipes_tags; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_recipes_tags ON demo_eyfs.menu_recipes USING gin (tags);


--
-- Name: idx_doc_workspaces_created_by; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_doc_workspaces_created_by ON demo_eyfs.document_workspaces USING btree (created_by);


--
-- Name: idx_doc_workspaces_status; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_doc_workspaces_status ON demo_eyfs.document_workspaces USING btree (status);


--
-- Name: idx_doc_ws_audit_workspace; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_doc_ws_audit_workspace ON demo_eyfs.document_workspace_audit USING btree (workspace_id);


--
-- Name: idx_fin_accts_code; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_fin_accts_code ON demo_eyfs.finance_accounts USING btree (code);


--
-- Name: idx_fin_accts_provider; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_fin_accts_provider ON demo_eyfs.finance_accounts USING btree (provider_id);


--
-- Name: idx_fin_balances_provider_ym; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_fin_balances_provider_ym ON demo_eyfs.finance_monthly_balances USING btree (provider_id, year, month);


--
-- Name: idx_fin_invoices_date; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_fin_invoices_date ON demo_eyfs.finance_invoices USING btree (invoice_date DESC);


--
-- Name: idx_fin_invoices_la; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_fin_invoices_la ON demo_eyfs.finance_invoices USING btree (is_la_funding, invoice_date);


--
-- Name: idx_fin_payments_date; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_fin_payments_date ON demo_eyfs.finance_payments USING btree (payment_date DESC);


--
-- Name: idx_fin_payments_invoice; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_fin_payments_invoice ON demo_eyfs.finance_payments USING btree (invoice_id);


--
-- Name: idx_fin_sync_log; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_fin_sync_log ON demo_eyfs.finance_sync_log USING btree (provider_id, started_at DESC);


--
-- Name: idx_reg_alerts_ai_null; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_reg_alerts_ai_null ON demo_eyfs.regulatory_alerts USING btree (id) WHERE (ai_analysis IS NULL);


--
-- Name: idx_reg_alerts_source; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_reg_alerts_source ON demo_eyfs.regulatory_alerts USING btree (source_id);


--
-- Name: idx_reg_alerts_status_date; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_reg_alerts_status_date ON demo_eyfs.regulatory_alerts USING btree (status, detected_at DESC);


--
-- Name: idx_reg_policy_links_policy; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_reg_policy_links_policy ON demo_eyfs.regulatory_policy_links USING btree (policy_id);


--
-- Name: idx_reg_policy_links_source; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_reg_policy_links_source ON demo_eyfs.regulatory_policy_links USING btree (source_id);


--
-- Name: idx_reg_sources_active_poll; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_reg_sources_active_poll ON demo_eyfs.regulatory_sources USING btree (is_active, last_polled_at);


--
-- Name: sg_child_demo_eyfs; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX sg_child_demo_eyfs ON demo_eyfs.safeguarding_concerns USING btree (child_id);


--
-- Name: sg_status_demo_eyfs; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX sg_status_demo_eyfs ON demo_eyfs.safeguarding_concerns USING btree (status);


--
-- Name: absence_requests absence_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.absence_requests
    ADD CONSTRAINT absence_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: absence_requests absence_requests_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.absence_requests
    ADD CONSTRAINT absence_requests_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: assessments assessments_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assessments
    ADD CONSTRAINT assessments_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: assessments assessments_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assessments
    ADD CONSTRAINT assessments_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: attendance attendance_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.attendance
    ADD CONSTRAINT attendance_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: attendance attendance_signed_in_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.attendance
    ADD CONSTRAINT attendance_signed_in_by_fkey FOREIGN KEY (signed_in_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: attendance attendance_signed_out_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.attendance
    ADD CONSTRAINT attendance_signed_out_by_fkey FOREIGN KEY (signed_out_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: behaviour_log behaviour_log_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.behaviour_log
    ADD CONSTRAINT behaviour_log_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: behaviour_log behaviour_log_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.behaviour_log
    ADD CONSTRAINT behaviour_log_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: child_about_me child_about_me_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_about_me
    ADD CONSTRAINT child_about_me_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: child_tags child_tags_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_tags
    ADD CONSTRAINT child_tags_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: children children_key_person_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.children
    ADD CONSTRAINT children_key_person_id_fkey FOREIGN KEY (key_person_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: children children_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.children
    ADD CONSTRAINT children_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id);


--
-- Name: comms_email_queue comms_email_queue_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_email_queue
    ADD CONSTRAINT comms_email_queue_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: comms_email_queue comms_email_queue_handled_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_email_queue
    ADD CONSTRAINT comms_email_queue_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: comms_email_queue comms_email_queue_parent_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_email_queue
    ADD CONSTRAINT comms_email_queue_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES demo_eyfs.children(id);


--
-- Name: contract_signature_log contract_signature_log_contract_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contract_signature_log
    ADD CONSTRAINT contract_signature_log_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES demo_eyfs.staff_contracts(id) ON DELETE CASCADE;


--
-- Name: cp_register cp_register_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cp_register
    ADD CONSTRAINT cp_register_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: cp_register cp_register_created_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cp_register
    ADD CONSTRAINT cp_register_created_by_fkey FOREIGN KEY (created_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: cpd_records cpd_records_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_records
    ADD CONSTRAINT cpd_records_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: curriculum_plans curriculum_plans_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.curriculum_plans
    ADD CONSTRAINT curriculum_plans_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id);


--
-- Name: curriculum_plans curriculum_plans_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.curriculum_plans
    ADD CONSTRAINT curriculum_plans_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: daily_diary daily_diary_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.daily_diary
    ADD CONSTRAINT daily_diary_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: daily_diary daily_diary_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.daily_diary
    ADD CONSTRAINT daily_diary_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: next_steps de_ns_pa_fk; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.next_steps
    ADD CONSTRAINT de_ns_pa_fk FOREIGN KEY (planned_activity_id) REFERENCES demo_eyfs.planned_activities(id);


--
-- Name: planned_activities de_pa_next_step_fk; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planned_activities
    ADD CONSTRAINT de_pa_next_step_fk FOREIGN KEY (next_step_id) REFERENCES demo_eyfs.next_steps(id);


--
-- Name: document_workspace_audit document_workspace_audit_workspace_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.document_workspace_audit
    ADD CONSTRAINT document_workspace_audit_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES demo_eyfs.document_workspaces(id) ON DELETE CASCADE;


--
-- Name: document_workspaces document_workspaces_created_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.document_workspaces
    ADD CONSTRAINT document_workspaces_created_by_fkey FOREIGN KEY (created_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: environment_assessments environment_assessments_assessor_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.environment_assessments
    ADD CONSTRAINT environment_assessments_assessor_id_fkey FOREIGN KEY (assessor_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: environment_assessments environment_assessments_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.environment_assessments
    ADD CONSTRAINT environment_assessments_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id);


--
-- Name: exclusions exclusions_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.exclusions
    ADD CONSTRAINT exclusions_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: exclusions exclusions_created_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.exclusions
    ADD CONSTRAINT exclusions_created_by_fkey FOREIGN KEY (created_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: finance_accounts finance_accounts_provider_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_accounts
    ADD CONSTRAINT finance_accounts_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES demo_eyfs.finance_providers(id) ON DELETE CASCADE;


--
-- Name: finance_invoices finance_invoices_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_invoices
    ADD CONSTRAINT finance_invoices_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: finance_invoices finance_invoices_provider_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_invoices
    ADD CONSTRAINT finance_invoices_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES demo_eyfs.finance_providers(id) ON DELETE CASCADE;


--
-- Name: finance_monthly_balances finance_monthly_balances_account_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_monthly_balances
    ADD CONSTRAINT finance_monthly_balances_account_id_fkey FOREIGN KEY (account_id) REFERENCES demo_eyfs.finance_accounts(id);


--
-- Name: finance_monthly_balances finance_monthly_balances_provider_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_monthly_balances
    ADD CONSTRAINT finance_monthly_balances_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES demo_eyfs.finance_providers(id) ON DELETE CASCADE;


--
-- Name: finance_payments finance_payments_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_payments
    ADD CONSTRAINT finance_payments_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES demo_eyfs.finance_accounts(id);


--
-- Name: finance_payments finance_payments_invoice_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_payments
    ADD CONSTRAINT finance_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES demo_eyfs.finance_invoices(id);


--
-- Name: finance_payments finance_payments_provider_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_payments
    ADD CONSTRAINT finance_payments_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES demo_eyfs.finance_providers(id) ON DELETE CASCADE;


--
-- Name: finance_sync_log finance_sync_log_provider_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.finance_sync_log
    ADD CONSTRAINT finance_sync_log_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES demo_eyfs.finance_providers(id);


--
-- Name: food_intake_log food_intake_log_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.food_intake_log
    ADD CONSTRAINT food_intake_log_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: food_intake_log food_intake_log_recipe_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.food_intake_log
    ADD CONSTRAINT food_intake_log_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES demo_eyfs.menu_recipes(id) ON DELETE SET NULL;


--
-- Name: framework_tracker framework_tracker_statement_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.framework_tracker
    ADD CONSTRAINT framework_tracker_statement_id_fkey FOREIGN KEY (statement_id) REFERENCES demo_eyfs.framework_statements(id);


--
-- Name: hr_absences hr_absences_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_absences
    ADD CONSTRAINT hr_absences_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: hr_holiday_entitlement hr_holiday_entitlement_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_holiday_entitlement
    ADD CONSTRAINT hr_holiday_entitlement_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: hr_overtime hr_overtime_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_overtime
    ADD CONSTRAINT hr_overtime_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: hr_toil_entries hr_toil_entries_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_toil_entries
    ADD CONSTRAINT hr_toil_entries_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: incidents incidents_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.incidents
    ADD CONSTRAINT incidents_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: incidents incidents_reported_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.incidents
    ADD CONSTRAINT incidents_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: invoices invoices_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoices
    ADD CONSTRAINT invoices_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: medicine_records medicine_records_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.medicine_records
    ADD CONSTRAINT medicine_records_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: medicine_records medicine_records_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.medicine_records
    ADD CONSTRAINT medicine_records_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: medium_term_plans medium_term_plans_created_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.medium_term_plans
    ADD CONSTRAINT medium_term_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: medium_term_plans medium_term_plans_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.medium_term_plans
    ADD CONSTRAINT medium_term_plans_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id);


--
-- Name: menu_plans menu_plans_recipe_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_plans
    ADD CONSTRAINT menu_plans_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES demo_eyfs.menu_recipes(id) ON DELETE SET NULL;


--
-- Name: next_steps next_steps_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.next_steps
    ADD CONSTRAINT next_steps_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: next_steps next_steps_completed_observation_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.next_steps
    ADD CONSTRAINT next_steps_completed_observation_id_fkey FOREIGN KEY (completed_observation_id) REFERENCES demo_eyfs.observations(id);


--
-- Name: next_steps next_steps_framework_statement_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.next_steps
    ADD CONSTRAINT next_steps_framework_statement_id_fkey FOREIGN KEY (framework_statement_id) REFERENCES demo_eyfs.framework_statements(id);


--
-- Name: next_steps next_steps_observation_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.next_steps
    ADD CONSTRAINT next_steps_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES demo_eyfs.observations(id) ON DELETE CASCADE;


--
-- Name: next_steps next_steps_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.next_steps
    ADD CONSTRAINT next_steps_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: notification_deliveries notification_deliveries_recipient_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_deliveries
    ADD CONSTRAINT notification_deliveries_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_preferences
    ADD CONSTRAINT notification_preferences_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: observations observations_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observations
    ADD CONSTRAINT observations_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: observations observations_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observations
    ADD CONSTRAINT observations_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: parent_portal_access parent_portal_access_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_portal_access
    ADD CONSTRAINT parent_portal_access_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: phonics_tracker phonics_tracker_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_tracker
    ADD CONSTRAINT phonics_tracker_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: phonics_tracker phonics_tracker_updated_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.phonics_tracker
    ADD CONSTRAINT phonics_tracker_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: planned_activities planned_activities_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planned_activities
    ADD CONSTRAINT planned_activities_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: planned_activities planned_activities_happened_observation_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planned_activities
    ADD CONSTRAINT planned_activities_happened_observation_id_fkey FOREIGN KEY (happened_observation_id) REFERENCES demo_eyfs.observations(id);


--
-- Name: planned_activities planned_activities_source_observation_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planned_activities
    ADD CONSTRAINT planned_activities_source_observation_id_fkey FOREIGN KEY (source_observation_id) REFERENCES demo_eyfs.observations(id);


--
-- Name: planning_preferences planning_preferences_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.planning_preferences
    ADD CONSTRAINT planning_preferences_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id);


--
-- Name: regulatory_alerts regulatory_alerts_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_alerts
    ADD CONSTRAINT regulatory_alerts_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: regulatory_alerts regulatory_alerts_source_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_alerts
    ADD CONSTRAINT regulatory_alerts_source_id_fkey FOREIGN KEY (source_id) REFERENCES demo_eyfs.regulatory_sources(id);


--
-- Name: regulatory_policy_links regulatory_policy_links_source_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.regulatory_policy_links
    ADD CONSTRAINT regulatory_policy_links_source_id_fkey FOREIGN KEY (source_id) REFERENCES demo_eyfs.regulatory_sources(id) ON DELETE CASCADE;


--
-- Name: reports reports_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reports
    ADD CONSTRAINT reports_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: reports reports_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reports
    ADD CONSTRAINT reports_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: safeguarding_actions safeguarding_actions_action_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_actions
    ADD CONSTRAINT safeguarding_actions_action_by_fkey FOREIGN KEY (action_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: safeguarding_actions safeguarding_actions_concern_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_actions
    ADD CONSTRAINT safeguarding_actions_concern_id_fkey FOREIGN KEY (concern_id) REFERENCES demo_eyfs.safeguarding_concerns(id) ON DELETE CASCADE;


--
-- Name: safeguarding_concerns safeguarding_concerns_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_concerns
    ADD CONSTRAINT safeguarding_concerns_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: safeguarding_concerns safeguarding_concerns_closed_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_concerns
    ADD CONSTRAINT safeguarding_concerns_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: safeguarding_concerns safeguarding_concerns_dsl_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_concerns
    ADD CONSTRAINT safeguarding_concerns_dsl_reviewed_by_fkey FOREIGN KEY (dsl_reviewed_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: safeguarding_concerns safeguarding_concerns_reported_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_concerns
    ADD CONSTRAINT safeguarding_concerns_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: safeguarding_concerns safeguarding_concerns_witnessed_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_concerns
    ADD CONSTRAINT safeguarding_concerns_witnessed_by_fkey FOREIGN KEY (witnessed_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: safeguarding_log safeguarding_log_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_log
    ADD CONSTRAINT safeguarding_log_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: safeguarding_log safeguarding_log_reported_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_log
    ADD CONSTRAINT safeguarding_log_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: safeguarding_training safeguarding_training_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.safeguarding_training
    ADD CONSTRAINT safeguarding_training_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: sen_register sen_register_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sen_register
    ADD CONSTRAINT sen_register_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: sen_register sen_register_created_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sen_register
    ADD CONSTRAINT sen_register_created_by_fkey FOREIGN KEY (created_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: sleep_checks sleep_checks_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sleep_checks
    ADD CONSTRAINT sleep_checks_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id) ON DELETE CASCADE;


--
-- Name: sleep_checks sleep_checks_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sleep_checks
    ADD CONSTRAINT sleep_checks_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: staff_attendance staff_attendance_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_attendance
    ADD CONSTRAINT staff_attendance_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: staff_compliance staff_compliance_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_compliance
    ADD CONSTRAINT staff_compliance_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: staff_contracts staff_contracts_employer_signature_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_contracts
    ADD CONSTRAINT staff_contracts_employer_signature_by_fkey FOREIGN KEY (employer_signature_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: staff_contracts staff_contracts_template_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_contracts
    ADD CONSTRAINT staff_contracts_template_id_fkey FOREIGN KEY (template_id) REFERENCES demo_eyfs.contract_templates(id);


--
-- Name: staff_handbook_versions staff_handbook_versions_approved_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_handbook_versions
    ADD CONSTRAINT staff_handbook_versions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: staff_handbook_versions staff_handbook_versions_published_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_handbook_versions
    ADD CONSTRAINT staff_handbook_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: staff_room_allocations staff_room_allocations_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_room_allocations
    ADD CONSTRAINT staff_room_allocations_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id) ON DELETE CASCADE;


--
-- Name: staff_room_allocations staff_room_allocations_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_room_allocations
    ADD CONSTRAINT staff_room_allocations_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: staff staff_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff
    ADD CONSTRAINT staff_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id);


--
-- Name: timetable timetable_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.timetable
    ADD CONSTRAINT timetable_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id);


--
-- Name: timetable timetable_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.timetable
    ADD CONSTRAINT timetable_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: user_preferences user_preferences_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.user_preferences
    ADD CONSTRAINT user_preferences_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: vapi_calls vapi_calls_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.vapi_calls
    ADD CONSTRAINT vapi_calls_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: waiting_list waiting_list_enquiry_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.waiting_list
    ADD CONSTRAINT waiting_list_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES demo_eyfs.enquiries(id) ON DELETE SET NULL;


--
-- Name: weekly_plans weekly_plans_created_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.weekly_plans
    ADD CONSTRAINT weekly_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: weekly_plans weekly_plans_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.weekly_plans
    ADD CONSTRAINT weekly_plans_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id);


--
-- Name: weekly_plans weekly_plans_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.weekly_plans
    ADD CONSTRAINT weekly_plans_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- PostgreSQL database dump complete
--



--
-- PostgreSQL database dump
--

\restrict B6gh8YOFFESoVw7ApM1JToh18y3xTkOqvrfOlNE6NiAkAn6nAy6urlloN3lP3eV

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

CREATE SCHEMA demo_eyfs;


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
    half_day text,
    auto_approved boolean,
    ai_decision_reason text,
    rejected_reason text,
    return_to_work_date date,
    return_to_work_notes text,
    affects_rota boolean,
    room_impact_baby boolean,
    room_impact_preschool boolean,
    created_via text,
    external_ref text,
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
    id integer NOT NULL,
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
    visible_to_parents boolean DEFAULT false,
    scope character varying(30),
    category character varying(80),
    related_child_id integer,
    created_by_staff_id integer,
    archived_at timestamp without time zone
);


--
-- Name: action_plans_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.action_plans_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: action_plans_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.action_plans_id_seq_demo OWNED BY demo_eyfs.action_plans.id;


--
-- Name: ai_digest_items; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.ai_digest_items (
    id integer NOT NULL,
    week_date date,
    source character varying(200),
    title character varying(500),
    summary text,
    category character varying(60),
    suggested_action character varying(60),
    action_taken character varying(60),
    actioned_by character varying(100),
    actioned_at timestamp without time zone,
    is_accepted boolean,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: ai_digest_items_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.ai_digest_items_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_digest_items_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.ai_digest_items_id_seq_demo OWNED BY demo_eyfs.ai_digest_items.id;


--
-- Name: apprentice_corpus; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.apprentice_corpus (
    id bigint NOT NULL,
    source_ref text NOT NULL,
    source_label text NOT NULL,
    category text,
    title text,
    content text NOT NULL,
    tsv tsvector,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: apprentice_corpus_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.apprentice_corpus_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: apprentice_corpus_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.apprentice_corpus_id_seq_demo OWNED BY demo_eyfs.apprentice_corpus.id;


--
-- Name: apprentice_events; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.apprentice_events (
    id integer NOT NULL,
    staff_id integer,
    event_type text,
    title text,
    event_date date,
    event_time time without time zone,
    location text,
    provider text DEFAULT 'Swift'::text,
    notes text,
    linked_email_triage_id integer,
    otj_hours numeric,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT apprentice_events_event_type_check CHECK ((event_type = ANY (ARRAY['assessor_visit'::text, 'training_day'::text, 'epa'::text, 'review'::text, 'other'::text])))
);


--
-- Name: apprentice_events_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.apprentice_events_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: apprentice_events_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.apprentice_events_id_seq_demo OWNED BY demo_eyfs.apprentice_events.id;


--
-- Name: approval_queue; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.approval_queue (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    capability_key text NOT NULL,
    action_type text NOT NULL,
    action_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    notes text,
    CONSTRAINT approval_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: approval_queue_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.approval_queue_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: approval_queue_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.approval_queue_id_seq_demo OWNED BY demo_eyfs.approval_queue.id;


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
    id integer NOT NULL,
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
-- Name: assessments_primary_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.assessments_primary_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assessments_primary_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.assessments_primary_id_seq_demo OWNED BY demo_eyfs.assessments_primary.id;


--
-- Name: assessments_secondary; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.assessments_secondary (
    id integer NOT NULL,
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
-- Name: assessments_secondary_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.assessments_secondary_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assessments_secondary_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.assessments_secondary_id_seq_demo OWNED BY demo_eyfs.assessments_secondary.id;


--
-- Name: assistant_doc_chunks; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.assistant_doc_chunks (
    id bigint NOT NULL,
    session_id text NOT NULL,
    doc_id text NOT NULL,
    filename text NOT NULL,
    chunk_idx integer NOT NULL,
    content text NOT NULL,
    uploaded_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED
);


--
-- Name: assistant_doc_chunks_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.assistant_doc_chunks_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assistant_doc_chunks_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.assistant_doc_chunks_id_seq_demo OWNED BY demo_eyfs.assistant_doc_chunks.id;


--
-- Name: assistant_memory; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.assistant_memory (
    id bigint NOT NULL,
    staff_id integer NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    portal text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT assistant_memory_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: assistant_memory_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.assistant_memory_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assistant_memory_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.assistant_memory_id_seq_demo OWNED BY demo_eyfs.assistant_memory.id;


--
-- Name: assistant_profile; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.assistant_profile (
    staff_id integer NOT NULL,
    display_name text,
    prefs jsonb DEFAULT '{}'::jsonb,
    notes text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: assistant_shared_memory; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.assistant_shared_memory (
    id bigint NOT NULL,
    fact text NOT NULL,
    category text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: assistant_shared_memory_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.assistant_shared_memory_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assistant_shared_memory_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.assistant_shared_memory_id_seq_demo OWNED BY demo_eyfs.assistant_shared_memory.id;


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
    notes text,
    eylog_ref text
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
    id integer NOT NULL,
    child_id integer NOT NULL,
    date date NOT NULL,
    session text NOT NULL,
    code text NOT NULL,
    notes text,
    recorded_by integer,
    created_at timestamp with time zone DEFAULT now(),
    sign_in_time time without time zone,
    sign_out_time time without time zone,
    CONSTRAINT attendance_register_session_check CHECK ((session = ANY (ARRAY['am'::text, 'pm'::text])))
);


--
-- Name: attendance_register_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.attendance_register_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attendance_register_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.attendance_register_id_seq_demo OWNED BY demo_eyfs.attendance_register.id;


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
-- Name: automation_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.automation_audit (
    id integer NOT NULL,
    rule_id integer,
    triggered_at timestamp without time zone DEFAULT now(),
    result character varying(40),
    details text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: automation_audit_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.automation_audit_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: automation_audit_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.automation_audit_id_seq_demo OWNED BY demo_eyfs.automation_audit.id;


--
-- Name: automation_rules; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.automation_rules (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    trigger_type character varying(60),
    trigger_config jsonb,
    conditions_json jsonb,
    actions_json jsonb,
    is_active boolean DEFAULT true,
    last_run_at timestamp without time zone,
    run_count integer DEFAULT 0,
    created_by character varying(100),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: automation_rules_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.automation_rules_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: automation_rules_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.automation_rules_id_seq_demo OWNED BY demo_eyfs.automation_rules.id;


--
-- Name: away_mode; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.away_mode (
    id integer NOT NULL,
    active boolean DEFAULT false NOT NULL,
    return_date date,
    cover_person_id integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer
);


--
-- Name: away_mode_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.away_mode_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: away_mode_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.away_mode_id_seq_demo OWNED BY demo_eyfs.away_mode.id;


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
-- Name: bank_holidays; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.bank_holidays (
    holiday_date date NOT NULL,
    name text NOT NULL,
    division text DEFAULT 'england-and-wales'::text
);


--
-- Name: bank_statement_lines; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.bank_statement_lines (
    id integer NOT NULL,
    statement_id integer NOT NULL,
    transaction_date date NOT NULL,
    description text,
    amount_pence bigint NOT NULL,
    balance_pence bigint,
    reference text,
    category text,
    provider_id text,
    reconciled boolean DEFAULT false,
    reconciled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bank_statement_lines_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.bank_statement_lines_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bank_statement_lines_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.bank_statement_lines_id_seq_demo OWNED BY demo_eyfs.bank_statement_lines.id;


--
-- Name: bank_statements; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.bank_statements (
    id integer NOT NULL,
    source text DEFAULT 'csv'::text NOT NULL,
    account_name text,
    account_number text,
    sort_code text,
    period_from date,
    period_to date,
    total_credits_pence bigint DEFAULT 0,
    total_debits_pence bigint DEFAULT 0,
    line_count integer DEFAULT 0,
    reconciled_count integer DEFAULT 0,
    truelayer_account_id text,
    uploaded_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bank_statements_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.bank_statements_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bank_statements_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.bank_statements_id_seq_demo OWNED BY demo_eyfs.bank_statements.id;


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
    id integer NOT NULL,
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
-- Name: behaviour_log_primary_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.behaviour_log_primary_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: behaviour_log_primary_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.behaviour_log_primary_id_seq_demo OWNED BY demo_eyfs.behaviour_log_primary.id;


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
-- Name: capabilities; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.capabilities (
    id integer NOT NULL,
    key text NOT NULL,
    display_name text NOT NULL,
    category text NOT NULL,
    description text
);


--
-- Name: capabilities_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.capabilities_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: capabilities_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.capabilities_id_seq_demo OWNED BY demo_eyfs.capabilities.id;


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
-- Name: child_bookings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_bookings (
    id integer NOT NULL,
    child_id integer NOT NULL,
    room_id integer,
    mon boolean DEFAULT false,
    tue boolean DEFAULT false,
    wed boolean DEFAULT false,
    thu boolean DEFAULT false,
    fri boolean DEFAULT false,
    start_date date NOT NULL,
    end_date date,
    funded boolean DEFAULT false,
    notes text,
    source text DEFAULT 'manual'::text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    created_by integer
);


--
-- Name: child_bookings_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.child_bookings_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: child_bookings_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.child_bookings_id_seq_demo OWNED BY demo_eyfs.child_bookings.id;


--
-- Name: child_consents; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_consents (
    id integer NOT NULL,
    child_id integer NOT NULL,
    consent_type text NOT NULL,
    granted boolean,
    consent_date date,
    source text DEFAULT 'parent'::text,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now(),
    notes text
);


--
-- Name: child_consents_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.child_consents_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: child_consents_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.child_consents_id_seq_demo OWNED BY demo_eyfs.child_consents.id;


--
-- Name: child_funding; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_funding (
    id integer NOT NULL,
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
    updated_at timestamp with time zone DEFAULT now(),
    eyman_ref text
);


--
-- Name: child_funding_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.child_funding_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: child_funding_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.child_funding_id_seq_demo OWNED BY demo_eyfs.child_funding.id;


--
-- Name: child_holidays; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_holidays (
    id integer NOT NULL,
    child_id integer,
    date date,
    notes text,
    reason text,
    exclude_from_invoice text,
    source text DEFAULT 'eyman'::text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: child_holidays_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.child_holidays_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: child_holidays_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.child_holidays_id_seq_demo OWNED BY demo_eyfs.child_holidays.id;


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
    notes text,
    confidence integer
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
-- Name: child_sessions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.child_sessions (
    id integer NOT NULL,
    child_id integer,
    start_date date,
    finish_date date,
    start_time time without time zone,
    finish_time time without time zone,
    room text,
    session_type text,
    status text,
    source text DEFAULT 'eyman'::text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: child_sessions_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.child_sessions_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: child_sessions_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.child_sessions_id_seq_demo OWNED BY demo_eyfs.child_sessions.id;


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
    allergen_notes text,
    gender character varying(1),
    service_child boolean DEFAULT false,
    nationality text,
    country_of_birth text,
    ethnicity_code text,
    first_language_code text,
    preferred_surname text,
    preferred_forename text,
    nc_year text,
    sen_status character varying(1),
    ctf_source_lea text,
    ctf_source_estab text,
    ctf_source_school_name text,
    status text,
    room text,
    primary_contact_email text,
    funding_hours_15 integer,
    funding_hours_30 integer,
    eylog_ref text,
    eylog_child_id text,
    phase character varying(2),
    notice_given_date date,
    transfer_planned_date date,
    erased_at timestamp with time zone,
    erasure_request_id integer,
    erasure_note text
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
-- Name: cockpit_cards; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cockpit_cards (
    id integer NOT NULL,
    title text NOT NULL,
    detail text,
    col text DEFAULT 'backlog'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    due_date date,
    source text DEFAULT 'manual'::text NOT NULL,
    assignee text,
    tags text[] DEFAULT '{}'::text[],
    "position" integer DEFAULT 0 NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cockpit_cards_col_check CHECK ((col = ANY (ARRAY['backlog'::text, 'this_week'::text, 'in_progress'::text, 'done'::text]))),
    CONSTRAINT cockpit_cards_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT cockpit_cards_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'hermes'::text, 'auto'::text])))
);


--
-- Name: cockpit_cards_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.cockpit_cards_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cockpit_cards_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.cockpit_cards_id_seq_demo OWNED BY demo_eyfs.cockpit_cards.id;


--
-- Name: cockpit_swot; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cockpit_swot (
    quadrant text NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cockpit_swot_quadrant_check CHECK ((quadrant = ANY (ARRAY['strengths'::text, 'weaknesses'::text, 'opportunities'::text, 'threats'::text])))
);


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
    handled_by integer,
    from_email text,
    from_name text,
    body_text text,
    classification text,
    suggested_draft text,
    draft_text text,
    handled_at timestamp with time zone,
    message_id text,
    to_email text,
    send_attempts integer,
    last_error text,
    category text,
    importance integer,
    suggested_replies jsonb,
    snippet text,
    summary text,
    suggested_action text
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
-- Name: contact_status_history; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.contact_status_history (
    id integer NOT NULL,
    contact_id integer NOT NULL,
    from_status text,
    to_status text NOT NULL,
    changed_by integer,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text
);


--
-- Name: contact_status_history_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.contact_status_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_status_history_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.contact_status_history_id_seq OWNED BY demo_eyfs.contact_status_history.id;


--
-- Name: contacts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.contacts (
    id integer NOT NULL,
    primary_email text,
    primary_phone text,
    full_name text,
    status text DEFAULT 'enquirer'::text NOT NULL,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    child_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    notes text,
    ai_summary_cache text,
    ai_summary_at timestamp with time zone,
    enquiry_id integer,
    CONSTRAINT contacts_status_check CHECK ((status = ANY (ARRAY['enquirer'::text, 'waiting_list'::text, 'enrolled'::text, 'leaver'::text])))
);


--
-- Name: contacts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.contacts_id_seq OWNED BY demo_eyfs.contacts.id;


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
-- Name: course_assignments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.course_assignments (
    id integer NOT NULL,
    course_id integer NOT NULL,
    staff_id integer NOT NULL,
    required boolean DEFAULT true NOT NULL,
    due_date date,
    status character varying(20) DEFAULT 'assigned'::character varying NOT NULL,
    assigned_by integer,
    assigned_at timestamp without time zone DEFAULT now() NOT NULL,
    authorised_by integer,
    authorised_at timestamp without time zone,
    notes text
);


--
-- Name: course_assignments_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.course_assignments_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: course_assignments_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.course_assignments_id_seq_demo OWNED BY demo_eyfs.course_assignments.id;


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
-- Name: ctf_assessment_results; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.ctf_assessment_results (
    id integer NOT NULL,
    child_id integer NOT NULL,
    stage text,
    subject_code text NOT NULL,
    result_status text,
    result_qualifier text,
    method text,
    season text,
    year integer,
    result_mark text,
    result_grade text,
    result_type text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ctf_assessment_results_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.ctf_assessment_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ctf_assessment_results_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.ctf_assessment_results_id_seq OWNED BY demo_eyfs.ctf_assessment_results.id;


--
-- Name: ctf_exports; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.ctf_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exported_by integer,
    exported_at timestamp with time zone DEFAULT now(),
    child_ids integer[],
    child_count integer,
    qualifier text DEFAULT 'partial'::text,
    dest_lea text,
    dest_estab text,
    dest_school_name text,
    filename text,
    xml_size_bytes integer
);


--
-- Name: ctf_fsm_history; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.ctf_fsm_history (
    id integer NOT NULL,
    child_id integer NOT NULL,
    fsm_start_date date,
    fsm_end_date date,
    fsm_eligible boolean DEFAULT false NOT NULL,
    fsm_uk_born boolean,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ctf_fsm_history_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.ctf_fsm_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ctf_fsm_history_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.ctf_fsm_history_id_seq OWNED BY demo_eyfs.ctf_fsm_history.id;


--
-- Name: ctf_school_history; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.ctf_school_history (
    id integer NOT NULL,
    child_id integer NOT NULL,
    lea text,
    estab text,
    school_name text,
    entry_date date,
    leaving_date date,
    leaving_reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ctf_school_history_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.ctf_school_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ctf_school_history_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.ctf_school_history_id_seq OWNED BY demo_eyfs.ctf_school_history.id;


--
-- Name: ctf_sen_history; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.ctf_sen_history (
    id integer NOT NULL,
    child_id integer NOT NULL,
    stage_type text NOT NULL,
    stage_start_date date,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ctf_sen_history_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.ctf_sen_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ctf_sen_history_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.ctf_sen_history_id_seq OWNED BY demo_eyfs.ctf_sen_history.id;


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
    milk_type text,
    finalised_at timestamp with time zone,
    eylog_ref text
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
-- Name: daily_summary_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.daily_summary_log (
    id integer NOT NULL,
    sent_at timestamp with time zone DEFAULT now(),
    coverage_start timestamp with time zone NOT NULL,
    coverage_end timestamp with time zone NOT NULL,
    items_count integer,
    email_to text
);


--
-- Name: daily_summary_log_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.daily_summary_log_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_summary_log_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.daily_summary_log_id_seq_demo OWNED BY demo_eyfs.daily_summary_log.id;


--
-- Name: data_archives; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.data_archives (
    id integer NOT NULL,
    record_type text NOT NULL,
    data_category text,
    criteria text,
    row_count integer,
    local_path text,
    archive_path text,
    offsite_remote text,
    encrypted boolean DEFAULT true,
    cipher text,
    sha256 text,
    size_bytes bigint,
    status text DEFAULT 'archived'::text,
    signed_off_by text,
    signed_off_at timestamp with time zone,
    hot_deleted boolean DEFAULT false,
    restored_at timestamp with time zone,
    restore_verified boolean DEFAULT false,
    restore_row_count integer,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    notes text
);


--
-- Name: data_archives_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.data_archives_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: data_archives_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.data_archives_id_seq_demo OWNED BY demo_eyfs.data_archives.id;


--
-- Name: data_subject_requests; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.data_subject_requests (
    id integer NOT NULL,
    child_id integer NOT NULL,
    request_type text NOT NULL,
    requested_by_email text,
    requester_name text,
    status text DEFAULT 'requested'::text NOT NULL,
    reason text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by integer,
    reviewed_by_name text,
    reviewed_at timestamp with time zone,
    completed_at timestamp with time zone,
    result jsonb,
    package_token text,
    notes text
);


--
-- Name: data_subject_requests_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.data_subject_requests_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: data_subject_requests_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.data_subject_requests_id_seq_demo OWNED BY demo_eyfs.data_subject_requests.id;


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
-- Name: diary_entries; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.diary_entries (
    id integer NOT NULL,
    child_id integer NOT NULL,
    entry_type text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_minutes integer,
    food_amount text,
    food_meal text,
    nappy_state text,
    drink_ml integer,
    drink_type text,
    sleep_quality text,
    notes text,
    share_with_parents boolean DEFAULT true NOT NULL,
    staff_id integer,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    eylog_ref text,
    source text DEFAULT 'staff'::text,
    logged_by_name text,
    CONSTRAINT diary_entries_drink_type_check CHECK ((drink_type = ANY (ARRAY['formula'::text, 'EBM'::text, 'cow'::text, 'water'::text, 'other'::text]))),
    CONSTRAINT diary_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['sleep'::text, 'nappy'::text, 'food'::text, 'drink'::text, 'note'::text]))),
    CONSTRAINT diary_entries_food_amount_check CHECK ((food_amount = ANY (ARRAY['all'::text, 'most'::text, 'some'::text, 'refused'::text]))),
    CONSTRAINT diary_entries_food_meal_check CHECK ((food_meal = ANY (ARRAY['breakfast'::text, 'snack-am'::text, 'lunch'::text, 'pudding'::text, 'snack-pm'::text, 'tea'::text]))),
    CONSTRAINT diary_entries_nappy_state_check CHECK ((nappy_state = ANY (ARRAY['clean'::text, 'wet'::text, 'soiled'::text, 'toilet'::text]))),
    CONSTRAINT diary_entries_sleep_quality_check CHECK ((sleep_quality = ANY (ARRAY['sound'::text, 'restless'::text, 'woke'::text])))
);


--
-- Name: diary_entries_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.diary_entries_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: diary_entries_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.diary_entries_id_seq_demo OWNED BY demo_eyfs.diary_entries.id;


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
-- Name: doorbell_events; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.doorbell_events (
    id integer NOT NULL,
    triggered_at timestamp with time zone DEFAULT now(),
    source character varying(20),
    snapshot_path text,
    answered_by_staff_id integer,
    answered_at timestamp with time zone,
    call_duration_seconds integer,
    door_released boolean DEFAULT false,
    door_released_at timestamp with time zone,
    door_released_by_staff_id integer,
    resolution character varying(30),
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: doorbell_events_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.doorbell_events_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: doorbell_events_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.doorbell_events_id_seq_demo OWNED BY demo_eyfs.doorbell_events.id;


--
-- Name: email_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.email_audit (
    id bigint NOT NULL,
    direction text DEFAULT 'out'::text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now(),
    from_email text,
    to_emails text[],
    subject text,
    body_preview text,
    event_type text,
    source text,
    sent_ok boolean,
    error text
);


--
-- Name: email_audit_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.email_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.email_audit_id_seq OWNED BY demo_eyfs.email_audit.id;


--
-- Name: email_sender_rules; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.email_sender_rules (
    id integer NOT NULL,
    pattern text NOT NULL,
    rule text,
    reason text,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT email_sender_rules_rule_check CHECK ((rule = ANY (ARRAY['always-alert'::text, 'never-alert'::text, 'always-archive'::text, 'force-importance-5'::text])))
);


--
-- Name: email_sender_rules_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.email_sender_rules_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_sender_rules_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.email_sender_rules_id_seq_demo OWNED BY demo_eyfs.email_sender_rules.id;


--
-- Name: email_triage; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.email_triage (
    id integer NOT NULL,
    message_id text,
    thread_id text,
    received_at timestamp without time zone,
    from_email text,
    from_name text,
    to_emails text[],
    cc_emails text[],
    subject text,
    body_preview text,
    body_full text,
    has_attachments boolean DEFAULT false,
    attachment_summary text,
    classified_at timestamp without time zone,
    classifier_model text,
    category character varying(40),
    importance integer,
    sender_type character varying(20),
    summary text,
    suggested_action text,
    classification_confidence double precision,
    alerted_at timestamp without time zone,
    alert_telegram_message_id text,
    user_action text,
    user_action_at timestamp without time zone,
    thread_snippet text,
    contact_known boolean,
    contact_role text,
    apprentice_relevant boolean DEFAULT false,
    apprentice_event_type text,
    CONSTRAINT email_triage_importance_check CHECK (((importance >= 1) AND (importance <= 5)))
);


--
-- Name: email_triage_feedback; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.email_triage_feedback (
    id integer NOT NULL,
    triage_id integer,
    correction text,
    created_at timestamp without time zone DEFAULT now(),
    detail text
);


--
-- Name: email_triage_feedback_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.email_triage_feedback_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_triage_feedback_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.email_triage_feedback_id_seq_demo OWNED BY demo_eyfs.email_triage_feedback.id;


--
-- Name: email_triage_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.email_triage_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_triage_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.email_triage_id_seq_demo OWNED BY demo_eyfs.email_triage.id;


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
    status text,
    message text,
    replied_at timestamp with time zone,
    replied_by integer,
    heard_about text,
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
-- Name: enquiry_replies; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.enquiry_replies (
    id integer NOT NULL,
    enquiry_id integer NOT NULL,
    staff_id integer,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: enquiry_replies_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.enquiry_replies_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enquiry_replies_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.enquiry_replies_id_seq_demo OWNED BY demo_eyfs.enquiry_replies.id;


--
-- Name: enrolled_devices; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.enrolled_devices (
    id bigint NOT NULL,
    device_uuid text NOT NULL,
    label text,
    device_type text NOT NULL,
    enrolled_by integer,
    created_at timestamp with time zone DEFAULT now(),
    last_seen_at timestamp with time zone,
    revoked boolean DEFAULT false,
    bound_subject_type text,
    bound_subject_id text,
    CONSTRAINT enrolled_devices_device_type_check CHECK ((device_type = ANY (ARRAY['ey_tablet'::text, 'admin_pc'::text, 'parents'::text, 'hr'::text])))
);


--
-- Name: enrolled_devices_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.enrolled_devices_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enrolled_devices_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.enrolled_devices_id_seq_demo OWNED BY demo_eyfs.enrolled_devices.id;


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
-- Name: event_rsvps; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.event_rsvps (
    id integer NOT NULL,
    event_id integer NOT NULL,
    child_id integer NOT NULL,
    parent_email text,
    response text DEFAULT 'yes'::text NOT NULL,
    headcount integer DEFAULT 1,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: event_rsvps_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.event_rsvps_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: event_rsvps_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.event_rsvps_id_seq_demo OWNED BY demo_eyfs.event_rsvps.id;


--
-- Name: events; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.events (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    event_date date NOT NULL,
    start_time text,
    end_time text,
    location text,
    audience text DEFAULT 'all'::text,
    rsvp_required boolean DEFAULT true,
    capacity integer,
    is_published boolean DEFAULT true,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: events_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.events_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: events_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.events_id_seq_demo OWNED BY demo_eyfs.events.id;


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
    date date,
    type text,
    days numeric,
    reinstatement_date date,
    governors_review boolean,
    logged_by integer,
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
-- Name: external_api_tokens; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.external_api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    parent_email text NOT NULL,
    child_id integer NOT NULL,
    label text DEFAULT 'Home Assistant'::text,
    scopes text[] DEFAULT ARRAY['read_child_data'::text],
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: external_test_tokens; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.external_test_tokens (
    id integer NOT NULL,
    token character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL,
    used_at timestamp without time zone,
    result_json jsonb,
    visitor_user_agent text,
    visitor_ip_hash character varying
);


--
-- Name: external_test_tokens_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.external_test_tokens_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: external_test_tokens_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.external_test_tokens_id_seq_demo OWNED BY demo_eyfs.external_test_tokens.id;


--
-- Name: feature_flags; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.feature_flags (
    key text NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    enabled_at timestamp with time zone,
    enabled_by integer,
    config jsonb DEFAULT '{}'::jsonb,
    notes text
);


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
    id integer NOT NULL,
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
-- Name: first_words_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.first_words_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: first_words_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.first_words_id_seq_demo OWNED BY demo_eyfs.first_words.id;


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
    created_at timestamp with time zone DEFAULT now(),
    coel_level character varying(20),
    coel_characteristic character varying(100)
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
    id integer NOT NULL,
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
    statement_id integer,
    eylog_ref text
);


--
-- Name: framework_tracker_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.framework_tracker_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: framework_tracker_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.framework_tracker_id_seq_demo OWNED BY demo_eyfs.framework_tracker.id;


--
-- Name: funding_submissions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.funding_submissions (
    id integer NOT NULL,
    term_id integer,
    submitted_at timestamp with time zone,
    submitted_by integer,
    total_children integer,
    total_hours_claimed numeric(10,2),
    total_value numeric(10,2),
    submission_reference character varying(100),
    status character varying(20) DEFAULT 'draft'::character varying,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: funding_submissions_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.funding_submissions_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: funding_submissions_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.funding_submissions_id_seq_demo OWNED BY demo_eyfs.funding_submissions.id;


--
-- Name: funding_terms; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.funding_terms (
    id integer NOT NULL,
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
-- Name: funding_terms_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.funding_terms_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: funding_terms_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.funding_terms_id_seq_demo OWNED BY demo_eyfs.funding_terms.id;


--
-- Name: gcal_events; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.gcal_events (
    id integer NOT NULL,
    wren_ref text NOT NULL,
    gcal_event_id text NOT NULL,
    calendar_id text NOT NULL,
    wren_type text,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gcal_events_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.gcal_events_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gcal_events_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.gcal_events_id_seq_demo OWNED BY demo_eyfs.gcal_events.id;


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
-- Name: gocardless_webhook_events; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.gocardless_webhook_events (
    event_id text NOT NULL,
    action text NOT NULL,
    resource_type text,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb
);


--
-- Name: governance_narrative; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.governance_narrative (
    id integer NOT NULL,
    section text NOT NULL,
    body text NOT NULL,
    model text,
    generated_at timestamp with time zone DEFAULT now()
);


--
-- Name: governance_narrative_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.governance_narrative_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: governance_narrative_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.governance_narrative_id_seq_demo OWNED BY demo_eyfs.governance_narrative.id;


--
-- Name: ha_config; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.ha_config (
    key character varying(80) NOT NULL,
    entity_id character varying(200),
    notes text,
    updated_at timestamp with time zone DEFAULT now()
);


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
-- Name: hr_blocked_routes; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.hr_blocked_routes (
    id integer NOT NULL,
    path text NOT NULL,
    method character varying(16),
    reason character varying(128),
    ip inet,
    user_agent text,
    cf_email character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hr_blocked_routes_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.hr_blocked_routes_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_blocked_routes_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.hr_blocked_routes_id_seq_demo OWNED BY demo_eyfs.hr_blocked_routes.id;


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
-- Name: import_jobs; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.import_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_kind character varying(32) DEFAULT 'csv'::character varying NOT NULL,
    uploaded_by integer,
    uploaded_at timestamp with time zone,
    file_path text,
    target_entity character varying(64),
    mapping_json jsonb,
    status character varying(32) DEFAULT 'draft'::character varying,
    row_count_total integer DEFAULT 0,
    row_count_imported integer DEFAULT 0,
    error_log_json jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: import_templates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.import_templates (
    id integer NOT NULL,
    name text NOT NULL,
    source_kind character varying(32) DEFAULT 'csv'::character varying,
    target_entity character varying(64),
    mapping_json jsonb NOT NULL,
    version integer DEFAULT 1,
    is_builtin boolean DEFAULT false,
    created_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: import_templates_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.import_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.import_templates_id_seq OWNED BY demo_eyfs.import_templates.id;


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
    witness_name character varying(100),
    signature_data text,
    hospital_transfer boolean,
    hospital_name text,
    days_absence_expected integer,
    riddor_threshold_reason text,
    riddor_notified_at timestamp with time zone,
    riddor_hse_ref text,
    specified_injury boolean,
    specified_injury_type text,
    dangerous_occurrence boolean,
    eylog_ref text
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
-- Name: induction_assignments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.induction_assignments (
    id integer NOT NULL,
    staff_id integer,
    template_id integer,
    assigned_by integer,
    room_leader_id integer,
    start_date date,
    target_complete_date date,
    status text DEFAULT 'in_progress'::text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT induction_assignments_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'complete'::text, 'paused'::text])))
);


--
-- Name: induction_assignments_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.induction_assignments_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: induction_assignments_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.induction_assignments_id_seq_demo OWNED BY demo_eyfs.induction_assignments.id;


--
-- Name: induction_item_progress; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.induction_item_progress (
    id integer NOT NULL,
    assignment_id integer,
    item_id integer,
    status text DEFAULT 'pending'::text,
    completed_at timestamp with time zone,
    signed_off_by integer,
    signed_off_at timestamp with time zone,
    evidence_note text,
    CONSTRAINT induction_item_progress_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'done'::text, 'signed_off'::text])))
);


--
-- Name: induction_item_progress_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.induction_item_progress_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: induction_item_progress_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.induction_item_progress_id_seq_demo OWNED BY demo_eyfs.induction_item_progress.id;


--
-- Name: induction_template_items; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.induction_template_items (
    id integer NOT NULL,
    template_id integer,
    section text,
    title text,
    description text,
    item_type text,
    course_id integer,
    source_refs text[],
    sort_order integer DEFAULT 0,
    required boolean DEFAULT true,
    CONSTRAINT induction_template_items_item_type_check CHECK ((item_type = ANY (ARRAY['form'::text, 'course'::text, 'reading'::text, 'task'::text])))
);


--
-- Name: induction_template_items_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.induction_template_items_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: induction_template_items_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.induction_template_items_id_seq_demo OWNED BY demo_eyfs.induction_template_items.id;


--
-- Name: induction_templates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.induction_templates (
    id integer NOT NULL,
    name text,
    role_target text[] DEFAULT '{apprentice,practitioner}'::text[],
    room_id integer,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: induction_templates_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.induction_templates_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: induction_templates_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.induction_templates_id_seq_demo OWNED BY demo_eyfs.induction_templates.id;


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
    updated_at timestamp with time zone DEFAULT now(),
    bill_payer_email text,
    amount_pence integer,
    issued_on date,
    due_on date,
    paid_on date,
    reference text,
    line_items jsonb,
    payment_method text,
    stripe_session_id text,
    room_id integer,
    sent_by integer,
    credit_note_for_id integer,
    tfc_reference text,
    gc_payment_id text,
    eylog_ref text
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
-- Name: kitchen_cleaning_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.kitchen_cleaning_log (
    id integer NOT NULL,
    task_id integer,
    date date NOT NULL,
    done boolean DEFAULT true,
    notes text,
    recorded_by character varying(100),
    recorded_at timestamp without time zone DEFAULT now()
);


--
-- Name: kitchen_cleaning_log_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.kitchen_cleaning_log_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kitchen_cleaning_log_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.kitchen_cleaning_log_id_seq_demo OWNED BY demo_eyfs.kitchen_cleaning_log.id;


--
-- Name: kitchen_cleaning_tasks; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.kitchen_cleaning_tasks (
    id integer NOT NULL,
    area character varying(120) NOT NULL,
    frequency character varying(20) NOT NULL,
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    CONSTRAINT kitchen_cleaning_tasks_frequency_check CHECK (((frequency)::text = ANY ((ARRAY['daily'::character varying, 'weekly'::character varying, 'monthly'::character varying])::text[])))
);


--
-- Name: kitchen_cleaning_tasks_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.kitchen_cleaning_tasks_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kitchen_cleaning_tasks_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.kitchen_cleaning_tasks_id_seq_demo OWNED BY demo_eyfs.kitchen_cleaning_tasks.id;


--
-- Name: kitchen_cooking_temps; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.kitchen_cooking_temps (
    id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    food_name text NOT NULL,
    temp_c numeric(5,1) NOT NULL,
    logged_at time without time zone DEFAULT CURRENT_TIME NOT NULL,
    logged_by_id integer,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kitchen_cooking_temps_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.kitchen_cooking_temps_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kitchen_cooking_temps_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.kitchen_cooking_temps_id_seq_demo OWNED BY demo_eyfs.kitchen_cooking_temps.id;


--
-- Name: kitchen_notes; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.kitchen_notes (
    id integer NOT NULL,
    date date NOT NULL,
    content text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kitchen_notes_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.kitchen_notes_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kitchen_notes_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.kitchen_notes_id_seq_demo OWNED BY demo_eyfs.kitchen_notes.id;


--
-- Name: kitchen_sensor_readings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.kitchen_sensor_readings (
    id integer NOT NULL,
    location character varying(40) NOT NULL,
    sensor_id character varying(80),
    reading_c numeric(5,1) NOT NULL,
    humidity_pct numeric(5,1),
    out_of_range boolean DEFAULT false,
    source character varying(20) DEFAULT 'sonoff'::character varying,
    recorded_at timestamp without time zone DEFAULT now()
);


--
-- Name: kitchen_sensor_readings_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.kitchen_sensor_readings_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kitchen_sensor_readings_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.kitchen_sensor_readings_id_seq_demo OWNED BY demo_eyfs.kitchen_sensor_readings.id;


--
-- Name: kitchen_temp_thresholds; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.kitchen_temp_thresholds (
    location character varying(40) NOT NULL,
    label character varying(80) NOT NULL,
    min_c numeric(5,1) NOT NULL,
    max_c numeric(5,1) NOT NULL,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: leavers_books; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.leavers_books (
    id integer NOT NULL,
    child_id integer NOT NULL,
    cover_title text,
    leaving_date date,
    staff_farewell text,
    included_photos jsonb DEFAULT '[]'::jsonb,
    ai_highlights text,
    status text DEFAULT 'draft'::text,
    pdf_url text,
    generated_at timestamp with time zone,
    generated_by integer
);


--
-- Name: leavers_books_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.leavers_books_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leavers_books_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.leavers_books_id_seq_demo OWNED BY demo_eyfs.leavers_books.id;


--
-- Name: leavers_gift_packages; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.leavers_gift_packages (
    id integer NOT NULL,
    child_id integer NOT NULL,
    token text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    title text,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    media_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    created_by integer,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_accessed_at timestamp with time zone,
    access_count integer DEFAULT 0 NOT NULL
);


--
-- Name: leavers_gift_packages_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.leavers_gift_packages_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leavers_gift_packages_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.leavers_gift_packages_id_seq_demo OWNED BY demo_eyfs.leavers_gift_packages.id;


--
-- Name: mandatory_training; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.mandatory_training (
    id integer NOT NULL,
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
-- Name: mandatory_training_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.mandatory_training_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mandatory_training_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.mandatory_training_id_seq_demo OWNED BY demo_eyfs.mandatory_training.id;


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
    stock_returned boolean DEFAULT false,
    eylog_ref text,
    form_status text
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
    id integer NOT NULL,
    name text,
    date_from date,
    date_to date,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: menu_groups_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.menu_groups_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: menu_groups_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.menu_groups_id_seq_demo OWNED BY demo_eyfs.menu_groups.id;


--
-- Name: menu_items; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.menu_items (
    id integer NOT NULL,
    menu_group_id integer,
    day_of_week integer,
    meal_type text,
    description text,
    allergens text[],
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: menu_items_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.menu_items_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: menu_items_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.menu_items_id_seq_demo OWNED BY demo_eyfs.menu_items.id;


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
-- Name: message_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.message_audit (
    id integer NOT NULL,
    message_id integer,
    staff_id integer,
    preview text,
    has_attachment boolean DEFAULT false,
    manager_reviewed boolean DEFAULT false,
    reviewed_at timestamp without time zone,
    reviewed_by_staff_id integer,
    reviewed_decision character varying(20),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: message_audit_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.message_audit_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: message_audit_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.message_audit_id_seq_demo OWNED BY demo_eyfs.message_audit.id;


--
-- Name: message_threads; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.message_threads (
    id integer NOT NULL,
    child_id integer,
    subject text,
    last_message_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    recipient_type text DEFAULT 'nursery'::text,
    recipient_staff_id integer
);


--
-- Name: message_threads_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.message_threads_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: message_threads_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.message_threads_id_seq_demo OWNED BY demo_eyfs.message_threads.id;


--
-- Name: messages; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.messages (
    id integer NOT NULL,
    thread_id integer,
    sender_type text NOT NULL,
    sender_id integer,
    parent_email text,
    body text NOT NULL,
    is_read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    attachment_path text,
    attachment_mime character varying(50),
    read_at timestamp without time zone,
    pending_review boolean,
    review_decision character varying(20),
    eylog_ref text,
    ai_draft boolean,
    CONSTRAINT messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['staff'::text, 'parent'::text])))
);


--
-- Name: messages_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.messages_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.messages_id_seq_demo OWNED BY demo_eyfs.messages.id;


--
-- Name: migration_jobs; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.migration_jobs (
    id integer NOT NULL,
    source_system text,
    status text DEFAULT 'pending'::text,
    children_csv text,
    invoices_csv text,
    payments_csv text,
    children_count integer DEFAULT 0,
    invoices_count integer DEFAULT 0,
    payments_count integer DEFAULT 0,
    imported_at timestamp with time zone,
    error text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: migration_jobs_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.migration_jobs_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migration_jobs_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.migration_jobs_id_seq_demo OWNED BY demo_eyfs.migration_jobs.id;


--
-- Name: module_records; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.module_records (
    id bigint NOT NULL,
    module_id integer NOT NULL,
    entity_type text,
    entity_id integer,
    related_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    submitted_by integer,
    submitted_portal text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_deleted boolean DEFAULT false NOT NULL,
    ai_summary text
);


--
-- Name: module_records_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.module_records_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: module_records_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.module_records_id_seq_demo OWNED BY demo_eyfs.module_records.id;


--
-- Name: module_uploads; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.module_uploads (
    id bigint NOT NULL,
    record_id bigint,
    field_key text NOT NULL,
    filename text NOT NULL,
    mime_type text,
    size_bytes integer,
    storage_path text NOT NULL,
    uploaded_by integer,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: module_uploads_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.module_uploads_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: module_uploads_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.module_uploads_id_seq_demo OWNED BY demo_eyfs.module_uploads.id;


--
-- Name: module_views; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.module_views (
    id integer NOT NULL,
    module_id integer NOT NULL,
    name text NOT NULL,
    description text,
    filter_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    display_type text DEFAULT 'table'::text NOT NULL,
    display_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_shared boolean DEFAULT false NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sort jsonb DEFAULT '[]'::jsonb NOT NULL,
    columns jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT module_views_display_type_check CHECK ((display_type = ANY (ARRAY['table'::text, 'cards'::text, 'chart'::text, 'count'::text, 'stat'::text])))
);


--
-- Name: module_views_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.module_views_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: module_views_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.module_views_id_seq_demo OWNED BY demo_eyfs.module_views.id;


--
-- Name: module_workflows; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.module_workflows (
    id integer NOT NULL,
    module_id integer NOT NULL,
    name text NOT NULL,
    trigger text NOT NULL,
    schedule_cron text,
    action_type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT module_workflows_action_type_check CHECK ((action_type = ANY (ARRAY['email'::text, 'ai_summary'::text, 'create_record'::text, 'webhook'::text]))),
    CONSTRAINT module_workflows_trigger_check CHECK ((trigger = ANY (ARRAY['on_submit'::text, 'on_update'::text, 'scheduled'::text])))
);


--
-- Name: module_workflows_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.module_workflows_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: module_workflows_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.module_workflows_id_seq_demo OWNED BY demo_eyfs.module_workflows.id;


--
-- Name: modules; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.modules (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    icon text,
    attaches_to text NOT NULL,
    portals jsonb DEFAULT '[]'::jsonb NOT NULL,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    workflows jsonb DEFAULT '[]'::jsonb NOT NULL,
    ai_prompts jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer,
    is_template boolean DEFAULT false,
    template_category text,
    template_description text,
    review_status character varying(20) DEFAULT 'approved'::character varying,
    origin character varying(20) DEFAULT 'human'::character varying,
    CONSTRAINT modules_attaches_to_check CHECK ((attaches_to = ANY (ARRAY['child'::text, 'staff'::text, 'parent'::text, 'standalone'::text, 'multi'::text])))
);


--
-- Name: modules_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.modules_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: modules_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.modules_id_seq_demo OWNED BY demo_eyfs.modules.id;


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
-- Name: newsletter_reminders; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.newsletter_reminders (
    id integer NOT NULL,
    school_id integer,
    added_by integer,
    added_at timestamp with time zone DEFAULT now(),
    source_type text NOT NULL,
    source_id integer,
    note text NOT NULL,
    included boolean DEFAULT false,
    newsletter_id integer
);


--
-- Name: newsletter_reminders_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.newsletter_reminders_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: newsletter_reminders_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.newsletter_reminders_id_seq_demo OWNED BY demo_eyfs.newsletter_reminders.id;


--
-- Name: newsletter_sections; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.newsletter_sections (
    id integer NOT NULL,
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
-- Name: newsletter_sections_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.newsletter_sections_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: newsletter_sections_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.newsletter_sections_id_seq_demo OWNED BY demo_eyfs.newsletter_sections.id;


--
-- Name: newsletter_sends; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.newsletter_sends (
    id integer NOT NULL,
    newsletter_id integer,
    parent_email character varying(255) NOT NULL,
    parent_name character varying(255),
    child_name character varying(255),
    sent_at timestamp with time zone DEFAULT now(),
    status character varying(20) DEFAULT 'sent'::character varying,
    error_text text
);


--
-- Name: newsletter_sends_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.newsletter_sends_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: newsletter_sends_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.newsletter_sends_id_seq_demo OWNED BY demo_eyfs.newsletter_sends.id;


--
-- Name: newsletter_templates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.newsletter_templates (
    id integer NOT NULL,
    school_id integer,
    edition text DEFAULT 'ladn'::text NOT NULL,
    source_filename text,
    parsed_structure jsonb,
    brand_colours text[],
    tone_notes text,
    uploaded_at timestamp with time zone DEFAULT now(),
    uploaded_by integer
);


--
-- Name: newsletter_templates_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.newsletter_templates_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: newsletter_templates_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.newsletter_templates_id_seq_demo OWNED BY demo_eyfs.newsletter_templates.id;


--
-- Name: newsletters; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.newsletters (
    id integer NOT NULL,
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
    from_name character varying(255) DEFAULT 'Toby Jones'::character varying,
    title character varying(255),
    week_starting date,
    template_id integer,
    auto_generated boolean,
    CONSTRAINT newsletters_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'ready'::text, 'sent'::text])))
);


--
-- Name: newsletters_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.newsletters_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: newsletters_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.newsletters_id_seq_demo OWNED BY demo_eyfs.newsletters.id;


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
    updated_at timestamp with time zone DEFAULT now(),
    source_report_id integer
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
-- Name: notification_queue; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.notification_queue (
    id integer NOT NULL,
    channel text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    queued_at timestamp with time zone DEFAULT now(),
    scheduled_for timestamp with time zone NOT NULL,
    sent_at timestamp with time zone,
    suppressed_at timestamp with time zone
);


--
-- Name: notification_queue_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.notification_queue_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_queue_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.notification_queue_id_seq_demo OWNED BY demo_eyfs.notification_queue.id;


--
-- Name: notification_schedule_prefs; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.notification_schedule_prefs (
    id integer NOT NULL,
    channel text NOT NULL,
    event_type text NOT NULL,
    enabled boolean DEFAULT true,
    respect_working_hours boolean DEFAULT false,
    respect_away_mode boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: notification_schedule_prefs_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.notification_schedule_prefs_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_schedule_prefs_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.notification_schedule_prefs_id_seq_demo OWNED BY demo_eyfs.notification_schedule_prefs.id;


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
    id integer NOT NULL,
    key character varying(100) NOT NULL,
    value numeric NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: observation_standards_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.observation_standards_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: observation_standards_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.observation_standards_id_seq_demo OWNED BY demo_eyfs.observation_standards.id;


--
-- Name: observation_statements; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.observation_statements (
    id bigint NOT NULL,
    observation_id integer NOT NULL,
    statement_id integer NOT NULL,
    framework character varying(50) NOT NULL,
    statement_code character varying(50),
    coel_characteristic character varying(50),
    coel_level character varying(20),
    is_next_step boolean DEFAULT false,
    source character varying(20) DEFAULT 'ai_suggested'::character varying,
    confirmed_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone,
    CONSTRAINT observation_statements_source_check CHECK (((source)::text = ANY ((ARRAY['ai_suggested'::character varying, 'manual'::character varying, 'parent'::character varying, 'teacher'::character varying])::text[])))
);


--
-- Name: observation_statements_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.observation_statements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: observation_statements_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.observation_statements_id_seq OWNED BY demo_eyfs.observation_statements.id;


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
    client_uuid text,
    dsl_only boolean DEFAULT false,
    phase character varying,
    author_name text,
    eylog_ref text,
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
    id integer NOT NULL,
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
-- Name: outings_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.outings_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outings_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.outings_id_seq_demo OWNED BY demo_eyfs.outings.id;


--
-- Name: parent_account_credits; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_account_credits (
    id integer NOT NULL,
    parent_email text NOT NULL,
    child_name text,
    reward_key text DEFAULT 'core_health_dev_2026'::text NOT NULL,
    amount_pence integer DEFAULT 5000 NOT NULL,
    reason text DEFAULT 'Completed all parent study guides'::text NOT NULL,
    status text DEFAULT 'pending_approval'::text NOT NULL,
    earned_at timestamp without time zone DEFAULT now(),
    reviewed_by text,
    reviewed_at timestamp without time zone,
    review_notes text,
    applied_invoice_id integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT parent_account_credits_status_check CHECK ((status = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'applied'::text, 'rejected'::text])))
);


--
-- Name: parent_account_credits_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.parent_account_credits_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: parent_account_credits_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.parent_account_credits_id_seq_demo OWNED BY demo_eyfs.parent_account_credits.id;


--
-- Name: parent_guide_reward_set; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_guide_reward_set (
    module_id integer NOT NULL,
    reward_key text DEFAULT 'core_health_dev_2026'::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    added_at timestamp without time zone DEFAULT now()
);


--
-- Name: parent_message_blocks; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_message_blocks (
    id integer NOT NULL,
    parent_email character varying(255) NOT NULL,
    blocked_at timestamp without time zone DEFAULT now(),
    blocked_by_staff_id integer,
    reason text
);


--
-- Name: parent_message_blocks_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.parent_message_blocks_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: parent_message_blocks_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.parent_message_blocks_id_seq_demo OWNED BY demo_eyfs.parent_message_blocks.id;


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
    answers_json jsonb DEFAULT '[]'::jsonb,
    child_name character varying(200),
    started_at timestamp without time zone,
    answers jsonb,
    time_spent_minutes integer
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
    password_hash text,
    eylog_ref text
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
-- Name: parent_reported_absences; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_reported_absences (
    id integer NOT NULL,
    child_id integer NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    absence_type text DEFAULT 'absence'::text,
    reason text,
    reported_by_email text,
    status text DEFAULT 'reported'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    applied_at timestamp with time zone
);


--
-- Name: parent_reported_absences_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.parent_reported_absences_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: parent_reported_absences_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.parent_reported_absences_id_seq_demo OWNED BY demo_eyfs.parent_reported_absences.id;


--
-- Name: parent_reports; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.parent_reports (
    id integer NOT NULL,
    child_id integer NOT NULL,
    report_type text NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    draft_content text,
    final_content text,
    status text DEFAULT 'draft'::text,
    generated_at timestamp with time zone,
    finalised_at timestamp with time zone,
    sent_at timestamp with time zone,
    generated_by integer,
    CONSTRAINT parent_reports_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'finalised'::text, 'sent'::text])))
);


--
-- Name: parent_reports_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.parent_reports_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: parent_reports_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.parent_reports_id_seq_demo OWNED BY demo_eyfs.parent_reports.id;


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
    is_seen boolean DEFAULT false,
    child_name character varying(200),
    module_id integer,
    reward_data jsonb,
    earned_at timestamp without time zone,
    claimed boolean,
    claimed_at timestamp without time zone
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
    published_at timestamp with time zone,
    category character varying(30),
    age_group character varying(20),
    target_audience text,
    summary text,
    version integer,
    created_by character varying(120),
    reviewed_by character varying(120),
    last_reviewed_at timestamp without time zone,
    seed_document_path text,
    updated_at timestamp without time zone
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
-- Name: payment_reconciliation_flags; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.payment_reconciliation_flags (
    id integer NOT NULL,
    payment_id integer,
    provider text NOT NULL,
    flag_type text NOT NULL,
    detail jsonb,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_reconciliation_flags_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.payment_reconciliation_flags_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_reconciliation_flags_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.payment_reconciliation_flags_id_seq_demo OWNED BY demo_eyfs.payment_reconciliation_flags.id;


--
-- Name: payment_settings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.payment_settings (
    key text NOT NULL,
    enc_value text NOT NULL,
    iv text NOT NULL,
    tag text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


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
    updated_at timestamp with time zone DEFAULT now(),
    eylog_ref text
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
-- Name: payroll_runs; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.payroll_runs (
    id integer NOT NULL,
    period_label text NOT NULL,
    period_year integer NOT NULL,
    period_month integer NOT NULL,
    period_from date NOT NULL,
    period_to date NOT NULL,
    status text DEFAULT 'draft'::text,
    total_gross_pence bigint DEFAULT 0,
    total_tax_pence bigint DEFAULT 0,
    total_ni_pence bigint DEFAULT 0,
    total_net_pence bigint DEFAULT 0,
    staff_count integer DEFAULT 0,
    finalised_by integer,
    finalised_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: payroll_runs_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.payroll_runs_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_runs_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.payroll_runs_id_seq_demo OWNED BY demo_eyfs.payroll_runs.id;


--
-- Name: payroll_staff_lines; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.payroll_staff_lines (
    id integer NOT NULL,
    run_id integer NOT NULL,
    staff_id integer,
    staff_name text,
    contract_type text DEFAULT 'hourly'::text,
    hours_worked numeric(8,2) DEFAULT 0,
    hourly_rate_pence integer DEFAULT 0,
    gross_pence bigint DEFAULT 0,
    tax_pence bigint DEFAULT 0,
    ni_pence bigint DEFAULT 0,
    pension_pence bigint DEFAULT 0,
    net_pence bigint DEFAULT 0,
    holiday_hours numeric(8,2) DEFAULT 0,
    sick_hours numeric(8,2) DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: payroll_staff_lines_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.payroll_staff_lines_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_staff_lines_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.payroll_staff_lines_id_seq_demo OWNED BY demo_eyfs.payroll_staff_lines.id;


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
-- Name: permissions_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.permissions_audit (
    id integer NOT NULL,
    changed_by integer NOT NULL,
    role_key text NOT NULL,
    capability_key text NOT NULL,
    old_level text,
    new_level text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: permissions_audit_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.permissions_audit_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: permissions_audit_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.permissions_audit_id_seq_demo OWNED BY demo_eyfs.permissions_audit.id;


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
    played_at timestamp with time zone DEFAULT now(),
    correct_count integer,
    attempted_count integer
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
    display_order integer DEFAULT 0,
    sound_code character varying(20),
    sound_type character varying(30),
    example_words text[],
    pronunciation_guide text,
    rwi_action text,
    position_in_phase integer
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
    edition text[],
    age_band text[],
    source text,
    source_school_id integer,
    is_public boolean,
    area_of_learning text[],
    subject text[],
    curriculum_links text[],
    group_size text,
    setting text[],
    ai_extension_prompts text[],
    share_to_community boolean,
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
-- Name: probation_periods; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.probation_periods (
    id integer NOT NULL,
    staff_id integer,
    start_date date,
    length_weeks integer DEFAULT 26,
    review_1_date date,
    review_2_date date,
    final_review_date date,
    status text DEFAULT 'active'::text,
    outcome_note text,
    decided_by integer,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT probation_periods_status_check CHECK ((status = ANY (ARRAY['active'::text, 'passed'::text, 'extended'::text, 'failed'::text, 'left'::text])))
);


--
-- Name: probation_periods_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.probation_periods_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: probation_periods_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.probation_periods_id_seq_demo OWNED BY demo_eyfs.probation_periods.id;


--
-- Name: probation_reviews; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.probation_reviews (
    id integer NOT NULL,
    probation_id integer,
    review_type text,
    scheduled_date date,
    completed_date date,
    reviewer_id integer,
    rating text,
    strengths text,
    development_areas text,
    actions text,
    source_refs text[],
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT probation_reviews_review_type_check CHECK ((review_type = ANY (ARRAY['review_1'::text, 'review_2'::text, 'final'::text, 'ad_hoc'::text])))
);


--
-- Name: probation_reviews_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.probation_reviews_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: probation_reviews_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.probation_reviews_id_seq_demo OWNED BY demo_eyfs.probation_reviews.id;


--
-- Name: protected_staff_pins; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.protected_staff_pins (
    staff_id integer NOT NULL,
    staff_name text,
    pin_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.push_subscriptions (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone
);


--
-- Name: push_subscriptions_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.push_subscriptions_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: push_subscriptions_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.push_subscriptions_id_seq_demo OWNED BY demo_eyfs.push_subscriptions.id;


--
-- Name: reconciliation_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.reconciliation_audit (
    id integer NOT NULL,
    event_type text NOT NULL,
    bank_line_id integer,
    payment_id integer,
    invoice_id integer,
    match_id integer,
    actor_id integer,
    confidence integer,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: reconciliation_audit_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.reconciliation_audit_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reconciliation_audit_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.reconciliation_audit_id_seq_demo OWNED BY demo_eyfs.reconciliation_audit.id;


--
-- Name: reconciliation_matches; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.reconciliation_matches (
    id integer NOT NULL,
    bank_line_id integer NOT NULL,
    payment_id integer,
    invoice_id integer,
    match_type text DEFAULT 'suggested'::text NOT NULL,
    confidence_score integer DEFAULT 0 NOT NULL,
    match_reasons jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    confirmed_by integer,
    confirmed_at timestamp with time zone,
    rejected_reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: reconciliation_matches_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.reconciliation_matches_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reconciliation_matches_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.reconciliation_matches_id_seq_demo OWNED BY demo_eyfs.reconciliation_matches.id;


--
-- Name: refresh_tokens; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.refresh_tokens (
    id integer NOT NULL,
    token_hash text NOT NULL,
    parent_email text,
    child_id integer,
    issued_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false,
    device_hint text,
    staff_id integer,
    portal text
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
-- Name: report_sessions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.report_sessions (
    id integer NOT NULL,
    staff_id integer,
    child_id integer,
    child_name text,
    child_age_months integer,
    room text,
    conversation jsonb DEFAULT '[]'::jsonb,
    final_report text,
    report_generated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    framework_selection jsonb
);


--
-- Name: report_sessions_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.report_sessions_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: report_sessions_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.report_sessions_id_seq_demo OWNED BY demo_eyfs.report_sessions.id;


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
    id integer NOT NULL,
    title text NOT NULL,
    content_html text,
    source_url text,
    category text DEFAULT 'general'::text,
    published boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: resources_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.resources_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: resources_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.resources_id_seq_demo OWNED BY demo_eyfs.resources.id;


--
-- Name: retention_policies; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.retention_policies (
    id integer NOT NULL,
    record_type text NOT NULL,
    retention_rule interval NOT NULL,
    trigger_event text NOT NULL,
    legal_basis text NOT NULL,
    source_citation text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    data_category text,
    record_tables text[],
    active_window interval,
    status text DEFAULT 'draft'::text,
    notes text,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by text
);


--
-- Name: retention_policies_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.retention_policies_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: retention_policies_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.retention_policies_id_seq_demo OWNED BY demo_eyfs.retention_policies.id;


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
-- Name: role_capabilities; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.role_capabilities (
    role_id integer NOT NULL,
    capability_id integer NOT NULL,
    level text NOT NULL,
    CONSTRAINT role_capabilities_level_check CHECK ((level = ANY (ARRAY['view'::text, 'edit'::text, 'approve'::text, 'manage'::text])))
);


--
-- Name: roles; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.roles (
    id integer NOT NULL,
    key text NOT NULL,
    display_name text NOT NULL,
    description text,
    is_built_in boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roles_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.roles_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.roles_id_seq_demo OWNED BY demo_eyfs.roles.id;


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
    created_at timestamp with time zone DEFAULT now(),
    target_capacity integer,
    legal_capacity integer,
    monthly_fee_pence integer,
    ratio_children_per_staff integer
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
    created_at timestamp with time zone DEFAULT now(),
    day_of_week integer,
    is_meeting boolean,
    is_lunch_cover boolean,
    source text,
    conflict_flags jsonb,
    is_absent boolean,
    acceptance text,
    is_open boolean,
    label text,
    colour text,
    responded_at timestamp with time zone,
    claimed_at timestamp with time zone
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
    created_at timestamp with time zone DEFAULT now(),
    status text,
    generated_from_pattern_at timestamp with time zone,
    name text,
    duration_days integer,
    budget numeric,
    copied_from integer
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
    severity text,
    is_multi_child boolean,
    category_ids text[],
    requires_lado boolean,
    lado_referral_date date,
    lado_ref_number text,
    escalation_level text,
    escalation_due_at timestamp with time zone,
    escalated_to text,
    escalated_at timestamp with time zone,
    dsl_signoff_at timestamp with time zone,
    dsl_signoff_by integer,
    supervision_notes text,
    supervision_at timestamp with time zone,
    supervision_by integer,
    mash_referral_date date,
    mash_ref_number text,
    transfer_bundle_at timestamp with time zone,
    prev_hash text,
    row_hash text,
    eylog_ref text,
    subject_staff_id integer,
    subject_other_name text,
    lado_category text,
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
-- Name: security_alerts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.security_alerts (
    id integer NOT NULL,
    alert_type character varying(64) NOT NULL,
    origin character varying(255),
    expected_edition character varying(32),
    actual_edition character varying(32),
    path text,
    staff_id integer,
    ip inet,
    user_agent text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: security_alerts_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.security_alerts_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_alerts_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.security_alerts_id_seq_demo OWNED BY demo_eyfs.security_alerts.id;


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
-- Name: security_check_runs; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.security_check_runs (
    id integer NOT NULL,
    triggered_by character varying,
    triggered_at timestamp without time zone DEFAULT now(),
    checks_run integer,
    pass_count integer,
    warn_count integer,
    fail_count integer,
    error_count integer
);


--
-- Name: security_check_runs_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.security_check_runs_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_check_runs_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.security_check_runs_id_seq_demo OWNED BY demo_eyfs.security_check_runs.id;


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
    created_at timestamp with time zone DEFAULT now(),
    check_function_name character varying
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
-- Name: sfbb_records; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.sfbb_records (
    id integer NOT NULL,
    date date NOT NULL,
    shift character varying(10) NOT NULL,
    section character varying(60) NOT NULL,
    item character varying(160) NOT NULL,
    checked boolean DEFAULT false,
    value_text text,
    notes text,
    recorded_by character varying(100),
    recorded_at timestamp without time zone DEFAULT now(),
    CONSTRAINT sfbb_records_shift_check CHECK (((shift)::text = ANY ((ARRAY['opening'::character varying, 'closing'::character varying])::text[])))
);


--
-- Name: sfbb_records_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.sfbb_records_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sfbb_records_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.sfbb_records_id_seq_demo OWNED BY demo_eyfs.sfbb_records.id;


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
    created_at timestamp with time zone DEFAULT now(),
    eylog_ref text
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
-- Name: slot_interest; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.slot_interest (
    id integer NOT NULL,
    room_id integer,
    month text,
    source text DEFAULT 'website'::text,
    ip_hash text,
    session_id text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: slot_interest_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.slot_interest_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: slot_interest_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.slot_interest_id_seq_demo OWNED BY demo_eyfs.slot_interest.id;


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
    photo_url text,
    pin_length integer DEFAULT 4,
    last_login_at timestamp with time zone,
    totp_secret text,
    totp_enrolled_at timestamp with time zone,
    totp_verified boolean,
    totp_last_used integer,
    hourly_rate numeric(6,2),
    qualification text,
    qualification_level integer,
    years_of_service integer,
    is_dsl boolean,
    is_deputy_dsl boolean,
    is_first_aider boolean,
    is_send_lead boolean,
    annual_salary numeric(10,2),
    work_pattern_id integer,
    CONSTRAINT staff_role_check CHECK ((role = ANY (ARRAY['manager'::text, 'deputy_manager'::text, 'room_leader'::text, 'practitioner'::text, 'apprentice'::text, 'admin'::text, 'cook'::text])))
);


--
-- Name: staff_analytics_reports; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_analytics_reports (
    id integer NOT NULL,
    report_type text NOT NULL,
    scope_from date,
    scope_to date,
    generated_at timestamp with time zone DEFAULT now(),
    generated_by integer,
    model_used text,
    deterministic_stats jsonb NOT NULL,
    narrative_summary text,
    flagged_staff jsonb,
    raw_inputs_hash text
);


--
-- Name: staff_analytics_reports_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_analytics_reports_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_analytics_reports_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_analytics_reports_id_seq_demo OWNED BY demo_eyfs.staff_analytics_reports.id;


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
    break_end timestamp with time zone,
    late_minutes integer,
    auto_clocked_out boolean
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
-- Name: staff_capabilities; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_capabilities (
    staff_id integer NOT NULL,
    capability_id integer NOT NULL,
    level text DEFAULT 'manage'::text NOT NULL,
    granted_by integer,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: staff_class_assignments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_class_assignments (
    staff_id integer NOT NULL,
    class_or_room text NOT NULL,
    is_lead boolean DEFAULT false NOT NULL
);


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
    id integer NOT NULL,
    staff_id integer,
    annual_leave_days numeric(4,1) DEFAULT 28,
    carried_over_days numeric(4,1) DEFAULT 0,
    used_days numeric(4,1) DEFAULT 0,
    year text DEFAULT '2025-2026'::text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_entitlement_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_entitlement_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_entitlement_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_entitlement_id_seq_demo OWNED BY demo_eyfs.staff_entitlement.id;


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
-- Name: staff_role_assignments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_role_assignments (
    staff_id integer NOT NULL,
    role_id integer NOT NULL,
    assigned_by integer,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    approved_by integer
);


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
-- Name: staff_work_patterns; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.staff_work_patterns (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    day_of_week integer NOT NULL,
    shift_start time without time zone,
    shift_end time without time zone,
    is_off boolean DEFAULT false NOT NULL,
    lunch_break_minutes integer DEFAULT 0,
    room text,
    effective_from date DEFAULT CURRENT_DATE NOT NULL,
    effective_to date,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT staff_work_patterns_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6)))
);


--
-- Name: staff_work_patterns_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.staff_work_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_work_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.staff_work_patterns_id_seq OWNED BY demo_eyfs.staff_work_patterns.id;


--
-- Name: state_forecast_cache; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.state_forecast_cache (
    forecast_date date NOT NULL,
    computed_at timestamp without time zone DEFAULT now(),
    payload jsonb NOT NULL
);


--
-- Name: stripe_customers; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.stripe_customers (
    id integer NOT NULL,
    bill_payer_email text NOT NULL,
    stripe_customer_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_customers_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.stripe_customers_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stripe_customers_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.stripe_customers_id_seq_demo OWNED BY demo_eyfs.stripe_customers.id;


--
-- Name: stripe_webhook_events; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.stripe_webhook_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb
);


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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    category text,
    question_key text
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
-- Name: supervision_structured; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.supervision_structured (
    id integer NOT NULL,
    supervision_id integer NOT NULL,
    staff_id integer,
    question_key text NOT NULL,
    category text,
    summary_text text,
    rag text,
    flag boolean DEFAULT false,
    ordinal integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supervision_structured_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.supervision_structured_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supervision_structured_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.supervision_structured_id_seq_demo OWNED BY demo_eyfs.supervision_structured.id;


--
-- Name: supervision_targets; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.supervision_targets (
    id integer NOT NULL,
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
-- Name: supervision_targets_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.supervision_targets_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supervision_targets_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.supervision_targets_id_seq_demo OWNED BY demo_eyfs.supervision_targets.id;


--
-- Name: supervisions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.supervisions (
    id integer NOT NULL,
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
-- Name: supervisions_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.supervisions_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supervisions_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.supervisions_id_seq_demo OWNED BY demo_eyfs.supervisions.id;


--
-- Name: survey_invites; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.survey_invites (
    id integer NOT NULL,
    template_id integer NOT NULL,
    email text NOT NULL,
    child_id integer,
    token text DEFAULT encode(public.gen_random_bytes(24), 'hex'::text) NOT NULL,
    sent_at timestamp with time zone,
    clicked_at timestamp with time zone,
    response_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_at timestamp with time zone,
    reminded_at timestamp with time zone
);


--
-- Name: survey_invites_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.survey_invites_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: survey_invites_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.survey_invites_id_seq_demo OWNED BY demo_eyfs.survey_invites.id;


--
-- Name: survey_responses; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.survey_responses (
    id integer NOT NULL,
    survey_type text NOT NULL,
    responses jsonb NOT NULL,
    submitted_at timestamp with time zone DEFAULT now(),
    email text,
    template_id integer
);


--
-- Name: survey_responses_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.survey_responses_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: survey_responses_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.survey_responses_id_seq_demo OWNED BY demo_eyfs.survey_responses.id;


--
-- Name: survey_templates; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.survey_templates (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    survey_type text NOT NULL,
    description text,
    questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: survey_templates_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.survey_templates_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: survey_templates_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.survey_templates_id_seq_demo OWNED BY demo_eyfs.survey_templates.id;


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
-- Name: tasks; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.tasks (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    due_date date,
    owner_staff_id integer,
    created_by integer,
    source text DEFAULT 'manual'::text,
    source_ref text,
    linked_to text,
    linked_id integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    time_of_day character varying(5),
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'done'::text, 'cancelled'::text]))),
    CONSTRAINT tasks_time_of_day_check CHECK (((time_of_day IS NULL) OR ((time_of_day)::text ~ '^[0-2][0-9]:[0-5][0-9]$'::text)))
);


--
-- Name: tasks_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.tasks_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tasks_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.tasks_id_seq_demo OWNED BY demo_eyfs.tasks.id;


--
-- Name: term_plans; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.term_plans (
    id integer NOT NULL,
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
-- Name: term_plans_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.term_plans_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: term_plans_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.term_plans_id_seq_demo OWNED BY demo_eyfs.term_plans.id;


--
-- Name: tfc_payments; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.tfc_payments (
    id integer NOT NULL,
    child_id integer,
    bill_payer_email text,
    tfc_reference text,
    expected_pence integer,
    invoice_id integer,
    status text DEFAULT 'pending'::text,
    bank_line_id integer,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: tfc_payments_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.tfc_payments_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tfc_payments_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.tfc_payments_id_seq_demo OWNED BY demo_eyfs.tfc_payments.id;


--
-- Name: thread_messages; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.thread_messages (
    id integer NOT NULL,
    thread_id integer NOT NULL,
    direction text NOT NULL,
    source text NOT NULL,
    body_text text,
    body_html text,
    attachments_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    sender_email text,
    sender_phone text,
    vapi_call_id text,
    email_triage_id integer,
    enquiry_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_by_staff_id integer,
    ai_drafted boolean DEFAULT false NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT thread_messages_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT thread_messages_source_check CHECK ((source = ANY (ARRAY['enquiry_form'::text, 'email_triage'::text, 'parents_portal'::text, 'newsletter'::text, 'vapi_call'::text, 'manual_note'::text, 'calendar_invite'::text, 'system'::text])))
);


--
-- Name: thread_messages_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.thread_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: thread_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.thread_messages_id_seq OWNED BY demo_eyfs.thread_messages.id;


--
-- Name: threads; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.threads (
    id integer NOT NULL,
    contact_id integer,
    subject text,
    last_message_at timestamp with time zone,
    last_message_preview text,
    unread_count integer DEFAULT 0 NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: threads_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.threads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: threads_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.threads_id_seq OWNED BY demo_eyfs.threads.id;


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
-- Name: totp_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.totp_audit (
    id integer NOT NULL,
    staff_id integer,
    event text NOT NULL,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: totp_audit_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.totp_audit_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: totp_audit_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.totp_audit_id_seq_demo OWNED BY demo_eyfs.totp_audit.id;


--
-- Name: totp_recovery_codes; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.totp_recovery_codes (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: totp_recovery_codes_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.totp_recovery_codes_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: totp_recovery_codes_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.totp_recovery_codes_id_seq_demo OWNED BY demo_eyfs.totp_recovery_codes.id;


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
    created_at timestamp with time zone DEFAULT now(),
    from_number text,
    to_number text,
    raw jsonb,
    outcome text,
    ended_reason text,
    action_status text,
    action_summary text,
    action_notes text,
    action_completed_at timestamp with time zone,
    callback_handled_at timestamp with time zone,
    audio_local_path text,
    audio_download_status text,
    audio_download_at timestamp with time zone,
    audio_retry_count integer,
    safeguarding_flagged boolean,
    safeguarding_flagged_by integer,
    safeguarding_flagged_at timestamp with time zone,
    notes text,
    archived_at timestamp with time zone,
    archived_by integer
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
-- Name: voice_notes; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.voice_notes (
    id integer NOT NULL,
    recorded_by integer,
    child_id integer,
    source_url text,
    source_page text,
    audio_path text NOT NULL,
    duration_ms integer,
    mime_type text,
    size_bytes integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    transcribed_at timestamp with time zone,
    transcript text,
    ollama_classification jsonb,
    draft_id integer,
    draft_table text,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    audio_deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: voice_notes_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.voice_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: voice_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.voice_notes_id_seq OWNED BY demo_eyfs.voice_notes.id;


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
    updated_at timestamp with time zone DEFAULT now(),
    added_at timestamp with time zone,
    fit_score integer,
    tier text,
    days_needed integer,
    preferred_days text[],
    min_days integer,
    deposit_paid boolean,
    deposit_amount_pence integer,
    ready_reserve boolean,
    offer_made_at timestamp with time zone,
    offer_expires_at timestamp with time zone,
    offer_status text,
    seat_depth integer
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
    eyfs_area text,
    learning_intention_id integer,
    eylog_ref text
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
-- Name: work_pattern_days; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.work_pattern_days (
    id integer NOT NULL,
    work_pattern_id integer NOT NULL,
    day_of_week integer NOT NULL,
    shift_start time without time zone,
    shift_end time without time zone,
    is_off boolean DEFAULT false NOT NULL,
    break_minutes integer DEFAULT 0 NOT NULL,
    room text,
    CONSTRAINT work_pattern_days_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6)))
);


--
-- Name: work_pattern_days_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.work_pattern_days_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: work_pattern_days_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.work_pattern_days_id_seq_demo OWNED BY demo_eyfs.work_pattern_days.id;


--
-- Name: work_patterns; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.work_patterns (
    id integer NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    pattern_start_date date,
    public_holiday_handling text DEFAULT 'not_deducted'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    brighthr_ref text,
    staff_id integer,
    weekly_hours numeric,
    pattern_data jsonb,
    source text,
    CONSTRAINT work_patterns_public_holiday_handling_check CHECK ((public_holiday_handling = ANY (ARRAY['deducted'::text, 'not_deducted'::text, 'works'::text])))
);


--
-- Name: work_patterns_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.work_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: work_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.work_patterns_id_seq OWNED BY demo_eyfs.work_patterns.id;


--
-- Name: wren_history_corpus; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.wren_history_corpus (
    id bigint NOT NULL,
    source_ref text NOT NULL,
    source_label text NOT NULL,
    category text,
    title text,
    content text NOT NULL,
    tsv tsvector,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: wren_history_corpus_id_seq_demo; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.wren_history_corpus_id_seq_demo
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wren_history_corpus_id_seq_demo; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.wren_history_corpus_id_seq_demo OWNED BY demo_eyfs.wren_history_corpus.id;


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
-- Name: action_plans id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.action_plans ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.action_plans_id_seq_demo'::regclass);


--
-- Name: ai_digest_items id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ai_digest_items ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.ai_digest_items_id_seq_demo'::regclass);


--
-- Name: apprentice_corpus id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.apprentice_corpus ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.apprentice_corpus_id_seq_demo'::regclass);


--
-- Name: apprentice_events id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.apprentice_events ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.apprentice_events_id_seq_demo'::regclass);


--
-- Name: approval_queue id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.approval_queue ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.approval_queue_id_seq_demo'::regclass);


--
-- Name: assessments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assessments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.assessments_id_seq'::regclass);


--
-- Name: assessments_primary id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assessments_primary ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.assessments_primary_id_seq_demo'::regclass);


--
-- Name: assessments_secondary id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assessments_secondary ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.assessments_secondary_id_seq_demo'::regclass);


--
-- Name: assistant_doc_chunks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assistant_doc_chunks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.assistant_doc_chunks_id_seq_demo'::regclass);


--
-- Name: assistant_memory id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assistant_memory ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.assistant_memory_id_seq_demo'::regclass);


--
-- Name: assistant_shared_memory id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assistant_shared_memory ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.assistant_shared_memory_id_seq_demo'::regclass);


--
-- Name: attendance id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.attendance ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.attendance_id_seq'::regclass);


--
-- Name: attendance_register id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.attendance_register ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.attendance_register_id_seq_demo'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.audit_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.audit_log_id_seq'::regclass);


--
-- Name: automation_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.automation_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.automation_audit_id_seq_demo'::regclass);


--
-- Name: automation_rules id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.automation_rules ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.automation_rules_id_seq_demo'::regclass);


--
-- Name: away_mode id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.away_mode ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.away_mode_id_seq_demo'::regclass);


--
-- Name: bank_statement_lines id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_statement_lines ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.bank_statement_lines_id_seq_demo'::regclass);


--
-- Name: bank_statements id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_statements ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.bank_statements_id_seq_demo'::regclass);


--
-- Name: behaviour_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.behaviour_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.behaviour_log_id_seq'::regclass);


--
-- Name: behaviour_log_primary id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.behaviour_log_primary ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.behaviour_log_primary_id_seq_demo'::regclass);


--
-- Name: calendar_feed_tokens id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.calendar_feed_tokens ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.calendar_feed_tokens_id_seq'::regclass);


--
-- Name: capabilities id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.capabilities ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.capabilities_id_seq_demo'::regclass);


--
-- Name: certificates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.certificates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.certificates_id_seq'::regclass);


--
-- Name: child_about_me id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_about_me ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_about_me_id_seq'::regclass);


--
-- Name: child_bookings id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_bookings ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_bookings_id_seq_demo'::regclass);


--
-- Name: child_consents id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_consents ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_consents_id_seq_demo'::regclass);


--
-- Name: child_funding id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_funding ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_funding_id_seq_demo'::regclass);


--
-- Name: child_holidays id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_holidays ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_holidays_id_seq_demo'::regclass);


--
-- Name: child_phonics_progress id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_phonics_progress ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_phonics_progress_id_seq'::regclass);


--
-- Name: child_sessions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_sessions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_sessions_id_seq_demo'::regclass);


--
-- Name: child_tags id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_tags ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.child_tags_id_seq'::regclass);


--
-- Name: children id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.children ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.children_id_seq'::regclass);


--
-- Name: cockpit_cards id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cockpit_cards ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.cockpit_cards_id_seq_demo'::regclass);


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
-- Name: contact_status_history id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contact_status_history ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.contact_status_history_id_seq'::regclass);


--
-- Name: contacts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contacts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.contacts_id_seq'::regclass);


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
-- Name: course_assignments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_assignments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.course_assignments_id_seq_demo'::regclass);


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
-- Name: ctf_assessment_results id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_assessment_results ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.ctf_assessment_results_id_seq'::regclass);


--
-- Name: ctf_fsm_history id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_fsm_history ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.ctf_fsm_history_id_seq'::regclass);


--
-- Name: ctf_school_history id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_school_history ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.ctf_school_history_id_seq'::regclass);


--
-- Name: ctf_sen_history id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_sen_history ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.ctf_sen_history_id_seq'::regclass);


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
-- Name: daily_summary_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.daily_summary_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.daily_summary_log_id_seq_demo'::regclass);


--
-- Name: data_archives id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.data_archives ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.data_archives_id_seq_demo'::regclass);


--
-- Name: data_subject_requests id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.data_subject_requests ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.data_subject_requests_id_seq_demo'::regclass);


--
-- Name: decision_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.decision_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.decision_log_id_seq'::regclass);


--
-- Name: diary_entries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.diary_entries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.diary_entries_id_seq_demo'::regclass);


--
-- Name: document_workspace_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.document_workspace_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.document_workspace_audit_id_seq'::regclass);


--
-- Name: document_workspaces id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.document_workspaces ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.document_workspaces_id_seq'::regclass);


--
-- Name: doorbell_events id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.doorbell_events ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.doorbell_events_id_seq_demo'::regclass);


--
-- Name: email_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.email_audit_id_seq'::regclass);


--
-- Name: email_sender_rules id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_sender_rules ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.email_sender_rules_id_seq_demo'::regclass);


--
-- Name: email_triage id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_triage ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.email_triage_id_seq_demo'::regclass);


--
-- Name: email_triage_feedback id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_triage_feedback ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.email_triage_feedback_id_seq_demo'::regclass);


--
-- Name: enquiries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enquiries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.enquiries_id_seq'::regclass);


--
-- Name: enquiry_replies id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enquiry_replies ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.enquiry_replies_id_seq_demo'::regclass);


--
-- Name: enrolled_devices id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enrolled_devices ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.enrolled_devices_id_seq_demo'::regclass);


--
-- Name: environment_assessments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.environment_assessments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.environment_assessments_id_seq'::regclass);


--
-- Name: event_rsvps id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.event_rsvps ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.event_rsvps_id_seq_demo'::regclass);


--
-- Name: events id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.events ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.events_id_seq_demo'::regclass);


--
-- Name: exclusions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.exclusions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.exclusions_id_seq'::regclass);


--
-- Name: external_test_tokens id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.external_test_tokens ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.external_test_tokens_id_seq_demo'::regclass);


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
-- Name: first_words id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.first_words ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.first_words_id_seq_demo'::regclass);


--
-- Name: food_intake_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.food_intake_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.food_intake_log_id_seq'::regclass);


--
-- Name: framework_statements id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.framework_statements ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.framework_statements_id_seq'::regclass);


--
-- Name: framework_tracker id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.framework_tracker ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.framework_tracker_id_seq_demo'::regclass);


--
-- Name: funding_submissions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.funding_submissions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.funding_submissions_id_seq_demo'::regclass);


--
-- Name: funding_terms id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.funding_terms ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.funding_terms_id_seq_demo'::regclass);


--
-- Name: gcal_events id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gcal_events ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.gcal_events_id_seq_demo'::regclass);


--
-- Name: gias_cache id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gias_cache ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.gias_cache_id_seq'::regclass);


--
-- Name: gocardless_mandates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gocardless_mandates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.gocardless_mandates_id_seq'::regclass);


--
-- Name: governance_narrative id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.governance_narrative ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.governance_narrative_id_seq_demo'::regclass);


--
-- Name: hr_absences id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_absences ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.hr_absences_id_seq'::regclass);


--
-- Name: hr_blocked_routes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_blocked_routes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.hr_blocked_routes_id_seq_demo'::regclass);


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
-- Name: import_templates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.import_templates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.import_templates_id_seq'::regclass);


--
-- Name: incidents id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.incidents ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.incidents_id_seq'::regclass);


--
-- Name: induction_assignments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_assignments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.induction_assignments_id_seq_demo'::regclass);


--
-- Name: induction_item_progress id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_item_progress ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.induction_item_progress_id_seq_demo'::regclass);


--
-- Name: induction_template_items id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_template_items ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.induction_template_items_id_seq_demo'::regclass);


--
-- Name: induction_templates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_templates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.induction_templates_id_seq_demo'::regclass);


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
-- Name: kitchen_cleaning_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_cleaning_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.kitchen_cleaning_log_id_seq_demo'::regclass);


--
-- Name: kitchen_cleaning_tasks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_cleaning_tasks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.kitchen_cleaning_tasks_id_seq_demo'::regclass);


--
-- Name: kitchen_cooking_temps id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_cooking_temps ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.kitchen_cooking_temps_id_seq_demo'::regclass);


--
-- Name: kitchen_notes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_notes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.kitchen_notes_id_seq_demo'::regclass);


--
-- Name: kitchen_sensor_readings id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_sensor_readings ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.kitchen_sensor_readings_id_seq_demo'::regclass);


--
-- Name: leavers_books id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.leavers_books ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.leavers_books_id_seq_demo'::regclass);


--
-- Name: leavers_gift_packages id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.leavers_gift_packages ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.leavers_gift_packages_id_seq_demo'::regclass);


--
-- Name: mandatory_training id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.mandatory_training ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.mandatory_training_id_seq_demo'::regclass);


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
-- Name: menu_groups id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_groups ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.menu_groups_id_seq_demo'::regclass);


--
-- Name: menu_items id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_items ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.menu_items_id_seq_demo'::regclass);


--
-- Name: menu_plans id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_plans ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.menu_plans_id_seq'::regclass);


--
-- Name: menu_recipes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.menu_recipes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.menu_recipes_id_seq'::regclass);


--
-- Name: message_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.message_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.message_audit_id_seq_demo'::regclass);


--
-- Name: message_threads id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.message_threads ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.message_threads_id_seq_demo'::regclass);


--
-- Name: messages id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.messages ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.messages_id_seq_demo'::regclass);


--
-- Name: migration_jobs id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.migration_jobs ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.migration_jobs_id_seq_demo'::regclass);


--
-- Name: module_records id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.module_records ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.module_records_id_seq_demo'::regclass);


--
-- Name: module_uploads id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.module_uploads ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.module_uploads_id_seq_demo'::regclass);


--
-- Name: module_views id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.module_views ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.module_views_id_seq_demo'::regclass);


--
-- Name: module_workflows id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.module_workflows ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.module_workflows_id_seq_demo'::regclass);


--
-- Name: modules id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.modules ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.modules_id_seq_demo'::regclass);


--
-- Name: n8n_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.n8n_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.n8n_audit_id_seq'::regclass);


--
-- Name: newsletter_reminders id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.newsletter_reminders ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.newsletter_reminders_id_seq_demo'::regclass);


--
-- Name: newsletter_sections id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.newsletter_sections ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.newsletter_sections_id_seq_demo'::regclass);


--
-- Name: newsletter_sends id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.newsletter_sends ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.newsletter_sends_id_seq_demo'::regclass);


--
-- Name: newsletter_templates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.newsletter_templates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.newsletter_templates_id_seq_demo'::regclass);


--
-- Name: newsletters id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.newsletters ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.newsletters_id_seq_demo'::regclass);


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
-- Name: notification_queue id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_queue ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.notification_queue_id_seq_demo'::regclass);


--
-- Name: notification_schedule_prefs id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_schedule_prefs ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.notification_schedule_prefs_id_seq_demo'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notifications ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.notifications_id_seq'::regclass);


--
-- Name: observation_standards id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observation_standards ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.observation_standards_id_seq_demo'::regclass);


--
-- Name: observation_statements id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observation_statements ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.observation_statements_id_seq'::regclass);


--
-- Name: observations id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observations ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.observations_id_seq'::regclass);


--
-- Name: outings id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.outings ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.outings_id_seq_demo'::regclass);


--
-- Name: parent_account_credits id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_account_credits ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_account_credits_id_seq_demo'::regclass);


--
-- Name: parent_message_blocks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_message_blocks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_message_blocks_id_seq_demo'::regclass);


--
-- Name: parent_module_attempts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_module_attempts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_module_attempts_id_seq'::regclass);


--
-- Name: parent_portal_access id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_portal_access ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_portal_access_id_seq'::regclass);


--
-- Name: parent_reported_absences id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_reported_absences ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_reported_absences_id_seq_demo'::regclass);


--
-- Name: parent_reports id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_reports ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_reports_id_seq_demo'::regclass);


--
-- Name: parent_rewards id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_rewards ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_rewards_id_seq'::regclass);


--
-- Name: parent_study_modules id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_study_modules ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.parent_study_modules_id_seq'::regclass);


--
-- Name: payment_reconciliation_flags id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payment_reconciliation_flags ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.payment_reconciliation_flags_id_seq_demo'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.payments_id_seq'::regclass);


--
-- Name: payroll_runs id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_runs ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.payroll_runs_id_seq_demo'::regclass);


--
-- Name: payroll_staff_lines id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_staff_lines ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.payroll_staff_lines_id_seq_demo'::regclass);


--
-- Name: permission_slip_responses id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permission_slip_responses ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.permission_slip_responses_id_seq'::regclass);


--
-- Name: permission_slips id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permission_slips ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.permission_slips_id_seq'::regclass);


--
-- Name: permissions_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permissions_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.permissions_audit_id_seq_demo'::regclass);


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
-- Name: probation_periods id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.probation_periods ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.probation_periods_id_seq_demo'::regclass);


--
-- Name: probation_reviews id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.probation_reviews ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.probation_reviews_id_seq_demo'::regclass);


--
-- Name: push_subscriptions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.push_subscriptions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.push_subscriptions_id_seq_demo'::regclass);


--
-- Name: reconciliation_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reconciliation_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.reconciliation_audit_id_seq_demo'::regclass);


--
-- Name: reconciliation_matches id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reconciliation_matches ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.reconciliation_matches_id_seq_demo'::regclass);


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
-- Name: report_sessions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.report_sessions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.report_sessions_id_seq_demo'::regclass);


--
-- Name: reports id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reports ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.reports_id_seq'::regclass);


--
-- Name: resources id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.resources ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.resources_id_seq_demo'::regclass);


--
-- Name: retention_policies id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.retention_policies ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.retention_policies_id_seq_demo'::regclass);


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
-- Name: roles id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.roles ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.roles_id_seq_demo'::regclass);


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
-- Name: security_alerts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_alerts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.security_alerts_id_seq_demo'::regclass);


--
-- Name: security_check_results id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_check_results ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.security_check_results_id_seq'::regclass);


--
-- Name: security_check_runs id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_check_runs ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.security_check_runs_id_seq_demo'::regclass);


--
-- Name: security_checks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_checks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.security_checks_id_seq'::regclass);


--
-- Name: sen_register id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sen_register ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.sen_register_id_seq'::regclass);


--
-- Name: sfbb_records id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sfbb_records ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.sfbb_records_id_seq_demo'::regclass);


--
-- Name: shopping_lists id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.shopping_lists ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.shopping_lists_id_seq'::regclass);


--
-- Name: sleep_checks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sleep_checks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.sleep_checks_id_seq'::regclass);


--
-- Name: slot_interest id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.slot_interest ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.slot_interest_id_seq_demo'::regclass);


--
-- Name: staff id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_id_seq'::regclass);


--
-- Name: staff_analytics_reports id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_analytics_reports ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_analytics_reports_id_seq_demo'::regclass);


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
-- Name: staff_entitlement id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_entitlement ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_entitlement_id_seq_demo'::regclass);


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
-- Name: staff_work_patterns id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_work_patterns ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.staff_work_patterns_id_seq'::regclass);


--
-- Name: stripe_customers id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.stripe_customers ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.stripe_customers_id_seq_demo'::regclass);


--
-- Name: supervision_question_templates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervision_question_templates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.supervision_question_templates_id_seq'::regclass);


--
-- Name: supervision_structured id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervision_structured ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.supervision_structured_id_seq_demo'::regclass);


--
-- Name: supervision_targets id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervision_targets ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.supervision_targets_id_seq_demo'::regclass);


--
-- Name: supervisions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervisions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.supervisions_id_seq_demo'::regclass);


--
-- Name: survey_invites id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.survey_invites ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.survey_invites_id_seq_demo'::regclass);


--
-- Name: survey_responses id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.survey_responses ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.survey_responses_id_seq_demo'::regclass);


--
-- Name: survey_templates id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.survey_templates ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.survey_templates_id_seq_demo'::regclass);


--
-- Name: tag_definitions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.tag_definitions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.tag_definitions_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.tasks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.tasks_id_seq_demo'::regclass);


--
-- Name: term_plans id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.term_plans ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.term_plans_id_seq_demo'::regclass);


--
-- Name: tfc_payments id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.tfc_payments ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.tfc_payments_id_seq_demo'::regclass);


--
-- Name: thread_messages id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.thread_messages ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.thread_messages_id_seq'::regclass);


--
-- Name: threads id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.threads ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.threads_id_seq'::regclass);


--
-- Name: timetable id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.timetable ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.timetable_id_seq'::regclass);


--
-- Name: toil_entries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.toil_entries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.toil_entries_id_seq'::regclass);


--
-- Name: totp_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.totp_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.totp_audit_id_seq_demo'::regclass);


--
-- Name: totp_recovery_codes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.totp_recovery_codes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.totp_recovery_codes_id_seq_demo'::regclass);


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
-- Name: voice_notes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.voice_notes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.voice_notes_id_seq'::regclass);


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
-- Name: work_pattern_days id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.work_pattern_days ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.work_pattern_days_id_seq_demo'::regclass);


--
-- Name: work_patterns id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.work_patterns ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.work_patterns_id_seq'::regclass);


--
-- Name: wren_history_corpus id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wren_history_corpus ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.wren_history_corpus_id_seq_demo'::regclass);


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
-- Name: ai_digest_items ai_digest_items_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ai_digest_items
    ADD CONSTRAINT ai_digest_items_pkey PRIMARY KEY (id);


--
-- Name: apprentice_corpus apprentice_corpus_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.apprentice_corpus
    ADD CONSTRAINT apprentice_corpus_pkey PRIMARY KEY (id);


--
-- Name: apprentice_corpus apprentice_corpus_source_ref_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.apprentice_corpus
    ADD CONSTRAINT apprentice_corpus_source_ref_key UNIQUE (source_ref);


--
-- Name: apprentice_events apprentice_events_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.apprentice_events
    ADD CONSTRAINT apprentice_events_pkey PRIMARY KEY (id);


--
-- Name: approval_queue approval_queue_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.approval_queue
    ADD CONSTRAINT approval_queue_pkey PRIMARY KEY (id);


--
-- Name: assessments assessments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assessments
    ADD CONSTRAINT assessments_pkey PRIMARY KEY (id);


--
-- Name: assistant_doc_chunks assistant_doc_chunks_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assistant_doc_chunks
    ADD CONSTRAINT assistant_doc_chunks_pkey PRIMARY KEY (id);


--
-- Name: assistant_memory assistant_memory_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assistant_memory
    ADD CONSTRAINT assistant_memory_pkey PRIMARY KEY (id);


--
-- Name: assistant_profile assistant_profile_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assistant_profile
    ADD CONSTRAINT assistant_profile_pkey PRIMARY KEY (staff_id);


--
-- Name: assistant_shared_memory assistant_shared_memory_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.assistant_shared_memory
    ADD CONSTRAINT assistant_shared_memory_pkey PRIMARY KEY (id);


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
-- Name: automation_audit automation_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.automation_audit
    ADD CONSTRAINT automation_audit_pkey PRIMARY KEY (id);


--
-- Name: automation_rules automation_rules_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.automation_rules
    ADD CONSTRAINT automation_rules_pkey PRIMARY KEY (id);


--
-- Name: away_mode away_mode_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.away_mode
    ADD CONSTRAINT away_mode_pkey PRIMARY KEY (id);


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
-- Name: bank_holidays bank_holidays_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_holidays
    ADD CONSTRAINT bank_holidays_pkey PRIMARY KEY (holiday_date);


--
-- Name: bank_statement_lines bank_statement_lines_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_statement_lines
    ADD CONSTRAINT bank_statement_lines_pkey PRIMARY KEY (id);


--
-- Name: bank_statement_lines bank_statement_lines_statement_id_provider_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_statement_lines
    ADD CONSTRAINT bank_statement_lines_statement_id_provider_id_key UNIQUE (statement_id, provider_id);


--
-- Name: bank_statements bank_statements_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_statements
    ADD CONSTRAINT bank_statements_pkey PRIMARY KEY (id);


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
-- Name: capabilities capabilities_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.capabilities
    ADD CONSTRAINT capabilities_key_key UNIQUE (key);


--
-- Name: capabilities capabilities_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.capabilities
    ADD CONSTRAINT capabilities_pkey PRIMARY KEY (id);


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
-- Name: child_bookings child_bookings_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_bookings
    ADD CONSTRAINT child_bookings_pkey PRIMARY KEY (id);


--
-- Name: child_consents child_consents_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_consents
    ADD CONSTRAINT child_consents_pkey PRIMARY KEY (id);


--
-- Name: child_funding child_funding_child_id_term_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_funding
    ADD CONSTRAINT child_funding_child_id_term_id_key UNIQUE (child_id, term_id);


--
-- Name: child_holidays child_holidays_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_holidays
    ADD CONSTRAINT child_holidays_pkey PRIMARY KEY (id);


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
-- Name: child_sessions child_sessions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.child_sessions
    ADD CONSTRAINT child_sessions_pkey PRIMARY KEY (id);


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
-- Name: cockpit_cards cockpit_cards_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cockpit_cards
    ADD CONSTRAINT cockpit_cards_pkey PRIMARY KEY (id);


--
-- Name: cockpit_swot cockpit_swot_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cockpit_swot
    ADD CONSTRAINT cockpit_swot_pkey PRIMARY KEY (quadrant);


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
-- Name: contact_status_history contact_status_history_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contact_status_history
    ADD CONSTRAINT contact_status_history_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


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
-- Name: course_assignments course_assignments_course_id_staff_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_assignments
    ADD CONSTRAINT course_assignments_course_id_staff_id_key UNIQUE (course_id, staff_id);


--
-- Name: course_assignments course_assignments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.course_assignments
    ADD CONSTRAINT course_assignments_pkey PRIMARY KEY (id);


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
-- Name: ctf_assessment_results ctf_assessment_results_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_assessment_results
    ADD CONSTRAINT ctf_assessment_results_pkey PRIMARY KEY (id);


--
-- Name: ctf_exports ctf_exports_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_exports
    ADD CONSTRAINT ctf_exports_pkey PRIMARY KEY (id);


--
-- Name: ctf_fsm_history ctf_fsm_history_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_fsm_history
    ADD CONSTRAINT ctf_fsm_history_pkey PRIMARY KEY (id);


--
-- Name: ctf_school_history ctf_school_history_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_school_history
    ADD CONSTRAINT ctf_school_history_pkey PRIMARY KEY (id);


--
-- Name: ctf_sen_history ctf_sen_history_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ctf_sen_history
    ADD CONSTRAINT ctf_sen_history_pkey PRIMARY KEY (id);


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
-- Name: daily_summary_log daily_summary_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.daily_summary_log
    ADD CONSTRAINT daily_summary_log_pkey PRIMARY KEY (id);


--
-- Name: data_archives data_archives_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.data_archives
    ADD CONSTRAINT data_archives_pkey PRIMARY KEY (id);


--
-- Name: data_subject_requests data_subject_requests_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.data_subject_requests
    ADD CONSTRAINT data_subject_requests_pkey PRIMARY KEY (id);


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
-- Name: diary_entries diary_entries_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.diary_entries
    ADD CONSTRAINT diary_entries_pkey PRIMARY KEY (id);


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
-- Name: doorbell_events doorbell_events_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.doorbell_events
    ADD CONSTRAINT doorbell_events_pkey PRIMARY KEY (id);


--
-- Name: email_audit email_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_audit
    ADD CONSTRAINT email_audit_pkey PRIMARY KEY (id);


--
-- Name: email_sender_rules email_sender_rules_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_sender_rules
    ADD CONSTRAINT email_sender_rules_pkey PRIMARY KEY (id);


--
-- Name: email_triage_feedback email_triage_feedback_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_triage_feedback
    ADD CONSTRAINT email_triage_feedback_pkey PRIMARY KEY (id);


--
-- Name: email_triage email_triage_message_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_triage
    ADD CONSTRAINT email_triage_message_id_key UNIQUE (message_id);


--
-- Name: email_triage email_triage_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.email_triage
    ADD CONSTRAINT email_triage_pkey PRIMARY KEY (id);


--
-- Name: enquiries enquiries_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enquiries
    ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);


--
-- Name: enquiry_replies enquiry_replies_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enquiry_replies
    ADD CONSTRAINT enquiry_replies_pkey PRIMARY KEY (id);


--
-- Name: enrolled_devices enrolled_devices_device_uuid_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enrolled_devices
    ADD CONSTRAINT enrolled_devices_device_uuid_key UNIQUE (device_uuid);


--
-- Name: enrolled_devices enrolled_devices_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.enrolled_devices
    ADD CONSTRAINT enrolled_devices_pkey PRIMARY KEY (id);


--
-- Name: environment_assessments environment_assessments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.environment_assessments
    ADD CONSTRAINT environment_assessments_pkey PRIMARY KEY (id);


--
-- Name: event_rsvps event_rsvps_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.event_rsvps
    ADD CONSTRAINT event_rsvps_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: exclusions exclusions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.exclusions
    ADD CONSTRAINT exclusions_pkey PRIMARY KEY (id);


--
-- Name: external_api_tokens external_api_tokens_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.external_api_tokens
    ADD CONSTRAINT external_api_tokens_pkey PRIMARY KEY (id);


--
-- Name: external_api_tokens external_api_tokens_token_hash_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.external_api_tokens
    ADD CONSTRAINT external_api_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: external_test_tokens external_test_tokens_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.external_test_tokens
    ADD CONSTRAINT external_test_tokens_pkey PRIMARY KEY (id);


--
-- Name: external_test_tokens external_test_tokens_token_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.external_test_tokens
    ADD CONSTRAINT external_test_tokens_token_key UNIQUE (token);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (key);


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
-- Name: funding_submissions funding_submissions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.funding_submissions
    ADD CONSTRAINT funding_submissions_pkey PRIMARY KEY (id);


--
-- Name: gcal_events gcal_events_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gcal_events
    ADD CONSTRAINT gcal_events_pkey PRIMARY KEY (id);


--
-- Name: gcal_events gcal_events_wren_ref_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gcal_events
    ADD CONSTRAINT gcal_events_wren_ref_key UNIQUE (wren_ref);


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
-- Name: gocardless_webhook_events gocardless_webhook_events_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.gocardless_webhook_events
    ADD CONSTRAINT gocardless_webhook_events_pkey PRIMARY KEY (event_id);


--
-- Name: governance_narrative governance_narrative_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.governance_narrative
    ADD CONSTRAINT governance_narrative_pkey PRIMARY KEY (id);


--
-- Name: governance_narrative governance_narrative_section_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.governance_narrative
    ADD CONSTRAINT governance_narrative_section_key UNIQUE (section);


--
-- Name: ha_config ha_config_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.ha_config
    ADD CONSTRAINT ha_config_pkey PRIMARY KEY (key);


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
-- Name: hr_blocked_routes hr_blocked_routes_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.hr_blocked_routes
    ADD CONSTRAINT hr_blocked_routes_pkey PRIMARY KEY (id);


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
-- Name: import_jobs import_jobs_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.import_jobs
    ADD CONSTRAINT import_jobs_pkey PRIMARY KEY (id);


--
-- Name: import_templates import_templates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.import_templates
    ADD CONSTRAINT import_templates_pkey PRIMARY KEY (id);


--
-- Name: incidents incidents_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.incidents
    ADD CONSTRAINT incidents_pkey PRIMARY KEY (id);


--
-- Name: induction_assignments induction_assignments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_assignments
    ADD CONSTRAINT induction_assignments_pkey PRIMARY KEY (id);


--
-- Name: induction_item_progress induction_item_progress_assignment_id_item_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_item_progress
    ADD CONSTRAINT induction_item_progress_assignment_id_item_id_key UNIQUE (assignment_id, item_id);


--
-- Name: induction_item_progress induction_item_progress_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_item_progress
    ADD CONSTRAINT induction_item_progress_pkey PRIMARY KEY (id);


--
-- Name: induction_template_items induction_template_items_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_template_items
    ADD CONSTRAINT induction_template_items_pkey PRIMARY KEY (id);


--
-- Name: induction_templates induction_templates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.induction_templates
    ADD CONSTRAINT induction_templates_pkey PRIMARY KEY (id);


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
-- Name: kitchen_cleaning_log kitchen_cleaning_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_cleaning_log
    ADD CONSTRAINT kitchen_cleaning_log_pkey PRIMARY KEY (id);


--
-- Name: kitchen_cleaning_tasks kitchen_cleaning_tasks_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_cleaning_tasks
    ADD CONSTRAINT kitchen_cleaning_tasks_pkey PRIMARY KEY (id);


--
-- Name: kitchen_cooking_temps kitchen_cooking_temps_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_cooking_temps
    ADD CONSTRAINT kitchen_cooking_temps_pkey PRIMARY KEY (id);


--
-- Name: kitchen_notes kitchen_notes_date_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_notes
    ADD CONSTRAINT kitchen_notes_date_key UNIQUE (date);


--
-- Name: kitchen_notes kitchen_notes_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_notes
    ADD CONSTRAINT kitchen_notes_pkey PRIMARY KEY (id);


--
-- Name: kitchen_sensor_readings kitchen_sensor_readings_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_sensor_readings
    ADD CONSTRAINT kitchen_sensor_readings_pkey PRIMARY KEY (id);


--
-- Name: kitchen_temp_thresholds kitchen_temp_thresholds_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.kitchen_temp_thresholds
    ADD CONSTRAINT kitchen_temp_thresholds_pkey PRIMARY KEY (location);


--
-- Name: leavers_books leavers_books_child_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.leavers_books
    ADD CONSTRAINT leavers_books_child_id_key UNIQUE (child_id);


--
-- Name: leavers_books leavers_books_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.leavers_books
    ADD CONSTRAINT leavers_books_pkey PRIMARY KEY (id);


--
-- Name: leavers_gift_packages leavers_gift_packages_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.leavers_gift_packages
    ADD CONSTRAINT leavers_gift_packages_pkey PRIMARY KEY (id);


--
-- Name: leavers_gift_packages leavers_gift_packages_token_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.leavers_gift_packages
    ADD CONSTRAINT leavers_gift_packages_token_key UNIQUE (token);


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
-- Name: message_audit message_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.message_audit
    ADD CONSTRAINT message_audit_pkey PRIMARY KEY (id);


--
-- Name: migration_jobs migration_jobs_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.migration_jobs
    ADD CONSTRAINT migration_jobs_pkey PRIMARY KEY (id);


--
-- Name: module_records module_records_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.module_records
    ADD CONSTRAINT module_records_pkey PRIMARY KEY (id);


--
-- Name: module_uploads module_uploads_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.module_uploads
    ADD CONSTRAINT module_uploads_pkey PRIMARY KEY (id);


--
-- Name: module_views module_views_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.module_views
    ADD CONSTRAINT module_views_pkey PRIMARY KEY (id);


--
-- Name: module_workflows module_workflows_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.module_workflows
    ADD CONSTRAINT module_workflows_pkey PRIMARY KEY (id);


--
-- Name: modules modules_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.modules
    ADD CONSTRAINT modules_pkey PRIMARY KEY (id);


--
-- Name: modules modules_slug_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.modules
    ADD CONSTRAINT modules_slug_key UNIQUE (slug);


--
-- Name: n8n_audit n8n_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.n8n_audit
    ADD CONSTRAINT n8n_audit_pkey PRIMARY KEY (id);


--
-- Name: newsletter_reminders newsletter_reminders_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.newsletter_reminders
    ADD CONSTRAINT newsletter_reminders_pkey PRIMARY KEY (id);


--
-- Name: newsletter_sends newsletter_sends_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.newsletter_sends
    ADD CONSTRAINT newsletter_sends_pkey PRIMARY KEY (id);


--
-- Name: newsletter_templates newsletter_templates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.newsletter_templates
    ADD CONSTRAINT newsletter_templates_pkey PRIMARY KEY (id);


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
-- Name: notification_queue notification_queue_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_queue
    ADD CONSTRAINT notification_queue_pkey PRIMARY KEY (id);


--
-- Name: notification_schedule_prefs notification_schedule_prefs_channel_event_type_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_schedule_prefs
    ADD CONSTRAINT notification_schedule_prefs_channel_event_type_key UNIQUE (channel, event_type);


--
-- Name: notification_schedule_prefs notification_schedule_prefs_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.notification_schedule_prefs
    ADD CONSTRAINT notification_schedule_prefs_pkey PRIMARY KEY (id);


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
-- Name: observation_statements observation_statements_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observation_statements
    ADD CONSTRAINT observation_statements_pkey PRIMARY KEY (id);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: parent_account_credits parent_account_credits_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_account_credits
    ADD CONSTRAINT parent_account_credits_pkey PRIMARY KEY (id);


--
-- Name: parent_guide_reward_set parent_guide_reward_set_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_guide_reward_set
    ADD CONSTRAINT parent_guide_reward_set_pkey PRIMARY KEY (module_id);


--
-- Name: parent_message_blocks parent_message_blocks_parent_email_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_message_blocks
    ADD CONSTRAINT parent_message_blocks_parent_email_key UNIQUE (parent_email);


--
-- Name: parent_message_blocks parent_message_blocks_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_message_blocks
    ADD CONSTRAINT parent_message_blocks_pkey PRIMARY KEY (id);


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
-- Name: parent_reported_absences parent_reported_absences_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_reported_absences
    ADD CONSTRAINT parent_reported_absences_pkey PRIMARY KEY (id);


--
-- Name: parent_reports parent_reports_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.parent_reports
    ADD CONSTRAINT parent_reports_pkey PRIMARY KEY (id);


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
-- Name: payment_reconciliation_flags payment_reconciliation_flags_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payment_reconciliation_flags
    ADD CONSTRAINT payment_reconciliation_flags_pkey PRIMARY KEY (id);


--
-- Name: payment_settings payment_settings_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payment_settings
    ADD CONSTRAINT payment_settings_pkey PRIMARY KEY (key);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: payroll_runs payroll_runs_period_year_period_month_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_runs
    ADD CONSTRAINT payroll_runs_period_year_period_month_key UNIQUE (period_year, period_month);


--
-- Name: payroll_runs payroll_runs_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);


--
-- Name: payroll_staff_lines payroll_staff_lines_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_staff_lines
    ADD CONSTRAINT payroll_staff_lines_pkey PRIMARY KEY (id);


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
-- Name: permissions_audit permissions_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.permissions_audit
    ADD CONSTRAINT permissions_audit_pkey PRIMARY KEY (id);


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
-- Name: probation_periods probation_periods_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.probation_periods
    ADD CONSTRAINT probation_periods_pkey PRIMARY KEY (id);


--
-- Name: probation_reviews probation_reviews_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.probation_reviews
    ADD CONSTRAINT probation_reviews_pkey PRIMARY KEY (id);


--
-- Name: protected_staff_pins protected_staff_pins_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.protected_staff_pins
    ADD CONSTRAINT protected_staff_pins_pkey PRIMARY KEY (staff_id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_audit reconciliation_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reconciliation_audit
    ADD CONSTRAINT reconciliation_audit_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_matches reconciliation_matches_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reconciliation_matches
    ADD CONSTRAINT reconciliation_matches_pkey PRIMARY KEY (id);


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
-- Name: report_sessions report_sessions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.report_sessions
    ADD CONSTRAINT report_sessions_pkey PRIMARY KEY (id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: retention_policies retention_policies_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.retention_policies
    ADD CONSTRAINT retention_policies_pkey PRIMARY KEY (id);


--
-- Name: retention_policies retention_policies_record_type_trigger_event_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.retention_policies
    ADD CONSTRAINT retention_policies_record_type_trigger_event_key UNIQUE (record_type, trigger_event);


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
-- Name: role_capabilities role_capabilities_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.role_capabilities
    ADD CONSTRAINT role_capabilities_pkey PRIMARY KEY (role_id, capability_id);


--
-- Name: roles roles_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.roles
    ADD CONSTRAINT roles_key_key UNIQUE (key);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


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
-- Name: security_alerts security_alerts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_alerts
    ADD CONSTRAINT security_alerts_pkey PRIMARY KEY (id);


--
-- Name: security_check_results security_check_results_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_check_results
    ADD CONSTRAINT security_check_results_pkey PRIMARY KEY (id);


--
-- Name: security_check_runs security_check_runs_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.security_check_runs
    ADD CONSTRAINT security_check_runs_pkey PRIMARY KEY (id);


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
-- Name: sfbb_records sfbb_records_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.sfbb_records
    ADD CONSTRAINT sfbb_records_pkey PRIMARY KEY (id);


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
-- Name: slot_interest slot_interest_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.slot_interest
    ADD CONSTRAINT slot_interest_pkey PRIMARY KEY (id);


--
-- Name: staff_analytics_reports staff_analytics_reports_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_analytics_reports
    ADD CONSTRAINT staff_analytics_reports_pkey PRIMARY KEY (id);


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
-- Name: staff_capabilities staff_capabilities_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_capabilities
    ADD CONSTRAINT staff_capabilities_pkey PRIMARY KEY (staff_id, capability_id);


--
-- Name: staff_class_assignments staff_class_assignments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_class_assignments
    ADD CONSTRAINT staff_class_assignments_pkey PRIMARY KEY (staff_id, class_or_room);


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
-- Name: staff_role_assignments staff_role_assignments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_role_assignments
    ADD CONSTRAINT staff_role_assignments_pkey PRIMARY KEY (staff_id, role_id);


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
-- Name: staff_work_patterns staff_work_patterns_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_work_patterns
    ADD CONSTRAINT staff_work_patterns_pkey PRIMARY KEY (id);


--
-- Name: staff_work_patterns staff_work_patterns_staff_id_day_of_week_effective_from_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.staff_work_patterns
    ADD CONSTRAINT staff_work_patterns_staff_id_day_of_week_effective_from_key UNIQUE (staff_id, day_of_week, effective_from);


--
-- Name: state_forecast_cache state_forecast_cache_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.state_forecast_cache
    ADD CONSTRAINT state_forecast_cache_pkey PRIMARY KEY (forecast_date);


--
-- Name: stripe_customers stripe_customers_bill_payer_email_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.stripe_customers
    ADD CONSTRAINT stripe_customers_bill_payer_email_key UNIQUE (bill_payer_email);


--
-- Name: stripe_customers stripe_customers_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.stripe_customers
    ADD CONSTRAINT stripe_customers_pkey PRIMARY KEY (id);


--
-- Name: stripe_customers stripe_customers_stripe_customer_id_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.stripe_customers
    ADD CONSTRAINT stripe_customers_stripe_customer_id_key UNIQUE (stripe_customer_id);


--
-- Name: stripe_webhook_events stripe_webhook_events_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.stripe_webhook_events
    ADD CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (event_id);


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
-- Name: supervision_structured supervision_structured_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervision_structured
    ADD CONSTRAINT supervision_structured_pkey PRIMARY KEY (id);


--
-- Name: supervision_structured supervision_structured_supervision_id_question_key_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.supervision_structured
    ADD CONSTRAINT supervision_structured_supervision_id_question_key_key UNIQUE (supervision_id, question_key);


--
-- Name: survey_invites survey_invites_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.survey_invites
    ADD CONSTRAINT survey_invites_pkey PRIMARY KEY (id);


--
-- Name: survey_invites survey_invites_token_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.survey_invites
    ADD CONSTRAINT survey_invites_token_key UNIQUE (token);


--
-- Name: survey_templates survey_templates_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.survey_templates
    ADD CONSTRAINT survey_templates_pkey PRIMARY KEY (id);


--
-- Name: survey_templates survey_templates_slug_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.survey_templates
    ADD CONSTRAINT survey_templates_slug_key UNIQUE (slug);


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
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: tfc_payments tfc_payments_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.tfc_payments
    ADD CONSTRAINT tfc_payments_pkey PRIMARY KEY (id);


--
-- Name: thread_messages thread_messages_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.thread_messages
    ADD CONSTRAINT thread_messages_pkey PRIMARY KEY (id);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);


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
-- Name: totp_audit totp_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.totp_audit
    ADD CONSTRAINT totp_audit_pkey PRIMARY KEY (id);


--
-- Name: totp_recovery_codes totp_recovery_codes_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.totp_recovery_codes
    ADD CONSTRAINT totp_recovery_codes_pkey PRIMARY KEY (id);


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
-- Name: voice_notes voice_notes_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.voice_notes
    ADD CONSTRAINT voice_notes_pkey PRIMARY KEY (id);


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
-- Name: work_pattern_days work_pattern_days_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.work_pattern_days
    ADD CONSTRAINT work_pattern_days_pkey PRIMARY KEY (id);


--
-- Name: work_pattern_days work_pattern_days_work_pattern_id_day_of_week_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.work_pattern_days
    ADD CONSTRAINT work_pattern_days_work_pattern_id_day_of_week_key UNIQUE (work_pattern_id, day_of_week);


--
-- Name: work_patterns work_patterns_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.work_patterns
    ADD CONSTRAINT work_patterns_pkey PRIMARY KEY (id);


--
-- Name: wren_history_corpus wren_history_corpus_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wren_history_corpus
    ADD CONSTRAINT wren_history_corpus_pkey PRIMARY KEY (id);


--
-- Name: wren_history_corpus wren_history_corpus_source_ref_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.wren_history_corpus
    ADD CONSTRAINT wren_history_corpus_source_ref_key UNIQUE (source_ref);


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
-- Name: apprentice_corpus_source_ref_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX apprentice_corpus_source_ref_idx ON demo_eyfs.apprentice_corpus USING btree (source_ref);


--
-- Name: apprentice_corpus_tsv_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX apprentice_corpus_tsv_idx ON demo_eyfs.apprentice_corpus USING gin (tsv);


--
-- Name: apprentice_events_event_date_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX apprentice_events_event_date_idx ON demo_eyfs.apprentice_events USING btree (event_date);


--
-- Name: apprentice_events_linked_email_triage_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX apprentice_events_linked_email_triage_id_idx ON demo_eyfs.apprentice_events USING btree (linked_email_triage_id);


--
-- Name: apprentice_events_staff_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX apprentice_events_staff_id_idx ON demo_eyfs.apprentice_events USING btree (staff_id);


--
-- Name: assistant_doc_chunks_doc_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX assistant_doc_chunks_doc_id_idx ON demo_eyfs.assistant_doc_chunks USING btree (doc_id);


--
-- Name: assistant_doc_chunks_session_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX assistant_doc_chunks_session_id_idx ON demo_eyfs.assistant_doc_chunks USING btree (session_id);


--
-- Name: assistant_doc_chunks_tsv_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX assistant_doc_chunks_tsv_idx ON demo_eyfs.assistant_doc_chunks USING gin (tsv);


--
-- Name: assistant_memory_staff_id_created_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX assistant_memory_staff_id_created_at_idx ON demo_eyfs.assistant_memory USING btree (staff_id, created_at DESC);


--
-- Name: automation_audit_rule_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX automation_audit_rule_id_idx ON demo_eyfs.automation_audit USING btree (rule_id);


--
-- Name: bank_statement_lines_reconciled_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX bank_statement_lines_reconciled_idx ON demo_eyfs.bank_statement_lines USING btree (reconciled);


--
-- Name: bank_statement_lines_statement_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX bank_statement_lines_statement_id_idx ON demo_eyfs.bank_statement_lines USING btree (statement_id);


--
-- Name: bank_statement_lines_transaction_date_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX bank_statement_lines_transaction_date_idx ON demo_eyfs.bank_statement_lines USING btree (transaction_date);


--
-- Name: child_bookings_child_id_is_active_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX child_bookings_child_id_is_active_idx ON demo_eyfs.child_bookings USING btree (child_id, is_active);


--
-- Name: child_consents_child_id_consent_type_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX child_consents_child_id_consent_type_idx ON demo_eyfs.child_consents USING btree (child_id, consent_type);


--
-- Name: child_holidays_child_id_date_coalesce_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX child_holidays_child_id_date_coalesce_idx ON demo_eyfs.child_holidays USING btree (child_id, date, COALESCE(reason, ''::text));


--
-- Name: child_sessions_child_id_start_date_coalesce_coalesce1_coale_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX child_sessions_child_id_start_date_coalesce_coalesce1_coale_idx ON demo_eyfs.child_sessions USING btree (child_id, start_date, COALESCE(start_time, '00:00:00'::time without time zone), COALESCE(session_type, ''::text), COALESCE(room, ''::text));


--
-- Name: children_upn_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX children_upn_idx ON demo_eyfs.children USING btree (upn) WHERE (upn IS NOT NULL);


--
-- Name: cockpit_cards_col_position_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cockpit_cards_col_position_idx ON demo_eyfs.cockpit_cards USING btree (col, "position");


--
-- Name: cockpit_cards_source_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cockpit_cards_source_idx ON demo_eyfs.cockpit_cards USING btree (source);


--
-- Name: contact_status_history_changed_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX contact_status_history_changed_idx ON demo_eyfs.contact_status_history USING btree (changed_at DESC);


--
-- Name: contact_status_history_contact_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX contact_status_history_contact_idx ON demo_eyfs.contact_status_history USING btree (contact_id);


--
-- Name: contacts_child_ids_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX contacts_child_ids_idx ON demo_eyfs.contacts USING gin (child_ids);


--
-- Name: contacts_email_unique; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX contacts_email_unique ON demo_eyfs.contacts USING btree (lower(primary_email)) WHERE (primary_email IS NOT NULL);


--
-- Name: contacts_phone_only_unique; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX contacts_phone_only_unique ON demo_eyfs.contacts USING btree (primary_phone) WHERE ((primary_email IS NULL) AND (primary_phone IS NOT NULL));


--
-- Name: contacts_status_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX contacts_status_idx ON demo_eyfs.contacts USING btree (status);


--
-- Name: course_assignments_course_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX course_assignments_course_id_idx ON demo_eyfs.course_assignments USING btree (course_id);


--
-- Name: course_assignments_staff_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX course_assignments_staff_id_idx ON demo_eyfs.course_assignments USING btree (staff_id);


--
-- Name: cp_child_demo_eyfs; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cp_child_demo_eyfs ON demo_eyfs.cp_register USING btree (child_id) WHERE (is_active = true);


--
-- Name: data_archives_record_type_created_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX data_archives_record_type_created_at_idx ON demo_eyfs.data_archives USING btree (record_type, created_at DESC);


--
-- Name: data_subject_requests_child_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX data_subject_requests_child_id_idx ON demo_eyfs.data_subject_requests USING btree (child_id);


--
-- Name: data_subject_requests_status_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX data_subject_requests_status_idx ON demo_eyfs.data_subject_requests USING btree (status);


--
-- Name: demo_eyfs_medium_term_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX demo_eyfs_medium_term_idx ON demo_eyfs.medium_term_plans USING btree (room_id, term_name, academic_year);


--
-- Name: demo_eyfs_term_plans_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX demo_eyfs_term_plans_idx ON demo_eyfs.term_plans USING btree (room_id, term_name, academic_year);


--
-- Name: diary_entries_child_id_occurred_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX diary_entries_child_id_occurred_at_idx ON demo_eyfs.diary_entries USING btree (child_id, occurred_at DESC);


--
-- Name: diary_entries_eylog_ref_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX diary_entries_eylog_ref_idx ON demo_eyfs.diary_entries USING btree (eylog_ref) WHERE (eylog_ref IS NOT NULL);


--
-- Name: diary_entries_occurred_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX diary_entries_occurred_at_idx ON demo_eyfs.diary_entries USING btree (occurred_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: doorbell_events_triggered_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX doorbell_events_triggered_at_idx ON demo_eyfs.doorbell_events USING btree (triggered_at DESC);


--
-- Name: email_audit_occurred_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX email_audit_occurred_idx ON demo_eyfs.email_audit USING btree (occurred_at DESC);


--
-- Name: email_triage_importance_received_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX email_triage_importance_received_at_idx ON demo_eyfs.email_triage USING btree (importance, received_at DESC) WHERE (alerted_at IS NOT NULL);


--
-- Name: email_triage_received_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX email_triage_received_at_idx ON demo_eyfs.email_triage USING btree (received_at DESC);


--
-- Name: event_rsvps_event_id_child_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX event_rsvps_event_id_child_id_idx ON demo_eyfs.event_rsvps USING btree (event_id, child_id);


--
-- Name: events_event_date_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX events_event_date_idx ON demo_eyfs.events USING btree (event_date);


--
-- Name: external_api_tokens_parent_email_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX external_api_tokens_parent_email_idx ON demo_eyfs.external_api_tokens USING btree (parent_email);


--
-- Name: external_api_tokens_token_hash_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX external_api_tokens_token_hash_idx ON demo_eyfs.external_api_tokens USING btree (token_hash);


--
-- Name: external_test_tokens_expires_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX external_test_tokens_expires_at_idx ON demo_eyfs.external_test_tokens USING btree (expires_at);


--
-- Name: external_test_tokens_token_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX external_test_tokens_token_idx ON demo_eyfs.external_test_tokens USING btree (token);


--
-- Name: gcal_events_wren_ref_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX gcal_events_wren_ref_idx ON demo_eyfs.gcal_events USING btree (wren_ref);


--
-- Name: hr_blocked_routes_created_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX hr_blocked_routes_created_at_idx ON demo_eyfs.hr_blocked_routes USING btree (created_at DESC);


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
-- Name: idx_demo_fw_area_gin; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_fw_area_gin ON demo_eyfs.framework_statements USING gin (area public.gin_trgm_ops);


--
-- Name: idx_demo_fw_aspect_gin; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_fw_aspect_gin ON demo_eyfs.framework_statements USING gin (aspect public.gin_trgm_ops);


--
-- Name: idx_demo_fw_framework; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_fw_framework ON demo_eyfs.framework_statements USING btree (framework);


--
-- Name: idx_demo_fw_stmt_text_gin; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_demo_fw_stmt_text_gin ON demo_eyfs.framework_statements USING gin (statement_text public.gin_trgm_ops);


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
-- Name: idx_eyfs_obs_statements_obs_id; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_eyfs_obs_statements_obs_id ON demo_eyfs.observation_statements USING btree (observation_id);


--
-- Name: idx_eyfs_obs_statements_stmt_id; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_eyfs_obs_statements_stmt_id ON demo_eyfs.observation_statements USING btree (statement_id);


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
-- Name: induction_assignments_room_leader_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX induction_assignments_room_leader_id_idx ON demo_eyfs.induction_assignments USING btree (room_leader_id);


--
-- Name: induction_assignments_staff_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX induction_assignments_staff_id_idx ON demo_eyfs.induction_assignments USING btree (staff_id);


--
-- Name: induction_item_progress_assignment_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX induction_item_progress_assignment_id_idx ON demo_eyfs.induction_item_progress USING btree (assignment_id);


--
-- Name: kitchen_cleaning_log_task_id_date_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX kitchen_cleaning_log_task_id_date_idx ON demo_eyfs.kitchen_cleaning_log USING btree (task_id, date);


--
-- Name: kitchen_sensor_readings_location_recorded_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX kitchen_sensor_readings_location_recorded_at_idx ON demo_eyfs.kitchen_sensor_readings USING btree (location, recorded_at DESC);


--
-- Name: leavers_gift_packages_child_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX leavers_gift_packages_child_id_idx ON demo_eyfs.leavers_gift_packages USING btree (child_id);


--
-- Name: leavers_gift_packages_token_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX leavers_gift_packages_token_idx ON demo_eyfs.leavers_gift_packages USING btree (token);


--
-- Name: module_records_data_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX module_records_data_idx ON demo_eyfs.module_records USING gin (data);


--
-- Name: module_records_entity_type_entity_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX module_records_entity_type_entity_id_idx ON demo_eyfs.module_records USING btree (entity_type, entity_id) WHERE (entity_type IS NOT NULL);


--
-- Name: module_records_module_id_submitted_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX module_records_module_id_submitted_at_idx ON demo_eyfs.module_records USING btree (module_id, submitted_at DESC);


--
-- Name: module_uploads_record_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX module_uploads_record_id_idx ON demo_eyfs.module_uploads USING btree (record_id);


--
-- Name: module_views_module_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX module_views_module_id_idx ON demo_eyfs.module_views USING btree (module_id);


--
-- Name: module_workflows_module_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX module_workflows_module_id_idx ON demo_eyfs.module_workflows USING btree (module_id);


--
-- Name: module_workflows_module_id_is_active_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX module_workflows_module_id_is_active_idx ON demo_eyfs.module_workflows USING btree (module_id, is_active) WHERE (is_active = true);


--
-- Name: modules_attaches_to_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX modules_attaches_to_idx ON demo_eyfs.modules USING btree (attaches_to);


--
-- Name: modules_is_active_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX modules_is_active_idx ON demo_eyfs.modules USING btree (is_active) WHERE (is_active = true);


--
-- Name: newsletter_reminders_included_added_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX newsletter_reminders_included_added_at_idx ON demo_eyfs.newsletter_reminders USING btree (included, added_at);


--
-- Name: newsletter_sends_newsletter_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX newsletter_sends_newsletter_id_idx ON demo_eyfs.newsletter_sends USING btree (newsletter_id);


--
-- Name: observations_client_uuid_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX observations_client_uuid_idx ON demo_eyfs.observations USING btree (client_uuid) WHERE (client_uuid IS NOT NULL);


--
-- Name: parent_account_credits_lower_reward_key_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX parent_account_credits_lower_reward_key_idx ON demo_eyfs.parent_account_credits USING btree (lower(parent_email), reward_key) WHERE (status = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'applied'::text]));


--
-- Name: parent_reported_absences_child_id_start_date_end_date_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX parent_reported_absences_child_id_start_date_end_date_idx ON demo_eyfs.parent_reported_absences USING btree (child_id, start_date, end_date);


--
-- Name: parent_reported_absences_status_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX parent_reported_absences_status_idx ON demo_eyfs.parent_reported_absences USING btree (status);


--
-- Name: payroll_staff_lines_run_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX payroll_staff_lines_run_id_idx ON demo_eyfs.payroll_staff_lines USING btree (run_id);


--
-- Name: probation_periods_staff_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX probation_periods_staff_id_idx ON demo_eyfs.probation_periods USING btree (staff_id);


--
-- Name: probation_periods_status_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX probation_periods_status_idx ON demo_eyfs.probation_periods USING btree (status);


--
-- Name: probation_reviews_probation_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX probation_reviews_probation_id_idx ON demo_eyfs.probation_reviews USING btree (probation_id);


--
-- Name: probation_reviews_scheduled_date_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX probation_reviews_scheduled_date_idx ON demo_eyfs.probation_reviews USING btree (scheduled_date);


--
-- Name: push_subscriptions_staff_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX push_subscriptions_staff_id_idx ON demo_eyfs.push_subscriptions USING btree (staff_id);


--
-- Name: reconciliation_audit_created_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX reconciliation_audit_created_at_idx ON demo_eyfs.reconciliation_audit USING btree (created_at);


--
-- Name: reconciliation_matches_bank_line_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX reconciliation_matches_bank_line_id_idx ON demo_eyfs.reconciliation_matches USING btree (bank_line_id);


--
-- Name: reconciliation_matches_status_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX reconciliation_matches_status_idx ON demo_eyfs.reconciliation_matches USING btree (status);


--
-- Name: security_alerts_created_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX security_alerts_created_at_idx ON demo_eyfs.security_alerts USING btree (created_at DESC);


--
-- Name: sfbb_records_date_shift_section_item_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX sfbb_records_date_shift_section_item_idx ON demo_eyfs.sfbb_records USING btree (date, shift, section, item);


--
-- Name: sg_child_demo_eyfs; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX sg_child_demo_eyfs ON demo_eyfs.safeguarding_concerns USING btree (child_id);


--
-- Name: sg_status_demo_eyfs; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX sg_status_demo_eyfs ON demo_eyfs.safeguarding_concerns USING btree (status);


--
-- Name: slot_interest_created_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX slot_interest_created_at_idx ON demo_eyfs.slot_interest USING btree (created_at);


--
-- Name: slot_interest_room_id_month_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX slot_interest_room_id_month_idx ON demo_eyfs.slot_interest USING btree (room_id, month);


--
-- Name: slot_interest_room_id_month_ip_hash_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX slot_interest_room_id_month_ip_hash_idx ON demo_eyfs.slot_interest USING btree (room_id, month, ip_hash);


--
-- Name: staff_analytics_reports_report_type_generated_at_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX staff_analytics_reports_report_type_generated_at_idx ON demo_eyfs.staff_analytics_reports USING btree (report_type, generated_at DESC);


--
-- Name: staff_work_patterns_room_dow_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX staff_work_patterns_room_dow_idx ON demo_eyfs.staff_work_patterns USING btree (room, day_of_week) WHERE (effective_to IS NULL);


--
-- Name: staff_work_patterns_staff_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX staff_work_patterns_staff_idx ON demo_eyfs.staff_work_patterns USING btree (staff_id);


--
-- Name: supervision_structured_staff_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX supervision_structured_staff_id_idx ON demo_eyfs.supervision_structured USING btree (staff_id);


--
-- Name: supervision_structured_supervision_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX supervision_structured_supervision_id_idx ON demo_eyfs.supervision_structured USING btree (supervision_id);


--
-- Name: tasks_status_due_date_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX tasks_status_due_date_idx ON demo_eyfs.tasks USING btree (status, due_date);


--
-- Name: tfc_payments_child_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX tfc_payments_child_id_idx ON demo_eyfs.tfc_payments USING btree (child_id);


--
-- Name: tfc_payments_status_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX tfc_payments_status_idx ON demo_eyfs.tfc_payments USING btree (status);


--
-- Name: thread_messages_created_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX thread_messages_created_idx ON demo_eyfs.thread_messages USING btree (created_at DESC);


--
-- Name: thread_messages_fts_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX thread_messages_fts_idx ON demo_eyfs.thread_messages USING gin (to_tsvector('english'::regconfig, COALESCE(body_text, ''::text)));


--
-- Name: thread_messages_source_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX thread_messages_source_idx ON demo_eyfs.thread_messages USING btree (source);


--
-- Name: thread_messages_thread_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX thread_messages_thread_idx ON demo_eyfs.thread_messages USING btree (thread_id);


--
-- Name: thread_messages_triage_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX thread_messages_triage_idx ON demo_eyfs.thread_messages USING btree (email_triage_id) WHERE (email_triage_id IS NOT NULL);


--
-- Name: thread_messages_vapi_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX thread_messages_vapi_idx ON demo_eyfs.thread_messages USING btree (vapi_call_id) WHERE (vapi_call_id IS NOT NULL);


--
-- Name: threads_contact_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX threads_contact_id_idx ON demo_eyfs.threads USING btree (contact_id);


--
-- Name: threads_last_message_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX threads_last_message_idx ON demo_eyfs.threads USING btree (last_message_at DESC NULLS LAST);


--
-- Name: threads_unread_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX threads_unread_idx ON demo_eyfs.threads USING btree (unread_count) WHERE (unread_count > 0);


--
-- Name: totp_recovery_codes_staff_id_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX totp_recovery_codes_staff_id_idx ON demo_eyfs.totp_recovery_codes USING btree (staff_id) WHERE (used_at IS NULL);


--
-- Name: voice_notes_recorded_by_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX voice_notes_recorded_by_idx ON demo_eyfs.voice_notes USING btree (recorded_by, recorded_at DESC);


--
-- Name: voice_notes_status_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX voice_notes_status_idx ON demo_eyfs.voice_notes USING btree (status) WHERE (status <> 'drafted'::text);


--
-- Name: work_pattern_days_work_pattern_id_day_of_week_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX work_pattern_days_work_pattern_id_day_of_week_idx ON demo_eyfs.work_pattern_days USING btree (work_pattern_id, day_of_week);


--
-- Name: wren_history_corpus_source_ref_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX wren_history_corpus_source_ref_idx ON demo_eyfs.wren_history_corpus USING btree (source_ref);


--
-- Name: wren_history_corpus_tsv_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX wren_history_corpus_tsv_idx ON demo_eyfs.wren_history_corpus USING gin (tsv);


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
-- Name: observation_statements fk_obs; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observation_statements
    ADD CONSTRAINT fk_obs FOREIGN KEY (observation_id) REFERENCES demo_eyfs.observations(id) ON DELETE CASCADE;


--
-- Name: observation_statements fk_staff; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observation_statements
    ADD CONSTRAINT fk_staff FOREIGN KEY (confirmed_by) REFERENCES demo_eyfs.staff(id) ON DELETE SET NULL;


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

\unrestrict B6gh8YOFFESoVw7ApM1JToh18y3xTkOqvrfOlNE6NiAkAn6nAy6urlloN3lP3eV


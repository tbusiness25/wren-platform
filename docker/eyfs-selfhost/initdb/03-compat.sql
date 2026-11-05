-- =============================================================================
-- Schema compatibility patches for the self-host bundle.
--
-- 01-schema.sql is a point-in-time pg_dump of the demo_eyfs schema. A few
-- columns the current EYFS app code expects were added after that dump was
-- taken. This file brings the seeded schema up to what the running code needs.
--
-- Everything here is idempotent (ADD COLUMN IF NOT EXISTS), so it is safe to
-- re-run and safe as schema evolves. Runs after 01-schema.sql and 02-seed.sql
-- because docker-entrypoint-initdb.d applies files in alphanumeric order.
-- =============================================================================

SET search_path TO demo_eyfs;

-- The staff list / login pad need pin_length so the keypad knows whether to
-- expect a 4- or 6-digit PIN. Default 4 matches the seeded demo PINs (1234).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_length integer DEFAULT 4;
UPDATE staff SET pin_length = 4 WHERE pin_length IS NULL;

-- ---------------------------------------------------------------------------
-- 2026-11-03: columns and tables the current code uses that 01-schema.sql (taken
-- from the public demo's structure) does not have yet. Structure only; generated
-- from the hosted schema with scripts noted in wren-docs/public-release/.
-- ---------------------------------------------------------------------------
ALTER TABLE demo_eyfs.bank_statement_lines ADD COLUMN IF NOT EXISTS duplicate_of_line_id integer;
ALTER TABLE demo_eyfs.bank_statement_lines ADD COLUMN IF NOT EXISTS duplicate_rule text;
ALTER TABLE demo_eyfs.children ADD COLUMN IF NOT EXISTS town text;
ALTER TABLE demo_eyfs.contacts ADD COLUMN IF NOT EXISTS town text;
ALTER TABLE demo_eyfs.cpd_room_meeting_attendees ADD COLUMN IF NOT EXISTS absence_reason text;
ALTER TABLE demo_eyfs.cpd_room_meeting_attendees ADD COLUMN IF NOT EXISTS attended boolean DEFAULT true;
ALTER TABLE demo_eyfs.cpd_room_meeting_attendees ADD COLUMN IF NOT EXISTS from_rota boolean DEFAULT false;
ALTER TABLE demo_eyfs.cpd_room_meeting_attendees ADD COLUMN IF NOT EXISTS recorded_at timestamp with time zone DEFAULT now();
ALTER TABLE demo_eyfs.cpd_room_meeting_attendees ADD COLUMN IF NOT EXISTS recorded_by integer;
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS auto_created boolean DEFAULT false;
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS cancelled_at timestamp with time zone;
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS cancelled_reason text;
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS held_at timestamp with time zone;
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS minutes_written_at timestamp with time zone;
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS start_time time without time zone;
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS status text DEFAULT 'minutes_written'::text;
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
ALTER TABLE demo_eyfs.cpd_room_meetings ADD COLUMN IF NOT EXISTS updated_by integer;
ALTER TABLE demo_eyfs.eylog_deleted_invoices ADD COLUMN IF NOT EXISTS child_room text;
ALTER TABLE demo_eyfs.eylog_deleted_invoices ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE demo_eyfs.eylog_deleted_invoices ADD COLUMN IF NOT EXISTS eylog_status text;
ALTER TABLE demo_eyfs.eylog_deleted_invoices ADD COLUMN IF NOT EXISTS parent_1_email_sent text;
ALTER TABLE demo_eyfs.eylog_deleted_invoices ADD COLUMN IF NOT EXISTS parent_2_email_sent text;
ALTER TABLE demo_eyfs.eylog_uninvoiced_sessions ADD COLUMN IF NOT EXISTS branch text;
ALTER TABLE demo_eyfs.eylog_uninvoiced_sessions ADD COLUMN IF NOT EXISTS child_name text;
ALTER TABLE demo_eyfs.eylog_uninvoiced_sessions ADD COLUMN IF NOT EXISTS session_count integer;
ALTER TABLE demo_eyfs.eylog_uninvoiced_sessions ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE demo_eyfs.induction_template_items ADD COLUMN IF NOT EXISTS auto_rule text;
ALTER TABLE demo_eyfs.induction_template_items ADD COLUMN IF NOT EXISTS due_day integer;
ALTER TABLE demo_eyfs.induction_template_items ADD COLUMN IF NOT EXISTS learning_intention text;
ALTER TABLE demo_eyfs.invoices ADD COLUMN IF NOT EXISTS parent_viewed_at timestamp with time zone;
ALTER TABLE demo_eyfs.messages ADD COLUMN IF NOT EXISTS draft_kind text;
ALTER TABLE demo_eyfs.push_subscriptions ADD COLUMN IF NOT EXISTS portal character varying(20);
ALTER TABLE demo_eyfs.staff ADD COLUMN IF NOT EXISTS ey_number text GENERATED ALWAYS AS ((('LA'::text || (id)::text) || 'ST'::text)) STORED;
ALTER TABLE demo_eyfs.staff_about_me ADD COLUMN IF NOT EXISTS blurb text;
ALTER TABLE demo_eyfs.staff_about_me ADD COLUMN IF NOT EXISTS hidden_at timestamp with time zone;
ALTER TABLE demo_eyfs.staff_about_me ADD COLUMN IF NOT EXISTS hidden_by integer;
ALTER TABLE demo_eyfs.staff_about_me ADD COLUMN IF NOT EXISTS hidden_by_manager boolean DEFAULT false;
ALTER TABLE demo_eyfs.staff_about_me ADD COLUMN IF NOT EXISTS hidden_reason text;
ALTER TABLE demo_eyfs.staff_about_me ADD COLUMN IF NOT EXISTS show_photo boolean DEFAULT false;
ALTER TABLE demo_eyfs.staff_reflections ADD COLUMN IF NOT EXISTS shared_with_mentor boolean DEFAULT false;
ALTER TABLE demo_eyfs.term_plans ADD COLUMN IF NOT EXISTS overview jsonb;
ALTER TABLE demo_eyfs.termly_plan_days ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE demo_eyfs.termly_plan_days ADD COLUMN IF NOT EXISTS intention text;
ALTER TABLE demo_eyfs.waiting_list ADD COLUMN IF NOT EXISTS ey_number text;
ALTER TABLE demo_eyfs.zigbee_join_sessions ADD COLUMN IF NOT EXISTS baseline_offline text[] DEFAULT '{}'::text[];
ALTER TABLE demo_eyfs.zigbee_known_devices ADD COLUMN IF NOT EXISTS needs_repair boolean DEFAULT false;

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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts_ledger_postings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.accounts_ledger_postings (
    id bigint NOT NULL,
    source_kind text NOT NULL,
    source_table text NOT NULL,
    source_id bigint,
    account text NOT NULL,
    period_year integer NOT NULL,
    period_month integer NOT NULL,
    amount_pence bigint NOT NULL,
    is_pay boolean DEFAULT false NOT NULL,
    label text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    posted_by integer,
    posted_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT accounts_ledger_postings_period_month_check CHECK (((period_month >= 1) AND (period_month <= 12)))
);


--
-- Name: accounts_ledger_postings_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.accounts_ledger_postings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounts_ledger_postings_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.accounts_ledger_postings_id_seq OWNED BY demo_eyfs.accounts_ledger_postings.id;


--
-- Name: apprentice_feedback; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.apprentice_feedback (
    id integer NOT NULL,
    apprentice_staff_id integer NOT NULL,
    author_staff_id integer NOT NULL,
    kind text DEFAULT 'observation'::text NOT NULL,
    reflection_id integer,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: apprentice_feedback_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.apprentice_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: apprentice_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.apprentice_feedback_id_seq OWNED BY demo_eyfs.apprentice_feedback.id;


--
-- Name: bank_auto_matches; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.bank_auto_matches (
    id integer NOT NULL,
    bank_line_id integer NOT NULL,
    target_kind text NOT NULL,
    target_id bigint,
    amount_pence bigint NOT NULL,
    certainty text DEFAULT 'review'::text NOT NULL,
    rule text NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    auto boolean DEFAULT false NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    applied_by integer,
    applied_at timestamp with time zone,
    undone_by integer,
    undone_at timestamp with time zone,
    undo_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bank_auto_matches_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.bank_auto_matches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bank_auto_matches_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.bank_auto_matches_id_seq OWNED BY demo_eyfs.bank_auto_matches.id;


--
-- Name: bank_line_duplicate_flags; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.bank_line_duplicate_flags (
    id integer NOT NULL,
    report_id integer NOT NULL,
    bank_line_id integer NOT NULL,
    keep_line_id integer NOT NULL,
    transaction_date date,
    amount_pence bigint,
    dup_source text,
    keep_source text,
    rule text NOT NULL,
    suggested_excluded_reason text NOT NULL,
    already_excluded boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bank_line_duplicate_flags_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.bank_line_duplicate_flags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bank_line_duplicate_flags_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.bank_line_duplicate_flags_id_seq OWNED BY demo_eyfs.bank_line_duplicate_flags.id;


--
-- Name: bank_line_duplicate_reports; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.bank_line_duplicate_reports (
    id integer NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    run_by integer,
    db_name text,
    groups_found integer DEFAULT 0 NOT NULL,
    lines_flagged integer DEFAULT 0 NOT NULL,
    pence_flagged bigint DEFAULT 0 NOT NULL,
    applied_at timestamp with time zone,
    applied_by integer,
    notes text
);


--
-- Name: bank_line_duplicate_reports_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.bank_line_duplicate_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bank_line_duplicate_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.bank_line_duplicate_reports_id_seq OWNED BY demo_eyfs.bank_line_duplicate_reports.id;


--
-- Name: card_settlements; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.card_settlements (
    id integer NOT NULL,
    bank_line_id integer NOT NULL,
    settled_on date,
    gross_pence bigint NOT NULL,
    net_pence bigint NOT NULL,
    fee_pence bigint DEFAULT 0 NOT NULL,
    payment_count integer DEFAULT 0 NOT NULL,
    era text DEFAULT 'wren'::text NOT NULL,
    rule text,
    auto boolean DEFAULT false NOT NULL,
    status text DEFAULT 'applied'::text NOT NULL,
    matched_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    undone_by integer,
    undone_at timestamp with time zone
);


--
-- Name: card_settlements_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.card_settlements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: card_settlements_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.card_settlements_id_seq OWNED BY demo_eyfs.card_settlements.id;


--
-- Name: cctv_gate_tests; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cctv_gate_tests (
    id integer NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    camera_key text,
    probe text NOT NULL,
    expected integer NOT NULL,
    actual integer,
    passed boolean NOT NULL,
    detail text
);


--
-- Name: cctv_gate_tests_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.cctv_gate_tests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cctv_gate_tests_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.cctv_gate_tests_id_seq OWNED BY demo_eyfs.cctv_gate_tests.id;


--
-- Name: comms_email_child_links; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.comms_email_child_links (
    email_id integer NOT NULL,
    child_id integer NOT NULL,
    method text NOT NULL,
    confidence numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comms_email_link_checked; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.comms_email_link_checked (
    email_id integer NOT NULL,
    model text,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_identity; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.contact_identity (
    contact_id integer NOT NULL,
    ni_number text,
    date_of_birth date,
    source text,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_identity_ni_chk CHECK (((ni_number IS NULL) OR (ni_number ~ '^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][0-9]{6}[A-D]$'::text)))
);


--
-- Name: contact_identity_audit; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.contact_identity_audit (
    id bigint NOT NULL,
    contact_id integer,
    child_id integer,
    action text NOT NULL,
    fields text[] DEFAULT '{}'::text[] NOT NULL,
    actor_kind text DEFAULT 'staff'::text NOT NULL,
    actor_id integer,
    ip text,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_identity_audit_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.contact_identity_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_identity_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.contact_identity_audit_id_seq OWNED BY demo_eyfs.contact_identity_audit.id;


--
-- Name: cpd_room_meeting_actions; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cpd_room_meeting_actions (
    id integer NOT NULL,
    meeting_id integer NOT NULL,
    what text NOT NULL,
    owner_id integer,
    due_date date,
    done_at timestamp with time zone,
    done_by integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cpd_rm_actions_what_ck CHECK ((btrim(what) <> ''::text))
);


--
-- Name: cpd_room_meeting_actions_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.cpd_room_meeting_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cpd_room_meeting_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.cpd_room_meeting_actions_id_seq OWNED BY demo_eyfs.cpd_room_meeting_actions.id;


--
-- Name: cpd_room_meeting_agenda; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cpd_room_meeting_agenda (
    id integer NOT NULL,
    meeting_id integer NOT NULL,
    "position" smallint DEFAULT 50 NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    article_id integer,
    title text NOT NULL,
    notes text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cpd_rm_agenda_source_ck CHECK ((source = ANY (ARRAY['cpd_article'::text, 'manual'::text]))),
    CONSTRAINT cpd_rm_agenda_title_ck CHECK ((btrim(title) <> ''::text))
);


--
-- Name: cpd_room_meeting_agenda_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.cpd_room_meeting_agenda_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cpd_room_meeting_agenda_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.cpd_room_meeting_agenda_id_seq OWNED BY demo_eyfs.cpd_room_meeting_agenda.id;


--
-- Name: cpd_room_meeting_notices; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cpd_room_meeting_notices (
    id integer NOT NULL,
    kind text NOT NULL,
    meeting_id integer,
    room_id integer,
    claim_key text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cpd_rm_notices_kind_ck CHECK ((kind = ANY (ARRAY['tomorrow'::text, 'minutes_due'::text, 'room_overdue'::text])))
);


--
-- Name: cpd_room_meeting_notices_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.cpd_room_meeting_notices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cpd_room_meeting_notices_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.cpd_room_meeting_notices_id_seq OWNED BY demo_eyfs.cpd_room_meeting_notices.id;


--
-- Name: cpd_room_meeting_reads; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cpd_room_meeting_reads (
    meeting_id integer NOT NULL,
    staff_id integer NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cpd_room_meeting_schedule; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.cpd_room_meeting_schedule (
    room_id integer NOT NULL,
    weekday smallint DEFAULT 3 NOT NULL,
    start_time time without time zone DEFAULT '13:00:00'::time without time zone NOT NULL,
    every_n_weeks smallint DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cpd_rm_sched_every_ck CHECK (((every_n_weeks >= 1) AND (every_n_weeks <= 4))),
    CONSTRAINT cpd_rm_sched_weekday_ck CHECK (((weekday >= 1) AND (weekday <= 5)))
);


--
-- Name: detail_nudge_log; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.detail_nudge_log (
    id bigint NOT NULL,
    family_key text NOT NULL,
    child_id integer NOT NULL,
    child_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    codes text[] NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    mode text DEFAULT 'auto'::text NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    period_id integer,
    channel text DEFAULT 'bell'::text NOT NULL,
    notification_id integer,
    actor_id integer,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: detail_nudge_log_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.detail_nudge_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: detail_nudge_log_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.detail_nudge_log_id_seq OWNED BY demo_eyfs.detail_nudge_log.id;


--
-- Name: family_comms_notes; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.family_comms_notes (
    id integer NOT NULL,
    child_id integer,
    waiting_list_id integer,
    enquiry_id integer,
    note text DEFAULT ''::text NOT NULL,
    important jsonb DEFAULT '[]'::jsonb NOT NULL,
    model text,
    source_email_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    edited_by integer,
    edited_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_comms_notes_check CHECK ((num_nonnulls(child_id, waiting_list_id, enquiry_id) = 1))
);


--
-- Name: family_comms_notes_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.family_comms_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: family_comms_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.family_comms_notes_id_seq OWNED BY demo_eyfs.family_comms_notes.id;


--
-- Name: family_detail_fills; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.family_detail_fills (
    id integer NOT NULL,
    target_table text NOT NULL,
    target_id integer NOT NULL,
    target_column text NOT NULL,
    value text NOT NULL,
    email_id integer,
    model text NOT NULL,
    confidence numeric,
    filled_at timestamp with time zone DEFAULT now() NOT NULL,
    undone_at timestamp with time zone,
    undone_by integer,
    CONSTRAINT family_detail_fills_target_table_check CHECK ((target_table = ANY (ARRAY['children'::text, 'enquiries'::text, 'waiting_list'::text, 'contacts'::text])))
);


--
-- Name: family_detail_fills_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.family_detail_fills_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: family_detail_fills_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.family_detail_fills_id_seq OWNED BY demo_eyfs.family_detail_fills.id;


--
-- Name: funding_claim_receipts; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.funding_claim_receipts (
    id integer NOT NULL,
    claim_period_id integer NOT NULL,
    bank_line_id integer NOT NULL,
    amount_pence bigint NOT NULL,
    received_on date,
    is_adjustment boolean DEFAULT false NOT NULL,
    matched_rule text,
    auto boolean DEFAULT false NOT NULL,
    matched_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: funding_claim_receipts_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.funding_claim_receipts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: funding_claim_receipts_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.funding_claim_receipts_id_seq OWNED BY demo_eyfs.funding_claim_receipts.id;


--
-- Name: invoice_change_carries; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.invoice_change_carries (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    child_id integer NOT NULL,
    diff_pence integer NOT NULL,
    direction text NOT NULL,
    credit_id integer,
    child_fee_item_id integer,
    target_period text,
    reason text,
    reason_codes text[],
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoice_change_carries_direction_check CHECK ((direction = ANY (ARRAY['credit'::text, 'charge'::text])))
);


--
-- Name: invoice_change_carries_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.invoice_change_carries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_change_carries_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.invoice_change_carries_id_seq OWNED BY demo_eyfs.invoice_change_carries.id;


--
-- Name: observation_reads; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.observation_reads (
    staff_id integer NOT NULL,
    observation_id integer NOT NULL,
    first_read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: opening_balance_changes; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.opening_balance_changes (
    id integer NOT NULL,
    child_id integer NOT NULL,
    old_pence bigint NOT NULL,
    new_pence bigint NOT NULL,
    reason text,
    changed_by text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    rows_before jsonb,
    rows_after jsonb
);


--
-- Name: opening_balance_changes_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.opening_balance_changes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: opening_balance_changes_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.opening_balance_changes_id_seq OWNED BY demo_eyfs.opening_balance_changes.id;


--
-- Name: opening_balance_checks; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.opening_balance_checks (
    id integer NOT NULL,
    child_id integer NOT NULL,
    parent_email text NOT NULL,
    response text NOT NULL,
    balance_pence bigint NOT NULL,
    thread_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT opening_balance_checks_response_check CHECK ((response = ANY (ARRAY['confirmed'::text, 'queried'::text])))
);


--
-- Name: opening_balance_checks_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.opening_balance_checks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: opening_balance_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.opening_balance_checks_id_seq OWNED BY demo_eyfs.opening_balance_checks.id;


--
-- Name: opening_balances; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.opening_balances (
    child_id integer NOT NULL,
    as_of date NOT NULL,
    balance_pence bigint NOT NULL,
    source text DEFAULT 'eyman_r76'::text NOT NULL,
    eyman_as_of_month date,
    eylog_rows_sum_pence bigint,
    invoice_id integer,
    payment_id integer,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    updated_by text,
    updated_at timestamp with time zone
);


--
-- Name: payroll_file_imports; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.payroll_file_imports (
    id integer NOT NULL,
    run_id integer,
    file_kind text NOT NULL,
    filename text,
    header_signature text,
    mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    period_year integer,
    period_month integer,
    rows_in_file integer DEFAULT 0 NOT NULL,
    rows_matched integer DEFAULT 0 NOT NULL,
    rows_unmatched integer DEFAULT 0 NOT NULL,
    totals jsonb DEFAULT '{}'::jsonb NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'applied'::text NOT NULL,
    imported_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_file_imports_period_month_check CHECK (((period_month IS NULL) OR ((period_month >= 1) AND (period_month <= 12))))
);


--
-- Name: payroll_file_imports_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.payroll_file_imports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_file_imports_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.payroll_file_imports_id_seq OWNED BY demo_eyfs.payroll_file_imports.id;


--
-- Name: payroll_run_import_mappings; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.payroll_run_import_mappings (
    id integer NOT NULL,
    file_kind text NOT NULL,
    header_signature text NOT NULL,
    source_label text,
    mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    headers jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    times_used integer DEFAULT 0 NOT NULL
);


--
-- Name: payroll_run_import_mappings_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.payroll_run_import_mappings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_run_import_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.payroll_run_import_mappings_id_seq OWNED BY demo_eyfs.payroll_run_import_mappings.id;


--
-- Name: rota_history_days; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.rota_history_days (
    id integer NOT NULL,
    staff_id integer,
    person_key text NOT NULL,
    display_name text NOT NULL,
    date date NOT NULL,
    status text NOT NULL,
    in_time time without time zone,
    out_time time without time zone,
    hours numeric(5,2),
    room text,
    sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    confidence text NOT NULL,
    built_at timestamp with time zone DEFAULT now() NOT NULL,
    build_version text NOT NULL,
    CONSTRAINT rota_history_days_confidence_check CHECK ((confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT rota_history_days_status_check CHECK ((status = ANY (ARRAY['present'::text, 'present_pattern'::text, 'annual_leave'::text, 'sick'::text, 'toil'::text, 'bank_holiday'::text, 'unpaid'::text, 'training'::text, 'mandatory_leave'::text, 'medical'::text, 'other_leave'::text, 'closed'::text, 'off'::text])))
);


--
-- Name: rota_history_days_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.rota_history_days_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rota_history_days_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.rota_history_days_id_seq OWNED BY demo_eyfs.rota_history_days.id;


--
-- Name: rota_history_payroll; Type: TABLE; Schema: demo_eyfs; Owner: -
--

CREATE TABLE demo_eyfs.rota_history_payroll (
    id integer NOT NULL,
    person_key text NOT NULL,
    month date NOT NULL,
    contracted_hours numeric(6,2),
    deductions jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_file text,
    model text,
    confidence text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    period_from date,
    period_to date,
    matched_by text
);


--
-- Name: COLUMN rota_history_payroll.contracted_hours; Type: COMMENT; Schema: demo_eyfs; Owner: -
--

COMMENT ON COLUMN demo_eyfs.rota_history_payroll.contracted_hours IS 'Hours per week from the payroll submission (weekly)';


--
-- Name: COLUMN rota_history_payroll.deductions; Type: COMMENT; Schema: demo_eyfs; Owner: -
--

COMMENT ON COLUMN demo_eyfs.rota_history_payroll.deductions IS '[{kind: sick|unpaid|toil|smp|other, days?, hours?}] — categories only, never the free-text reason';


--
-- Name: rota_history_payroll_id_seq; Type: SEQUENCE; Schema: demo_eyfs; Owner: -
--

CREATE SEQUENCE demo_eyfs.rota_history_payroll_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rota_history_payroll_id_seq; Type: SEQUENCE OWNED BY; Schema: demo_eyfs; Owner: -
--

ALTER SEQUENCE demo_eyfs.rota_history_payroll_id_seq OWNED BY demo_eyfs.rota_history_payroll.id;


--
-- Name: accounts_ledger_postings id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.accounts_ledger_postings ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.accounts_ledger_postings_id_seq'::regclass);


--
-- Name: apprentice_feedback id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.apprentice_feedback ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.apprentice_feedback_id_seq'::regclass);


--
-- Name: bank_auto_matches id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_auto_matches ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.bank_auto_matches_id_seq'::regclass);


--
-- Name: bank_line_duplicate_flags id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_line_duplicate_flags ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.bank_line_duplicate_flags_id_seq'::regclass);


--
-- Name: bank_line_duplicate_reports id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_line_duplicate_reports ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.bank_line_duplicate_reports_id_seq'::regclass);


--
-- Name: card_settlements id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.card_settlements ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.card_settlements_id_seq'::regclass);


--
-- Name: cctv_gate_tests id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cctv_gate_tests ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.cctv_gate_tests_id_seq'::regclass);


--
-- Name: contact_identity_audit id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contact_identity_audit ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.contact_identity_audit_id_seq'::regclass);


--
-- Name: cpd_room_meeting_actions id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_actions ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.cpd_room_meeting_actions_id_seq'::regclass);


--
-- Name: cpd_room_meeting_agenda id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_agenda ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.cpd_room_meeting_agenda_id_seq'::regclass);


--
-- Name: cpd_room_meeting_notices id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_notices ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.cpd_room_meeting_notices_id_seq'::regclass);


--
-- Name: detail_nudge_log id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.detail_nudge_log ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.detail_nudge_log_id_seq'::regclass);


--
-- Name: family_comms_notes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_comms_notes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.family_comms_notes_id_seq'::regclass);


--
-- Name: family_detail_fills id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_detail_fills ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.family_detail_fills_id_seq'::regclass);


--
-- Name: funding_claim_receipts id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.funding_claim_receipts ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.funding_claim_receipts_id_seq'::regclass);


--
-- Name: invoice_change_carries id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoice_change_carries ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.invoice_change_carries_id_seq'::regclass);


--
-- Name: opening_balance_changes id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balance_changes ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.opening_balance_changes_id_seq'::regclass);


--
-- Name: opening_balance_checks id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balance_checks ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.opening_balance_checks_id_seq'::regclass);


--
-- Name: payroll_file_imports id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_file_imports ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.payroll_file_imports_id_seq'::regclass);


--
-- Name: payroll_run_import_mappings id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_run_import_mappings ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.payroll_run_import_mappings_id_seq'::regclass);


--
-- Name: rota_history_days id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_history_days ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.rota_history_days_id_seq'::regclass);


--
-- Name: rota_history_payroll id; Type: DEFAULT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_history_payroll ALTER COLUMN id SET DEFAULT nextval('demo_eyfs.rota_history_payroll_id_seq'::regclass);


--
-- Name: accounts_ledger_postings accounts_ledger_postings_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.accounts_ledger_postings
    ADD CONSTRAINT accounts_ledger_postings_pkey PRIMARY KEY (id);


--
-- Name: apprentice_feedback apprentice_feedback_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.apprentice_feedback
    ADD CONSTRAINT apprentice_feedback_pkey PRIMARY KEY (id);


--
-- Name: bank_auto_matches bank_auto_matches_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_auto_matches
    ADD CONSTRAINT bank_auto_matches_pkey PRIMARY KEY (id);


--
-- Name: bank_line_duplicate_flags bank_line_duplicate_flags_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_line_duplicate_flags
    ADD CONSTRAINT bank_line_duplicate_flags_pkey PRIMARY KEY (id);


--
-- Name: bank_line_duplicate_reports bank_line_duplicate_reports_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_line_duplicate_reports
    ADD CONSTRAINT bank_line_duplicate_reports_pkey PRIMARY KEY (id);


--
-- Name: card_settlements card_settlements_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.card_settlements
    ADD CONSTRAINT card_settlements_pkey PRIMARY KEY (id);


--
-- Name: cctv_gate_tests cctv_gate_tests_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cctv_gate_tests
    ADD CONSTRAINT cctv_gate_tests_pkey PRIMARY KEY (id);


--
-- Name: comms_email_child_links comms_email_child_links_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_email_child_links
    ADD CONSTRAINT comms_email_child_links_pkey PRIMARY KEY (email_id, child_id);


--
-- Name: comms_email_link_checked comms_email_link_checked_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.comms_email_link_checked
    ADD CONSTRAINT comms_email_link_checked_pkey PRIMARY KEY (email_id);


--
-- Name: contact_identity_audit contact_identity_audit_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contact_identity_audit
    ADD CONSTRAINT contact_identity_audit_pkey PRIMARY KEY (id);


--
-- Name: contact_identity contact_identity_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contact_identity
    ADD CONSTRAINT contact_identity_pkey PRIMARY KEY (contact_id);


--
-- Name: cpd_room_meeting_actions cpd_room_meeting_actions_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_actions
    ADD CONSTRAINT cpd_room_meeting_actions_pkey PRIMARY KEY (id);


--
-- Name: cpd_room_meeting_agenda cpd_room_meeting_agenda_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_agenda
    ADD CONSTRAINT cpd_room_meeting_agenda_pkey PRIMARY KEY (id);


--
-- Name: cpd_room_meeting_notices cpd_room_meeting_notices_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_notices
    ADD CONSTRAINT cpd_room_meeting_notices_pkey PRIMARY KEY (id);


--
-- Name: cpd_room_meeting_reads cpd_room_meeting_reads_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_reads
    ADD CONSTRAINT cpd_room_meeting_reads_pkey PRIMARY KEY (meeting_id, staff_id);


--
-- Name: cpd_room_meeting_schedule cpd_room_meeting_schedule_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_schedule
    ADD CONSTRAINT cpd_room_meeting_schedule_pkey PRIMARY KEY (room_id);


--
-- Name: detail_nudge_log detail_nudge_log_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.detail_nudge_log
    ADD CONSTRAINT detail_nudge_log_pkey PRIMARY KEY (id);


--
-- Name: family_comms_notes family_comms_notes_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_comms_notes
    ADD CONSTRAINT family_comms_notes_pkey PRIMARY KEY (id);


--
-- Name: family_detail_fills family_detail_fills_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_detail_fills
    ADD CONSTRAINT family_detail_fills_pkey PRIMARY KEY (id);


--
-- Name: funding_claim_receipts funding_claim_receipts_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.funding_claim_receipts
    ADD CONSTRAINT funding_claim_receipts_pkey PRIMARY KEY (id);


--
-- Name: invoice_change_carries invoice_change_carries_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoice_change_carries
    ADD CONSTRAINT invoice_change_carries_pkey PRIMARY KEY (id);


--
-- Name: observation_reads observation_reads_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.observation_reads
    ADD CONSTRAINT observation_reads_pkey PRIMARY KEY (staff_id, observation_id);


--
-- Name: opening_balance_changes opening_balance_changes_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balance_changes
    ADD CONSTRAINT opening_balance_changes_pkey PRIMARY KEY (id);


--
-- Name: opening_balance_checks opening_balance_checks_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balance_checks
    ADD CONSTRAINT opening_balance_checks_pkey PRIMARY KEY (id);


--
-- Name: opening_balances opening_balances_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balances
    ADD CONSTRAINT opening_balances_pkey PRIMARY KEY (child_id);


--
-- Name: payroll_file_imports payroll_file_imports_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_file_imports
    ADD CONSTRAINT payroll_file_imports_pkey PRIMARY KEY (id);


--
-- Name: payroll_run_import_mappings payroll_run_import_mappings_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_run_import_mappings
    ADD CONSTRAINT payroll_run_import_mappings_pkey PRIMARY KEY (id);


--
-- Name: rota_history_days rota_history_days_person_key_date_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_history_days
    ADD CONSTRAINT rota_history_days_person_key_date_key UNIQUE (person_key, date);


--
-- Name: rota_history_days rota_history_days_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_history_days
    ADD CONSTRAINT rota_history_days_pkey PRIMARY KEY (id);


--
-- Name: rota_history_payroll rota_history_payroll_person_key_month_key; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_history_payroll
    ADD CONSTRAINT rota_history_payroll_person_key_month_key UNIQUE (person_key, month);


--
-- Name: rota_history_payroll rota_history_payroll_pkey; Type: CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_history_payroll
    ADD CONSTRAINT rota_history_payroll_pkey PRIMARY KEY (id);


--
-- Name: accounts_ledger_postings_kind_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX accounts_ledger_postings_kind_idx ON demo_eyfs.accounts_ledger_postings USING btree (source_kind, period_year, period_month);


--
-- Name: accounts_ledger_postings_period_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX accounts_ledger_postings_period_idx ON demo_eyfs.accounts_ledger_postings USING btree (period_year, period_month);


--
-- Name: accounts_ledger_postings_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX accounts_ledger_postings_uq ON demo_eyfs.accounts_ledger_postings USING btree (source_kind, source_table, source_id, account) WHERE ((superseded_at IS NULL) AND (source_id IS NOT NULL));


--
-- Name: apprentice_feedback_apprentice_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX apprentice_feedback_apprentice_idx ON demo_eyfs.apprentice_feedback USING btree (apprentice_staff_id, created_at DESC);


--
-- Name: bank_auto_matches_live_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX bank_auto_matches_live_uq ON demo_eyfs.bank_auto_matches USING btree (bank_line_id) WHERE (status = ANY (ARRAY['applied'::text, 'queued'::text]));


--
-- Name: bank_auto_matches_status_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX bank_auto_matches_status_idx ON demo_eyfs.bank_auto_matches USING btree (status, created_at DESC);


--
-- Name: bank_auto_matches_target_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX bank_auto_matches_target_idx ON demo_eyfs.bank_auto_matches USING btree (target_kind, target_id);


--
-- Name: bank_line_duplicate_flags_report_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX bank_line_duplicate_flags_report_idx ON demo_eyfs.bank_line_duplicate_flags USING btree (report_id);


--
-- Name: bank_line_duplicate_flags_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX bank_line_duplicate_flags_uq ON demo_eyfs.bank_line_duplicate_flags USING btree (report_id, bank_line_id);


--
-- Name: card_settlements_line_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX card_settlements_line_uq ON demo_eyfs.card_settlements USING btree (bank_line_id) WHERE (status = 'applied'::text);


--
-- Name: cctv_gate_tests_ran_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cctv_gate_tests_ran_idx ON demo_eyfs.cctv_gate_tests USING btree (ran_at DESC);


--
-- Name: comms_email_child_links_child; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX comms_email_child_links_child ON demo_eyfs.comms_email_child_links USING btree (child_id);


--
-- Name: contact_identity_audit_contact_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX contact_identity_audit_contact_idx ON demo_eyfs.contact_identity_audit USING btree (contact_id, at);


--
-- Name: cpd_rm_actions_meeting_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cpd_rm_actions_meeting_idx ON demo_eyfs.cpd_room_meeting_actions USING btree (meeting_id, id);


--
-- Name: cpd_rm_actions_owner_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cpd_rm_actions_owner_idx ON demo_eyfs.cpd_room_meeting_actions USING btree (owner_id, due_date) WHERE (done_at IS NULL);


--
-- Name: cpd_rm_agenda_article_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX cpd_rm_agenda_article_uq ON demo_eyfs.cpd_room_meeting_agenda USING btree (meeting_id, article_id) WHERE (article_id IS NOT NULL);


--
-- Name: cpd_rm_agenda_meeting_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cpd_rm_agenda_meeting_idx ON demo_eyfs.cpd_room_meeting_agenda USING btree (meeting_id, "position", id);


--
-- Name: cpd_rm_notices_claim_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX cpd_rm_notices_claim_uq ON demo_eyfs.cpd_room_meeting_notices USING btree (claim_key);


--
-- Name: cpd_rm_reads_staff_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX cpd_rm_reads_staff_idx ON demo_eyfs.cpd_room_meeting_reads USING btree (staff_id, read_at DESC);


--
-- Name: detail_nudge_log_child_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX detail_nudge_log_child_idx ON demo_eyfs.detail_nudge_log USING btree (child_id, sent_at);


--
-- Name: detail_nudge_log_family_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX detail_nudge_log_family_idx ON demo_eyfs.detail_nudge_log USING btree (family_key, sent_at);


--
-- Name: family_comms_notes_child_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX family_comms_notes_child_uq ON demo_eyfs.family_comms_notes USING btree (child_id) WHERE (child_id IS NOT NULL);


--
-- Name: family_comms_notes_enquiry_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX family_comms_notes_enquiry_uq ON demo_eyfs.family_comms_notes USING btree (enquiry_id) WHERE (enquiry_id IS NOT NULL);


--
-- Name: family_comms_notes_wl_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX family_comms_notes_wl_uq ON demo_eyfs.family_comms_notes USING btree (waiting_list_id) WHERE (waiting_list_id IS NOT NULL);


--
-- Name: family_detail_fills_target_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX family_detail_fills_target_idx ON demo_eyfs.family_detail_fills USING btree (target_table, target_id);


--
-- Name: funding_claim_receipts_line_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX funding_claim_receipts_line_uq ON demo_eyfs.funding_claim_receipts USING btree (bank_line_id);


--
-- Name: funding_claim_receipts_period_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX funding_claim_receipts_period_idx ON demo_eyfs.funding_claim_receipts USING btree (claim_period_id);


--
-- Name: idx_opening_balance_changes_child; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX idx_opening_balance_changes_child ON demo_eyfs.opening_balance_changes USING btree (child_id, changed_at DESC);


--
-- Name: invoice_change_carries_child_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX invoice_change_carries_child_idx ON demo_eyfs.invoice_change_carries USING btree (child_id);


--
-- Name: invoice_change_carries_invoice_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX invoice_change_carries_invoice_uq ON demo_eyfs.invoice_change_carries USING btree (invoice_id);


--
-- Name: opening_balance_checks_child; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX opening_balance_checks_child ON demo_eyfs.opening_balance_checks USING btree (child_id, created_at DESC);


--
-- Name: payroll_file_imports_period_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX payroll_file_imports_period_idx ON demo_eyfs.payroll_file_imports USING btree (period_year, period_month);


--
-- Name: payroll_file_imports_run_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX payroll_file_imports_run_idx ON demo_eyfs.payroll_file_imports USING btree (run_id);


--
-- Name: payroll_run_import_mappings_uq; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE UNIQUE INDEX payroll_run_import_mappings_uq ON demo_eyfs.payroll_run_import_mappings USING btree (file_kind, header_signature);


--
-- Name: rota_history_days_date_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX rota_history_days_date_idx ON demo_eyfs.rota_history_days USING btree (date);


--
-- Name: rota_history_days_person_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX rota_history_days_person_idx ON demo_eyfs.rota_history_days USING btree (person_key);


--
-- Name: rota_history_days_staff_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX rota_history_days_staff_idx ON demo_eyfs.rota_history_days USING btree (staff_id);


--
-- Name: rota_history_payroll_month_idx; Type: INDEX; Schema: demo_eyfs; Owner: -
--

CREATE INDEX rota_history_payroll_month_idx ON demo_eyfs.rota_history_payroll USING btree (month);


--
-- Name: bank_auto_matches bank_auto_matches_bank_line_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_auto_matches
    ADD CONSTRAINT bank_auto_matches_bank_line_id_fkey FOREIGN KEY (bank_line_id) REFERENCES demo_eyfs.bank_statement_lines(id) ON DELETE CASCADE;


--
-- Name: bank_line_duplicate_flags bank_line_duplicate_flags_bank_line_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_line_duplicate_flags
    ADD CONSTRAINT bank_line_duplicate_flags_bank_line_id_fkey FOREIGN KEY (bank_line_id) REFERENCES demo_eyfs.bank_statement_lines(id) ON DELETE CASCADE;


--
-- Name: bank_line_duplicate_flags bank_line_duplicate_flags_keep_line_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_line_duplicate_flags
    ADD CONSTRAINT bank_line_duplicate_flags_keep_line_id_fkey FOREIGN KEY (keep_line_id) REFERENCES demo_eyfs.bank_statement_lines(id) ON DELETE CASCADE;


--
-- Name: bank_line_duplicate_flags bank_line_duplicate_flags_report_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.bank_line_duplicate_flags
    ADD CONSTRAINT bank_line_duplicate_flags_report_id_fkey FOREIGN KEY (report_id) REFERENCES demo_eyfs.bank_line_duplicate_reports(id) ON DELETE CASCADE;


--
-- Name: card_settlements card_settlements_bank_line_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.card_settlements
    ADD CONSTRAINT card_settlements_bank_line_id_fkey FOREIGN KEY (bank_line_id) REFERENCES demo_eyfs.bank_statement_lines(id) ON DELETE CASCADE;


--
-- Name: contact_identity contact_identity_contact_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.contact_identity
    ADD CONSTRAINT contact_identity_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES demo_eyfs.contacts(id) ON DELETE CASCADE;


--
-- Name: cpd_room_meeting_actions cpd_room_meeting_actions_created_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_actions
    ADD CONSTRAINT cpd_room_meeting_actions_created_by_fkey FOREIGN KEY (created_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: cpd_room_meeting_actions cpd_room_meeting_actions_done_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_actions
    ADD CONSTRAINT cpd_room_meeting_actions_done_by_fkey FOREIGN KEY (done_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: cpd_room_meeting_actions cpd_room_meeting_actions_meeting_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_actions
    ADD CONSTRAINT cpd_room_meeting_actions_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES demo_eyfs.cpd_room_meetings(id) ON DELETE CASCADE;


--
-- Name: cpd_room_meeting_actions cpd_room_meeting_actions_owner_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_actions
    ADD CONSTRAINT cpd_room_meeting_actions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES demo_eyfs.staff(id);


--
-- Name: cpd_room_meeting_agenda cpd_room_meeting_agenda_article_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_agenda
    ADD CONSTRAINT cpd_room_meeting_agenda_article_id_fkey FOREIGN KEY (article_id) REFERENCES demo_eyfs.cpd_theme_articles(id) ON DELETE SET NULL;


--
-- Name: cpd_room_meeting_agenda cpd_room_meeting_agenda_created_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_agenda
    ADD CONSTRAINT cpd_room_meeting_agenda_created_by_fkey FOREIGN KEY (created_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: cpd_room_meeting_agenda cpd_room_meeting_agenda_meeting_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_agenda
    ADD CONSTRAINT cpd_room_meeting_agenda_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES demo_eyfs.cpd_room_meetings(id) ON DELETE CASCADE;


--
-- Name: cpd_room_meeting_notices cpd_room_meeting_notices_meeting_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_notices
    ADD CONSTRAINT cpd_room_meeting_notices_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES demo_eyfs.cpd_room_meetings(id) ON DELETE CASCADE;


--
-- Name: cpd_room_meeting_notices cpd_room_meeting_notices_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_notices
    ADD CONSTRAINT cpd_room_meeting_notices_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id) ON DELETE CASCADE;


--
-- Name: cpd_room_meeting_reads cpd_room_meeting_reads_meeting_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_reads
    ADD CONSTRAINT cpd_room_meeting_reads_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES demo_eyfs.cpd_room_meetings(id) ON DELETE CASCADE;


--
-- Name: cpd_room_meeting_reads cpd_room_meeting_reads_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_reads
    ADD CONSTRAINT cpd_room_meeting_reads_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id) ON DELETE CASCADE;


--
-- Name: cpd_room_meeting_schedule cpd_room_meeting_schedule_room_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_schedule
    ADD CONSTRAINT cpd_room_meeting_schedule_room_id_fkey FOREIGN KEY (room_id) REFERENCES demo_eyfs.rooms(id) ON DELETE CASCADE;


--
-- Name: cpd_room_meeting_schedule cpd_room_meeting_schedule_updated_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.cpd_room_meeting_schedule
    ADD CONSTRAINT cpd_room_meeting_schedule_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: family_comms_notes family_comms_notes_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_comms_notes
    ADD CONSTRAINT family_comms_notes_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: family_comms_notes family_comms_notes_edited_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_comms_notes
    ADD CONSTRAINT family_comms_notes_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: family_comms_notes family_comms_notes_enquiry_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_comms_notes
    ADD CONSTRAINT family_comms_notes_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES demo_eyfs.enquiries(id);


--
-- Name: family_comms_notes family_comms_notes_waiting_list_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_comms_notes
    ADD CONSTRAINT family_comms_notes_waiting_list_id_fkey FOREIGN KEY (waiting_list_id) REFERENCES demo_eyfs.waiting_list(id);


--
-- Name: family_detail_fills family_detail_fills_email_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_detail_fills
    ADD CONSTRAINT family_detail_fills_email_id_fkey FOREIGN KEY (email_id) REFERENCES demo_eyfs.comms_email_queue(id);


--
-- Name: family_detail_fills family_detail_fills_undone_by_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.family_detail_fills
    ADD CONSTRAINT family_detail_fills_undone_by_fkey FOREIGN KEY (undone_by) REFERENCES demo_eyfs.staff(id);


--
-- Name: funding_claim_receipts funding_claim_receipts_bank_line_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.funding_claim_receipts
    ADD CONSTRAINT funding_claim_receipts_bank_line_id_fkey FOREIGN KEY (bank_line_id) REFERENCES demo_eyfs.bank_statement_lines(id) ON DELETE CASCADE;


--
-- Name: funding_claim_receipts funding_claim_receipts_claim_period_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.funding_claim_receipts
    ADD CONSTRAINT funding_claim_receipts_claim_period_id_fkey FOREIGN KEY (claim_period_id) REFERENCES demo_eyfs.funding_claim_periods(id) ON DELETE CASCADE;


--
-- Name: invoice_change_carries invoice_change_carries_invoice_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.invoice_change_carries
    ADD CONSTRAINT invoice_change_carries_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES demo_eyfs.invoices(id) ON DELETE CASCADE;


--
-- Name: opening_balance_changes opening_balance_changes_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balance_changes
    ADD CONSTRAINT opening_balance_changes_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: opening_balance_checks opening_balance_checks_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balance_checks
    ADD CONSTRAINT opening_balance_checks_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: opening_balances opening_balances_child_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balances
    ADD CONSTRAINT opening_balances_child_id_fkey FOREIGN KEY (child_id) REFERENCES demo_eyfs.children(id);


--
-- Name: opening_balances opening_balances_invoice_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balances
    ADD CONSTRAINT opening_balances_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES demo_eyfs.invoices(id);


--
-- Name: opening_balances opening_balances_payment_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.opening_balances
    ADD CONSTRAINT opening_balances_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES demo_eyfs.payments(id);


--
-- Name: payroll_file_imports payroll_file_imports_run_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.payroll_file_imports
    ADD CONSTRAINT payroll_file_imports_run_id_fkey FOREIGN KEY (run_id) REFERENCES demo_eyfs.payroll_runs(id) ON DELETE SET NULL;


--
-- Name: rota_history_days rota_history_days_staff_id_fkey; Type: FK CONSTRAINT; Schema: demo_eyfs; Owner: -
--

ALTER TABLE ONLY demo_eyfs.rota_history_days
    ADD CONSTRAINT rota_history_days_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES demo_eyfs.staff(id);


--
-- PostgreSQL database dump complete
--




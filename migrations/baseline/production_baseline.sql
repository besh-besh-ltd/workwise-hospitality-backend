--
-- PostgreSQL database dump
--


-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.8 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: action_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.action_type AS ENUM (
    'approved',
    'rejected',
    'forwarded',
    'cancelled',
    'edited',
    'grn',
    'invoice'
);


--
-- Name: amount_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.amount_mode AS ENUM (
    'percentage',
    'absolute'
);


--
-- Name: approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.approval_status AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'CANCELLED'
);


--
-- Name: approval_status_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.approval_status_type AS ENUM (
    'pending',
    'approved',
    'rejected',
    'cancelled'
);


--
-- Name: approver_source_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.approver_source_type AS ENUM (
    'USER',
    'ROLE',
    'DEPARTMENT'
);


--
-- Name: decision_rule_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.decision_rule_type AS ENUM (
    'ANY',
    'ALL'
);


--
-- Name: document_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.document_type AS ENUM (
    'invoice',
    'grn'
);


--
-- Name: employee_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.employee_type AS ENUM (
    'freelance',
    'part-time',
    'full-time',
    'contracted',
    'other'
);


--
-- Name: hierarchy_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.hierarchy_type AS ENUM (
    'finalization',
    'po'
);


--
-- Name: item_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.item_mode AS ENUM (
    'percentage',
    'absolute'
);


--
-- Name: lifecycle_entity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.lifecycle_entity_type AS ENUM (
    'RFQ',
    'TENDER',
    'PO',
    'INDENT',
    'TECHNICAL',
    'ARC',
    'NEGOTIATION_QUOTE',
    'NEGOTIATION'
);


--
-- Name: milestone_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.milestone_status AS ENUM (
    'pending',
    'achieved',
    'cancelled',
    'deleted'
);


--
-- Name: permission_action_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.permission_action_type AS ENUM (
    'read',
    'create',
    'update',
    'delete',
    'approve',
    'regenerate',
    'action_center',
    'procurement_snapshot',
    'negotiation_savings',
    'cost_intelligence',
    'category_insights',
    'workflow_efficiency',
    'smart_insights',
    'my_drafts',
    'my_active_rfqs',
    'my_no_response_rfqs',
    'my_rfqs_bid_closed_no_quotes',
    'my_tech_evals_pending',
    'tech_evals_with_vendor_disagreements',
    'tech_eval_throughput',
    'my_tech_approvals_pending',
    'tech_approval_oldest_pending',
    'tech_approval_throughput',
    'my_quote_compares',
    'my_active_negotiations',
    'savings_pipeline',
    'my_commercial_approvals_pending',
    'deals_with_price_anomalies',
    'commercial_approval_throughput',
    'my_award_approvals_pending',
    'recent_awards',
    'award_value_pipeline',
    'evaluate',
    'admin',
    'abc_analysis'
);


--
-- Name: po_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.po_status AS ENUM (
    'draft',
    'pending_approval',
    'acceptance_pending',
    'approved',
    'rejected',
    'rejected_by_vendor',
    'sent',
    'GRN',
    'completed',
    'cancelled',
    'invoice_raised',
    'dispatched'
);


--
-- Name: resource_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.resource_type AS ENUM (
    'rfq',
    'tender',
    'te',
    'quote-compare',
    'po',
    'commercial',
    'negotitation',
    'negotiation',
    'arc',
    'awarding',
    'boq',
    'dashboard',
    'arc-tech',
    'arc-comm',
    'arc-committee',
    'mr'
);


--
-- Name: token_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.token_type AS ENUM (
    'GRN'
);


--
-- Name: log_changes_direct(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_changes_direct() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_old JSONB := NULL;
    v_new JSONB := NULL;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
    END IF;

    INSERT INTO audit_log_temp (
        table_name, operation, record_id, old_data, new_data, changed_by, changed_at
    ) VALUES (
                 TG_TABLE_NAME, TG_OP, COALESCE(NEW.id, OLD.id),
                 v_old, v_new, current_user, now()
             );

    RETURN NEW;
END;
$$;


--
-- Name: set_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;


--
-- Name: tbl_negotiation_rounds_fill_source(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tbl_negotiation_rounds_fill_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.source_type IS NULL AND NEW.rfq_id IS NOT NULL THEN
    NEW.source_type := 'RFQ';
  END IF;
  IF NEW.source_id IS NULL AND NEW.rfq_id IS NOT NULL THEN
    NEW.source_id := NEW.rfq_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: update_at_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_at_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
 BEGIN NEW.updated_at = NOW();
RETURN NEW;
  END$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_log_temp; Type: TABLE; Schema: public; Owner: -
--

CREATE UNLOGGED TABLE public.audit_log_temp (
    id bigint NOT NULL,
    table_name text NOT NULL,
    operation text NOT NULL,
    record_id bigint,
    old_data jsonb,
    new_data jsonb,
    changed_by text,
    changed_at timestamp without time zone DEFAULT now()
);


--
-- Name: audit_log_temp_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE UNLOGGED SEQUENCE public.audit_log_temp_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_temp_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_temp_id_seq OWNED BY public.audit_log_temp.id;


--
-- Name: holidays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.holidays (
    id integer NOT NULL,
    date date NOT NULL,
    description character varying(255)
);


--
-- Name: holidays_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.holidays_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: holidays_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.holidays_id_seq OWNED BY public.holidays.id;


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    run_on timestamp without time zone NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 40
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: product_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_categories_id_seq
    START WITH 623
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: product_search_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_search_record_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_admin_rfq_service; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_admin_rfq_service (
    id integer NOT NULL,
    rfq_id integer,
    subadmin_id integer,
    status character varying(20) DEFAULT 'Pending'::character varying,
    comment text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_admin_rfq_service_status_check CHECK (((status)::text = ANY (ARRAY[('Pending'::character varying)::text, ('Working'::character varying)::text, ('Complete'::character varying)::text])))
);


--
-- Name: tbl_admin_rfq_service_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_admin_rfq_service_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_admin_rfq_service_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_admin_rfq_service_id_seq OWNED BY public.tbl_admin_rfq_service.id;


--
-- Name: tbl_approval_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_actions (
    id integer NOT NULL,
    approval_instance_id integer NOT NULL,
    approval_instance_step_id integer,
    approver_user_id integer NOT NULL,
    action character varying(20) NOT NULL,
    comment text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_approval_actions_action_check CHECK (((action)::text = ANY ((ARRAY['APPROVE'::character varying, 'REJECT'::character varying, 'CANCELLED'::character varying, 'POLICY_CHANGE'::character varying, 'APPROVER_REMOVED'::character varying, 'APPROVER_ADDED'::character varying, 'STEP_REMOVED'::character varying, 'STEP_ADDED'::character varying, 'MEMBERSHIP_REVALIDATION'::character varying])::text[])))
);


--
-- Name: tbl_approval_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_actions_id_seq OWNED BY public.tbl_approval_actions.id;


--
-- Name: tbl_approval_hierarchy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_hierarchy (
    id integer NOT NULL,
    company_id integer NOT NULL,
    user_id integer NOT NULL,
    approval_level integer NOT NULL,
    bypass_cap numeric NOT NULL,
    hierarchy_type public.hierarchy_type NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hierarchy_id bigint DEFAULT 1
);


--
-- Name: tbl_approval_hierarchy_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_hierarchy_history (
    id integer NOT NULL,
    approval_transaction_id integer NOT NULL,
    approved_by integer NOT NULL,
    action public.action_type NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb
);


--
-- Name: tbl_approval_hierarchy_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_hierarchy_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_hierarchy_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_hierarchy_history_id_seq OWNED BY public.tbl_approval_hierarchy_history.id;


--
-- Name: tbl_approval_hierarchy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_hierarchy_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_hierarchy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_hierarchy_id_seq OWNED BY public.tbl_approval_hierarchy.id;


--
-- Name: tbl_approval_hierarchy_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_hierarchy_transactions (
    id integer NOT NULL,
    hierarchy_type public.hierarchy_type NOT NULL,
    target_entity_id integer NOT NULL,
    company_id integer NOT NULL,
    current_approver_id integer,
    initiated_by integer NOT NULL,
    status public.approval_status_type NOT NULL,
    final_decision_by integer,
    meta jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    hierarchy_id bigint
);


--
-- Name: tbl_approval_hierarchy_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_hierarchy_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_hierarchy_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_hierarchy_transactions_id_seq OWNED BY public.tbl_approval_hierarchy_transactions.id;


--
-- Name: tbl_approval_instance_change_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_instance_change_log (
    id integer NOT NULL,
    approval_instance_id integer NOT NULL,
    policy_change_log_id integer,
    change_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_approval_instance_change_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_instance_change_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_instance_change_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_instance_change_log_id_seq OWNED BY public.tbl_approval_instance_change_log.id;


--
-- Name: tbl_approval_instance_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_instance_steps (
    id integer NOT NULL,
    approval_instance_id integer NOT NULL,
    policy_step_id integer,
    step_order integer NOT NULL,
    decision_rule character varying(10) DEFAULT 'ANY'::character varying,
    status character varying(20) DEFAULT 'PENDING'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp without time zone,
    added_mid_flight boolean DEFAULT false,
    removed_mid_flight boolean DEFAULT false,
    CONSTRAINT tbl_approval_instance_steps_decision_rule_check CHECK (((decision_rule)::text = ANY (ARRAY[('ANY'::character varying)::text, ('ALL'::character varying)::text]))),
    CONSTRAINT tbl_approval_instance_steps_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'CANCELLED'::character varying, 'REMOVED'::character varying, 'SKIPPED'::character varying])::text[])))
);


--
-- Name: tbl_approval_instance_steps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_instance_steps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_instance_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_instance_steps_id_seq OWNED BY public.tbl_approval_instance_steps.id;


--
-- Name: tbl_approval_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_instances (
    id integer NOT NULL,
    entity_type character varying(50) NOT NULL,
    entity_id integer NOT NULL,
    approval_policy_id integer NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying,
    current_step integer DEFAULT 1,
    hospitality_company_id integer NOT NULL,
    hotel_id integer,
    department_id integer,
    initiated_by integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp without time zone,
    process_id integer,
    policy_version integer DEFAULT 1,
    CONSTRAINT tbl_approval_instances_status_check CHECK (((status)::text = ANY (ARRAY[('PENDING'::character varying)::text, ('APPROVED'::character varying)::text, ('REJECTED'::character varying)::text, ('CANCELLED'::character varying)::text])))
);


--
-- Name: tbl_approval_instances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_instances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_instances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_instances_id_seq OWNED BY public.tbl_approval_instances.id;


--
-- Name: tbl_approval_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_policies (
    id integer NOT NULL,
    entity_type character varying(50) NOT NULL,
    hospitality_company_id integer NOT NULL,
    hotel_id integer,
    department_id integer,
    is_active boolean DEFAULT true,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    process_id integer,
    is_master boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1
);


--
-- Name: tbl_approval_policies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_policies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_policies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_policies_id_seq OWNED BY public.tbl_approval_policies.id;


--
-- Name: tbl_approval_policy_change_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_policy_change_log (
    id integer NOT NULL,
    approval_policy_id integer,
    changed_by integer NOT NULL,
    change_type text NOT NULL,
    change_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    affected_instance_ids integer[] DEFAULT '{}'::integer[],
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_approval_policy_change_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_policy_change_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_policy_change_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_policy_change_log_id_seq OWNED BY public.tbl_approval_policy_change_log.id;


--
-- Name: tbl_approval_policy_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_policy_steps (
    id integer NOT NULL,
    approval_policy_id integer NOT NULL,
    step_order integer DEFAULT 1 NOT NULL,
    approval_type character varying(50) DEFAULT 'STANDARD'::character varying,
    decision_rule character varying(10) DEFAULT 'ANY'::character varying,
    approver_source_type character varying(20) NOT NULL,
    approver_source_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_approval_policy_steps_approver_source_type_check CHECK (((approver_source_type)::text = ANY (ARRAY[('USER'::character varying)::text, ('ROLE'::character varying)::text, ('DEPARTMENT'::character varying)::text]))),
    CONSTRAINT tbl_approval_policy_steps_decision_rule_check CHECK (((decision_rule)::text = ANY (ARRAY[('ANY'::character varying)::text, ('ALL'::character varying)::text])))
);


--
-- Name: tbl_approval_policy_steps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_policy_steps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_policy_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_policy_steps_id_seq OWNED BY public.tbl_approval_policy_steps.id;


--
-- Name: tbl_approval_processes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_processes (
    id integer NOT NULL,
    company_id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    process_type character varying(20) DEFAULT 'RFQ'::character varying NOT NULL
);


--
-- Name: tbl_approval_processes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_processes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_processes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_processes_id_seq OWNED BY public.tbl_approval_processes.id;


--
-- Name: tbl_approval_step_approvers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_approval_step_approvers (
    id integer NOT NULL,
    approval_instance_step_id integer NOT NULL,
    approver_user_id integer NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying,
    comment text,
    acted_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    removed_at timestamp with time zone,
    removal_reason text,
    added_mid_flight boolean DEFAULT false,
    CONSTRAINT tbl_approval_step_approvers_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'REMOVED'::character varying])::text[])))
);


--
-- Name: tbl_approval_step_approvers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_approval_step_approvers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_approval_step_approvers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_approval_step_approvers_id_seq OWNED BY public.tbl_approval_step_approvers.id;


--
-- Name: tbl_arc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc (
    id bigint NOT NULL,
    arc_number character varying(40) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    category_id integer NOT NULL,
    sub_category_ids jsonb DEFAULT '[]'::jsonb,
    hospitality_company_id integer NOT NULL,
    hotel_id integer NOT NULL,
    department_id integer NOT NULL,
    process_id integer,
    status character varying(40) DEFAULT 'draft'::character varying NOT NULL,
    submission_start_at timestamp without time zone,
    submission_end_at timestamp without time zone,
    contract_start_at timestamp without time zone,
    contract_end_at timestamp without time zone,
    technical_response_required boolean DEFAULT false NOT NULL,
    sample_required boolean DEFAULT false NOT NULL,
    eligibility_type character varying(20) DEFAULT 'open'::character varying NOT NULL,
    escalation_clause_json jsonb DEFAULT '{}'::jsonb,
    payment_terms_expected character varying(255),
    delivery_expected character varying(255),
    penalty_clause text,
    created_by integer NOT NULL,
    closed_reason text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    type character varying(20) DEFAULT 'product'::character varying,
    CONSTRAINT tbl_arc_eligibility_chk CHECK (((eligibility_type)::text = ANY ((ARRAY['open'::character varying, 'invitation'::character varying])::text[]))),
    CONSTRAINT tbl_arc_status_chk CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'pending_publish_approval'::character varying, 'publish_rejected'::character varying, 'floated'::character varying, 'submission_closed'::character varying, 'tech_eval_in_progress'::character varying, 'tech_eval_approved'::character varying, 'tech_eval_rejected'::character varying, 'comm_eval_in_progress'::character varying, 'comm_eval_finalized'::character varying, 'committee_review'::character varying, 'committee_approved'::character varying, 'committee_sent_back'::character varying, 'committee_rejected'::character varying, 'contract_generated'::character varying, 'awaiting_vendor_acceptance'::character varying, 'contract_active'::character varying, 'expiring_soon'::character varying, 'expired'::character varying, 'terminated'::character varying, 'closed_no_award'::character varying])::text[])))
);


--
-- Name: tbl_arc_amendment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_amendment (
    id bigint NOT NULL,
    arc_contract_id bigint NOT NULL,
    amendment_type character varying(20) NOT NULL,
    amendment_from date NOT NULL,
    amendment_to date,
    status character varying(20) DEFAULT 'requested'::character varying NOT NULL,
    reason text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    requested_by integer NOT NULL,
    approval_instance_id integer,
    decided_by integer,
    decided_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    approval_chain jsonb DEFAULT '[]'::jsonb NOT NULL,
    current_step integer DEFAULT 1 NOT NULL,
    CONSTRAINT tbl_arc_amendment_status_chk CHECK (((status)::text = ANY ((ARRAY['requested'::character varying, 'approved'::character varying, 'awaiting_signature'::character varying, 'rejected'::character varying, 'live'::character varying, 'ended'::character varying, 'voided'::character varying])::text[]))),
    CONSTRAINT tbl_arc_amendment_type_chk CHECK (((amendment_type)::text = ANY ((ARRAY['price'::character varying, 'qty'::character varying, 'item_add'::character varying, 'item_remove'::character varying, 'term'::character varying])::text[]))),
    CONSTRAINT tbl_arc_amendment_window_chk CHECK (((amendment_to IS NULL) OR (amendment_to >= amendment_from)))
);


--
-- Name: tbl_arc_amendment_document; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_amendment_document (
    id bigint NOT NULL,
    arc_amendment_id bigint NOT NULL,
    arc_contract_id bigint NOT NULL,
    addendum_number integer NOT NULL,
    document_s3_url text,
    document_hash character varying(128),
    status character varying(30) DEFAULT 'awaiting_signature'::character varying NOT NULL,
    signed_by_vendor_at timestamp without time zone,
    signed_by integer,
    generated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT tbl_arc_amendment_document_status_check CHECK (((status)::text = ANY ((ARRAY['awaiting_signature'::character varying, 'signed'::character varying, 'voided'::character varying])::text[])))
);


--
-- Name: tbl_arc_amendment_document_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_amendment_document_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_amendment_document_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_amendment_document_id_seq OWNED BY public.tbl_arc_amendment_document.id;


--
-- Name: tbl_arc_amendment_edit_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_amendment_edit_history (
    id bigint NOT NULL,
    arc_amendment_id bigint NOT NULL,
    field_changed character varying(60) NOT NULL,
    before_value jsonb,
    after_value jsonb,
    changed_by integer NOT NULL,
    comment text,
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_amendment_edit_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_amendment_edit_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_amendment_edit_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_amendment_edit_history_id_seq OWNED BY public.tbl_arc_amendment_edit_history.id;


--
-- Name: tbl_arc_amendment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_amendment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_amendment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_amendment_id_seq OWNED BY public.tbl_arc_amendment.id;


--
-- Name: tbl_arc_callof_po; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_callof_po (
    id bigint NOT NULL,
    po_id integer NOT NULL,
    mr_id bigint NOT NULL,
    arc_contract_id bigint NOT NULL,
    arc_contract_line_id bigint NOT NULL,
    quantity numeric(15,2) NOT NULL,
    applied_amendment_id bigint,
    price_applied numeric(15,2) NOT NULL,
    released_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_callof_po_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_callof_po_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_callof_po_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_callof_po_id_seq OWNED BY public.tbl_arc_callof_po.id;


--
-- Name: tbl_arc_comm_evaluation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_comm_evaluation (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    status character varying(20) DEFAULT 'in_progress'::character varying NOT NULL,
    finalized_by integer,
    finalized_at timestamp without time zone,
    approval_instance_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_arc_comm_evaluation_status_chk CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'finalized'::character varying, 'sent_back'::character varying])::text[])))
);


--
-- Name: tbl_arc_comm_evaluation_award; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_comm_evaluation_award (
    id bigint NOT NULL,
    arc_comm_evaluation_id bigint NOT NULL,
    arc_item_id bigint NOT NULL,
    awarded_vendor_id integer NOT NULL,
    awarded_quote_line_id bigint NOT NULL,
    allocated_qty numeric(15,2) NOT NULL,
    allocated_share_pct numeric(7,4),
    l_rank character varying(8),
    is_l1_default boolean DEFAULT false NOT NULL,
    awarded_quote_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    awarded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_comm_evaluation_award_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_comm_evaluation_award_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_comm_evaluation_award_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_comm_evaluation_award_id_seq OWNED BY public.tbl_arc_comm_evaluation_award.id;


--
-- Name: tbl_arc_comm_evaluation_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_comm_evaluation_history (
    id bigint NOT NULL,
    arc_comm_evaluation_id bigint NOT NULL,
    action character varying(40) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    changed_by integer,
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_comm_evaluation_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_comm_evaluation_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_comm_evaluation_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_comm_evaluation_history_id_seq OWNED BY public.tbl_arc_comm_evaluation_history.id;


--
-- Name: tbl_arc_comm_evaluation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_comm_evaluation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_comm_evaluation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_comm_evaluation_id_seq OWNED BY public.tbl_arc_comm_evaluation.id;


--
-- Name: tbl_arc_contract; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_contract (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    document_s3_url text,
    document_hash character varying(128),
    status character varying(40) DEFAULT 'generated'::character varying NOT NULL,
    generated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    awaiting_until timestamp without time zone,
    signed_by_vendor_at timestamp without time zone,
    terminated_at timestamp without time zone,
    terminated_reason text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    document_source character varying(20) DEFAULT 'generated'::character varying NOT NULL,
    CONSTRAINT chk_tbl_arc_contract_document_source CHECK (((document_source)::text = ANY ((ARRAY['generated'::character varying, 'manual_upload'::character varying])::text[]))),
    CONSTRAINT tbl_arc_contract_status_chk CHECK (((status)::text = ANY ((ARRAY['generated'::character varying, 'awaiting_acceptance'::character varying, 'clarification'::character varying, 'active'::character varying, 'expiring_soon'::character varying, 'expired'::character varying, 'terminated'::character varying, 'declined'::character varying])::text[])))
);


--
-- Name: tbl_arc_contract_clarification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_contract_clarification (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    arc_contract_id bigint NOT NULL,
    arc_item_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    field character varying(24) NOT NULL,
    round integer DEFAULT 1 NOT NULL,
    vendor_comment text NOT NULL,
    status character varying(16) DEFAULT 'open'::character varying NOT NULL,
    old_value jsonb,
    new_value jsonb,
    buyer_response text,
    raised_by integer NOT NULL,
    resolved_by integer,
    resolved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_arc_contract_clarification_field_chk CHECK (((field)::text = ANY ((ARRAY['base_price'::character varying, 'gst'::character varying, 'charges'::character varying, 'committed_qty'::character varying, 'payment_terms'::character varying, 'delivery_terms'::character varying])::text[]))),
    CONSTRAINT tbl_arc_contract_clarification_status_chk CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'revised'::character varying, 'upheld'::character varying, 'withdrawn'::character varying])::text[])))
);


--
-- Name: tbl_arc_contract_clarification_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_contract_clarification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_contract_clarification_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_contract_clarification_id_seq OWNED BY public.tbl_arc_contract_clarification.id;


--
-- Name: tbl_arc_contract_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_contract_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_contract_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_contract_id_seq OWNED BY public.tbl_arc_contract.id;


--
-- Name: tbl_arc_contract_line; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_contract_line (
    id bigint NOT NULL,
    arc_contract_id bigint NOT NULL,
    arc_item_id bigint NOT NULL,
    unit_rate numeric(15,2) NOT NULL,
    gst_pct numeric(5,2),
    charges jsonb DEFAULT '[]'::jsonb,
    payment_terms character varying(255),
    delivery_terms character varying(255),
    committed_qty numeric(15,2) NOT NULL,
    consumed_qty numeric(15,2) DEFAULT 0 NOT NULL,
    awarded_quote_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_contract_line_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_contract_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_contract_line_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_contract_line_id_seq OWNED BY public.tbl_arc_contract_line.id;


--
-- Name: tbl_arc_contract_signature_otp; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_contract_signature_otp (
    id bigint NOT NULL,
    arc_contract_id bigint NOT NULL,
    vendor_user_id integer NOT NULL,
    otp_hash character varying(128) NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    verified_at timestamp without time zone,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    arc_amendment_document_id bigint
);


--
-- Name: tbl_arc_contract_signature_otp_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_contract_signature_otp_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_contract_signature_otp_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_contract_signature_otp_id_seq OWNED BY public.tbl_arc_contract_signature_otp.id;


--
-- Name: tbl_arc_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_event_log (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    event_type character varying(60) NOT NULL,
    actor_id integer,
    payload jsonb DEFAULT '{}'::jsonb,
    at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_event_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_event_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_event_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_event_log_id_seq OWNED BY public.tbl_arc_event_log.id;


--
-- Name: tbl_arc_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_id_seq OWNED BY public.tbl_arc.id;


--
-- Name: tbl_arc_invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_invitation (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    status character varying(20) DEFAULT 'invited'::character varying NOT NULL,
    invited_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    responded_at timestamp without time zone,
    CONSTRAINT tbl_arc_invitation_status_chk CHECK (((status)::text = ANY ((ARRAY['invited'::character varying, 'viewed'::character varying, 'submitted'::character varying, 'declined'::character varying])::text[])))
);


--
-- Name: tbl_arc_invitation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_invitation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_invitation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_invitation_id_seq OWNED BY public.tbl_arc_invitation.id;


--
-- Name: tbl_arc_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_item (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    product_variant_id integer NOT NULL,
    spec_text text,
    target_price numeric(15,2),
    indicative_qty numeric(15,2) NOT NULL,
    uom character varying(50),
    spec_attachment_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    hsn text
);


--
-- Name: tbl_arc_item_history_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_item_history_snapshot (
    id bigint NOT NULL,
    arc_item_id bigint NOT NULL,
    year_offset smallint NOT NULL,
    consumed_qty numeric(15,2) DEFAULT 0 NOT NULL,
    last_rate numeric(15,2),
    last_vendor_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_arc_item_history_snapshot_year_chk CHECK (((year_offset >= 1) AND (year_offset <= 5)))
);


--
-- Name: tbl_arc_item_history_snapshot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_item_history_snapshot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_item_history_snapshot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_item_history_snapshot_id_seq OWNED BY public.tbl_arc_item_history_snapshot.id;


--
-- Name: tbl_arc_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_item_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_item_id_seq OWNED BY public.tbl_arc_item.id;


--
-- Name: tbl_arc_item_tech_evaluation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_item_tech_evaluation (
    id bigint NOT NULL,
    arc_item_id bigint NOT NULL,
    minimum_passing_score numeric(5,2) DEFAULT 0 NOT NULL,
    is_complete boolean DEFAULT false NOT NULL,
    current_round integer DEFAULT 1 NOT NULL,
    approval_instance_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_item_tech_evaluation_clauses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_item_tech_evaluation_clauses (
    id bigint NOT NULL,
    arc_item_tech_evaluation_id bigint NOT NULL,
    clause_text text NOT NULL,
    weightage numeric(5,2) NOT NULL,
    clause_type character varying(40),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_mandatory boolean DEFAULT false NOT NULL
);


--
-- Name: tbl_arc_item_tech_evaluation_clauses_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_item_tech_evaluation_clauses_files (
    id bigint NOT NULL,
    arc_item_tech_evaluation_clauses_id bigint NOT NULL,
    file_url text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_item_tech_evaluation_clauses_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_item_tech_evaluation_clauses_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_item_tech_evaluation_clauses_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_item_tech_evaluation_clauses_files_id_seq OWNED BY public.tbl_arc_item_tech_evaluation_clauses_files.id;


--
-- Name: tbl_arc_item_tech_evaluation_clauses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_item_tech_evaluation_clauses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_item_tech_evaluation_clauses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_item_tech_evaluation_clauses_id_seq OWNED BY public.tbl_arc_item_tech_evaluation_clauses.id;


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_item_tech_evaluation_cleared_vendors (
    id bigint NOT NULL,
    arc_item_tech_evaluation_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    calculated_score numeric(5,2),
    is_verified boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'qualified'::character varying NOT NULL,
    evaluation_round integer DEFAULT 1 NOT NULL,
    approval_instance_id integer,
    reject_message text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_arc_item_te_cleared_status_chk CHECK (((status)::text = ANY ((ARRAY['qualified'::character varying, 'not_qualified'::character varying])::text[])))
);


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_item_tech_evaluation_cleared_vendors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_item_tech_evaluation_cleared_vendors_id_seq OWNED BY public.tbl_arc_item_tech_evaluation_cleared_vendors.id;


--
-- Name: tbl_arc_item_tech_evaluation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_item_tech_evaluation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_item_tech_evaluation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_item_tech_evaluation_id_seq OWNED BY public.tbl_arc_item_tech_evaluation.id;


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_item_tech_evaluation_vendors_response (
    id bigint NOT NULL,
    arc_item_tech_evaluation_clauses_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    vendor_response text,
    buyer_id integer,
    buyer_marks numeric(5,2),
    buyer_remark text,
    score_timestamp timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    mandatory_passed boolean
);


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_item_tech_evaluation_vendors_response_files (
    id bigint NOT NULL,
    arc_item_tech_evaluation_vendors_response_id bigint NOT NULL,
    file_url text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    original_name text
);


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_item_tech_evaluation_vendors_response_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_item_tech_evaluation_vendors_response_files_id_seq OWNED BY public.tbl_arc_item_tech_evaluation_vendors_response_files.id;


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_item_tech_evaluation_vendors_response_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_item_tech_evaluation_vendors_response_id_seq OWNED BY public.tbl_arc_item_tech_evaluation_vendors_response.id;


--
-- Name: tbl_arc_manual_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_manual_entry (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    is_manual boolean DEFAULT true NOT NULL,
    target_stage character varying(20) NOT NULL,
    eligibility_overridden boolean DEFAULT false NOT NULL,
    committee_decision character varying(20),
    committee_decided_at timestamp without time zone,
    committee_decided_by integer,
    committee_comment text,
    entered_by integer NOT NULL,
    entry_notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    backdated_dates jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT chk_arc_manual_entry_decision CHECK (((committee_decision IS NULL) OR ((committee_decision)::text = ANY ((ARRAY['approved'::character varying, 'rejected'::character varying])::text[])))),
    CONSTRAINT chk_arc_manual_entry_target_stage CHECK (((target_stage)::text = ANY ((ARRAY['draft'::character varying, 'floated'::character varying, 'evaluation'::character varying, 'sig_pending'::character varying, 'active'::character varying, 'ended'::character varying])::text[])))
);


--
-- Name: tbl_arc_manual_entry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_manual_entry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_manual_entry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_manual_entry_id_seq OWNED BY public.tbl_arc_manual_entry.id;


--
-- Name: tbl_arc_number_seq; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_number_seq (
    fy character varying(9) NOT NULL,
    last_seq integer NOT NULL
);


--
-- Name: tbl_arc_quote; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_quote (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    submitted_at timestamp without time zone,
    withdrawn_at timestamp without time zone,
    payment_terms character varying(255),
    gstin_used character varying(20),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    tech_submitted_at timestamp without time zone,
    terms_accepted_at timestamp without time zone,
    quote_pricing jsonb,
    pricing_method character varying(12) DEFAULT 'TRADITIONAL'::character varying NOT NULL,
    CONSTRAINT chk_tbl_arc_quote_pricing_method CHECK (((pricing_method)::text = ANY ((ARRAY['TRADITIONAL'::character varying, 'MRP'::character varying])::text[])))
);


--
-- Name: tbl_arc_quote_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_quote_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_quote_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_quote_id_seq OWNED BY public.tbl_arc_quote.id;


--
-- Name: tbl_arc_quote_line; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_quote_line (
    id bigint NOT NULL,
    arc_quote_id bigint NOT NULL,
    arc_item_id bigint NOT NULL,
    rate numeric(15,2),
    gst_pct numeric(5,2),
    charges jsonb DEFAULT '[]'::jsonb,
    lead_time_days integer,
    moq numeric(15,2),
    validity_notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    line_pricing jsonb,
    rate_source character varying(16) DEFAULT 'LANDED'::character varying NOT NULL,
    negotiated_round_id bigint,
    pricing_method character varying(12) DEFAULT 'TRADITIONAL'::character varying NOT NULL,
    entered_mrp numeric(15,2),
    mrp_discount numeric(15,2),
    mrp_discount_mode character varying(12),
    CONSTRAINT chk_tbl_arc_quote_line_pricing_method CHECK (((pricing_method)::text = ANY ((ARRAY['TRADITIONAL'::character varying, 'MRP'::character varying])::text[]))),
    CONSTRAINT tbl_arc_quote_line_rate_source_chk CHECK (((rate_source)::text = ANY ((ARRAY['LANDED'::character varying, 'NEGOTIATED'::character varying])::text[])))
);


--
-- Name: tbl_arc_quote_line_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_quote_line_history (
    id bigint NOT NULL,
    arc_quote_line_id bigint NOT NULL,
    rate numeric(15,2),
    gst_pct numeric(5,2),
    charges jsonb,
    changed_by integer,
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_quote_line_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_quote_line_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_quote_line_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_quote_line_history_id_seq OWNED BY public.tbl_arc_quote_line_history.id;


--
-- Name: tbl_arc_quote_line_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_quote_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_quote_line_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_quote_line_id_seq OWNED BY public.tbl_arc_quote_line.id;


--
-- Name: tbl_arc_quote_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_quote_version (
    id bigint NOT NULL,
    arc_quote_id bigint NOT NULL,
    arc_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    version_no integer NOT NULL,
    quote_pricing jsonb,
    lines jsonb,
    submitted_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_quote_version_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_quote_version_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_quote_version_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_quote_version_id_seq OWNED BY public.tbl_arc_quote_version.id;


--
-- Name: tbl_arc_tech_eval_edit_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_tech_eval_edit_history (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    response_id bigint NOT NULL,
    field_changed character varying(60) NOT NULL,
    before_value jsonb,
    after_value jsonb,
    changed_by integer NOT NULL,
    comment text,
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_tech_eval_edit_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_tech_eval_edit_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_tech_eval_edit_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_tech_eval_edit_history_id_seq OWNED BY public.tbl_arc_tech_eval_edit_history.id;


--
-- Name: tbl_arc_tech_evaluation_rounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_tech_evaluation_rounds (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    round_number integer NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    opened_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    closed_at timestamp without time zone,
    opened_by integer
);


--
-- Name: tbl_arc_tech_evaluation_rounds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_tech_evaluation_rounds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_tech_evaluation_rounds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_tech_evaluation_rounds_id_seq OWNED BY public.tbl_arc_tech_evaluation_rounds.id;


--
-- Name: tbl_arc_tech_shortlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_tech_shortlist (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    commercial_rank integer NOT NULL,
    basket_total numeric(18,2),
    status character varying(16) DEFAULT 'on_hold'::character varying NOT NULL,
    promoted_at timestamp without time zone,
    promoted_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT arc_tech_shortlist_status_chk CHECK (((status)::text = ANY ((ARRAY['in_eval'::character varying, 'on_hold'::character varying, 'promoted'::character varying])::text[])))
);


--
-- Name: tbl_arc_tech_shortlist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_tech_shortlist_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_tech_shortlist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_tech_shortlist_id_seq OWNED BY public.tbl_arc_tech_shortlist.id;


--
-- Name: tbl_arc_universal_tech_evaluation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_universal_tech_evaluation (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    minimum_passing_score numeric(5,2) DEFAULT 0 NOT NULL,
    is_complete boolean DEFAULT false NOT NULL,
    current_round integer DEFAULT 1 NOT NULL,
    approval_instance_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_universal_tech_evaluation_clauses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_universal_tech_evaluation_clauses (
    id bigint NOT NULL,
    arc_universal_tech_evaluation_id bigint NOT NULL,
    clause_text text NOT NULL,
    weightage numeric(5,2) NOT NULL,
    clause_type character varying(40),
    is_mandatory boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_universal_tech_evaluation_clauses_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_universal_tech_evaluation_clauses_files (
    id bigint NOT NULL,
    arc_universal_tech_evaluation_clauses_id bigint NOT NULL,
    file_url text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_universal_tech_evaluation_clauses_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_universal_tech_evaluation_clauses_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_universal_tech_evaluation_clauses_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_universal_tech_evaluation_clauses_files_id_seq OWNED BY public.tbl_arc_universal_tech_evaluation_clauses_files.id;


--
-- Name: tbl_arc_universal_tech_evaluation_clauses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_universal_tech_evaluation_clauses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_universal_tech_evaluation_clauses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_universal_tech_evaluation_clauses_id_seq OWNED BY public.tbl_arc_universal_tech_evaluation_clauses.id;


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_universal_tech_evaluation_cleared_vendors (
    id bigint NOT NULL,
    arc_universal_tech_evaluation_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    calculated_score numeric(5,2),
    is_verified boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'qualified'::character varying NOT NULL,
    evaluation_round integer DEFAULT 1 NOT NULL,
    approval_instance_id integer,
    reject_message text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_arc_univ_te_cleared_status_chk CHECK (((status)::text = ANY ((ARRAY['qualified'::character varying, 'not_qualified'::character varying])::text[])))
);


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_universal_tech_evaluation_cleared_vendors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_universal_tech_evaluation_cleared_vendors_id_seq OWNED BY public.tbl_arc_universal_tech_evaluation_cleared_vendors.id;


--
-- Name: tbl_arc_universal_tech_evaluation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_universal_tech_evaluation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_universal_tech_evaluation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_universal_tech_evaluation_id_seq OWNED BY public.tbl_arc_universal_tech_evaluation.id;


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_universal_tech_evaluation_vendors_response (
    id bigint NOT NULL,
    arc_universal_tech_evaluation_clauses_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    vendor_response text,
    buyer_id integer,
    buyer_marks numeric(5,2),
    buyer_remark text,
    mandatory_passed boolean,
    score_timestamp timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_universal_tech_evaluation_vendors_response_files (
    id bigint NOT NULL,
    arc_universal_tech_evaluation_vendors_response_id bigint NOT NULL,
    file_url text NOT NULL,
    original_name text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_universal_tech_evaluation_vendors_response_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_universal_tech_evaluation_vendors_response_files_id_seq OWNED BY public.tbl_arc_universal_tech_evaluation_vendors_response_files.id;


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_universal_tech_evaluation_vendors_response_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_universal_tech_evaluation_vendors_response_id_seq OWNED BY public.tbl_arc_universal_tech_evaluation_vendors_response.id;


--
-- Name: tbl_arc_vendor_alias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_arc_vendor_alias (
    id bigint NOT NULL,
    arc_id bigint NOT NULL,
    vendor_id integer NOT NULL,
    alias_index integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_arc_vendor_alias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_arc_vendor_alias_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_arc_vendor_alias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_arc_vendor_alias_id_seq OWNED BY public.tbl_arc_vendor_alias.id;


--
-- Name: tbl_attribute_values_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_attribute_values_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_attribute_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_attribute_values (
    id integer DEFAULT nextval('public.tbl_attribute_values_id_seq'::regclass) NOT NULL,
    attribute_id integer NOT NULL,
    attribute_value character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    created_by integer,
    updated_by integer
);


--
-- Name: tbl_attributes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_attributes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_attributes (
    id integer DEFAULT nextval('public.tbl_attributes_id_seq'::regclass) NOT NULL,
    attribute_name character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL
);


--
-- Name: tbl_blog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_blog_id_seq
    START WITH 8
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_blog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_blog (
    id integer DEFAULT nextval('public.tbl_blog_id_seq'::regclass) NOT NULL,
    title character varying(255),
    description text,
    blog_cat_id integer DEFAULT 1 NOT NULL,
    image character varying(255),
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    created_by integer NOT NULL,
    slug character varying(255),
    status smallint DEFAULT '1'::smallint NOT NULL,
    original_filename character varying
);


--
-- Name: tbl_blog_category_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_blog_category_id_seq
    START WITH 3
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_blog_category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_blog_category (
    id integer DEFAULT nextval('public.tbl_blog_category_id_seq'::regclass) NOT NULL,
    title character varying(255),
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    created_by integer
);


--
-- Name: tbl_buyer_private_vendors_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_buyer_private_vendors_mapping (
    id integer NOT NULL,
    created_by integer NOT NULL,
    vendor_id integer NOT NULL,
    created_date timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_date timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer
);


--
-- Name: tbl_buyer_private_vendors_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_buyer_private_vendors_mapping_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_buyer_private_vendors_mapping_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_buyer_private_vendors_mapping_id_seq OWNED BY public.tbl_buyer_private_vendors_mapping.id;


--
-- Name: tbl_category_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_category_id_seq
    START WITH 83
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_category (
    id integer DEFAULT nextval('public.tbl_category_id_seq'::regclass) NOT NULL,
    title character varying(255),
    parent_id integer,
    status integer DEFAULT 1,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    slug character varying(255),
    created_by integer NOT NULL,
    is_deleted integer DEFAULT 0 NOT NULL,
    updated_by integer,
    fee_amount integer DEFAULT 500 NOT NULL
);


--
-- Name: tbl_category_department; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_category_department (
    id bigint NOT NULL,
    category_id integer NOT NULL,
    department_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_category_department_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_category_department_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_category_department_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_category_department_id_seq OWNED BY public.tbl_category_department.id;


--
-- Name: tbl_charge_names; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_charge_names (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    is_global boolean DEFAULT false,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    slug character varying(100)
);


--
-- Name: tbl_charge_names_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_charge_names_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_charge_names_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_charge_names_id_seq OWNED BY public.tbl_charge_names.id;


--
-- Name: tbl_cms_banner_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_cms_banner_id_seq
    START WITH 14
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_cms_banner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_cms_banner (
    id integer DEFAULT nextval('public.tbl_cms_banner_id_seq'::regclass) NOT NULL,
    page_id integer NOT NULL,
    content text NOT NULL,
    image character varying(255) NOT NULL,
    button_link character varying(255),
    status integer DEFAULT 1 NOT NULL,
    created_by integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_cms_page_sections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_cms_page_sections_id_seq
    START WITH 24
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_cms_page_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_cms_page_sections (
    id integer DEFAULT nextval('public.tbl_cms_page_sections_id_seq'::regclass) NOT NULL,
    page_id integer,
    section_name text,
    image text,
    content text,
    button_label_1 text,
    button_link_1 text,
    button_label_2 text,
    button_link_2 text,
    is_deleted integer DEFAULT 0 NOT NULL,
    status integer DEFAULT 1 NOT NULL
);


--
-- Name: tbl_cms_pages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_cms_pages_id_seq
    START WITH 6
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_cms_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_cms_pages (
    id integer DEFAULT nextval('public.tbl_cms_pages_id_seq'::regclass) NOT NULL,
    name character varying(255) NOT NULL
);


--
-- Name: tbl_communication_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_communication_settings_id_seq
    START WITH 12
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_communication_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_communication_settings (
    id integer DEFAULT nextval('public.tbl_communication_settings_id_seq'::regclass) NOT NULL,
    type_id integer NOT NULL,
    email integer DEFAULT 1 NOT NULL,
    sms integer DEFAULT 0 NOT NULL,
    user_id integer NOT NULL
);


--
-- Name: tbl_communication_settings_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_communication_settings_types_id_seq
    START WITH 3
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_communication_settings_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_communication_settings_types (
    id integer DEFAULT nextval('public.tbl_communication_settings_types_id_seq'::regclass) NOT NULL,
    name text,
    details text
);


--
-- Name: tbl_companies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_companies_id_seq
    START WITH 5
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_company_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_company_id_seq
    START WITH 10
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_company; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_company (
    id integer DEFAULT nextval('public.tbl_company_id_seq'::regclass) NOT NULL,
    company_name character varying(255),
    profile text,
    nature_of_business character varying(255),
    type_of_business character varying(200),
    turnover character varying(200),
    no_of_employess character varying(100),
    import_export_code character varying(100),
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    location character varying(255),
    gstin character varying(200),
    cin character varying(200),
    website character varying(200),
    logo character varying(255),
    established_year character varying(255),
    is_private integer DEFAULT 0,
    source character varying(100),
    is_hospitality smallint DEFAULT 0
);


--
-- Name: tbl_company_buyer_account_limit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_company_buyer_account_limit (
    company_id integer NOT NULL,
    max_top_management integer DEFAULT 0,
    max_procurement integer DEFAULT 0,
    max_engineering integer DEFAULT 0,
    max_finance integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_company_location; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_company_location (
    id integer NOT NULL,
    company_id integer,
    country_id integer,
    state_id integer,
    city_id integer,
    postal_code character varying(40),
    address text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    updated_by integer
);


--
-- Name: tbl_company_location_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_company_location_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_company_location_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_company_location_id_seq OWNED BY public.tbl_company_location.id;


--
-- Name: tbl_company_logo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_company_logo (
    id integer DEFAULT nextval('public.tbl_companies_id_seq'::regclass) NOT NULL,
    title character varying,
    image character varying,
    created_by integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    status smallint DEFAULT '1'::smallint NOT NULL
);


--
-- Name: tbl_contact_us_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_contact_us_id_seq
    START WITH 24
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_contact_us; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_contact_us (
    id integer DEFAULT nextval('public.tbl_contact_us_id_seq'::regclass) NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    phone character varying(255) NOT NULL,
    subject text NOT NULL,
    comment text NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    submitted_from smallint NOT NULL
);


--
-- Name: tbl_country_code; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_country_code (
    id integer NOT NULL,
    country_code character varying(10) NOT NULL,
    phone_code character varying(10) NOT NULL
);


--
-- Name: tbl_country_code_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_country_code_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_country_code_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_country_code_id_seq OWNED BY public.tbl_country_code.id;


--
-- Name: tbl_coupon_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_coupon_id_seq
    START WITH 6
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_coupon; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_coupon (
    id integer DEFAULT nextval('public.tbl_coupon_id_seq'::regclass) NOT NULL,
    coupon character varying NOT NULL,
    used_time smallint DEFAULT '0'::smallint NOT NULL,
    is_percentage boolean DEFAULT false NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    discount_amount numeric(10,2) NOT NULL,
    created_by integer NOT NULL,
    status smallint DEFAULT '1'::smallint NOT NULL,
    updated_by smallint,
    user_type character varying(10) DEFAULT 2 NOT NULL
);


--
-- Name: tbl_department; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_department (
    id integer NOT NULL,
    title character varying(99) NOT NULL
);


--
-- Name: tbl_department_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_department_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_department_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_department_id_seq OWNED BY public.tbl_department.id;


--
-- Name: tbl_discount_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_discount_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_documents (
    id integer DEFAULT nextval('public.tbl_documents_id_seq'::regclass) NOT NULL,
    user_id integer NOT NULL,
    doc_type character varying(100) NOT NULL,
    doc_filename character varying(255) NOT NULL,
    doc_original_filename character varying(255) NOT NULL,
    doc_extension character varying(100) NOT NULL,
    created_by integer NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_faq_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_faq_id_seq
    START WITH 11
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_faq; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_faq (
    id integer DEFAULT nextval('public.tbl_faq_id_seq'::regclass) NOT NULL,
    question character varying(255) NOT NULL,
    description text,
    status integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_files_id_seq
    START WITH 139
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_files (
    id integer DEFAULT nextval('public.tbl_files_id_seq'::regclass) NOT NULL,
    user_id integer NOT NULL,
    file_name text,
    file_path text,
    file_type text,
    doc_type text,
    new_file_name text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_hierarchy_default_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_hierarchy_default_mapping (
    id integer NOT NULL,
    hierarchy_id bigint NOT NULL,
    hierarchy_type public.hierarchy_type NOT NULL,
    company_id bigint NOT NULL,
    created_by bigint NOT NULL
);


--
-- Name: tbl_hierarchy_default_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_hierarchy_default_mapping_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_hierarchy_default_mapping_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_hierarchy_default_mapping_id_seq OWNED BY public.tbl_hierarchy_default_mapping.id;


--
-- Name: tbl_hierarchy_project_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_hierarchy_project_mapping (
    id integer NOT NULL,
    company_id bigint NOT NULL,
    hierarchy_id bigint NOT NULL,
    hierarchy_type public.hierarchy_type,
    project_id bigint NOT NULL,
    mapped_by bigint,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: tbl_hierarchy_project_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_hierarchy_project_mapping_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_hierarchy_project_mapping_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_hierarchy_project_mapping_id_seq OWNED BY public.tbl_hierarchy_project_mapping.id;


--
-- Name: tbl_hospitality_companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_hospitality_companies (
    id integer NOT NULL,
    buyer_company_id integer NOT NULL,
    name character varying(255) NOT NULL,
    region character varying(255),
    contact_email character varying(255),
    created_by integer,
    updated_by integer,
    is_deleted smallint DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    registered_office_address text,
    corporate_office_address text,
    gst character varying(15),
    pan character varying(10),
    bank_account_number character varying(255),
    bank_name character varying(255),
    ifsc_code character varying(20),
    account_holder_name character varying(255),
    msme character varying(255)
);


--
-- Name: tbl_hospitality_companies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_hospitality_companies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_hospitality_companies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_hospitality_companies_id_seq OWNED BY public.tbl_hospitality_companies.id;


--
-- Name: tbl_hospitality_company_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_hospitality_company_documents (
    id integer NOT NULL,
    hospitality_company_id integer NOT NULL,
    document_type character varying(50) NOT NULL,
    document_url character varying(500),
    document_number character varying(255),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT tbl_hospitality_company_documents_document_type_check CHECK (((document_type)::text = ANY (ARRAY[('gst'::character varying)::text, ('pan'::character varying)::text, ('cancelled_cheque'::character varying)::text, ('msme'::character varying)::text, ('other'::character varying)::text])))
);


--
-- Name: tbl_hospitality_company_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_hospitality_company_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_hospitality_company_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_hospitality_company_documents_id_seq OWNED BY public.tbl_hospitality_company_documents.id;


--
-- Name: tbl_hospitality_company_hotels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_hospitality_company_hotels (
    id integer NOT NULL,
    hospitality_company_id integer NOT NULL,
    name character varying(255) NOT NULL,
    city character varying(255),
    keys integer DEFAULT 0,
    status character varying(100) DEFAULT 'Active'::character varying,
    created_by integer,
    updated_by integer,
    is_deleted smallint DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    fee_amount integer DEFAULT 500 NOT NULL,
    full_address text,
    state character varying(100),
    gst character varying(15),
    pan character varying(10),
    bank_account_number character varying(255),
    bank_name character varying(255),
    ifsc_code character varying(20),
    account_holder_name character varying(255),
    msme character varying(255),
    delivery_address text,
    email character varying(255),
    payment_status character varying(50) DEFAULT 'onboarding'::character varying
);


--
-- Name: tbl_hospitality_company_hotels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_hospitality_company_hotels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_hospitality_company_hotels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_hospitality_company_hotels_id_seq OWNED BY public.tbl_hospitality_company_hotels.id;


--
-- Name: tbl_hospitality_hotel_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_hospitality_hotel_documents (
    id integer NOT NULL,
    hospitality_hotel_id integer NOT NULL,
    document_type character varying(50) NOT NULL,
    document_url character varying(500),
    document_number character varying(255),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT tbl_hospitality_hotel_documents_document_type_check CHECK (((document_type)::text = ANY (ARRAY[('gst'::character varying)::text, ('pan'::character varying)::text, ('cancelled_cheque'::character varying)::text, ('msme'::character varying)::text, ('other'::character varying)::text])))
);


--
-- Name: tbl_hospitality_hotel_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_hospitality_hotel_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_hospitality_hotel_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_hospitality_hotel_documents_id_seq OWNED BY public.tbl_hospitality_hotel_documents.id;


--
-- Name: tbl_hospitality_project_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_hospitality_project_mappings (
    id integer NOT NULL,
    project_id integer NOT NULL,
    hospitality_company_id integer NOT NULL,
    hospitality_hotel_id integer,
    mapping_type smallint DEFAULT 0 NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT chk_hospitality_project_mapping_type CHECK ((((mapping_type = 0) AND (hospitality_hotel_id IS NULL)) OR ((mapping_type = 1) AND (hospitality_hotel_id IS NOT NULL))))
);


--
-- Name: tbl_hospitality_project_mappings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_hospitality_project_mappings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_hospitality_project_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_hospitality_project_mappings_id_seq OWNED BY public.tbl_hospitality_project_mappings.id;


--
-- Name: tbl_hospitality_user_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_hospitality_user_mappings (
    id integer NOT NULL,
    user_id integer NOT NULL,
    hospitality_company_id integer NOT NULL,
    hospitality_hotel_id integer,
    mapping_type smallint DEFAULT 0 NOT NULL,
    auto_map_projects boolean DEFAULT false,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT chk_hospitality_user_mapping_type CHECK ((((mapping_type = 0) AND (hospitality_hotel_id IS NULL)) OR ((mapping_type = 1) AND (hospitality_hotel_id IS NOT NULL))))
);


--
-- Name: tbl_hospitality_user_mappings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_hospitality_user_mappings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_hospitality_user_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_hospitality_user_mappings_id_seq OWNED BY public.tbl_hospitality_user_mappings.id;


--
-- Name: tbl_lifecycle_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_lifecycle_history (
    id integer NOT NULL,
    entity_id integer NOT NULL,
    entity_type public.lifecycle_entity_type NOT NULL,
    stage character varying(50) NOT NULL,
    action character varying(50) NOT NULL,
    performed_by integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    remarks text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_lifecycle_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_lifecycle_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_lifecycle_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_lifecycle_history_id_seq OWNED BY public.tbl_lifecycle_history.id;


--
-- Name: tbl_location_cities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_location_cities_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_location_cities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_location_cities (
    id integer DEFAULT nextval('public.tbl_location_cities_id_seq'::regclass) NOT NULL,
    city_name text NOT NULL,
    state_id integer NOT NULL
);


--
-- Name: tbl_location_country_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_location_country_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_location_country; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_location_country (
    id smallint DEFAULT nextval('public.tbl_location_country_id_seq'::regclass) NOT NULL,
    country_name character varying(255) NOT NULL
);


--
-- Name: tbl_location_states_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_location_states_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_location_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_location_states (
    id integer DEFAULT nextval('public.tbl_location_states_id_seq'::regclass) NOT NULL,
    state_name text NOT NULL,
    country_id smallint
);


--
-- Name: tbl_login_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_login_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_login_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_login_log (
    id integer DEFAULT nextval('public.tbl_login_log_id_seq'::regclass) NOT NULL,
    user_id integer NOT NULL,
    user_type integer NOT NULL,
    date timestamp without time zone DEFAULT now() NOT NULL,
    user_agent character varying NOT NULL
);


--
-- Name: tbl_management_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_management_id_seq
    START WITH 4
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_management; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_management (
    id integer DEFAULT nextval('public.tbl_management_id_seq'::regclass) NOT NULL,
    name character varying(255),
    designation character varying(255),
    management_type integer DEFAULT 1 NOT NULL,
    profile_image character varying(255) NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now(),
    created_by integer NOT NULL
);


--
-- Name: tbl_material_requisition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_material_requisition (
    id bigint NOT NULL,
    mr_number character varying(40) NOT NULL,
    title character varying(255) NOT NULL,
    hospitality_company_id integer NOT NULL,
    hotel_id integer NOT NULL,
    department_id integer NOT NULL,
    cost_center character varying(120),
    urgency character varying(20) DEFAULT 'normal'::character varying NOT NULL,
    required_by_date date,
    justification text,
    delivery_location text,
    status character varying(40) DEFAULT 'draft'::character varying NOT NULL,
    raised_by integer NOT NULL,
    submitted_at timestamp without time zone,
    approval_instance_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_material_requisition_status_chk CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'pending_approval'::character varying, 'approved'::character varying, 'po_released'::character varying, 'rejected'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT tbl_material_requisition_urgency_chk CHECK (((urgency)::text = ANY ((ARRAY['low'::character varying, 'normal'::character varying, 'urgent'::character varying])::text[])))
);


--
-- Name: tbl_material_requisition_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_material_requisition_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_material_requisition_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_material_requisition_id_seq OWNED BY public.tbl_material_requisition.id;


--
-- Name: tbl_material_requisition_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_material_requisition_item (
    id bigint NOT NULL,
    mr_id bigint NOT NULL,
    product_variant_id integer NOT NULL,
    quantity numeric(15,2) NOT NULL,
    uom character varying(50),
    arc_contract_id bigint NOT NULL,
    arc_contract_line_id bigint NOT NULL,
    matched_unit_rate numeric(15,2),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_material_requisition_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_material_requisition_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_material_requisition_item_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_material_requisition_item_id_seq OWNED BY public.tbl_material_requisition_item.id;


--
-- Name: tbl_media_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_media_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_media (
    id integer DEFAULT nextval('public.tbl_media_id_seq'::regclass) NOT NULL,
    name character varying(255),
    url text NOT NULL,
    is_featured integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    thumbnail_image character varying(255),
    page_id integer DEFAULT 1 NOT NULL
);


--
-- Name: tbl_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_migrations (
    id integer NOT NULL,
    file_name text NOT NULL,
    checksum text NOT NULL,
    started_at timestamp without time zone NOT NULL,
    completed_at timestamp without time zone,
    status character varying(20) NOT NULL,
    error text,
    reverted_at timestamp without time zone
);


--
-- Name: tbl_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_migrations_id_seq OWNED BY public.tbl_migrations.id;


--
-- Name: tbl_negotiation_round_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_negotiation_round_approvals (
    id integer NOT NULL,
    negotiation_round_id integer NOT NULL,
    approver_user_id integer NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying,
    remarks text,
    acted_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_negotiation_round_approvals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_negotiation_round_approvals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_negotiation_round_approvals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_negotiation_round_approvals_id_seq OWNED BY public.tbl_negotiation_round_approvals.id;


--
-- Name: tbl_negotiation_round_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_negotiation_round_quotes (
    id integer NOT NULL,
    negotiation_round_id integer NOT NULL,
    vendor_id integer NOT NULL,
    rfq_product_id integer,
    quoted_price numeric(15,2),
    previous_price numeric(15,2),
    submitted_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    arc_item_id bigint
);


--
-- Name: tbl_negotiation_round_quotes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_negotiation_round_quotes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_negotiation_round_quotes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_negotiation_round_quotes_id_seq OWNED BY public.tbl_negotiation_round_quotes.id;


--
-- Name: tbl_negotiation_rounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_negotiation_rounds (
    id integer NOT NULL,
    rfq_id integer,
    round_number integer DEFAULT 1 NOT NULL,
    target_price numeric(15,2),
    end_date timestamp without time zone NOT NULL,
    status character varying(20) DEFAULT 'DRAFT'::character varying,
    created_by integer NOT NULL,
    approved_at timestamp without time zone,
    published_at timestamp without time zone,
    closed_at timestamp without time zone,
    remarks text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    rfq_product_id integer,
    vendor_ids integer[],
    vendor_approvals jsonb DEFAULT '[]'::jsonb,
    source_type character varying(20) DEFAULT 'RFQ'::character varying NOT NULL,
    source_id integer NOT NULL,
    products jsonb,
    arc_item_id bigint,
    CONSTRAINT chk_neg_round_scope CHECK (((rfq_product_id IS NOT NULL) OR (products IS NOT NULL))),
    CONSTRAINT tbl_negotiation_rounds_source_type_chk CHECK (((source_type)::text = ANY ((ARRAY['RFQ'::character varying, 'ARC'::character varying])::text[])))
);


--
-- Name: tbl_negotiation_rounds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_negotiation_rounds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_negotiation_rounds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_negotiation_rounds_id_seq OWNED BY public.tbl_negotiation_rounds.id;


--
-- Name: tbl_notification_setting_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_notification_setting_id_seq
    START WITH 7
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_notification_setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_notification_setting (
    id integer DEFAULT nextval('public.tbl_notification_setting_id_seq'::regclass) NOT NULL,
    title character varying(255) NOT NULL,
    notification_type integer DEFAULT 1 NOT NULL,
    status smallint DEFAULT '1'::smallint NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    created_by integer NOT NULL,
    is_deleted integer DEFAULT 0 NOT NULL,
    content text,
    send_to integer DEFAULT 1 NOT NULL,
    name character varying(255)
);


--
-- Name: tbl_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_notifications (
    id integer DEFAULT nextval('public.notifications_id_seq'::regclass) NOT NULL,
    sender_user_id integer,
    receiver_user_ids integer[],
    type character varying(255),
    title character varying(255),
    message text,
    is_read smallint DEFAULT '0'::smallint,
    is_read_at timestamp with time zone,
    additional_data json,
    created_at timestamp with time zone DEFAULT now(),
    admin_is_read smallint DEFAULT '0'::smallint,
    token text,
    recipient_user_id integer,
    action_url text,
    category character varying(32),
    delivered_at timestamp with time zone,
    dismissed_at timestamp with time zone
);


--
-- Name: tbl_offer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_offer (
    is_percentage boolean DEFAULT false NOT NULL,
    text character varying(255) NOT NULL,
    price numeric(10,2) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    id integer DEFAULT nextval('public.tbl_discount_id_seq'::regclass) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    created_by integer NOT NULL,
    updated_by integer,
    status smallint DEFAULT '1'::smallint NOT NULL,
    user_type character varying(10) DEFAULT 2 NOT NULL
);


--
-- Name: tbl_payment_milestone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_payment_milestone (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    po_id integer NOT NULL,
    company_id integer NOT NULL,
    milestone_name text NOT NULL,
    due_date date NOT NULL,
    is_reminded boolean DEFAULT false,
    status public.milestone_status DEFAULT 'pending'::public.milestone_status,
    milestone_description text,
    reminder_users integer[] DEFAULT '{}'::integer[],
    attachments jsonb DEFAULT '[]'::jsonb,
    created_by integer NOT NULL,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone,
    is_done boolean DEFAULT false NOT NULL,
    amount double precision,
    amount_mode public.amount_mode DEFAULT 'percentage'::public.amount_mode
);


--
-- Name: tbl_payment_milestone_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_payment_milestone_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_payment_milestone_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_payment_milestone_id_seq OWNED BY public.tbl_payment_milestone.id;


--
-- Name: tbl_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_permissions (
    id integer NOT NULL,
    resource public.resource_type NOT NULL,
    action public.permission_action_type NOT NULL,
    ordering smallint DEFAULT 0 NOT NULL
);


--
-- Name: tbl_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_permissions_id_seq OWNED BY public.tbl_permissions.id;


--
-- Name: tbl_portal_tour_content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_portal_tour_content (
    id integer NOT NULL,
    page_id integer NOT NULL,
    page_name character varying(50) NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_portal_tour_content_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_portal_tour_content_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_portal_tour_content_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_portal_tour_content_id_seq OWNED BY public.tbl_portal_tour_content.id;


--
-- Name: tbl_portal_tour_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_portal_tour_progress (
    id integer NOT NULL,
    user_id integer NOT NULL,
    page_id integer NOT NULL,
    completed boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_portal_tour_progress_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_portal_tour_progress_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_portal_tour_progress_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_portal_tour_progress_id_seq OWNED BY public.tbl_portal_tour_progress.id;


--
-- Name: tbl_product_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_id_seq
    START WITH 156
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_product; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product (
    id integer DEFAULT nextval('public.tbl_product_id_seq'::regclass) NOT NULL,
    name character varying(255),
    description text,
    slug character varying(255),
    sku character varying,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    created_by integer,
    updated_by integer,
    status integer DEFAULT 1,
    is_deleted integer DEFAULT 0,
    is_review smallint DEFAULT '0'::smallint NOT NULL,
    added_by integer NOT NULL,
    is_approve smallint DEFAULT '0'::smallint NOT NULL,
    reject_reason_id smallint,
    admin_added_product integer,
    approved_at timestamp without time zone,
    vendor_approved_by integer
);


--
-- Name: tbl_product_attribute_values_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_attribute_values_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_product_attribute_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_attribute_values (
    id integer DEFAULT nextval('public.tbl_product_attribute_values_id_seq'::regclass) NOT NULL,
    product_attribute_id integer NOT NULL,
    attribute_value_id integer NOT NULL
);


--
-- Name: tbl_product_attributes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_attributes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_product_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_attributes (
    id integer DEFAULT nextval('public.tbl_product_attributes_id_seq'::regclass) NOT NULL,
    product_id integer NOT NULL,
    attribute_id integer NOT NULL
);


--
-- Name: tbl_product_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_categories (
    id integer DEFAULT nextval('public.product_categories_id_seq'::regclass) NOT NULL,
    product_id integer NOT NULL,
    category_name character varying,
    category_id integer
);


--
-- Name: tbl_product_cms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_cms (
    id integer NOT NULL,
    product_id integer,
    title character varying(300),
    description text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_product_cms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_cms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_product_cms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_product_cms_id_seq OWNED BY public.tbl_product_cms.id;


--
-- Name: tbl_product_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_images_id_seq
    START WITH 54
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_product_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_images (
    id integer DEFAULT nextval('public.tbl_product_images_id_seq'::regclass) NOT NULL,
    new_image_name character varying(255) NOT NULL,
    original_image_name character varying(255) NOT NULL,
    product_id integer NOT NULL,
    is_featured integer DEFAULT 0 NOT NULL
);


--
-- Name: tbl_product_tech_spec; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_tech_spec (
    id integer NOT NULL,
    product_id integer NOT NULL,
    title character varying(100) NOT NULL,
    value character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_product_tech_spec_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_tech_spec_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_product_tech_spec_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_product_tech_spec_id_seq OWNED BY public.tbl_product_tech_spec.id;


--
-- Name: tbl_product_variant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_variant (
    id integer NOT NULL,
    name character varying(255),
    slug character varying(255) NOT NULL,
    sku character varying,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    created_by integer,
    updated_by integer,
    status integer DEFAULT 1,
    is_deleted integer DEFAULT 0,
    is_review smallint DEFAULT '0'::smallint NOT NULL,
    added_by integer NOT NULL,
    is_approve smallint DEFAULT '0'::smallint NOT NULL,
    reject_reason_id smallint,
    product_id integer,
    approved_at timestamp without time zone,
    approved_by integer,
    hsn_code text
);


--
-- Name: tbl_product_variant_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_variant_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_product_variant_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_product_variant_id_seq OWNED BY public.tbl_product_variant.id;


--
-- Name: tbl_product_variant_spec; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_variant_spec (
    id integer NOT NULL,
    variant_id integer NOT NULL,
    key character varying(255) NOT NULL,
    value text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_product_variant_spec_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_variant_spec_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_product_variant_spec_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_product_variant_spec_id_seq OWNED BY public.tbl_product_variant_spec.id;


--
-- Name: tbl_product_variant_vendor_make; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_variant_vendor_make (
    id integer NOT NULL,
    variant_vendor_map_id integer NOT NULL,
    make_name character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_product_variant_vendor_make_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_variant_vendor_make_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_product_variant_vendor_make_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_product_variant_vendor_make_id_seq OWNED BY public.tbl_product_variant_vendor_make.id;


--
-- Name: tbl_product_variant_vendor_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_variant_vendor_mapping (
    id integer NOT NULL,
    product_variant_id integer,
    vendor_id integer,
    status boolean,
    is_approved boolean,
    approved_by integer,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    approved_at timestamp with time zone
);


--
-- Name: tbl_product_variant_vendor_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_variant_vendor_mapping_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_product_variant_vendor_mapping_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_product_variant_vendor_mapping_id_seq OWNED BY public.tbl_product_variant_vendor_mapping.id;


--
-- Name: tbl_product_variants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_product_variants_id_seq
    START WITH 464
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_product_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_product_variants (
    id integer DEFAULT nextval('public.tbl_product_variants_id_seq'::regclass) NOT NULL,
    product_id integer NOT NULL,
    variant_name character varying(255),
    variant_value character varying(255)
);


--
-- Name: tbl_project_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_project_files (
    id integer NOT NULL,
    project_id integer NOT NULL,
    file_name text NOT NULL,
    file_url text NOT NULL,
    file_type text DEFAULT 'otherDocuments'::text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_project_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_project_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_project_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_project_files_id_seq OWNED BY public.tbl_project_files.id;


--
-- Name: tbl_project_team; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_project_team (
    id integer NOT NULL,
    project_id integer NOT NULL,
    user_id integer NOT NULL,
    role integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer
);


--
-- Name: tbl_project_team_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_project_team_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_project_team_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_project_team_id_seq OWNED BY public.tbl_project_team.id;


--
-- Name: tbl_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_projects (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    location text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    ended_at timestamp with time zone,
    status integer DEFAULT 1,
    user_id integer,
    rfq_type character varying(12),
    reverse_auction smallint DEFAULT 1,
    budget bigint
);


--
-- Name: tbl_projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_projects_id_seq OWNED BY public.tbl_projects.id;


--
-- Name: tbl_purchase_order_document; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_purchase_order_document (
    id integer NOT NULL,
    purchase_order_id bigint NOT NULL,
    document_type public.document_type NOT NULL,
    document_url text NOT NULL,
    uploaded_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_purchase_order_document_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_purchase_order_document_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_purchase_order_document_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_purchase_order_document_id_seq OWNED BY public.tbl_purchase_order_document.id;


--
-- Name: tbl_purchase_order_hsn_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_purchase_order_hsn_mapping (
    id integer NOT NULL,
    po_id integer,
    rfq_item_id integer NOT NULL,
    hsn_code character varying(12) NOT NULL,
    mapped_by integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: tbl_purchase_order_hsn_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_purchase_order_hsn_mapping_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_purchase_order_hsn_mapping_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_purchase_order_hsn_mapping_id_seq OWNED BY public.tbl_purchase_order_hsn_mapping.id;


--
-- Name: tbl_purchase_order_product; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_purchase_order_product (
    id integer NOT NULL,
    purchase_order_id bigint NOT NULL,
    rfq_product_id bigint,
    quote_id bigint,
    quantity numeric NOT NULL,
    unit character varying(99) NOT NULL,
    unit_price numeric(15,2) NOT NULL,
    charges_meta jsonb,
    total_price numeric(15,2) NOT NULL,
    product_variant_id integer,
    arc_contract_line_id bigint
);


--
-- Name: tbl_purchase_order_product_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_purchase_order_product_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_purchase_order_product_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_purchase_order_product_id_seq OWNED BY public.tbl_purchase_order_product.id;


--
-- Name: tbl_purchase_order_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_purchase_order_tasks (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    po_id integer NOT NULL,
    company_id integer NOT NULL,
    task_name text NOT NULL,
    completion_date date NOT NULL,
    status character varying(90) NOT NULL,
    task_description text,
    created_by integer NOT NULL,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone
);


--
-- Name: tbl_purchase_order_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_purchase_order_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_purchase_order_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_purchase_order_tasks_id_seq OWNED BY public.tbl_purchase_order_tasks.id;


--
-- Name: tbl_push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_push_subscriptions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone
);


--
-- Name: tbl_push_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_push_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_push_subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_push_subscriptions_id_seq OWNED BY public.tbl_push_subscriptions.id;


--
-- Name: tbl_query_message_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_query_message_files (
    id integer NOT NULL,
    message_id integer,
    file_name text,
    file_url text NOT NULL
);


--
-- Name: tbl_query_message_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_query_message_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_query_message_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_query_message_files_id_seq OWNED BY public.tbl_query_message_files.id;


--
-- Name: tbl_query_message_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_query_message_reads (
    message_id integer NOT NULL,
    user_id integer NOT NULL,
    read_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: tbl_query_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_query_messages (
    id integer NOT NULL,
    rfq_id integer,
    sender_id integer,
    receiver_id integer,
    sender_type integer,
    message_text text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    is_seen boolean DEFAULT false
);


--
-- Name: tbl_query_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_query_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_query_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_query_messages_id_seq OWNED BY public.tbl_query_messages.id;


--
-- Name: tbl_quote_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quote_activity (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    current_status character varying(10) NOT NULL,
    prev_status character varying(10),
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_quote_activity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quote_activity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_quote_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_quote_activity_id_seq OWNED BY public.tbl_quote_activity.id;


--
-- Name: tbl_quote_estimates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quote_estimates (
    id integer NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_quote_estimates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quote_estimates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_quote_estimates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_quote_estimates_id_seq OWNED BY public.tbl_quote_estimates.id;


--
-- Name: tbl_quote_estimates_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quote_estimates_item (
    id integer NOT NULL,
    quote_estimates_id integer NOT NULL,
    product_variant_id integer NOT NULL,
    lowest_price double precision,
    average_price double precision,
    highest_price double precision,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_quote_estimates_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quote_estimates_item_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_quote_estimates_item_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_quote_estimates_item_id_seq OWNED BY public.tbl_quote_estimates_item.id;


--
-- Name: tbl_quote_finalization_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quote_finalization_id_seq
    START WITH 13
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_quote_finalization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quote_finalization (
    id integer DEFAULT nextval('public.tbl_quote_finalization_id_seq'::regclass) NOT NULL,
    rfq_id integer NOT NULL,
    rfq_no integer NOT NULL,
    quote_id integer NOT NULL,
    product_variant_id integer NOT NULL,
    vendor_id integer NOT NULL,
    created_by integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    variant integer,
    comment text
);


--
-- Name: tbl_quote_finalization_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quote_finalization_history (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    rfq_no integer NOT NULL,
    quote_id integer NOT NULL,
    product_variant_id integer NOT NULL,
    vendor_id integer NOT NULL,
    created_by integer NOT NULL,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    variant integer,
    changed_by integer NOT NULL,
    changed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    comment text
);


--
-- Name: tbl_quote_finalization_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quote_finalization_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_quote_finalization_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_quote_finalization_history_id_seq OWNED BY public.tbl_quote_finalization_history.id;


--
-- Name: tbl_quote_item_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quote_item_files (
    id integer NOT NULL,
    quote_item_id integer NOT NULL,
    file_type character varying(50) NOT NULL,
    file_url text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_quote_item_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quote_item_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_quote_item_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_quote_item_files_id_seq OWNED BY public.tbl_quote_item_files.id;


--
-- Name: tbl_quote_item_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quote_item_history (
    id integer NOT NULL,
    quote_item_id integer,
    rfq_id integer,
    product_variant_id integer,
    unit_price real,
    package_price real,
    tax real,
    freight_price real,
    total_price real,
    comment text,
    delivery_period text,
    quantity character varying(255),
    variant integer,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    freight_mode public.item_mode DEFAULT 'percentage'::public.item_mode,
    package_mode public.item_mode DEFAULT 'percentage'::public.item_mode,
    tax_mode public.item_mode DEFAULT 'percentage'::public.item_mode,
    other_charges jsonb DEFAULT '[]'::jsonb,
    pricing_method character varying(12) DEFAULT 'TRADITIONAL'::character varying,
    entered_mrp numeric(15,2),
    mrp_discount numeric(15,2),
    mrp_discount_mode public.item_mode
);


--
-- Name: tbl_quote_item_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quote_item_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_quote_item_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_quote_item_history_id_seq OWNED BY public.tbl_quote_item_history.id;


--
-- Name: tbl_quote_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quote_items_id_seq
    START WITH 29
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_quote_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quote_items (
    id integer DEFAULT nextval('public.tbl_quote_items_id_seq'::regclass) NOT NULL,
    rfq_id integer NOT NULL,
    rfq_no integer NOT NULL,
    quote_id integer NOT NULL,
    product_variant_id integer NOT NULL,
    unit_price numeric(15,2) DEFAULT 0 NOT NULL,
    package_price numeric(15,2) DEFAULT 0,
    tax numeric(15,2) DEFAULT 0,
    freight_price numeric(15,2) DEFAULT 0,
    total_price numeric(15,2) DEFAULT 0 NOT NULL,
    comment text NOT NULL,
    delivery_period text NOT NULL,
    product_name text,
    quantity character varying DEFAULT '0'::character varying NOT NULL,
    variant integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone,
    freight_mode public.item_mode DEFAULT 'percentage'::public.item_mode,
    package_mode public.item_mode DEFAULT 'percentage'::public.item_mode,
    tax_mode public.item_mode DEFAULT 'percentage'::public.item_mode,
    other_charges jsonb DEFAULT '[]'::jsonb,
    pricing_method character varying(12) DEFAULT 'TRADITIONAL'::character varying NOT NULL,
    entered_mrp numeric(15,2),
    mrp_discount numeric(15,2),
    mrp_discount_mode public.item_mode,
    CONSTRAINT chk_tbl_quote_items_pricing_method CHECK (((pricing_method)::text = ANY ((ARRAY['TRADITIONAL'::character varying, 'MRP'::character varying])::text[])))
);


--
-- Name: tbl_quotes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quotes_id_seq
    START WITH 27
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quotes (
    id integer DEFAULT nextval('public.tbl_quotes_id_seq'::regclass) NOT NULL,
    rfq_id integer NOT NULL,
    rfq_no integer NOT NULL,
    status integer DEFAULT 1 NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_regret integer DEFAULT 0 NOT NULL,
    global_payment_term text,
    global_comment text,
    regret_reason text,
    gstin character varying(15),
    payment_id integer,
    global_tax numeric DEFAULT 0,
    global_tax_mode character varying(20) DEFAULT 'percentage'::character varying,
    global_charges jsonb DEFAULT '[]'::jsonb,
    pricing_method character varying(12) DEFAULT 'TRADITIONAL'::character varying NOT NULL,
    CONSTRAINT chk_tbl_quotes_pricing_method CHECK (((pricing_method)::text = ANY ((ARRAY['TRADITIONAL'::character varying, 'MRP'::character varying])::text[])))
);


--
-- Name: tbl_quotes_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quotes_files (
    id integer NOT NULL,
    quote_id integer NOT NULL,
    file_type character varying(50) NOT NULL,
    file_url text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_quotes_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quotes_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_quotes_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_quotes_files_id_seq OWNED BY public.tbl_quotes_files.id;


--
-- Name: tbl_quotes_payment_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_quotes_payment_terms (
    id integer NOT NULL,
    quote_id integer NOT NULL,
    value integer NOT NULL,
    type text NOT NULL,
    days integer,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by integer,
    comment text,
    CONSTRAINT tbl_quotes_payment_terms_type_check CHECK ((type = ANY (ARRAY['advance'::text, 'credit'::text, 'other'::text]))),
    CONSTRAINT tbl_quotes_payment_terms_value_check CHECK (((value >= 0) AND (value <= 100)))
);


--
-- Name: tbl_quotes_payment_terms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_quotes_payment_terms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_quotes_payment_terms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_quotes_payment_terms_id_seq OWNED BY public.tbl_quotes_payment_terms.id;


--
-- Name: tbl_reject_reason_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_reject_reason_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_reject_reason; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_reject_reason (
    id integer DEFAULT nextval('public.tbl_reject_reason_id_seq'::regclass) NOT NULL,
    status integer DEFAULT 1 NOT NULL,
    reject_reason text NOT NULL,
    type smallint NOT NULL
);


--
-- Name: tbl_rfq_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_id_seq
    START WITH 112
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_rfq_rfq_no_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_rfq_no_seq
    START WITH 480870
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq (
    id integer DEFAULT nextval('public.tbl_rfq_id_seq'::regclass) NOT NULL,
    rfq_no integer DEFAULT nextval('public.tbl_rfq_rfq_no_seq'::regclass) NOT NULL,
    comment text NOT NULL,
    company_name text NOT NULL,
    response_email text NOT NULL,
    contact_name text NOT NULL,
    contact_number text NOT NULL,
    bid_end_date text NOT NULL,
    location text NOT NULL,
    is_published integer DEFAULT 0 NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status integer DEFAULT 1 NOT NULL,
    rfq_type character varying(12),
    reverse_auction smallint DEFAULT 1,
    project_id integer,
    ra_start_date timestamp without time zone,
    ra_end_date timestamp without time zone,
    rfq_added_from character varying(50),
    processed_url character varying(500),
    is_tender smallint DEFAULT 0,
    tender_publish_date timestamp without time zone,
    vendor_clarification_date timestamp without time zone,
    hospitality_company_id integer,
    hotel_id integer,
    tender_fees integer,
    department_id integer,
    title character varying(500),
    technical_evaluation_by integer,
    process_id integer,
    publish_attempts integer DEFAULT 0 NOT NULL,
    last_publish_attempt_at timestamp without time zone,
    publish_failure_reason text,
    publish_failure_notified_at timestamp without time zone,
    copied_from_rfq_id integer,
    copied_from_rfq_no integer
);


--
-- Name: tbl_rfq_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_activity (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: tbl_rfq_activity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_activity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_activity_id_seq OWNED BY public.tbl_rfq_activity.id;


--
-- Name: tbl_rfq_change_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_change_history (
    id bigint NOT NULL,
    rfq_id integer NOT NULL,
    edit_session_id uuid NOT NULL,
    entity_type character varying(32) NOT NULL,
    entity_id integer,
    entity_label character varying(255),
    field_name character varying(80),
    change_type character varying(16) NOT NULL,
    old_value jsonb,
    new_value jsonb,
    is_material boolean DEFAULT false NOT NULL,
    changed_by integer NOT NULL,
    changed_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_rfq_change_history_change_type CHECK (((change_type)::text = ANY ((ARRAY['CREATE'::character varying, 'UPDATE'::character varying, 'DELETE'::character varying])::text[]))),
    CONSTRAINT chk_rfq_change_history_entity_type CHECK (((entity_type)::text = ANY ((ARRAY['RFQ'::character varying, 'PRODUCT'::character varying, 'PRODUCT_SPEC'::character varying, 'PRODUCT_FILE'::character varying, 'PRODUCT_VENDOR'::character varying, 'PRODUCT_TECH_EVAL'::character varying, 'TERMS'::character varying, 'TERM_FILE'::character varying])::text[])))
);


--
-- Name: tbl_rfq_change_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_change_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_change_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_change_history_id_seq OWNED BY public.tbl_rfq_change_history.id;


--
-- Name: tbl_rfq_clarification_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_clarification_files (
    id integer NOT NULL,
    clarification_id integer NOT NULL,
    file_name character varying(255) NOT NULL,
    file_url text NOT NULL,
    file_type character varying(255),
    is_response_file boolean DEFAULT false,
    uploaded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_rfq_clarification_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_clarification_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_clarification_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_clarification_files_id_seq OWNED BY public.tbl_rfq_clarification_files.id;


--
-- Name: tbl_rfq_clarification_message_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_clarification_message_files (
    id integer NOT NULL,
    message_id integer NOT NULL,
    file_name character varying(255) NOT NULL,
    file_url text NOT NULL,
    file_type character varying(255),
    uploaded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_rfq_clarification_message_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_clarification_message_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_clarification_message_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_clarification_message_files_id_seq OWNED BY public.tbl_rfq_clarification_message_files.id;


--
-- Name: tbl_rfq_clarification_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_clarification_messages (
    id integer NOT NULL,
    clarification_id integer NOT NULL,
    sender_id integer NOT NULL,
    sender_type character varying(20) NOT NULL,
    message text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tbl_rfq_clarification_messages_sender_type_check CHECK (((sender_type)::text = ANY (ARRAY[('VENDOR'::character varying)::text, ('BUYER'::character varying)::text])))
);


--
-- Name: tbl_rfq_clarification_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_clarification_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_clarification_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_clarification_messages_id_seq OWNED BY public.tbl_rfq_clarification_messages.id;


--
-- Name: tbl_rfq_clarifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_clarifications (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    raised_by integer NOT NULL,
    vendor_company_id integer,
    subject character varying(200) NOT NULL,
    question text NOT NULL,
    response text,
    responded_by integer,
    status character varying(20) DEFAULT 'OPEN'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    responded_at timestamp without time zone,
    closed_at timestamp without time zone,
    closed_by integer,
    CONSTRAINT tbl_rfq_clarifications_status_check CHECK (((status)::text = ANY (ARRAY[('OPEN'::character varying)::text, ('CLOSED'::character varying)::text])))
);


--
-- Name: tbl_rfq_clarifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_clarifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_clarifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_clarifications_id_seq OWNED BY public.tbl_rfq_clarifications.id;


--
-- Name: tbl_rfq_draft_sheets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_draft_sheets (
    id integer NOT NULL,
    rfq_id bigint NOT NULL,
    sheet_name character varying(255) NOT NULL,
    is_processed boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    processed_url character varying(500),
    processed_at timestamp without time zone,
    validation_errors jsonb
);


--
-- Name: tbl_rfq_draft_sheets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_draft_sheets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_draft_sheets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_draft_sheets_id_seq OWNED BY public.tbl_rfq_draft_sheets.id;


--
-- Name: tbl_rfq_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_files (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    file_type character varying(50) NOT NULL,
    file_url text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_rfq_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_files_id_seq OWNED BY public.tbl_rfq_files.id;


--
-- Name: tbl_rfq_filters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_filters (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    rfq_product_id integer NOT NULL,
    type character varying(50) NOT NULL,
    value character varying(50) NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: tbl_rfq_filters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_filters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_filters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_filters_id_seq OWNED BY public.tbl_rfq_filters.id;


--
-- Name: tbl_rfq_hotel_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_hotel_mappings (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    hotel_id integer NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_rfq_hotel_mappings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_hotel_mappings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_hotel_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_hotel_mappings_id_seq OWNED BY public.tbl_rfq_hotel_mappings.id;


--
-- Name: tbl_rfq_persistent_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_persistent_jobs (
    id integer NOT NULL,
    file_name character varying(500) NOT NULL,
    user_id integer,
    status character varying(55) DEFAULT 'processing'::character varying NOT NULL,
    signature character varying(500) NOT NULL,
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    persisted_rfq_id integer,
    type character varying(100) DEFAULT 'rfq'::character varying,
    download_url character varying(999),
    errors jsonb,
    raw_file_url text
);


--
-- Name: tbl_rfq_persistent_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_persistent_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_persistent_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_persistent_jobs_id_seq OWNED BY public.tbl_rfq_persistent_jobs.id;


--
-- Name: tbl_rfq_product_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_files (
    id integer NOT NULL,
    rfq_product_id integer NOT NULL,
    file_type character varying(50) NOT NULL,
    file_url text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp with time zone
);


--
-- Name: tbl_rfq_product_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_files_id_seq OWNED BY public.tbl_rfq_product_files.id;


--
-- Name: tbl_rfq_product_target_price; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_target_price (
    id integer NOT NULL,
    tbl_rfq_product_id integer NOT NULL,
    target_price integer NOT NULL,
    vendor_id integer NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_rfq_product_target_price_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_target_price_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_target_price_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_target_price_id_seq OWNED BY public.tbl_rfq_product_target_price.id;


--
-- Name: tbl_rfq_product_tech_eval_vendor_replacements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_eval_vendor_replacements (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    rfq_product_id integer NOT NULL,
    old_vendor_id integer NOT NULL,
    new_vendor_id integer NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_rfq_product_tech_eval_vendor_replacements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_eval_vendor_replacements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_eval_vendor_replacements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_eval_vendor_replacements_id_seq OWNED BY public.tbl_rfq_product_tech_eval_vendor_replacements.id;


--
-- Name: tbl_rfq_product_tech_evaluation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_evaluation (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    tbl_rfq_product_id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    minimum_passing_score integer DEFAULT 0,
    is_complete boolean DEFAULT false,
    current_round integer DEFAULT 1,
    total_passed_verified integer DEFAULT 0,
    required_passed_vendors integer DEFAULT 5,
    blocked_insufficient_vendors boolean DEFAULT false
);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_evaluation_clauses (
    id integer NOT NULL,
    tbl_rfq_product_tech_evaluation_id integer,
    clause_text text NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    weightage integer DEFAULT 0,
    clause_type character varying(20) DEFAULT 'clause'::character varying
);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_evaluation_clauses_files (
    id integer NOT NULL,
    tbl_rfq_product_tech_evaluation_clauses_id integer,
    file_url character varying(200) NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_evaluation_clauses_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_evaluation_clauses_files_id_seq OWNED BY public.tbl_rfq_product_tech_evaluation_clauses_files.id;


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_evaluation_clauses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_evaluation_clauses_id_seq OWNED BY public.tbl_rfq_product_tech_evaluation_clauses.id;


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_evaluation_cleared_vendors (
    id integer NOT NULL,
    tbl_rfq_product_tech_evaluation_id integer,
    vendor_id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    reject_message text,
    status integer,
    created_by integer,
    is_verified boolean DEFAULT false,
    evaluation_round integer DEFAULT 1,
    approval_instance_id integer,
    calculated_score numeric(5,2),
    replaced_by_vendor_id integer
);


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_evaluation_cleared_vendors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_evaluation_cleared_vendors_id_seq OWNED BY public.tbl_rfq_product_tech_evaluation_cleared_vendors.id;


--
-- Name: tbl_rfq_product_tech_evaluation_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_evaluation_comments (
    id integer NOT NULL,
    tbl_rfq_product_tech_evaluation_clauses_id integer,
    text text NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    sender_id integer NOT NULL,
    receiver_id integer NOT NULL
);


--
-- Name: tbl_rfq_product_tech_evaluation_comments_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_evaluation_comments_files (
    id integer NOT NULL,
    tbl_rfq_product_tech_evaluation_comments_id integer,
    file_url character varying(255),
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    user_id integer NOT NULL
);


--
-- Name: tbl_rfq_product_tech_evaluation_comments_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_evaluation_comments_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_evaluation_comments_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_evaluation_comments_files_id_seq OWNED BY public.tbl_rfq_product_tech_evaluation_comments_files.id;


--
-- Name: tbl_rfq_product_tech_evaluation_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_evaluation_comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_evaluation_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_evaluation_comments_id_seq OWNED BY public.tbl_rfq_product_tech_evaluation_comments.id;


--
-- Name: tbl_rfq_product_tech_evaluation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_evaluation_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_evaluation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_evaluation_id_seq OWNED BY public.tbl_rfq_product_tech_evaluation.id;


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_evaluation_vendors_response (
    id integer NOT NULL,
    tbl_rfq_product_tech_evaluation_clauses_id integer,
    vendor_id integer NOT NULL,
    vendor_response text NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    buyer_id integer,
    buyer_marks integer DEFAULT 0,
    buyer_remark text,
    score_timestamp timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_tech_evaluation_vendors_response_files (
    id integer NOT NULL,
    tbl_rfq_product_tech_evaluation_vendors_response_id integer,
    file_url text,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_evaluation_vendors_response_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_evaluation_vendors_response_files_id_seq OWNED BY public.tbl_rfq_product_tech_evaluation_vendors_response_files.id;


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_tech_evaluation_vendors_response_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_product_tech_evaluation_vendors_response_id_seq OWNED BY public.tbl_rfq_product_tech_evaluation_vendors_response.id;


--
-- Name: tbl_rfq_product_vendors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_product_vendors_id_seq
    START WITH 123
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_rfq_product_vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_product_vendors (
    rfq_id integer NOT NULL,
    product_variant_id integer NOT NULL,
    user_id integer NOT NULL,
    id integer DEFAULT nextval('public.tbl_rfq_product_vendors_id_seq'::regclass) NOT NULL,
    variant integer,
    sheet_id bigint,
    is_rfq_viewed integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone,
    vendor_name character varying(255)
);


--
-- Name: tbl_rfq_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_products_id_seq
    START WITH 128
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_rfq_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_products (
    rfq_id integer NOT NULL,
    comment text NOT NULL,
    datasheet text DEFAULT '0'::text NOT NULL,
    spec_file text NOT NULL,
    qap_file text NOT NULL,
    product_variant_id integer NOT NULL,
    id integer DEFAULT nextval('public.tbl_rfq_products_id_seq'::regclass) NOT NULL,
    qap text DEFAULT '0'::text NOT NULL,
    datasheet_file text,
    variant integer,
    sheet_id bigint,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone
);


--
-- Name: tbl_rfq_products_specs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_products_specs_id_seq
    START WITH 340
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_rfq_products_specs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_products_specs (
    rfq_id integer NOT NULL,
    product_variant_id integer NOT NULL,
    title text NOT NULL,
    value text NOT NULL,
    id integer DEFAULT nextval('public.tbl_rfq_products_specs_id_seq'::regclass) NOT NULL,
    variant integer,
    sheet_id bigint,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone
);


--
-- Name: tbl_rfq_purchase_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_purchase_order (
    id integer NOT NULL,
    rfq_id integer,
    project_id integer,
    company_id integer NOT NULL,
    po_number character varying(80) NOT NULL,
    status public.po_status NOT NULL,
    rfq_product_id integer[] NOT NULL,
    quantity double precision NOT NULL,
    unit_price numeric NOT NULL,
    finalized_vendor_id integer NOT NULL,
    total_value numeric NOT NULL,
    quote_id integer[] DEFAULT '{}'::integer[] NOT NULL,
    initiated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    po_pdf_url text,
    gstin character varying(15),
    selected_hierarchy bigint,
    terms_and_conditions text,
    approval_instance_id integer,
    vendor_rejection_reason text,
    vendor_action_at timestamp without time zone,
    vendor_reminder_count integer DEFAULT 0,
    global_charges jsonb DEFAULT '[]'::jsonb NOT NULL,
    arc_contract_id bigint,
    source_mr_id bigint,
    is_call_off boolean DEFAULT false NOT NULL,
    auto_initiated boolean DEFAULT false NOT NULL,
    CONSTRAINT tbl_rfq_purchase_order_call_off_or_rfq_chk CHECK ((((is_call_off = true) AND (arc_contract_id IS NOT NULL) AND (source_mr_id IS NOT NULL)) OR ((is_call_off = false) AND (rfq_id IS NOT NULL))))
);


--
-- Name: tbl_rfq_purchase_order_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_purchase_order_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_purchase_order_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_purchase_order_id_seq OWNED BY public.tbl_rfq_purchase_order.id;


--
-- Name: tbl_rfq_quote_excel; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_quote_excel (
    id integer NOT NULL,
    rfq_id integer NOT NULL,
    user_id integer NOT NULL,
    downloaded_excel character varying(500),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_rfq_quote_excel_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_quote_excel_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_quote_excel_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_quote_excel_id_seq OWNED BY public.tbl_rfq_quote_excel.id;


--
-- Name: tbl_rfq_terms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_terms_id_seq
    START WITH 6
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_rfq_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_terms (
    term_content text NOT NULL,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    id integer DEFAULT nextval('public.tbl_rfq_terms_id_seq'::regclass) NOT NULL
);


--
-- Name: tbl_rfq_terms_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_terms_map_id_seq
    AS integer
    START WITH 139
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_terms_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_terms_map (
    id integer DEFAULT nextval('public.tbl_rfq_terms_map_id_seq'::regclass) NOT NULL,
    rfq_id smallint NOT NULL,
    terms_id smallint NOT NULL
);


--
-- Name: tbl_rfq_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_rfq_units (
    id integer NOT NULL,
    unit character varying(50) NOT NULL
);


--
-- Name: tbl_rfq_units_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_rfq_units_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_rfq_units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_rfq_units_id_seq OWNED BY public.tbl_rfq_units.id;


--
-- Name: tbl_role_menuw_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_role_menuw_id_seq
    START WITH 7
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_role_menu; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_role_menu (
    id integer DEFAULT nextval('public.tbl_role_menuw_id_seq'::regclass) NOT NULL,
    tile character varying(200) NOT NULL,
    status integer DEFAULT 1 NOT NULL,
    is_deleted integer DEFAULT 0 NOT NULL
);


--
-- Name: tbl_role_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_role_permission_id_seq
    START WITH 14
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_role_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_role_permission (
    id integer DEFAULT nextval('public.tbl_role_permission_id_seq'::regclass) NOT NULL,
    user_id integer NOT NULL,
    menu_id integer NOT NULL
);


--
-- Name: tbl_role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_role_permissions (
    id integer NOT NULL,
    role_id integer NOT NULL,
    permission_id integer NOT NULL
);


--
-- Name: tbl_role_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_role_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_role_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_role_permissions_id_seq OWNED BY public.tbl_role_permissions.id;


--
-- Name: tbl_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_roles (
    id integer NOT NULL,
    title character varying(99) NOT NULL,
    description text NOT NULL,
    created_by integer
);


--
-- Name: tbl_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_roles_id_seq OWNED BY public.tbl_roles.id;


--
-- Name: tbl_spoc_location_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_spoc_location_mapping (
    id integer NOT NULL,
    spoc_id integer NOT NULL,
    location_id integer NOT NULL,
    assigned_by integer,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: tbl_spoc_location_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_spoc_location_mapping_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_spoc_location_mapping_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_spoc_location_mapping_id_seq OWNED BY public.tbl_spoc_location_mapping.id;


--
-- Name: tbl_subscription_featured_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_subscription_featured_id_seq
    START WITH 4
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_subscription_feature; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_subscription_feature (
    id integer DEFAULT nextval('public.tbl_subscription_featured_id_seq'::regclass) NOT NULL,
    title character varying(255) NOT NULL,
    status integer NOT NULL,
    user_type character varying(10) DEFAULT 2 NOT NULL
);


--
-- Name: tbl_subscription_feature_plan_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_subscription_feature_plan_mapping_id_seq
    START WITH 67
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_subscription_feature_plan_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_subscription_feature_plan_mapping (
    id integer DEFAULT nextval('public.tbl_subscription_feature_plan_mapping_id_seq'::regclass) NOT NULL,
    feature_id integer NOT NULL,
    plan_id integer NOT NULL,
    status smallint DEFAULT '1'::smallint NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    allocated_feature smallint DEFAULT '0'::smallint NOT NULL
);


--
-- Name: tbl_subscription_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_subscription_plans_id_seq
    START WITH 16
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_subscription_plans (
    id integer DEFAULT nextval('public.tbl_subscription_plans_id_seq'::regclass) NOT NULL,
    plan_name character varying(255) NOT NULL,
    price numeric(10,2) NOT NULL,
    duration integer NOT NULL,
    plan_type character varying NOT NULL,
    status smallint NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    created_by integer,
    updated_by integer,
    currency character varying(10) DEFAULT '₹'::character varying NOT NULL,
    user_type character varying(10) DEFAULT 2 NOT NULL
);


--
-- Name: tbl_subscription_plans_offer_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_subscription_plans_offer_mapping_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_subscription_plans_offer_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_subscription_plans_offer_mapping (
    id integer DEFAULT nextval('public.tbl_subscription_plans_offer_mapping_id_seq'::regclass) NOT NULL,
    subscription_plan_id integer NOT NULL,
    offer_id integer NOT NULL,
    status integer DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_subscriptions_payment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_subscriptions_payment_id_seq
    START WITH 19
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_subscriptions_payment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_subscriptions_payment (
    id integer DEFAULT nextval('public.tbl_subscriptions_payment_id_seq'::regclass) NOT NULL,
    user_id integer NOT NULL,
    user_subscriptions_id integer NOT NULL,
    status integer NOT NULL,
    amount numeric(10,2) NOT NULL,
    date date,
    before_payment_response text,
    after_payment_response text,
    payment_id character varying(255),
    order_id character varying(255) NOT NULL,
    method character varying(255),
    receipt character varying(255) NOT NULL,
    subscription_charge numeric(10,2) NOT NULL,
    offer_price numeric(10,2) DEFAULT 0.00 NOT NULL,
    coupon_price numeric(10,2) DEFAULT 0.00 NOT NULL,
    invoice_file character varying(255)
);


--
-- Name: tbl_team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_team_members (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    role text NOT NULL,
    mobile character varying(15),
    email character varying(255),
    profile_image character varying(255),
    old_image character varying(255),
    page_id integer,
    linkedin character varying(255),
    facebook character varying(255),
    twitter character varying(255),
    whatsapp character varying(15),
    status smallint DEFAULT 1 NOT NULL,
    created_by integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT tbl_team_members_status_check CHECK ((status = ANY (ARRAY[0, 1])))
);


--
-- Name: tbl_team_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_team_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_team_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_team_members_id_seq OWNED BY public.tbl_team_members.id;


--
-- Name: tbl_tech_evaluation_rounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_tech_evaluation_rounds (
    id integer NOT NULL,
    tbl_rfq_product_tech_evaluation_id integer NOT NULL,
    round_number integer DEFAULT 1 NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying,
    approval_instance_id integer,
    vendors_evaluated json,
    passed_count integer DEFAULT 0,
    failed_count integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    submitted_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_by integer
);


--
-- Name: tbl_tech_evaluation_rounds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_tech_evaluation_rounds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_tech_evaluation_rounds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_tech_evaluation_rounds_id_seq OWNED BY public.tbl_tech_evaluation_rounds.id;


--
-- Name: tbl_temp_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_temp_user (
    id integer NOT NULL,
    buyer_id integer NOT NULL,
    vendor_name character varying(60) NOT NULL,
    email character varying(50) NOT NULL,
    mobile character varying(20) NOT NULL,
    product_list character varying(300) NOT NULL,
    status integer NOT NULL,
    reject_reason character varying(255),
    created_date timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_date timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_private integer DEFAULT 0
);


--
-- Name: tbl_temp_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_temp_user_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_temp_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_temp_user_id_seq OWNED BY public.tbl_temp_user.id;


--
-- Name: tbl_testimonials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_testimonials_id_seq
    START WITH 4
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_testimonials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_testimonials (
    id integer DEFAULT nextval('public.tbl_testimonials_id_seq'::regclass) NOT NULL,
    title character varying(255) NOT NULL,
    description text NOT NULL,
    created_by integer,
    thumbnail_image character varying(255),
    url character varying(255) NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    status smallint DEFAULT '1'::smallint NOT NULL,
    original_filename character varying,
    created_name character varying(255),
    created_image character varying(255),
    page_id integer
);


--
-- Name: tbl_token_login_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_token_login_data (
    id integer NOT NULL,
    token_type public.token_type NOT NULL,
    entity_id bigint NOT NULL,
    name character varying(99) NOT NULL,
    email character varying(300) NOT NULL,
    phone character varying(15) NOT NULL,
    token text NOT NULL,
    added_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_token_login_data_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_token_login_data_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_token_login_data_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_token_login_data_id_seq OWNED BY public.tbl_token_login_data.id;


--
-- Name: tbl_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_units (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_units_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_units_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_units_id_seq OWNED BY public.tbl_units.id;


--
-- Name: tbl_user_department; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_user_department (
    id integer NOT NULL,
    user_id integer NOT NULL,
    department_id integer NOT NULL
);


--
-- Name: tbl_user_department_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_user_department_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_user_department_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_user_department_id_seq OWNED BY public.tbl_user_department.id;


--
-- Name: tbl_user_role_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_user_role_scopes (
    id integer NOT NULL,
    user_id integer NOT NULL,
    role_id integer NOT NULL,
    company_id integer NOT NULL,
    hotel_id integer,
    department_id integer,
    process_id integer
);


--
-- Name: tbl_user_role_scopes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_user_role_scopes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_user_role_scopes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_user_role_scopes_id_seq OWNED BY public.tbl_user_role_scopes.id;


--
-- Name: tbl_user_subscription_feature_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_user_subscription_feature_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_user_subscription_feature; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_user_subscription_feature (
    id integer DEFAULT nextval('public.tbl_user_subscription_feature_id_seq'::regclass) NOT NULL,
    user_subscriptions_id integer NOT NULL,
    feature_id integer NOT NULL,
    plan_id integer NOT NULL,
    used_feature_count integer DEFAULT 0 NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    allocated_feature smallint DEFAULT '0'::smallint NOT NULL
);


--
-- Name: tbl_user_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_user_subscriptions_id_seq
    START WITH 23
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_user_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_user_subscriptions (
    id integer DEFAULT nextval('public.tbl_user_subscriptions_id_seq'::regclass) NOT NULL,
    user_id integer NOT NULL,
    plan_id integer NOT NULL,
    status integer NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    renew_date date NOT NULL
);


--
-- Name: tbl_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_users_id_seq
    START WITH 110
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_users (
    id integer DEFAULT nextval('public.tbl_users_id_seq'::regclass) NOT NULL,
    name character varying(255),
    email character varying(255),
    mobile character varying(15),
    user_type integer,
    password character varying(255),
    otp character varying(200),
    status integer NOT NULL,
    is_deleted integer DEFAULT 0 NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    social_login_id character varying(255),
    social_login_type character varying(200),
    social_login_profile_image character varying(255),
    whatsapp character varying(50),
    organization_name character varying(255),
    token character varying(255),
    subscription_plan_id integer,
    endpoint text,
    reject_reason_id integer,
    user_agent character varying(255),
    company_id integer,
    employee_code character varying(99),
    employee_type public.employee_type,
    designation character varying(99),
    payroll_company_id integer
);


--
-- Name: tbl_users_spoc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_users_spoc (
    id integer NOT NULL,
    name character varying(255) DEFAULT NULL::character varying,
    email character varying(255) DEFAULT NULL::character varying,
    mobile character varying(50) DEFAULT NULL::character varying,
    role character varying(255) DEFAULT NULL::character varying,
    is_deleted integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_id integer NOT NULL,
    created_by integer DEFAULT 111,
    status integer DEFAULT 2
);


--
-- Name: tbl_users_spoc_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_users_spoc_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_users_spoc_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_users_spoc_id_seq OWNED BY public.tbl_users_spoc.id;


--
-- Name: tbl_variant_values_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_variant_values_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_variant_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_variant_values (
    id integer DEFAULT nextval('public.tbl_variant_values_id_seq'::regclass) NOT NULL,
    variant_id integer NOT NULL,
    product_attribute_value_id integer NOT NULL
);


--
-- Name: tbl_variants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_variants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_variants (
    id integer DEFAULT nextval('public.tbl_variants_id_seq'::regclass) NOT NULL,
    title text NOT NULL,
    product_id integer NOT NULL,
    price integer,
    quantity integer NOT NULL,
    sku character varying NOT NULL,
    status integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tbl_vendor_approve_by_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendor_approve_by_id_seq
    START WITH 22
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_vendor_approve; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendor_approve (
    id integer DEFAULT nextval('public.tbl_vendor_approve_by_id_seq'::regclass) NOT NULL,
    vendor_approve character varying(150),
    vendor_logo character varying(255),
    status integer DEFAULT 1 NOT NULL,
    datasheet_file text,
    qap_file text,
    show_in_website integer
);


--
-- Name: tbl_vendor_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendor_documents (
    id integer NOT NULL,
    vendor_id integer NOT NULL,
    document_type character varying(50) NOT NULL,
    document_url character varying(500),
    document_number character varying(255),
    bank_account_number character varying(255),
    bank_name character varying(255),
    ifsc_code character varying(20),
    account_holder_name character varying(255),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT tbl_vendor_documents_document_type_check CHECK (((document_type)::text = ANY (ARRAY[('pan'::character varying)::text, ('gst'::character varying)::text, ('msme'::character varying)::text, ('fssai'::character varying)::text, ('cancelled_cheque'::character varying)::text, ('bank_account'::character varying)::text])))
);


--
-- Name: tbl_vendor_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendor_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_vendor_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_vendor_documents_id_seq OWNED BY public.tbl_vendor_documents.id;


--
-- Name: tbl_vendor_hotel_category_subscription; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendor_hotel_category_subscription (
    id integer NOT NULL,
    vendor_id integer NOT NULL,
    item_type character varying(20) NOT NULL,
    item_id integer NOT NULL,
    fee_amount integer NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status character varying(20) NOT NULL,
    payment_id integer,
    cancelled_at timestamp with time zone,
    cancelled_by integer,
    CONSTRAINT tbl_vendor_hotel_category_subscription_item_type_check CHECK (((item_type)::text = ANY ((ARRAY['category'::character varying, 'hotel'::character varying, 'subcategory'::character varying])::text[]))),
    CONSTRAINT tbl_vendor_hotel_category_subscription_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'pending'::character varying, 'expired'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: tbl_vendor_hotel_category_subscription_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendor_hotel_category_subscription_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_vendor_hotel_category_subscription_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_vendor_hotel_category_subscription_id_seq OWNED BY public.tbl_vendor_hotel_category_subscription.id;


--
-- Name: tbl_vendor_payment_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendor_payment_terms (
    id integer NOT NULL,
    vendor_id integer,
    value integer,
    type character varying(50),
    days integer,
    comment text,
    created_by integer,
    "timestamp" timestamp without time zone DEFAULT now()
);


--
-- Name: tbl_vendor_payment_terms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendor_payment_terms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_vendor_payment_terms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_vendor_payment_terms_id_seq OWNED BY public.tbl_vendor_payment_terms.id;


--
-- Name: tbl_vendor_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendor_payments (
    id integer NOT NULL,
    vendor_id integer NOT NULL,
    razorpay_order_id character varying(100),
    razorpay_payment_id character varying(100),
    razorpay_signature character varying(255),
    amount integer NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying,
    payment_status character varying(20) DEFAULT 'created'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    rfq_id integer,
    quote_id integer,
    payment_type character varying(20),
    method character varying(50),
    receipt character varying(100),
    before_payment_response text,
    after_payment_response text,
    invoice_file character varying(255),
    metadata jsonb,
    CONSTRAINT tbl_vendor_payments_payment_status_check CHECK (((payment_status)::text = ANY ((ARRAY['created'::character varying, 'pending'::character varying, 'paid'::character varying, 'success'::character varying, 'expired'::character varying])::text[]))),
    CONSTRAINT tbl_vendor_payments_payment_type_check CHECK (((payment_type)::text = ANY (ARRAY[('hospitality'::character varying)::text, ('tender'::character varying)::text])))
);


--
-- Name: tbl_vendor_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendor_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_vendor_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_vendor_payments_id_seq OWNED BY public.tbl_vendor_payments.id;


--
-- Name: tbl_vendor_profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendor_profile (
    id bigint NOT NULL,
    vendor_id bigint,
    file_type character varying(50),
    file_name character varying(255),
    file_url text,
    text_content text,
    payment_terms text,
    created_at timestamp without time zone DEFAULT now(),
    is_approved boolean DEFAULT false,
    approved_by bigint
);


--
-- Name: tbl_vendor_profile_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendor_profile_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_vendor_profile_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_vendor_profile_id_seq OWNED BY public.tbl_vendor_profile.id;


--
-- Name: tbl_vendor_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendor_reviews_id_seq
    START WITH 4
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_vendor_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendor_reviews (
    id integer DEFAULT nextval('public.tbl_vendor_reviews_id_seq'::regclass) NOT NULL,
    reviewed_by integer NOT NULL,
    reviewed_to integer NOT NULL,
    review_date timestamp without time zone DEFAULT now() NOT NULL,
    rating numeric,
    description text,
    quality_of_work integer,
    on_time_delivery integer,
    trustworthiness_reliability integer,
    overall_rating integer,
    is_published integer DEFAULT 0 NOT NULL
);


--
-- Name: tbl_vendor_rfq_tokens_non_login; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendor_rfq_tokens_non_login (
    id integer NOT NULL,
    token bigint NOT NULL,
    vendor_id integer NOT NULL,
    rfq_no integer NOT NULL,
    created_date timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_date timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tbl_vendor_rfq_tokens_non_login_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendor_rfq_tokens_non_login_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbl_vendor_rfq_tokens_non_login_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tbl_vendor_rfq_tokens_non_login_id_seq OWNED BY public.tbl_vendor_rfq_tokens_non_login.id;


--
-- Name: tbl_vendorapprove_product_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendorapprove_product_mapping_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_vendorapprove_product_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendorapprove_product_mapping (
    id integer DEFAULT nextval('public.tbl_vendorapprove_product_mapping_id_seq'::regclass) NOT NULL,
    product_id integer NOT NULL,
    vendor_approve_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    variant_vendor_mapping_id integer,
    approved_by integer
);


--
-- Name: tbl_vendorapprove_user_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tbl_vendorapprove_user_mapping_id_seq
    START WITH 103
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1;


--
-- Name: tbl_vendorapprove_user_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tbl_vendorapprove_user_mapping (
    id integer DEFAULT nextval('public.tbl_vendorapprove_user_mapping_id_seq'::regclass) NOT NULL,
    user_id integer NOT NULL,
    vendor_approve_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: users_book_demo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users_book_demo (
    id integer NOT NULL,
    mobile character(20) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: users_book_demo_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_book_demo_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_book_demo_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_book_demo_id_seq OWNED BY public.users_book_demo.id;


--
-- Name: vw_approval_policies_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_approval_policies_summary AS
SELECT
    NULL::integer AS id,
    NULL::character varying(50) AS entity_type,
    NULL::integer AS hospitality_company_id,
    NULL::integer AS hotel_id,
    NULL::integer AS department_id,
    NULL::boolean AS is_active,
    NULL::integer AS created_by,
    NULL::timestamp without time zone AS created_at,
    NULL::timestamp without time zone AS updated_at,
    NULL::character varying(255) AS company_name,
    NULL::character varying(255) AS hotel_name,
    NULL::character varying(99) AS department_name,
    NULL::character varying(255) AS created_by_name,
    NULL::bigint AS step_count,
    NULL::text AS scope_level;


--
-- Name: vw_pending_approvals; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_pending_approvals AS
 SELECT sa.approver_user_id,
    i.id AS instance_id,
    i.entity_type,
    i.entity_id,
    i.current_step,
    i.hospitality_company_id,
    i.hotel_id,
    i.department_id,
    i.metadata,
    i.created_at AS instance_created_at,
    s.id AS step_id,
    s.decision_rule,
    hc.name AS company_name,
    hh.name AS hotel_name,
    initiator.name AS initiated_by_name
   FROM (((((public.tbl_approval_instances i
     JOIN public.tbl_approval_instance_steps s ON (((s.approval_instance_id = i.id) AND (s.step_order = i.current_step))))
     JOIN public.tbl_approval_step_approvers sa ON ((sa.approval_instance_step_id = s.id)))
     LEFT JOIN public.tbl_hospitality_companies hc ON ((i.hospitality_company_id = hc.id)))
     LEFT JOIN public.tbl_hospitality_company_hotels hh ON ((i.hotel_id = hh.id)))
     LEFT JOIN public.tbl_users initiator ON ((i.initiated_by = initiator.id)))
  WHERE (((i.status)::text = 'PENDING'::text) AND ((sa.status)::text = 'PENDING'::text));


--
-- Name: audit_log_temp id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log_temp ALTER COLUMN id SET DEFAULT nextval('public.audit_log_temp_id_seq'::regclass);


--
-- Name: holidays id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holidays ALTER COLUMN id SET DEFAULT nextval('public.holidays_id_seq'::regclass);


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: tbl_admin_rfq_service id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_admin_rfq_service ALTER COLUMN id SET DEFAULT nextval('public.tbl_admin_rfq_service_id_seq'::regclass);


--
-- Name: tbl_approval_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_actions ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_actions_id_seq'::regclass);


--
-- Name: tbl_approval_hierarchy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_hierarchy ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_hierarchy_id_seq'::regclass);


--
-- Name: tbl_approval_hierarchy_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_hierarchy_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_hierarchy_history_id_seq'::regclass);


--
-- Name: tbl_approval_hierarchy_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_hierarchy_transactions ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_hierarchy_transactions_id_seq'::regclass);


--
-- Name: tbl_approval_instance_change_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instance_change_log ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_instance_change_log_id_seq'::regclass);


--
-- Name: tbl_approval_instance_steps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instance_steps ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_instance_steps_id_seq'::regclass);


--
-- Name: tbl_approval_instances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instances ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_instances_id_seq'::regclass);


--
-- Name: tbl_approval_policies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policies ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_policies_id_seq'::regclass);


--
-- Name: tbl_approval_policy_change_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policy_change_log ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_policy_change_log_id_seq'::regclass);


--
-- Name: tbl_approval_policy_steps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policy_steps ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_policy_steps_id_seq'::regclass);


--
-- Name: tbl_approval_processes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_processes ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_processes_id_seq'::regclass);


--
-- Name: tbl_approval_step_approvers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_step_approvers ALTER COLUMN id SET DEFAULT nextval('public.tbl_approval_step_approvers_id_seq'::regclass);


--
-- Name: tbl_arc id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_id_seq'::regclass);


--
-- Name: tbl_arc_amendment id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_amendment_id_seq'::regclass);


--
-- Name: tbl_arc_amendment_document id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_document ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_amendment_document_id_seq'::regclass);


--
-- Name: tbl_arc_amendment_edit_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_edit_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_amendment_edit_history_id_seq'::regclass);


--
-- Name: tbl_arc_callof_po id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_callof_po ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_callof_po_id_seq'::regclass);


--
-- Name: tbl_arc_comm_evaluation id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_comm_evaluation_id_seq'::regclass);


--
-- Name: tbl_arc_comm_evaluation_award id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_award ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_comm_evaluation_award_id_seq'::regclass);


--
-- Name: tbl_arc_comm_evaluation_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_comm_evaluation_history_id_seq'::regclass);


--
-- Name: tbl_arc_contract id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_contract_id_seq'::regclass);


--
-- Name: tbl_arc_contract_clarification id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_clarification ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_contract_clarification_id_seq'::regclass);


--
-- Name: tbl_arc_contract_line id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_line ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_contract_line_id_seq'::regclass);


--
-- Name: tbl_arc_contract_signature_otp id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_signature_otp ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_contract_signature_otp_id_seq'::regclass);


--
-- Name: tbl_arc_event_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_event_log ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_event_log_id_seq'::regclass);


--
-- Name: tbl_arc_invitation id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_invitation ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_invitation_id_seq'::regclass);


--
-- Name: tbl_arc_item id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_item_id_seq'::regclass);


--
-- Name: tbl_arc_item_history_snapshot id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_history_snapshot ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_item_history_snapshot_id_seq'::regclass);


--
-- Name: tbl_arc_item_tech_evaluation id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_item_tech_evaluation_id_seq'::regclass);


--
-- Name: tbl_arc_item_tech_evaluation_clauses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_clauses ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_item_tech_evaluation_clauses_id_seq'::regclass);


--
-- Name: tbl_arc_item_tech_evaluation_clauses_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_clauses_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_item_tech_evaluation_clauses_files_id_seq'::regclass);


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_cleared_vendors ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_item_tech_evaluation_cleared_vendors_id_seq'::regclass);


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_item_tech_evaluation_vendors_response_id_seq'::regclass);


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_item_tech_evaluation_vendors_response_files_id_seq'::regclass);


--
-- Name: tbl_arc_manual_entry id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_manual_entry ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_manual_entry_id_seq'::regclass);


--
-- Name: tbl_arc_quote id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_quote_id_seq'::regclass);


--
-- Name: tbl_arc_quote_line id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_quote_line_id_seq'::regclass);


--
-- Name: tbl_arc_quote_line_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_quote_line_history_id_seq'::regclass);


--
-- Name: tbl_arc_quote_version id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_version ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_quote_version_id_seq'::regclass);


--
-- Name: tbl_arc_tech_eval_edit_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_eval_edit_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_tech_eval_edit_history_id_seq'::regclass);


--
-- Name: tbl_arc_tech_evaluation_rounds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_evaluation_rounds ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_tech_evaluation_rounds_id_seq'::regclass);


--
-- Name: tbl_arc_tech_shortlist id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_shortlist ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_tech_shortlist_id_seq'::regclass);


--
-- Name: tbl_arc_universal_tech_evaluation id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_universal_tech_evaluation_id_seq'::regclass);


--
-- Name: tbl_arc_universal_tech_evaluation_clauses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_clauses ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_universal_tech_evaluation_clauses_id_seq'::regclass);


--
-- Name: tbl_arc_universal_tech_evaluation_clauses_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_clauses_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_universal_tech_evaluation_clauses_files_id_seq'::regclass);


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_cleared_vendors ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_universal_tech_evaluation_cleared_vendors_id_seq'::regclass);


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_universal_tech_evaluation_vendors_response_id_seq'::regclass);


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_universal_tech_evaluation_vendors_response_files_id_seq'::regclass);


--
-- Name: tbl_arc_vendor_alias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_vendor_alias ALTER COLUMN id SET DEFAULT nextval('public.tbl_arc_vendor_alias_id_seq'::regclass);


--
-- Name: tbl_buyer_private_vendors_mapping id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_buyer_private_vendors_mapping ALTER COLUMN id SET DEFAULT nextval('public.tbl_buyer_private_vendors_mapping_id_seq'::regclass);


--
-- Name: tbl_category_department id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_category_department ALTER COLUMN id SET DEFAULT nextval('public.tbl_category_department_id_seq'::regclass);


--
-- Name: tbl_charge_names id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_charge_names ALTER COLUMN id SET DEFAULT nextval('public.tbl_charge_names_id_seq'::regclass);


--
-- Name: tbl_company_location id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_company_location ALTER COLUMN id SET DEFAULT nextval('public.tbl_company_location_id_seq'::regclass);


--
-- Name: tbl_country_code id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_country_code ALTER COLUMN id SET DEFAULT nextval('public.tbl_country_code_id_seq'::regclass);


--
-- Name: tbl_department id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_department ALTER COLUMN id SET DEFAULT nextval('public.tbl_department_id_seq'::regclass);


--
-- Name: tbl_hierarchy_default_mapping id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hierarchy_default_mapping ALTER COLUMN id SET DEFAULT nextval('public.tbl_hierarchy_default_mapping_id_seq'::regclass);


--
-- Name: tbl_hierarchy_project_mapping id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hierarchy_project_mapping ALTER COLUMN id SET DEFAULT nextval('public.tbl_hierarchy_project_mapping_id_seq'::regclass);


--
-- Name: tbl_hospitality_companies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_companies ALTER COLUMN id SET DEFAULT nextval('public.tbl_hospitality_companies_id_seq'::regclass);


--
-- Name: tbl_hospitality_company_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_documents ALTER COLUMN id SET DEFAULT nextval('public.tbl_hospitality_company_documents_id_seq'::regclass);


--
-- Name: tbl_hospitality_company_hotels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_hotels ALTER COLUMN id SET DEFAULT nextval('public.tbl_hospitality_company_hotels_id_seq'::regclass);


--
-- Name: tbl_hospitality_hotel_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_hotel_documents ALTER COLUMN id SET DEFAULT nextval('public.tbl_hospitality_hotel_documents_id_seq'::regclass);


--
-- Name: tbl_hospitality_project_mappings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_project_mappings ALTER COLUMN id SET DEFAULT nextval('public.tbl_hospitality_project_mappings_id_seq'::regclass);


--
-- Name: tbl_hospitality_user_mappings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_user_mappings ALTER COLUMN id SET DEFAULT nextval('public.tbl_hospitality_user_mappings_id_seq'::regclass);


--
-- Name: tbl_lifecycle_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_lifecycle_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_lifecycle_history_id_seq'::regclass);


--
-- Name: tbl_material_requisition id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition ALTER COLUMN id SET DEFAULT nextval('public.tbl_material_requisition_id_seq'::regclass);


--
-- Name: tbl_material_requisition_item id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition_item ALTER COLUMN id SET DEFAULT nextval('public.tbl_material_requisition_item_id_seq'::regclass);


--
-- Name: tbl_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_migrations ALTER COLUMN id SET DEFAULT nextval('public.tbl_migrations_id_seq'::regclass);


--
-- Name: tbl_negotiation_round_approvals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_approvals ALTER COLUMN id SET DEFAULT nextval('public.tbl_negotiation_round_approvals_id_seq'::regclass);


--
-- Name: tbl_negotiation_round_quotes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_quotes ALTER COLUMN id SET DEFAULT nextval('public.tbl_negotiation_round_quotes_id_seq'::regclass);


--
-- Name: tbl_negotiation_rounds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_rounds ALTER COLUMN id SET DEFAULT nextval('public.tbl_negotiation_rounds_id_seq'::regclass);


--
-- Name: tbl_payment_milestone id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_payment_milestone ALTER COLUMN id SET DEFAULT nextval('public.tbl_payment_milestone_id_seq'::regclass);


--
-- Name: tbl_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_permissions ALTER COLUMN id SET DEFAULT nextval('public.tbl_permissions_id_seq'::regclass);


--
-- Name: tbl_portal_tour_content id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_portal_tour_content ALTER COLUMN id SET DEFAULT nextval('public.tbl_portal_tour_content_id_seq'::regclass);


--
-- Name: tbl_portal_tour_progress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_portal_tour_progress ALTER COLUMN id SET DEFAULT nextval('public.tbl_portal_tour_progress_id_seq'::regclass);


--
-- Name: tbl_product_cms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_cms ALTER COLUMN id SET DEFAULT nextval('public.tbl_product_cms_id_seq'::regclass);


--
-- Name: tbl_product_tech_spec id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_tech_spec ALTER COLUMN id SET DEFAULT nextval('public.tbl_product_tech_spec_id_seq'::regclass);


--
-- Name: tbl_product_variant id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant ALTER COLUMN id SET DEFAULT nextval('public.tbl_product_variant_id_seq'::regclass);


--
-- Name: tbl_product_variant_spec id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant_spec ALTER COLUMN id SET DEFAULT nextval('public.tbl_product_variant_spec_id_seq'::regclass);


--
-- Name: tbl_product_variant_vendor_make id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant_vendor_make ALTER COLUMN id SET DEFAULT nextval('public.tbl_product_variant_vendor_make_id_seq'::regclass);


--
-- Name: tbl_product_variant_vendor_mapping id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant_vendor_mapping ALTER COLUMN id SET DEFAULT nextval('public.tbl_product_variant_vendor_mapping_id_seq'::regclass);


--
-- Name: tbl_project_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_project_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_project_files_id_seq'::regclass);


--
-- Name: tbl_project_team id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_project_team ALTER COLUMN id SET DEFAULT nextval('public.tbl_project_team_id_seq'::regclass);


--
-- Name: tbl_projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_projects ALTER COLUMN id SET DEFAULT nextval('public.tbl_projects_id_seq'::regclass);


--
-- Name: tbl_purchase_order_document id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_purchase_order_document ALTER COLUMN id SET DEFAULT nextval('public.tbl_purchase_order_document_id_seq'::regclass);


--
-- Name: tbl_purchase_order_hsn_mapping id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_purchase_order_hsn_mapping ALTER COLUMN id SET DEFAULT nextval('public.tbl_purchase_order_hsn_mapping_id_seq'::regclass);


--
-- Name: tbl_purchase_order_product id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_purchase_order_product ALTER COLUMN id SET DEFAULT nextval('public.tbl_purchase_order_product_id_seq'::regclass);


--
-- Name: tbl_purchase_order_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_purchase_order_tasks ALTER COLUMN id SET DEFAULT nextval('public.tbl_purchase_order_tasks_id_seq'::regclass);


--
-- Name: tbl_push_subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_push_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.tbl_push_subscriptions_id_seq'::regclass);


--
-- Name: tbl_query_message_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_message_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_query_message_files_id_seq'::regclass);


--
-- Name: tbl_query_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_messages ALTER COLUMN id SET DEFAULT nextval('public.tbl_query_messages_id_seq'::regclass);


--
-- Name: tbl_quote_activity id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_activity ALTER COLUMN id SET DEFAULT nextval('public.tbl_quote_activity_id_seq'::regclass);


--
-- Name: tbl_quote_estimates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_estimates ALTER COLUMN id SET DEFAULT nextval('public.tbl_quote_estimates_id_seq'::regclass);


--
-- Name: tbl_quote_estimates_item id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_estimates_item ALTER COLUMN id SET DEFAULT nextval('public.tbl_quote_estimates_item_id_seq'::regclass);


--
-- Name: tbl_quote_finalization_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_finalization_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_quote_finalization_history_id_seq'::regclass);


--
-- Name: tbl_quote_item_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_item_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_quote_item_files_id_seq'::regclass);


--
-- Name: tbl_quote_item_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_item_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_quote_item_history_id_seq'::regclass);


--
-- Name: tbl_quotes_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quotes_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_quotes_files_id_seq'::regclass);


--
-- Name: tbl_quotes_payment_terms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quotes_payment_terms ALTER COLUMN id SET DEFAULT nextval('public.tbl_quotes_payment_terms_id_seq'::regclass);


--
-- Name: tbl_rfq_activity id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_activity ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_activity_id_seq'::regclass);


--
-- Name: tbl_rfq_change_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_change_history ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_change_history_id_seq'::regclass);


--
-- Name: tbl_rfq_clarification_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_clarification_files_id_seq'::regclass);


--
-- Name: tbl_rfq_clarification_message_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_message_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_clarification_message_files_id_seq'::regclass);


--
-- Name: tbl_rfq_clarification_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_messages ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_clarification_messages_id_seq'::regclass);


--
-- Name: tbl_rfq_clarifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarifications ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_clarifications_id_seq'::regclass);


--
-- Name: tbl_rfq_draft_sheets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_draft_sheets ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_draft_sheets_id_seq'::regclass);


--
-- Name: tbl_rfq_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_files_id_seq'::regclass);


--
-- Name: tbl_rfq_filters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_filters ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_filters_id_seq'::regclass);


--
-- Name: tbl_rfq_hotel_mappings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_hotel_mappings ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_hotel_mappings_id_seq'::regclass);


--
-- Name: tbl_rfq_persistent_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_persistent_jobs ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_persistent_jobs_id_seq'::regclass);


--
-- Name: tbl_rfq_product_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_files_id_seq'::regclass);


--
-- Name: tbl_rfq_product_target_price id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_target_price ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_target_price_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_eval_vendor_replacements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_eval_vendor_replacements ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_eval_vendor_replacements_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_evaluation id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_evaluation_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_clauses ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_evaluation_clauses_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_clauses_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_evaluation_clauses_files_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_cleared_vendors ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_evaluation_cleared_vendors_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_evaluation_comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_comments ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_evaluation_comments_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_evaluation_comments_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_comments_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_evaluation_comments_files_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_vendors_response ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_evaluation_vendors_response_id_seq'::regclass);


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_vendors_response_files ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_product_tech_evaluation_vendors_response_files_id_seq'::regclass);


--
-- Name: tbl_rfq_purchase_order id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_purchase_order ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_purchase_order_id_seq'::regclass);


--
-- Name: tbl_rfq_quote_excel id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_quote_excel ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_quote_excel_id_seq'::regclass);


--
-- Name: tbl_rfq_units id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_units ALTER COLUMN id SET DEFAULT nextval('public.tbl_rfq_units_id_seq'::regclass);


--
-- Name: tbl_role_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_role_permissions ALTER COLUMN id SET DEFAULT nextval('public.tbl_role_permissions_id_seq'::regclass);


--
-- Name: tbl_roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_roles ALTER COLUMN id SET DEFAULT nextval('public.tbl_roles_id_seq'::regclass);


--
-- Name: tbl_spoc_location_mapping id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_spoc_location_mapping ALTER COLUMN id SET DEFAULT nextval('public.tbl_spoc_location_mapping_id_seq'::regclass);


--
-- Name: tbl_team_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_team_members ALTER COLUMN id SET DEFAULT nextval('public.tbl_team_members_id_seq'::regclass);


--
-- Name: tbl_tech_evaluation_rounds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_tech_evaluation_rounds ALTER COLUMN id SET DEFAULT nextval('public.tbl_tech_evaluation_rounds_id_seq'::regclass);


--
-- Name: tbl_temp_user id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_temp_user ALTER COLUMN id SET DEFAULT nextval('public.tbl_temp_user_id_seq'::regclass);


--
-- Name: tbl_token_login_data id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_token_login_data ALTER COLUMN id SET DEFAULT nextval('public.tbl_token_login_data_id_seq'::regclass);


--
-- Name: tbl_units id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_units ALTER COLUMN id SET DEFAULT nextval('public.tbl_units_id_seq'::regclass);


--
-- Name: tbl_user_department id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_user_department ALTER COLUMN id SET DEFAULT nextval('public.tbl_user_department_id_seq'::regclass);


--
-- Name: tbl_user_role_scopes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_user_role_scopes ALTER COLUMN id SET DEFAULT nextval('public.tbl_user_role_scopes_id_seq'::regclass);


--
-- Name: tbl_users_spoc id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_users_spoc ALTER COLUMN id SET DEFAULT nextval('public.tbl_users_spoc_id_seq'::regclass);


--
-- Name: tbl_vendor_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_documents ALTER COLUMN id SET DEFAULT nextval('public.tbl_vendor_documents_id_seq'::regclass);


--
-- Name: tbl_vendor_hotel_category_subscription id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_hotel_category_subscription ALTER COLUMN id SET DEFAULT nextval('public.tbl_vendor_hotel_category_subscription_id_seq'::regclass);


--
-- Name: tbl_vendor_payment_terms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_payment_terms ALTER COLUMN id SET DEFAULT nextval('public.tbl_vendor_payment_terms_id_seq'::regclass);


--
-- Name: tbl_vendor_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_payments ALTER COLUMN id SET DEFAULT nextval('public.tbl_vendor_payments_id_seq'::regclass);


--
-- Name: tbl_vendor_profile id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_profile ALTER COLUMN id SET DEFAULT nextval('public.tbl_vendor_profile_id_seq'::regclass);


--
-- Name: tbl_vendor_rfq_tokens_non_login id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_rfq_tokens_non_login ALTER COLUMN id SET DEFAULT nextval('public.tbl_vendor_rfq_tokens_non_login_id_seq'::regclass);


--
-- Name: users_book_demo id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_book_demo ALTER COLUMN id SET DEFAULT nextval('public.users_book_demo_id_seq'::regclass);


--
-- Name: audit_log_temp audit_log_temp_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log_temp
    ADD CONSTRAINT audit_log_temp_pkey PRIMARY KEY (id);


--
-- Name: holidays holidays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT holidays_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: tbl_notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_categories product_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_categories
    ADD CONSTRAINT product_categories_pkey PRIMARY KEY (id);


--
-- Name: tbl_admin_rfq_service tbl_admin_rfq_service_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_admin_rfq_service
    ADD CONSTRAINT tbl_admin_rfq_service_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_actions tbl_approval_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_actions
    ADD CONSTRAINT tbl_approval_actions_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_hierarchy_history tbl_approval_hierarchy_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_hierarchy_history
    ADD CONSTRAINT tbl_approval_hierarchy_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_hierarchy tbl_approval_hierarchy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_hierarchy
    ADD CONSTRAINT tbl_approval_hierarchy_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_hierarchy_transactions tbl_approval_hierarchy_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_hierarchy_transactions
    ADD CONSTRAINT tbl_approval_hierarchy_transactions_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_instance_change_log tbl_approval_instance_change_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instance_change_log
    ADD CONSTRAINT tbl_approval_instance_change_log_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_instance_steps tbl_approval_instance_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instance_steps
    ADD CONSTRAINT tbl_approval_instance_steps_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_instances tbl_approval_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instances
    ADD CONSTRAINT tbl_approval_instances_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_policies tbl_approval_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policies
    ADD CONSTRAINT tbl_approval_policies_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_policy_change_log tbl_approval_policy_change_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policy_change_log
    ADD CONSTRAINT tbl_approval_policy_change_log_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_policy_steps tbl_approval_policy_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policy_steps
    ADD CONSTRAINT tbl_approval_policy_steps_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_processes tbl_approval_processes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_processes
    ADD CONSTRAINT tbl_approval_processes_pkey PRIMARY KEY (id);


--
-- Name: tbl_approval_step_approvers tbl_approval_step_approvers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_step_approvers
    ADD CONSTRAINT tbl_approval_step_approvers_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_amendment_document tbl_arc_amendment_document_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_document
    ADD CONSTRAINT tbl_arc_amendment_document_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_amendment_edit_history tbl_arc_amendment_edit_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_edit_history
    ADD CONSTRAINT tbl_arc_amendment_edit_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_amendment tbl_arc_amendment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment
    ADD CONSTRAINT tbl_arc_amendment_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc tbl_arc_arc_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc
    ADD CONSTRAINT tbl_arc_arc_number_key UNIQUE (arc_number);


--
-- Name: tbl_arc_callof_po tbl_arc_callof_po_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_callof_po
    ADD CONSTRAINT tbl_arc_callof_po_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_callof_po tbl_arc_callof_po_po_id_arc_contract_line_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_callof_po
    ADD CONSTRAINT tbl_arc_callof_po_po_id_arc_contract_line_id_key UNIQUE (po_id, arc_contract_line_id);


--
-- Name: tbl_arc_comm_evaluation tbl_arc_comm_evaluation_arc_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation
    ADD CONSTRAINT tbl_arc_comm_evaluation_arc_id_key UNIQUE (arc_id);


--
-- Name: tbl_arc_comm_evaluation_award tbl_arc_comm_evaluation_award_arc_comm_evaluation_id_arc_it_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_award
    ADD CONSTRAINT tbl_arc_comm_evaluation_award_arc_comm_evaluation_id_arc_it_key UNIQUE (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id);


--
-- Name: tbl_arc_comm_evaluation_award tbl_arc_comm_evaluation_award_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_award
    ADD CONSTRAINT tbl_arc_comm_evaluation_award_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_comm_evaluation_history tbl_arc_comm_evaluation_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_history
    ADD CONSTRAINT tbl_arc_comm_evaluation_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_comm_evaluation tbl_arc_comm_evaluation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation
    ADD CONSTRAINT tbl_arc_comm_evaluation_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_contract tbl_arc_contract_arc_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract
    ADD CONSTRAINT tbl_arc_contract_arc_id_vendor_id_key UNIQUE (arc_id, vendor_id);


--
-- Name: tbl_arc_contract_clarification tbl_arc_contract_clarification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_clarification
    ADD CONSTRAINT tbl_arc_contract_clarification_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_contract_line tbl_arc_contract_line_arc_contract_id_arc_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_line
    ADD CONSTRAINT tbl_arc_contract_line_arc_contract_id_arc_item_id_key UNIQUE (arc_contract_id, arc_item_id);


--
-- Name: tbl_arc_contract_line tbl_arc_contract_line_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_line
    ADD CONSTRAINT tbl_arc_contract_line_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_contract tbl_arc_contract_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract
    ADD CONSTRAINT tbl_arc_contract_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_contract_signature_otp tbl_arc_contract_signature_otp_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_signature_otp
    ADD CONSTRAINT tbl_arc_contract_signature_otp_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_event_log tbl_arc_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_event_log
    ADD CONSTRAINT tbl_arc_event_log_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_invitation tbl_arc_invitation_arc_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_invitation
    ADD CONSTRAINT tbl_arc_invitation_arc_id_vendor_id_key UNIQUE (arc_id, vendor_id);


--
-- Name: tbl_arc_invitation tbl_arc_invitation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_invitation
    ADD CONSTRAINT tbl_arc_invitation_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_item tbl_arc_item_arc_id_product_variant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item
    ADD CONSTRAINT tbl_arc_item_arc_id_product_variant_id_key UNIQUE (arc_id, product_variant_id);


--
-- Name: tbl_arc_item_history_snapshot tbl_arc_item_history_snapshot_arc_item_id_year_offset_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_history_snapshot
    ADD CONSTRAINT tbl_arc_item_history_snapshot_arc_item_id_year_offset_key UNIQUE (arc_item_id, year_offset);


--
-- Name: tbl_arc_item_history_snapshot tbl_arc_item_history_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_history_snapshot
    ADD CONSTRAINT tbl_arc_item_history_snapshot_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_item tbl_arc_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item
    ADD CONSTRAINT tbl_arc_item_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_clau_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_clau_key UNIQUE (arc_item_tech_evaluation_clauses_id, vendor_id);


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_id_v_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_id_v_key UNIQUE (arc_item_tech_evaluation_id, vendor_id, evaluation_round);


--
-- Name: tbl_arc_item_tech_evaluation tbl_arc_item_tech_evaluation_arc_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_arc_item_id_key UNIQUE (arc_item_id);


--
-- Name: tbl_arc_item_tech_evaluation_clauses_files tbl_arc_item_tech_evaluation_clauses_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_clauses_files
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_clauses_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_item_tech_evaluation_clauses tbl_arc_item_tech_evaluation_clauses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_clauses
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_clauses_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors tbl_arc_item_tech_evaluation_cleared_vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_cleared_vendors_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_item_tech_evaluation tbl_arc_item_tech_evaluation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response_files tbl_arc_item_tech_evaluation_vendors_response_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response_files
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_vendors_response_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response tbl_arc_item_tech_evaluation_vendors_response_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_vendors_response_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_manual_entry tbl_arc_manual_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_manual_entry
    ADD CONSTRAINT tbl_arc_manual_entry_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_number_seq tbl_arc_number_seq_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_number_seq
    ADD CONSTRAINT tbl_arc_number_seq_pkey PRIMARY KEY (fy);


--
-- Name: tbl_arc tbl_arc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc
    ADD CONSTRAINT tbl_arc_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_quote tbl_arc_quote_arc_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote
    ADD CONSTRAINT tbl_arc_quote_arc_id_vendor_id_key UNIQUE (arc_id, vendor_id);


--
-- Name: tbl_arc_quote_line tbl_arc_quote_line_arc_quote_id_arc_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line
    ADD CONSTRAINT tbl_arc_quote_line_arc_quote_id_arc_item_id_key UNIQUE (arc_quote_id, arc_item_id);


--
-- Name: tbl_arc_quote_line_history tbl_arc_quote_line_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line_history
    ADD CONSTRAINT tbl_arc_quote_line_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_quote_line tbl_arc_quote_line_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line
    ADD CONSTRAINT tbl_arc_quote_line_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_quote tbl_arc_quote_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote
    ADD CONSTRAINT tbl_arc_quote_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_quote_version tbl_arc_quote_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_version
    ADD CONSTRAINT tbl_arc_quote_version_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_tech_eval_edit_history tbl_arc_tech_eval_edit_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_eval_edit_history
    ADD CONSTRAINT tbl_arc_tech_eval_edit_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_tech_evaluation_rounds tbl_arc_tech_evaluation_rounds_arc_id_round_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_evaluation_rounds
    ADD CONSTRAINT tbl_arc_tech_evaluation_rounds_arc_id_round_number_key UNIQUE (arc_id, round_number);


--
-- Name: tbl_arc_tech_evaluation_rounds tbl_arc_tech_evaluation_rounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_evaluation_rounds
    ADD CONSTRAINT tbl_arc_tech_evaluation_rounds_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_tech_shortlist tbl_arc_tech_shortlist_arc_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_shortlist
    ADD CONSTRAINT tbl_arc_tech_shortlist_arc_id_vendor_id_key UNIQUE (arc_id, vendor_id);


--
-- Name: tbl_arc_tech_shortlist tbl_arc_tech_shortlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_shortlist
    ADD CONSTRAINT tbl_arc_tech_shortlist_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors tbl_arc_universal_tech_evalua_arc_universal_tech_evaluatio_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_universal_tech_evalua_arc_universal_tech_evaluatio_key1 UNIQUE (arc_universal_tech_evaluation_id, vendor_id, evaluation_round);


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response tbl_arc_universal_tech_evalua_arc_universal_tech_evaluation_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_universal_tech_evalua_arc_universal_tech_evaluation_key UNIQUE (arc_universal_tech_evaluation_clauses_id, vendor_id);


--
-- Name: tbl_arc_universal_tech_evaluation tbl_arc_universal_tech_evaluation_arc_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_arc_id_key UNIQUE (arc_id);


--
-- Name: tbl_arc_universal_tech_evaluation_clauses_files tbl_arc_universal_tech_evaluation_clauses_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_clauses_files
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_clauses_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_universal_tech_evaluation_clauses tbl_arc_universal_tech_evaluation_clauses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_clauses
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_clauses_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors tbl_arc_universal_tech_evaluation_cleared_vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_cleared_vendors_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_universal_tech_evaluation tbl_arc_universal_tech_evaluation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response_files tbl_arc_universal_tech_evaluation_vendors_response_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response_files
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_vendors_response_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response tbl_arc_universal_tech_evaluation_vendors_response_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_vendors_response_pkey PRIMARY KEY (id);


--
-- Name: tbl_arc_vendor_alias tbl_arc_vendor_alias_arc_id_alias_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_vendor_alias
    ADD CONSTRAINT tbl_arc_vendor_alias_arc_id_alias_index_key UNIQUE (arc_id, alias_index);


--
-- Name: tbl_arc_vendor_alias tbl_arc_vendor_alias_arc_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_vendor_alias
    ADD CONSTRAINT tbl_arc_vendor_alias_arc_id_vendor_id_key UNIQUE (arc_id, vendor_id);


--
-- Name: tbl_arc_vendor_alias tbl_arc_vendor_alias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_vendor_alias
    ADD CONSTRAINT tbl_arc_vendor_alias_pkey PRIMARY KEY (id);


--
-- Name: tbl_attribute_values tbl_attribute_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_attribute_values
    ADD CONSTRAINT tbl_attribute_values_pkey PRIMARY KEY (id);


--
-- Name: tbl_attributes tbl_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_attributes
    ADD CONSTRAINT tbl_attributes_pkey PRIMARY KEY (id);


--
-- Name: tbl_blog_category tbl_blog_category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_blog_category
    ADD CONSTRAINT tbl_blog_category_pkey PRIMARY KEY (id);


--
-- Name: tbl_blog tbl_blog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_blog
    ADD CONSTRAINT tbl_blog_pkey PRIMARY KEY (id);


--
-- Name: tbl_blog tbl_blog_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_blog
    ADD CONSTRAINT tbl_blog_slug UNIQUE (slug);


--
-- Name: tbl_buyer_private_vendors_mapping tbl_buyer_private_vendors_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_buyer_private_vendors_mapping
    ADD CONSTRAINT tbl_buyer_private_vendors_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_category_department tbl_category_department_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_category_department
    ADD CONSTRAINT tbl_category_department_pkey PRIMARY KEY (id);


--
-- Name: tbl_category_department tbl_category_department_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_category_department
    ADD CONSTRAINT tbl_category_department_uniq UNIQUE (category_id, department_id);


--
-- Name: tbl_category tbl_category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_category
    ADD CONSTRAINT tbl_category_pkey PRIMARY KEY (id);


--
-- Name: tbl_charge_names tbl_charge_names_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_charge_names
    ADD CONSTRAINT tbl_charge_names_pkey PRIMARY KEY (id);


--
-- Name: tbl_cms_banner tbl_cms_banner_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_cms_banner
    ADD CONSTRAINT tbl_cms_banner_pkey PRIMARY KEY (id);


--
-- Name: tbl_cms_page_sections tbl_cms_page_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_cms_page_sections
    ADD CONSTRAINT tbl_cms_page_sections_pkey PRIMARY KEY (id);


--
-- Name: tbl_cms_pages tbl_cms_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_cms_pages
    ADD CONSTRAINT tbl_cms_pages_pkey PRIMARY KEY (id);


--
-- Name: tbl_communication_settings tbl_communication_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_communication_settings
    ADD CONSTRAINT tbl_communication_settings_pkey PRIMARY KEY (id);


--
-- Name: tbl_communication_settings_types tbl_communication_settings_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_communication_settings_types
    ADD CONSTRAINT tbl_communication_settings_types_pkey PRIMARY KEY (id);


--
-- Name: tbl_company_logo tbl_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_company_logo
    ADD CONSTRAINT tbl_companies_pkey PRIMARY KEY (id);


--
-- Name: tbl_company_buyer_account_limit tbl_company_buyer_account_limit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_company_buyer_account_limit
    ADD CONSTRAINT tbl_company_buyer_account_limit_pkey PRIMARY KEY (company_id);


--
-- Name: tbl_company_location tbl_company_location_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_company_location
    ADD CONSTRAINT tbl_company_location_pkey PRIMARY KEY (id);


--
-- Name: tbl_company tbl_company_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_company
    ADD CONSTRAINT tbl_company_pkey PRIMARY KEY (id);


--
-- Name: tbl_contact_us tbl_contact_us_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_contact_us
    ADD CONSTRAINT tbl_contact_us_pkey PRIMARY KEY (id);


--
-- Name: tbl_country_code tbl_country_code_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_country_code
    ADD CONSTRAINT tbl_country_code_pkey PRIMARY KEY (id);


--
-- Name: tbl_coupon tbl_coupon_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_coupon
    ADD CONSTRAINT tbl_coupon_pkey PRIMARY KEY (id);


--
-- Name: tbl_department tbl_department_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_department
    ADD CONSTRAINT tbl_department_pkey PRIMARY KEY (id);


--
-- Name: tbl_offer tbl_discount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_offer
    ADD CONSTRAINT tbl_discount_pkey PRIMARY KEY (id);


--
-- Name: tbl_documents tbl_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_documents
    ADD CONSTRAINT tbl_documents_pkey PRIMARY KEY (id);


--
-- Name: tbl_faq tbl_faq_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_faq
    ADD CONSTRAINT tbl_faq_pkey PRIMARY KEY (id);


--
-- Name: tbl_files tbl_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_files
    ADD CONSTRAINT tbl_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_hierarchy_default_mapping tbl_hierarchy_default_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hierarchy_default_mapping
    ADD CONSTRAINT tbl_hierarchy_default_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_hierarchy_project_mapping tbl_hierarchy_project_mapping_hierarchy_id_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hierarchy_project_mapping
    ADD CONSTRAINT tbl_hierarchy_project_mapping_hierarchy_id_project_id_key UNIQUE (hierarchy_id, project_id);


--
-- Name: tbl_hierarchy_project_mapping tbl_hierarchy_project_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hierarchy_project_mapping
    ADD CONSTRAINT tbl_hierarchy_project_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_hospitality_companies tbl_hospitality_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_companies
    ADD CONSTRAINT tbl_hospitality_companies_pkey PRIMARY KEY (id);


--
-- Name: tbl_hospitality_company_documents tbl_hospitality_company_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_documents
    ADD CONSTRAINT tbl_hospitality_company_documents_pkey PRIMARY KEY (id);


--
-- Name: tbl_hospitality_company_hotels tbl_hospitality_company_hotels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_hotels
    ADD CONSTRAINT tbl_hospitality_company_hotels_pkey PRIMARY KEY (id);


--
-- Name: tbl_hospitality_hotel_documents tbl_hospitality_hotel_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_hotel_documents
    ADD CONSTRAINT tbl_hospitality_hotel_documents_pkey PRIMARY KEY (id);


--
-- Name: tbl_hospitality_project_mappings tbl_hospitality_project_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_project_mappings
    ADD CONSTRAINT tbl_hospitality_project_mappings_pkey PRIMARY KEY (id);


--
-- Name: tbl_hospitality_user_mappings tbl_hospitality_user_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_user_mappings
    ADD CONSTRAINT tbl_hospitality_user_mappings_pkey PRIMARY KEY (id);


--
-- Name: tbl_lifecycle_history tbl_lifecycle_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_lifecycle_history
    ADD CONSTRAINT tbl_lifecycle_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_location_cities tbl_location_cities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_location_cities
    ADD CONSTRAINT tbl_location_cities_pkey PRIMARY KEY (id);


--
-- Name: tbl_location_country tbl_location_country_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_location_country
    ADD CONSTRAINT tbl_location_country_pkey PRIMARY KEY (id);


--
-- Name: tbl_location_states tbl_location_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_location_states
    ADD CONSTRAINT tbl_location_states_pkey PRIMARY KEY (id);


--
-- Name: tbl_login_log tbl_login_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_login_log
    ADD CONSTRAINT tbl_login_log_pkey PRIMARY KEY (id);


--
-- Name: tbl_management tbl_management_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_management
    ADD CONSTRAINT tbl_management_pkey PRIMARY KEY (id);


--
-- Name: tbl_material_requisition_item tbl_material_requisition_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition_item
    ADD CONSTRAINT tbl_material_requisition_item_pkey PRIMARY KEY (id);


--
-- Name: tbl_material_requisition tbl_material_requisition_mr_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition
    ADD CONSTRAINT tbl_material_requisition_mr_number_key UNIQUE (mr_number);


--
-- Name: tbl_material_requisition tbl_material_requisition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition
    ADD CONSTRAINT tbl_material_requisition_pkey PRIMARY KEY (id);


--
-- Name: tbl_media tbl_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_media
    ADD CONSTRAINT tbl_media_pkey PRIMARY KEY (id);


--
-- Name: tbl_migrations tbl_migrations_file_name_checksum_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_migrations
    ADD CONSTRAINT tbl_migrations_file_name_checksum_key UNIQUE (file_name, checksum);


--
-- Name: tbl_migrations tbl_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_migrations
    ADD CONSTRAINT tbl_migrations_pkey PRIMARY KEY (id);


--
-- Name: tbl_negotiation_round_approvals tbl_negotiation_round_approva_negotiation_round_id_approver_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_approvals
    ADD CONSTRAINT tbl_negotiation_round_approva_negotiation_round_id_approver_key UNIQUE (negotiation_round_id, approver_user_id);


--
-- Name: tbl_negotiation_round_approvals tbl_negotiation_round_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_approvals
    ADD CONSTRAINT tbl_negotiation_round_approvals_pkey PRIMARY KEY (id);


--
-- Name: tbl_negotiation_round_quotes tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_quotes
    ADD CONSTRAINT tbl_negotiation_round_quotes_negotiation_round_id_vendor_id_key UNIQUE (negotiation_round_id, vendor_id, rfq_product_id);


--
-- Name: tbl_negotiation_round_quotes tbl_negotiation_round_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_quotes
    ADD CONSTRAINT tbl_negotiation_round_quotes_pkey PRIMARY KEY (id);


--
-- Name: tbl_negotiation_rounds tbl_negotiation_rounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_rounds
    ADD CONSTRAINT tbl_negotiation_rounds_pkey PRIMARY KEY (id);


--
-- Name: tbl_notification_setting tbl_notification_setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_notification_setting
    ADD CONSTRAINT tbl_notification_setting_pkey PRIMARY KEY (id);


--
-- Name: tbl_payment_milestone tbl_payment_milestone_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_payment_milestone
    ADD CONSTRAINT tbl_payment_milestone_pkey PRIMARY KEY (id);


--
-- Name: tbl_permissions tbl_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_permissions
    ADD CONSTRAINT tbl_permissions_pkey PRIMARY KEY (id);


--
-- Name: tbl_portal_tour_content tbl_portal_tour_content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_portal_tour_content
    ADD CONSTRAINT tbl_portal_tour_content_pkey PRIMARY KEY (id);


--
-- Name: tbl_portal_tour_progress tbl_portal_tour_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_portal_tour_progress
    ADD CONSTRAINT tbl_portal_tour_progress_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_attribute_values tbl_product_attribute_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_attribute_values
    ADD CONSTRAINT tbl_product_attribute_values_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_attributes tbl_product_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_attributes
    ADD CONSTRAINT tbl_product_attributes_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_cms tbl_product_cms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_cms
    ADD CONSTRAINT tbl_product_cms_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_images tbl_product_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_images
    ADD CONSTRAINT tbl_product_images_pkey PRIMARY KEY (id);


--
-- Name: tbl_product tbl_product_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product
    ADD CONSTRAINT tbl_product_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_tech_spec tbl_product_tech_spec_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_tech_spec
    ADD CONSTRAINT tbl_product_tech_spec_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_variant tbl_product_variant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant
    ADD CONSTRAINT tbl_product_variant_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_variant_spec tbl_product_variant_spec_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant_spec
    ADD CONSTRAINT tbl_product_variant_spec_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_variant_vendor_make tbl_product_variant_vendor_make_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant_vendor_make
    ADD CONSTRAINT tbl_product_variant_vendor_make_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_variant_vendor_mapping tbl_product_variant_vendor_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant_vendor_mapping
    ADD CONSTRAINT tbl_product_variant_vendor_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_product_variants tbl_product_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variants
    ADD CONSTRAINT tbl_product_variants_pkey PRIMARY KEY (id);


--
-- Name: tbl_project_files tbl_project_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_project_files
    ADD CONSTRAINT tbl_project_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_project_team tbl_project_team_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_project_team
    ADD CONSTRAINT tbl_project_team_pkey PRIMARY KEY (id);


--
-- Name: tbl_project_team tbl_project_team_project_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_project_team
    ADD CONSTRAINT tbl_project_team_project_id_user_id_key UNIQUE (project_id, user_id);


--
-- Name: tbl_projects tbl_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_projects
    ADD CONSTRAINT tbl_projects_pkey PRIMARY KEY (id);


--
-- Name: tbl_purchase_order_document tbl_purchase_order_document_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_purchase_order_document
    ADD CONSTRAINT tbl_purchase_order_document_pkey PRIMARY KEY (id);


--
-- Name: tbl_purchase_order_hsn_mapping tbl_purchase_order_hsn_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_purchase_order_hsn_mapping
    ADD CONSTRAINT tbl_purchase_order_hsn_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_purchase_order_product tbl_purchase_order_product_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_purchase_order_product
    ADD CONSTRAINT tbl_purchase_order_product_pkey PRIMARY KEY (id);


--
-- Name: tbl_purchase_order_tasks tbl_purchase_order_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_purchase_order_tasks
    ADD CONSTRAINT tbl_purchase_order_tasks_pkey PRIMARY KEY (id);


--
-- Name: tbl_push_subscriptions tbl_push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_push_subscriptions
    ADD CONSTRAINT tbl_push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: tbl_push_subscriptions tbl_push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_push_subscriptions
    ADD CONSTRAINT tbl_push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: tbl_query_message_files tbl_query_message_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_message_files
    ADD CONSTRAINT tbl_query_message_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_query_message_reads tbl_query_message_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_message_reads
    ADD CONSTRAINT tbl_query_message_reads_pkey PRIMARY KEY (message_id, user_id);


--
-- Name: tbl_query_messages tbl_query_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_messages
    ADD CONSTRAINT tbl_query_messages_pkey PRIMARY KEY (id);


--
-- Name: tbl_quote_activity tbl_quote_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_activity
    ADD CONSTRAINT tbl_quote_activity_pkey PRIMARY KEY (id);


--
-- Name: tbl_quote_estimates_item tbl_quote_estimates_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_estimates_item
    ADD CONSTRAINT tbl_quote_estimates_item_pkey PRIMARY KEY (id);


--
-- Name: tbl_quote_estimates tbl_quote_estimates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_estimates
    ADD CONSTRAINT tbl_quote_estimates_pkey PRIMARY KEY (id);


--
-- Name: tbl_quote_finalization_history tbl_quote_finalization_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_finalization_history
    ADD CONSTRAINT tbl_quote_finalization_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_quote_finalization tbl_quote_finalization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_finalization
    ADD CONSTRAINT tbl_quote_finalization_pkey PRIMARY KEY (id);


--
-- Name: tbl_quote_item_files tbl_quote_item_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_item_files
    ADD CONSTRAINT tbl_quote_item_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_quote_item_history tbl_quote_item_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_item_history
    ADD CONSTRAINT tbl_quote_item_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_quote_items tbl_quote_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_items
    ADD CONSTRAINT tbl_quote_items_pkey PRIMARY KEY (id);


--
-- Name: tbl_quotes_files tbl_quotes_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quotes_files
    ADD CONSTRAINT tbl_quotes_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_quotes_payment_terms tbl_quotes_payment_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quotes_payment_terms
    ADD CONSTRAINT tbl_quotes_payment_terms_pkey PRIMARY KEY (id);


--
-- Name: tbl_quotes tbl_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quotes
    ADD CONSTRAINT tbl_quotes_pkey PRIMARY KEY (id);


--
-- Name: tbl_reject_reason tbl_reject_reason_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_reject_reason
    ADD CONSTRAINT tbl_reject_reason_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_activity tbl_rfq_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_activity
    ADD CONSTRAINT tbl_rfq_activity_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_change_history tbl_rfq_change_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_change_history
    ADD CONSTRAINT tbl_rfq_change_history_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_clarification_files tbl_rfq_clarification_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_files
    ADD CONSTRAINT tbl_rfq_clarification_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_clarification_message_files tbl_rfq_clarification_message_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_message_files
    ADD CONSTRAINT tbl_rfq_clarification_message_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_clarification_messages tbl_rfq_clarification_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_messages
    ADD CONSTRAINT tbl_rfq_clarification_messages_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_clarifications tbl_rfq_clarifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarifications
    ADD CONSTRAINT tbl_rfq_clarifications_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_draft_sheets tbl_rfq_draft_sheets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_draft_sheets
    ADD CONSTRAINT tbl_rfq_draft_sheets_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_files tbl_rfq_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_files
    ADD CONSTRAINT tbl_rfq_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_filters tbl_rfq_filters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_filters
    ADD CONSTRAINT tbl_rfq_filters_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_hotel_mappings tbl_rfq_hotel_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_hotel_mappings
    ADD CONSTRAINT tbl_rfq_hotel_mappings_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_persistent_jobs tbl_rfq_persistent_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_persistent_jobs
    ADD CONSTRAINT tbl_rfq_persistent_jobs_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq tbl_rfq_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq
    ADD CONSTRAINT tbl_rfq_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_files tbl_rfq_product_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_files
    ADD CONSTRAINT tbl_rfq_product_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_target_price tbl_rfq_product_target_price_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_target_price
    ADD CONSTRAINT tbl_rfq_product_target_price_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_eval_vendor_replacements tbl_rfq_product_tech_eval_ven_rfq_id_rfq_product_id_old_ven_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_eval_vendor_replacements
    ADD CONSTRAINT tbl_rfq_product_tech_eval_ven_rfq_id_rfq_product_id_old_ven_key UNIQUE (rfq_id, rfq_product_id, old_vendor_id);


--
-- Name: tbl_rfq_product_tech_eval_vendor_replacements tbl_rfq_product_tech_eval_vendor_replacements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_eval_vendor_replacements
    ADD CONSTRAINT tbl_rfq_product_tech_eval_vendor_replacements_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_files tbl_rfq_product_tech_evaluation_clauses_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_clauses_files
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_clauses_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses tbl_rfq_product_tech_evaluation_clauses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_clauses
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_clauses_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors tbl_rfq_product_tech_evaluation_cleared_vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_cleared_vendors_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation_comments_files tbl_rfq_product_tech_evaluation_comments_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_comments_files
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_comments_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation_comments tbl_rfq_product_tech_evaluation_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_comments
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_comments_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation tbl_rfq_product_tech_evaluation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_files tbl_rfq_product_tech_evaluation_vendors_response_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_vendors_response_files
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_vendors_response_files_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response tbl_rfq_product_tech_evaluation_vendors_response_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_vendors_response_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_vendors tbl_rfq_product_vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_vendors
    ADD CONSTRAINT tbl_rfq_product_vendors_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_products tbl_rfq_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_products
    ADD CONSTRAINT tbl_rfq_products_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_products_specs tbl_rfq_products_specs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_products_specs
    ADD CONSTRAINT tbl_rfq_products_specs_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_purchase_order tbl_rfq_purchase_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_purchase_order
    ADD CONSTRAINT tbl_rfq_purchase_order_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_quote_excel tbl_rfq_quote_excel_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_quote_excel
    ADD CONSTRAINT tbl_rfq_quote_excel_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_terms_map tbl_rfq_terms_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_terms_map
    ADD CONSTRAINT tbl_rfq_terms_map_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_terms tbl_rfq_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_terms
    ADD CONSTRAINT tbl_rfq_terms_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_units tbl_rfq_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_units
    ADD CONSTRAINT tbl_rfq_units_pkey PRIMARY KEY (id);


--
-- Name: tbl_role_menu tbl_role_menuw_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_role_menu
    ADD CONSTRAINT tbl_role_menuw_pkey PRIMARY KEY (id);


--
-- Name: tbl_role_permission tbl_role_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_role_permission
    ADD CONSTRAINT tbl_role_permission_pkey PRIMARY KEY (id);


--
-- Name: tbl_role_permissions tbl_role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_role_permissions
    ADD CONSTRAINT tbl_role_permissions_pkey PRIMARY KEY (id);


--
-- Name: tbl_roles tbl_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_roles
    ADD CONSTRAINT tbl_roles_pkey PRIMARY KEY (id);


--
-- Name: tbl_spoc_location_mapping tbl_spoc_location_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_spoc_location_mapping
    ADD CONSTRAINT tbl_spoc_location_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_spoc_location_mapping tbl_spoc_location_mapping_spoc_id_location_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_spoc_location_mapping
    ADD CONSTRAINT tbl_spoc_location_mapping_spoc_id_location_id_key UNIQUE (spoc_id, location_id);


--
-- Name: tbl_subscription_feature_plan_mapping tbl_subscription_feature_plan_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_subscription_feature_plan_mapping
    ADD CONSTRAINT tbl_subscription_feature_plan_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_subscription_feature tbl_subscription_featured_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_subscription_feature
    ADD CONSTRAINT tbl_subscription_featured_pkey PRIMARY KEY (id);


--
-- Name: tbl_subscription_plans_offer_mapping tbl_subscription_plans_offer_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_subscription_plans_offer_mapping
    ADD CONSTRAINT tbl_subscription_plans_offer_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_subscription_plans tbl_subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_subscription_plans
    ADD CONSTRAINT tbl_subscription_plans_pkey PRIMARY KEY (id);


--
-- Name: tbl_subscriptions_payment tbl_subscriptions_payment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_subscriptions_payment
    ADD CONSTRAINT tbl_subscriptions_payment_pkey PRIMARY KEY (id);


--
-- Name: tbl_team_members tbl_team_members_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_team_members
    ADD CONSTRAINT tbl_team_members_email_key UNIQUE (email);


--
-- Name: tbl_team_members tbl_team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_team_members
    ADD CONSTRAINT tbl_team_members_pkey PRIMARY KEY (id);


--
-- Name: tbl_tech_evaluation_rounds tbl_tech_evaluation_rounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_tech_evaluation_rounds
    ADD CONSTRAINT tbl_tech_evaluation_rounds_pkey PRIMARY KEY (id);


--
-- Name: tbl_tech_evaluation_rounds tbl_tech_evaluation_rounds_tbl_rfq_product_tech_evaluation__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_tech_evaluation_rounds
    ADD CONSTRAINT tbl_tech_evaluation_rounds_tbl_rfq_product_tech_evaluation__key UNIQUE (tbl_rfq_product_tech_evaluation_id, round_number);


--
-- Name: tbl_temp_user tbl_temp_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_temp_user
    ADD CONSTRAINT tbl_temp_user_pkey PRIMARY KEY (id);


--
-- Name: tbl_testimonials tbl_testimonials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_testimonials
    ADD CONSTRAINT tbl_testimonials_pkey PRIMARY KEY (id);


--
-- Name: tbl_token_login_data tbl_token_login_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_token_login_data
    ADD CONSTRAINT tbl_token_login_data_pkey PRIMARY KEY (id);


--
-- Name: tbl_units tbl_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_units
    ADD CONSTRAINT tbl_units_pkey PRIMARY KEY (id);


--
-- Name: tbl_user_department tbl_user_department_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_user_department
    ADD CONSTRAINT tbl_user_department_pkey PRIMARY KEY (id);


--
-- Name: tbl_user_role_scopes tbl_user_role_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_user_role_scopes
    ADD CONSTRAINT tbl_user_role_scopes_pkey PRIMARY KEY (id);


--
-- Name: tbl_user_subscription_feature tbl_user_subscription_feature_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_user_subscription_feature
    ADD CONSTRAINT tbl_user_subscription_feature_pkey PRIMARY KEY (id);


--
-- Name: tbl_user_subscriptions tbl_user_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_user_subscriptions
    ADD CONSTRAINT tbl_user_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: tbl_users tbl_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_users
    ADD CONSTRAINT tbl_users_pkey PRIMARY KEY (id);


--
-- Name: tbl_users_spoc tbl_users_spoc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_users_spoc
    ADD CONSTRAINT tbl_users_spoc_pkey PRIMARY KEY (id);


--
-- Name: tbl_variant_values tbl_variant_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_variant_values
    ADD CONSTRAINT tbl_variant_values_pkey PRIMARY KEY (id);


--
-- Name: tbl_variants tbl_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_variants
    ADD CONSTRAINT tbl_variants_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_approve tbl_vendor_approve_by_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_approve
    ADD CONSTRAINT tbl_vendor_approve_by_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_documents tbl_vendor_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_documents
    ADD CONSTRAINT tbl_vendor_documents_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_hotel_category_subscription tbl_vendor_hotel_category_subscription_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_hotel_category_subscription
    ADD CONSTRAINT tbl_vendor_hotel_category_subscription_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_payment_terms tbl_vendor_payment_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_payment_terms
    ADD CONSTRAINT tbl_vendor_payment_terms_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_payments tbl_vendor_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_payments
    ADD CONSTRAINT tbl_vendor_payments_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_profile tbl_vendor_profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_profile
    ADD CONSTRAINT tbl_vendor_profile_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_reviews tbl_vendor_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_reviews
    ADD CONSTRAINT tbl_vendor_reviews_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_rfq_tokens_non_login tbl_vendor_rfq_tokens_non_login_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_rfq_tokens_non_login
    ADD CONSTRAINT tbl_vendor_rfq_tokens_non_login_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendor_rfq_tokens_non_login tbl_vendor_rfq_tokens_non_login_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_rfq_tokens_non_login
    ADD CONSTRAINT tbl_vendor_rfq_tokens_non_login_token_key UNIQUE (token);


--
-- Name: tbl_vendorapprove_product_mapping tbl_vendorapprove_product_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendorapprove_product_mapping
    ADD CONSTRAINT tbl_vendorapprove_product_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_vendorapprove_user_mapping tbl_vendorapprove_user_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendorapprove_user_mapping
    ADD CONSTRAINT tbl_vendorapprove_user_mapping_pkey PRIMARY KEY (id);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_files unique_clause_file; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_clauses_files
    ADD CONSTRAINT unique_clause_file UNIQUE (tbl_rfq_product_tech_evaluation_clauses_id, file_url);


--
-- Name: tbl_product_variant unique_product_variant_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant
    ADD CONSTRAINT unique_product_variant_slug UNIQUE (slug);


--
-- Name: tbl_admin_rfq_service unique_rfq_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_admin_rfq_service
    ADD CONSTRAINT unique_rfq_id UNIQUE (rfq_id);


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response unique_vendor_clause; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_vendors_response
    ADD CONSTRAINT unique_vendor_clause UNIQUE (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id);


--
-- Name: tbl_buyer_private_vendors_mapping unique_vendor_company_mapping; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_buyer_private_vendors_mapping
    ADD CONSTRAINT unique_vendor_company_mapping UNIQUE (vendor_id, company_id);


--
-- Name: tbl_arc_manual_entry uq_arc_manual_entry_arc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_manual_entry
    ADD CONSTRAINT uq_arc_manual_entry_arc UNIQUE (arc_id);


--
-- Name: tbl_hospitality_company_documents uq_hospitality_company_document; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_documents
    ADD CONSTRAINT uq_hospitality_company_document UNIQUE (hospitality_company_id, document_type);


--
-- Name: tbl_hospitality_hotel_documents uq_hospitality_hotel_document; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_hotel_documents
    ADD CONSTRAINT uq_hospitality_hotel_document UNIQUE (hospitality_hotel_id, document_type);


--
-- Name: tbl_hospitality_project_mappings uq_hospitality_project_mapping; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_project_mappings
    ADD CONSTRAINT uq_hospitality_project_mapping UNIQUE (project_id, mapping_type, hospitality_company_id, hospitality_hotel_id);


--
-- Name: tbl_hospitality_user_mappings uq_hospitality_user_mapping; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_user_mappings
    ADD CONSTRAINT uq_hospitality_user_mapping UNIQUE (user_id, mapping_type, hospitality_company_id, hospitality_hotel_id);


--
-- Name: tbl_approval_processes uq_process_company_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_processes
    ADD CONSTRAINT uq_process_company_name UNIQUE (company_id, name);


--
-- Name: tbl_rfq_hotel_mappings uq_rfq_hotel_mapping; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_hotel_mappings
    ADD CONSTRAINT uq_rfq_hotel_mapping UNIQUE (rfq_id, hotel_id);


--
-- Name: tbl_rfq uq_tbl_rfq_rfq_no; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq
    ADD CONSTRAINT uq_tbl_rfq_rfq_no UNIQUE (rfq_no);


--
-- Name: tbl_vendor_documents uq_vendor_document_type; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_documents
    ADD CONSTRAINT uq_vendor_document_type UNIQUE (vendor_id, document_type);


--
-- Name: tbl_vendor_hotel_category_subscription uq_vendor_hotel_category_subscription; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_hotel_category_subscription
    ADD CONSTRAINT uq_vendor_hotel_category_subscription UNIQUE (vendor_id, item_type, item_id, end_date);


--
-- Name: users_book_demo users_book_demo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_book_demo
    ADD CONSTRAINT users_book_demo_pkey PRIMARY KEY (id);


--
-- Name: idx_action_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_created ON public.tbl_approval_actions USING btree (created_at);


--
-- Name: idx_action_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_instance ON public.tbl_approval_actions USING btree (approval_instance_id);


--
-- Name: idx_action_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_user ON public.tbl_approval_actions USING btree (approver_user_id);


--
-- Name: idx_approval_actions_instance_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_actions_instance_id ON public.tbl_approval_actions USING btree (approval_instance_id, created_at);


--
-- Name: idx_approval_instance_steps_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_instance_steps_instance ON public.tbl_approval_instance_steps USING btree (approval_instance_id, step_order);


--
-- Name: idx_approval_instance_steps_instance_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_instance_steps_instance_id ON public.tbl_approval_instance_steps USING btree (approval_instance_id, step_order);


--
-- Name: idx_approval_instance_steps_instance_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_instance_steps_instance_status ON public.tbl_approval_instance_steps USING btree (approval_instance_id, status);


--
-- Name: idx_approval_instances_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_instances_entity ON public.tbl_approval_instances USING btree (entity_type, entity_id);


--
-- Name: idx_approval_instances_entity_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_instances_entity_status ON public.tbl_approval_instances USING btree (entity_type, entity_id, status);


--
-- Name: idx_approval_instances_process; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_instances_process ON public.tbl_approval_instances USING btree (process_id);


--
-- Name: idx_approval_instances_rfq_metadata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_instances_rfq_metadata ON public.tbl_approval_instances USING btree (((metadata ->> 'rfq_id'::text))) WHERE ((metadata ->> 'rfq_id'::text) IS NOT NULL);


--
-- Name: idx_approval_instances_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_instances_status ON public.tbl_approval_instances USING btree (entity_type, status);


--
-- Name: idx_approval_policies_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_policies_lookup ON public.tbl_approval_policies USING btree (entity_type, hospitality_company_id, is_active) WHERE (is_active = true);


--
-- Name: idx_approval_policies_process; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_policies_process ON public.tbl_approval_policies USING btree (process_id);


--
-- Name: idx_approval_policy_steps_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_policy_steps_policy ON public.tbl_approval_policy_steps USING btree (approval_policy_id, step_order);


--
-- Name: idx_approval_policy_steps_policy_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_policy_steps_policy_order ON public.tbl_approval_policy_steps USING btree (approval_policy_id, step_order);


--
-- Name: idx_approval_policy_steps_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_policy_steps_source ON public.tbl_approval_policy_steps USING btree (approver_source_type, approver_source_id);


--
-- Name: idx_approval_processes_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_processes_active ON public.tbl_approval_processes USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_approval_processes_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_processes_company ON public.tbl_approval_processes USING btree (company_id);


--
-- Name: idx_approval_step_approvers_step; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_step_approvers_step ON public.tbl_approval_step_approvers USING btree (approval_instance_step_id, status);


--
-- Name: idx_approval_step_approvers_step_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_step_approvers_step_id ON public.tbl_approval_step_approvers USING btree (approval_instance_step_id);


--
-- Name: idx_approval_step_approvers_step_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_step_approvers_step_user_status ON public.tbl_approval_step_approvers USING btree (approval_instance_step_id, approver_user_id, status);


--
-- Name: idx_approval_step_approvers_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_step_approvers_user_status ON public.tbl_approval_step_approvers USING btree (approver_user_id, status);


--
-- Name: idx_approver_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approver_pending ON public.tbl_approval_step_approvers USING btree (approver_user_id, status) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: idx_approver_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approver_status ON public.tbl_approval_step_approvers USING btree (status);


--
-- Name: idx_approver_step; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approver_step ON public.tbl_approval_step_approvers USING btree (approval_instance_step_id);


--
-- Name: idx_approver_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approver_user ON public.tbl_approval_step_approvers USING btree (approver_user_id);


--
-- Name: idx_arc_contract_clarification_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arc_contract_clarification_arc ON public.tbl_arc_contract_clarification USING btree (arc_id);


--
-- Name: idx_arc_contract_clarification_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arc_contract_clarification_contract ON public.tbl_arc_contract_clarification USING btree (arc_contract_id, status);


--
-- Name: idx_arc_quote_line_rate_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arc_quote_line_rate_source ON public.tbl_arc_quote_line USING btree (rate_source) WHERE ((rate_source)::text = 'NEGOTIATED'::text);


--
-- Name: idx_arc_tech_shortlist_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arc_tech_shortlist_arc ON public.tbl_arc_tech_shortlist USING btree (arc_id);


--
-- Name: idx_ars_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ars_rfq_id ON public.tbl_admin_rfq_service USING btree (rfq_id);


--
-- Name: idx_ars_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ars_status ON public.tbl_admin_rfq_service USING btree (status);


--
-- Name: idx_clarification_message_files_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clarification_message_files_message_id ON public.tbl_rfq_clarification_message_files USING btree (message_id);


--
-- Name: idx_clarification_messages_clarification_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clarification_messages_clarification_id ON public.tbl_rfq_clarification_messages USING btree (clarification_id);


--
-- Name: idx_clarification_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clarification_messages_created_at ON public.tbl_rfq_clarification_messages USING btree (clarification_id, created_at);


--
-- Name: idx_cleared_vendors_round; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleared_vendors_round ON public.tbl_rfq_product_tech_evaluation_cleared_vendors USING btree (evaluation_round);


--
-- Name: idx_cleared_vendors_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleared_vendors_verified ON public.tbl_rfq_product_tech_evaluation_cleared_vendors USING btree (is_verified);


--
-- Name: idx_hospitality_companies_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_companies_company_id ON public.tbl_hospitality_companies USING btree (buyer_company_id) WHERE (is_deleted = 0);


--
-- Name: idx_hospitality_company_documents_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_company_documents_company_id ON public.tbl_hospitality_company_documents USING btree (hospitality_company_id);


--
-- Name: idx_hospitality_company_documents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_company_documents_type ON public.tbl_hospitality_company_documents USING btree (document_type);


--
-- Name: idx_hospitality_hotel_documents_hotel_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_hotel_documents_hotel_id ON public.tbl_hospitality_hotel_documents USING btree (hospitality_hotel_id);


--
-- Name: idx_hospitality_hotel_documents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_hotel_documents_type ON public.tbl_hospitality_hotel_documents USING btree (document_type);


--
-- Name: idx_hospitality_hotels_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_hotels_company_id ON public.tbl_hospitality_company_hotels USING btree (hospitality_company_id) WHERE (is_deleted = 0);


--
-- Name: idx_hospitality_project_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_project_company ON public.tbl_hospitality_project_mappings USING btree (hospitality_company_id, hospitality_hotel_id, mapping_type);


--
-- Name: idx_hospitality_user_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_user_company ON public.tbl_hospitality_user_mappings USING btree (hospitality_company_id, hospitality_hotel_id, mapping_type);


--
-- Name: idx_hospitality_user_mappings_user_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hospitality_user_mappings_user_company ON public.tbl_hospitality_user_mappings USING btree (user_id, hospitality_company_id);


--
-- Name: idx_instance_change_log_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_change_log_instance ON public.tbl_approval_instance_change_log USING btree (approval_instance_id);


--
-- Name: idx_instance_change_log_policy_change; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_change_log_policy_change ON public.tbl_approval_instance_change_log USING btree (policy_change_log_id);


--
-- Name: idx_instance_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_company ON public.tbl_approval_instances USING btree (hospitality_company_id);


--
-- Name: idx_instance_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_entity ON public.tbl_approval_instances USING btree (entity_type, entity_id);


--
-- Name: idx_instance_initiator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_initiator ON public.tbl_approval_instances USING btree (initiated_by);


--
-- Name: idx_instance_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_pending ON public.tbl_approval_instances USING btree (status) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: idx_instance_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_policy ON public.tbl_approval_instances USING btree (approval_policy_id);


--
-- Name: idx_instance_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_status ON public.tbl_approval_instances USING btree (status);


--
-- Name: idx_instance_step_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_step_instance ON public.tbl_approval_instance_steps USING btree (approval_instance_id);


--
-- Name: idx_instance_step_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instance_step_status ON public.tbl_approval_instance_steps USING btree (status);


--
-- Name: idx_lifecycle_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lifecycle_created_at ON public.tbl_lifecycle_history USING btree (created_at DESC);


--
-- Name: idx_lifecycle_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lifecycle_entity ON public.tbl_lifecycle_history USING btree (entity_type, entity_id);


--
-- Name: idx_lifecycle_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lifecycle_stage ON public.tbl_lifecycle_history USING btree (stage);


--
-- Name: idx_neg_round_quotes_arc_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_neg_round_quotes_arc_item ON public.tbl_negotiation_round_quotes USING btree (arc_item_id);


--
-- Name: idx_neg_rounds_arc_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_neg_rounds_arc_item ON public.tbl_negotiation_rounds USING btree (source_id, arc_item_id) WHERE ((source_type)::text = 'ARC'::text);


--
-- Name: idx_negotiation_round_approvals_round_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_round_approvals_round_id ON public.tbl_negotiation_round_approvals USING btree (negotiation_round_id);


--
-- Name: idx_negotiation_round_quotes_round_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_round_quotes_round_id ON public.tbl_negotiation_round_quotes USING btree (negotiation_round_id);


--
-- Name: idx_negotiation_round_quotes_round_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_round_quotes_round_vendor ON public.tbl_negotiation_round_quotes USING btree (negotiation_round_id, vendor_id, rfq_product_id);


--
-- Name: idx_negotiation_rounds_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_rounds_created_at ON public.tbl_negotiation_rounds USING btree (created_at DESC);


--
-- Name: idx_negotiation_rounds_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_rounds_product_id ON public.tbl_negotiation_rounds USING btree (rfq_product_id);


--
-- Name: idx_negotiation_rounds_product_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_rounds_product_status ON public.tbl_negotiation_rounds USING btree (rfq_product_id, status, round_number DESC);


--
-- Name: idx_negotiation_rounds_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_rounds_rfq ON public.tbl_negotiation_rounds USING btree (rfq_id);


--
-- Name: idx_negotiation_rounds_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_rounds_rfq_id ON public.tbl_negotiation_rounds USING btree (rfq_id);


--
-- Name: idx_negotiation_rounds_rfq_product_round; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_negotiation_rounds_rfq_product_round ON public.tbl_negotiation_rounds USING btree (rfq_id, rfq_product_id, round_number) WHERE (rfq_product_id IS NOT NULL);


--
-- Name: idx_negotiation_rounds_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_negotiation_rounds_status ON public.tbl_negotiation_rounds USING btree (status);


--
-- Name: idx_notif_recipient_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_recipient_active ON public.tbl_notifications USING btree (recipient_user_id, created_at DESC) WHERE (dismissed_at IS NULL);


--
-- Name: idx_notif_recipient_undelivered; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_recipient_undelivered ON public.tbl_notifications USING btree (recipient_user_id) WHERE (delivered_at IS NULL);


--
-- Name: idx_notif_recipient_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_recipient_unread ON public.tbl_notifications USING btree (recipient_user_id, is_read);


--
-- Name: idx_one_open_clarification_per_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_one_open_clarification_per_rfq ON public.tbl_rfq_clarifications USING btree (rfq_id) WHERE ((status)::text = 'OPEN'::text);


--
-- Name: idx_po_approval_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_approval_instance ON public.tbl_rfq_purchase_order USING btree (approval_instance_id);


--
-- Name: idx_po_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_rfq ON public.tbl_rfq_purchase_order USING btree (rfq_id);


--
-- Name: idx_policy_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_active ON public.tbl_approval_policies USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_policy_change_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_change_log_created ON public.tbl_approval_policy_change_log USING btree (created_at DESC);


--
-- Name: idx_policy_change_log_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_change_log_policy ON public.tbl_approval_policy_change_log USING btree (approval_policy_id);


--
-- Name: idx_policy_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_company ON public.tbl_approval_policies USING btree (hospitality_company_id);


--
-- Name: idx_policy_entity_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_entity_type ON public.tbl_approval_policies USING btree (entity_type);


--
-- Name: idx_policy_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_hotel ON public.tbl_approval_policies USING btree (hotel_id) WHERE (hotel_id IS NOT NULL);


--
-- Name: idx_product_categories_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_categories_product ON public.tbl_product_categories USING btree (product_id, category_id);


--
-- Name: idx_product_variant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_variant_id ON public.tbl_product_variant USING btree (id) WHERE (is_deleted = 0);


--
-- Name: idx_project_team_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_team_project_id ON public.tbl_project_team USING btree (project_id);


--
-- Name: idx_project_team_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_team_user_id ON public.tbl_project_team USING btree (user_id);


--
-- Name: idx_push_sub_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_sub_user ON public.tbl_push_subscriptions USING btree (user_id);


--
-- Name: idx_pvvm_variant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pvvm_variant_active ON public.tbl_product_variant_vendor_mapping USING btree (product_variant_id, vendor_id) WHERE ((status = true) AND (is_approved = true));


--
-- Name: idx_qf_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qf_rfq_id ON public.tbl_quote_finalization USING btree (rfq_id);


--
-- Name: idx_quote_activity_rfq_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_activity_rfq_user_status ON public.tbl_quote_activity USING btree (rfq_id, created_by, current_status);


--
-- Name: idx_quote_finalization_createdby_rfq_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_finalization_createdby_rfq_timestamp ON public.tbl_quote_finalization USING btree (created_by, rfq_id, "timestamp" DESC) INCLUDE (quote_id);


--
-- Name: idx_quote_finalization_history_rfq_prod_variant_changedat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_finalization_history_rfq_prod_variant_changedat ON public.tbl_quote_finalization_history USING btree (rfq_id, product_variant_id, variant, changed_at DESC) INCLUDE (quote_id, vendor_id, changed_by, "timestamp");


--
-- Name: idx_quote_finalization_history_rfq_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_finalization_history_rfq_product ON public.tbl_quote_finalization_history USING btree (rfq_id, product_variant_id, variant);


--
-- Name: idx_quote_finalization_quote_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_finalization_quote_id ON public.tbl_quote_finalization USING btree (quote_id);


--
-- Name: idx_quote_finalization_quote_prod_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_finalization_quote_prod_variant ON public.tbl_quote_finalization USING btree (quote_id, product_variant_id, variant) INCLUDE (id, vendor_id, created_by, "timestamp");


--
-- Name: idx_quote_finalization_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_finalization_rfq ON public.tbl_quote_finalization USING btree (rfq_id);


--
-- Name: idx_quote_finalization_rfq_product_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_finalization_rfq_product_vendor ON public.tbl_quote_finalization USING btree (rfq_id, product_variant_id, vendor_id, variant);


--
-- Name: idx_quote_item_files_quote_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_item_files_quote_item ON public.tbl_quote_item_files USING btree (quote_item_id) INCLUDE (file_type, file_url);


--
-- Name: idx_quote_item_history_quote_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_item_history_quote_item_id ON public.tbl_quote_item_history USING btree (quote_item_id, "timestamp" DESC);


--
-- Name: idx_quote_item_history_quote_item_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_item_history_quote_item_timestamp ON public.tbl_quote_item_history USING btree (quote_item_id, "timestamp" DESC) INCLUDE (unit_price, package_price, tax, freight_price, total_price, quantity, variant, id);


--
-- Name: idx_quote_items_product_variant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_items_product_variant_id ON public.tbl_quote_items USING btree (product_variant_id);


--
-- Name: idx_quote_items_quote_prod_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_items_quote_prod_variant ON public.tbl_quote_items USING btree (quote_id, product_variant_id, variant) INCLUDE (unit_price, package_price, tax, freight_price, total_price, quantity, product_name, rfq_no, id);


--
-- Name: idx_quote_items_rfq_product_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_items_rfq_product_variant ON public.tbl_quote_items USING btree (rfq_id, product_variant_id, variant);


--
-- Name: idx_quote_items_rfq_product_variant_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quote_items_rfq_product_variant_variant ON public.tbl_quote_items USING btree (rfq_id, product_variant_id, variant) INCLUDE (quote_id, unit_price, total_price, quantity, comment, delivery_period);


--
-- Name: idx_quotes_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotes_created_by ON public.tbl_quotes USING btree (created_by);


--
-- Name: idx_quotes_files_quote_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotes_files_quote_id ON public.tbl_quotes_files USING btree (quote_id) INCLUDE (file_type, file_url);


--
-- Name: idx_quotes_is_regret; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotes_is_regret ON public.tbl_quotes USING btree (is_regret);


--
-- Name: idx_quotes_payment_terms_quote_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotes_payment_terms_quote_id ON public.tbl_quotes_payment_terms USING btree (quote_id) INCLUDE (type, value, days, comment, created_by);


--
-- Name: idx_quotes_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotes_rfq_id ON public.tbl_quotes USING btree (rfq_id);


--
-- Name: idx_quotes_rfq_timestamp_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotes_rfq_timestamp_desc ON public.tbl_quotes USING btree (rfq_id, "timestamp" DESC) INCLUDE (id, created_by, status, is_regret, regret_reason, global_payment_term, global_comment);


--
-- Name: idx_rfp_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfp_rfq_id ON public.tbl_rfq_products USING btree (rfq_id);


--
-- Name: idx_rfp_rfqid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfp_rfqid ON public.tbl_rfq_products USING btree (rfq_id);


--
-- Name: idx_rfps_productvariant_rfq_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfps_productvariant_rfq_variant ON public.tbl_rfq_products_specs USING btree (product_variant_id, variant, rfq_id, variant);


--
-- Name: idx_rfpv_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfpv_rfq_id ON public.tbl_rfq_product_vendors USING btree (rfq_id);


--
-- Name: idx_rfpv_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfpv_user_id ON public.tbl_rfq_product_vendors USING btree (user_id);


--
-- Name: idx_rfq_change_history_field_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_change_history_field_lookup ON public.tbl_rfq_change_history USING btree (rfq_id, entity_type, entity_id, field_name, changed_at DESC);


--
-- Name: idx_rfq_change_history_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_change_history_rfq_id ON public.tbl_rfq_change_history USING btree (rfq_id, changed_at DESC);


--
-- Name: idx_rfq_change_history_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_change_history_session ON public.tbl_rfq_change_history USING btree (edit_session_id);


--
-- Name: idx_rfq_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_created_by ON public.tbl_rfq USING btree (created_by);


--
-- Name: idx_rfq_department_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_department_id ON public.tbl_rfq USING btree (department_id);


--
-- Name: idx_rfq_hospitality_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_hospitality_company_id ON public.tbl_rfq USING btree (hospitality_company_id);


--
-- Name: idx_rfq_hotel_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_hotel_id ON public.tbl_rfq USING btree (hotel_id);


--
-- Name: idx_rfq_hotel_mapping_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_hotel_mapping_created_by ON public.tbl_rfq_hotel_mappings USING btree (created_by);


--
-- Name: idx_rfq_hotel_mapping_hotel_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_hotel_mapping_hotel_id ON public.tbl_rfq_hotel_mappings USING btree (hotel_id);


--
-- Name: idx_rfq_hotel_mapping_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_hotel_mapping_rfq_id ON public.tbl_rfq_hotel_mappings USING btree (rfq_id);


--
-- Name: idx_rfq_is_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_is_published ON public.tbl_rfq USING btree (is_published);


--
-- Name: idx_rfq_is_tender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_is_tender ON public.tbl_rfq USING btree (is_tender);


--
-- Name: idx_rfq_process; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_process ON public.tbl_rfq USING btree (process_id);


--
-- Name: idx_rfq_product_target_price_prod_vendor_createdat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_product_target_price_prod_vendor_createdat ON public.tbl_rfq_product_target_price USING btree (tbl_rfq_product_id, vendor_id, created_at DESC) INCLUDE (target_price);


--
-- Name: idx_rfq_product_tech_evaluation_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_product_tech_evaluation_rfq_id ON public.tbl_rfq_product_tech_evaluation USING btree (rfq_id);


--
-- Name: idx_rfq_product_vendors_user_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_product_vendors_user_rfq ON public.tbl_rfq_product_vendors USING btree (user_id, rfq_id) INCLUDE (id);


--
-- Name: idx_rfq_product_vendors_vendor_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_product_vendors_vendor_name ON public.tbl_rfq_product_vendors USING btree (vendor_name);


--
-- Name: idx_rfq_products_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_products_rfq ON public.tbl_rfq_products USING btree (rfq_id);


--
-- Name: idx_rfq_products_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_products_rfq_id ON public.tbl_rfq_products USING btree (rfq_id);


--
-- Name: idx_rfq_products_rfq_product_variant_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_products_rfq_product_variant_variant ON public.tbl_rfq_products USING btree (rfq_id, product_variant_id, variant) INCLUDE (id, sheet_id);


--
-- Name: idx_rfq_products_specs_prod_variant_variant_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_products_specs_prod_variant_variant_rfq ON public.tbl_rfq_products_specs USING btree (product_variant_id, variant, rfq_id) INCLUDE (title, value);


--
-- Name: idx_rfq_project_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_project_status ON public.tbl_rfq USING btree (project_id, status);


--
-- Name: idx_rfq_rfq_no; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_rfq_no ON public.tbl_rfq USING btree (rfq_no);


--
-- Name: idx_rfq_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_status ON public.tbl_rfq USING btree (status);


--
-- Name: idx_rfq_stuck_publish; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_stuck_publish ON public.tbl_rfq USING btree (tender_publish_date) WHERE ((status = 4) AND (is_published = 0));


--
-- Name: idx_rfq_tech_eval_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_tech_eval_product ON public.tbl_rfq_product_tech_evaluation USING btree (tbl_rfq_product_id);


--
-- Name: idx_rfq_tech_eval_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_tech_eval_rfq ON public.tbl_rfq_product_tech_evaluation USING btree (rfq_id);


--
-- Name: idx_rfq_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_timestamp ON public.tbl_rfq USING btree ("timestamp");


--
-- Name: idx_rfq_timestamp_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rfq_timestamp_id ON public.tbl_rfq USING btree ("timestamp" DESC, id DESC);


--
-- Name: idx_role_permissions_role_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_permissions_role_id ON public.tbl_role_permissions USING btree (role_id);


--
-- Name: idx_round_approvals_round_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_round_approvals_round_id ON public.tbl_negotiation_round_approvals USING btree (negotiation_round_id);


--
-- Name: idx_round_approvals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_round_approvals_status ON public.tbl_negotiation_round_approvals USING btree (status);


--
-- Name: idx_round_approvals_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_round_approvals_user_id ON public.tbl_negotiation_round_approvals USING btree (approver_user_id);


--
-- Name: idx_round_quotes_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_round_quotes_product_id ON public.tbl_negotiation_round_quotes USING btree (rfq_product_id);


--
-- Name: idx_round_quotes_round_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_round_quotes_round_id ON public.tbl_negotiation_round_quotes USING btree (negotiation_round_id);


--
-- Name: idx_round_quotes_round_vendor_product; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_round_quotes_round_vendor_product ON public.tbl_negotiation_round_quotes USING btree (negotiation_round_id, vendor_id, rfq_product_id);


--
-- Name: idx_round_quotes_submitted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_round_quotes_submitted_at ON public.tbl_negotiation_round_quotes USING btree (submitted_at DESC);


--
-- Name: idx_round_quotes_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_round_quotes_vendor_id ON public.tbl_negotiation_round_quotes USING btree (vendor_id);


--
-- Name: idx_rpv_rfqid_variant_userid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rpv_rfqid_variant_userid ON public.tbl_rfq_product_vendors USING btree (rfq_id, product_variant_id, variant, user_id);


--
-- Name: idx_step_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_step_order ON public.tbl_approval_policy_steps USING btree (step_order);


--
-- Name: idx_step_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_step_policy ON public.tbl_approval_policy_steps USING btree (approval_policy_id);


--
-- Name: idx_tbl_arc_amendment_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_amendment_contract ON public.tbl_arc_amendment USING btree (arc_contract_id);


--
-- Name: idx_tbl_arc_amendment_current_step; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_amendment_current_step ON public.tbl_arc_amendment USING btree (current_step) WHERE ((status)::text = 'requested'::text);


--
-- Name: idx_tbl_arc_amendment_document_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_amendment_document_contract ON public.tbl_arc_amendment_document USING btree (arc_contract_id, addendum_number);


--
-- Name: idx_tbl_arc_amendment_edit_history_amendment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_amendment_edit_history_amendment ON public.tbl_arc_amendment_edit_history USING btree (arc_amendment_id, changed_at DESC);


--
-- Name: idx_tbl_arc_amendment_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_amendment_status ON public.tbl_arc_amendment USING btree (status);


--
-- Name: idx_tbl_arc_amendment_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_amendment_window ON public.tbl_arc_amendment USING btree (arc_contract_id, amendment_from, amendment_to);


--
-- Name: idx_tbl_arc_callof_po_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_callof_po_contract ON public.tbl_arc_callof_po USING btree (arc_contract_id);


--
-- Name: idx_tbl_arc_callof_po_mr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_callof_po_mr ON public.tbl_arc_callof_po USING btree (mr_id);


--
-- Name: idx_tbl_arc_callof_po_po_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_callof_po_po_id ON public.tbl_arc_callof_po USING btree (po_id);


--
-- Name: idx_tbl_arc_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_category ON public.tbl_arc USING btree (category_id);


--
-- Name: idx_tbl_arc_comm_award_eval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_comm_award_eval ON public.tbl_arc_comm_evaluation_award USING btree (arc_comm_evaluation_id);


--
-- Name: idx_tbl_arc_comm_award_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_comm_award_item ON public.tbl_arc_comm_evaluation_award USING btree (arc_item_id);


--
-- Name: idx_tbl_arc_comm_award_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_comm_award_vendor ON public.tbl_arc_comm_evaluation_award USING btree (awarded_vendor_id);


--
-- Name: idx_tbl_arc_comm_eval_history_eval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_comm_eval_history_eval ON public.tbl_arc_comm_evaluation_history USING btree (arc_comm_evaluation_id, changed_at DESC);


--
-- Name: idx_tbl_arc_contract_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_contract_arc ON public.tbl_arc_contract USING btree (arc_id);


--
-- Name: idx_tbl_arc_contract_line_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_contract_line_contract ON public.tbl_arc_contract_line USING btree (arc_contract_id);


--
-- Name: idx_tbl_arc_contract_line_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_contract_line_item ON public.tbl_arc_contract_line USING btree (arc_item_id);


--
-- Name: idx_tbl_arc_contract_signature_otp_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_contract_signature_otp_contract ON public.tbl_arc_contract_signature_otp USING btree (arc_contract_id);


--
-- Name: idx_tbl_arc_contract_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_contract_status ON public.tbl_arc_contract USING btree (status);


--
-- Name: idx_tbl_arc_contract_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_contract_vendor ON public.tbl_arc_contract USING btree (vendor_id);


--
-- Name: idx_tbl_arc_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_created_by ON public.tbl_arc USING btree (created_by);


--
-- Name: idx_tbl_arc_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_department ON public.tbl_arc USING btree (department_id);


--
-- Name: idx_tbl_arc_event_log_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_event_log_arc ON public.tbl_arc_event_log USING btree (arc_id);


--
-- Name: idx_tbl_arc_event_log_event_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_event_log_event_at ON public.tbl_arc_event_log USING btree (event_type, at DESC);


--
-- Name: idx_tbl_arc_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_hotel ON public.tbl_arc USING btree (hotel_id);


--
-- Name: idx_tbl_arc_invitation_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_invitation_arc ON public.tbl_arc_invitation USING btree (arc_id);


--
-- Name: idx_tbl_arc_invitation_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_invitation_vendor ON public.tbl_arc_invitation USING btree (vendor_id);


--
-- Name: idx_tbl_arc_item_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_item_arc ON public.tbl_arc_item USING btree (arc_id);


--
-- Name: idx_tbl_arc_item_tech_evaluation_clauses_eval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_item_tech_evaluation_clauses_eval ON public.tbl_arc_item_tech_evaluation_clauses USING btree (arc_item_tech_evaluation_id);


--
-- Name: idx_tbl_arc_item_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_item_variant ON public.tbl_arc_item USING btree (product_variant_id);


--
-- Name: idx_tbl_arc_manual_entry_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_manual_entry_arc ON public.tbl_arc_manual_entry USING btree (arc_id);


--
-- Name: idx_tbl_arc_quote_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_quote_arc ON public.tbl_arc_quote USING btree (arc_id);


--
-- Name: idx_tbl_arc_quote_line_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_quote_line_item ON public.tbl_arc_quote_line USING btree (arc_item_id);


--
-- Name: idx_tbl_arc_quote_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_quote_vendor ON public.tbl_arc_quote USING btree (vendor_id);


--
-- Name: idx_tbl_arc_quote_version_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_quote_version_lookup ON public.tbl_arc_quote_version USING btree (arc_id, vendor_id, version_no);


--
-- Name: idx_tbl_arc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_status ON public.tbl_arc USING btree (status);


--
-- Name: idx_tbl_arc_te_vendor_response_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_te_vendor_response_vendor ON public.tbl_arc_item_tech_evaluation_vendors_response USING btree (vendor_id);


--
-- Name: idx_tbl_arc_tech_eval_edit_history_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_tech_eval_edit_history_arc ON public.tbl_arc_tech_eval_edit_history USING btree (arc_id, changed_at DESC);


--
-- Name: idx_tbl_arc_tech_eval_edit_history_response; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_tech_eval_edit_history_response ON public.tbl_arc_tech_eval_edit_history USING btree (response_id);


--
-- Name: idx_tbl_arc_univ_te_vendor_response_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_univ_te_vendor_response_vendor ON public.tbl_arc_universal_tech_evaluation_vendors_response USING btree (vendor_id);


--
-- Name: idx_tbl_arc_universal_te_clauses_eval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_universal_te_clauses_eval ON public.tbl_arc_universal_tech_evaluation_clauses USING btree (arc_universal_tech_evaluation_id);


--
-- Name: idx_tbl_arc_vendor_alias_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_arc_vendor_alias_arc ON public.tbl_arc_vendor_alias USING btree (arc_id);


--
-- Name: idx_tbl_category_department_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_category_department_category ON public.tbl_category_department USING btree (category_id);


--
-- Name: idx_tbl_category_department_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_category_department_department ON public.tbl_category_department USING btree (department_id);


--
-- Name: idx_tbl_company_is_hospitality; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_company_is_hospitality ON public.tbl_company USING btree (is_hospitality);


--
-- Name: idx_tbl_hotels_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_hotels_active ON public.tbl_hospitality_company_hotels USING btree (id) WHERE (is_deleted = 0);


--
-- Name: idx_tbl_material_requisition_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_material_requisition_department ON public.tbl_material_requisition USING btree (department_id);


--
-- Name: idx_tbl_material_requisition_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_material_requisition_hotel ON public.tbl_material_requisition USING btree (hotel_id);


--
-- Name: idx_tbl_material_requisition_item_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_material_requisition_item_contract ON public.tbl_material_requisition_item USING btree (arc_contract_id);


--
-- Name: idx_tbl_material_requisition_item_contract_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_material_requisition_item_contract_line ON public.tbl_material_requisition_item USING btree (arc_contract_line_id);


--
-- Name: idx_tbl_material_requisition_item_mr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_material_requisition_item_mr ON public.tbl_material_requisition_item USING btree (mr_id);


--
-- Name: idx_tbl_material_requisition_item_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_material_requisition_item_variant ON public.tbl_material_requisition_item USING btree (product_variant_id);


--
-- Name: idx_tbl_material_requisition_raised_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_material_requisition_raised_by ON public.tbl_material_requisition USING btree (raised_by);


--
-- Name: idx_tbl_material_requisition_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_material_requisition_status ON public.tbl_material_requisition USING btree (status);


--
-- Name: idx_tbl_negotiation_rounds_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_negotiation_rounds_source ON public.tbl_negotiation_rounds USING btree (source_type, source_id);


--
-- Name: idx_tbl_product_category_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_product_category_product_id ON public.tbl_product_categories USING btree (product_id);


--
-- Name: idx_tbl_query_messages_unseen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_query_messages_unseen ON public.tbl_query_messages USING btree (receiver_id, rfq_id) WHERE (is_seen = false);


--
-- Name: idx_tbl_quotes_payment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_quotes_payment_id ON public.tbl_quotes USING btree (payment_id);


--
-- Name: idx_tbl_quotes_payment_terms_quote_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_quotes_payment_terms_quote_id ON public.tbl_quotes_payment_terms USING btree (quote_id);


--
-- Name: idx_tbl_rfq_copied_from_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_copied_from_rfq_id ON public.tbl_rfq USING btree (copied_from_rfq_id) WHERE (copied_from_rfq_id IS NOT NULL);


--
-- Name: idx_tbl_rfq_hotel_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_hotel_id ON public.tbl_rfq USING btree (hotel_id);


--
-- Name: idx_tbl_rfq_hotel_mappings_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_hotel_mappings_rfq_id ON public.tbl_rfq_hotel_mappings USING btree (rfq_id);


--
-- Name: idx_tbl_rfq_is_tender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_is_tender ON public.tbl_rfq USING btree (is_tender);


--
-- Name: idx_tbl_rfq_product_files_pid_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_product_files_pid_type ON public.tbl_rfq_product_files USING btree (rfq_product_id, file_type);


--
-- Name: idx_tbl_rfq_product_tech_eval_clauses_eval_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_product_tech_eval_clauses_eval_id ON public.tbl_rfq_product_tech_evaluation_clauses USING btree (tbl_rfq_product_tech_evaluation_id);


--
-- Name: idx_tbl_rfq_product_tech_eval_cleared_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_product_tech_eval_cleared_vendor ON public.tbl_rfq_product_tech_evaluation_cleared_vendors USING btree (vendor_id, status);


--
-- Name: idx_tbl_rfq_product_tech_eval_rfq_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_product_tech_eval_rfq_product ON public.tbl_rfq_product_tech_evaluation USING btree (rfq_id, tbl_rfq_product_id);


--
-- Name: idx_tbl_rfq_products_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_products_rfq_id ON public.tbl_rfq_products USING btree (rfq_id);


--
-- Name: idx_tbl_rfq_products_specs_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_products_specs_lookup ON public.tbl_rfq_products_specs USING btree (rfq_id, product_variant_id, variant);


--
-- Name: idx_tbl_rfq_purchase_order_arc_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_purchase_order_arc_contract ON public.tbl_rfq_purchase_order USING btree (arc_contract_id) WHERE (arc_contract_id IS NOT NULL);


--
-- Name: idx_tbl_rfq_purchase_order_call_off; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_purchase_order_call_off ON public.tbl_rfq_purchase_order USING btree (is_call_off) WHERE (is_call_off = true);


--
-- Name: idx_tbl_rfq_purchase_order_source_mr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tbl_rfq_purchase_order_source_mr ON public.tbl_rfq_purchase_order USING btree (source_mr_id) WHERE (source_mr_id IS NOT NULL);


--
-- Name: idx_team_members_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_email ON public.tbl_team_members USING btree (email);


--
-- Name: idx_team_members_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_name ON public.tbl_team_members USING btree (name);


--
-- Name: idx_tech_eval_clauses_eval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_clauses_eval ON public.tbl_rfq_product_tech_evaluation_clauses USING btree (tbl_rfq_product_tech_evaluation_id);


--
-- Name: idx_tech_eval_cleared_eval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_cleared_eval ON public.tbl_rfq_product_tech_evaluation_cleared_vendors USING btree (tbl_rfq_product_tech_evaluation_id);


--
-- Name: idx_tech_eval_cleared_vendors_eval_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_cleared_vendors_eval_id ON public.tbl_rfq_product_tech_evaluation_cleared_vendors USING btree (tbl_rfq_product_tech_evaluation_id);


--
-- Name: idx_tech_eval_replacements_new_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_replacements_new_vendor ON public.tbl_rfq_product_tech_eval_vendor_replacements USING btree (new_vendor_id);


--
-- Name: idx_tech_eval_replacements_old_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_replacements_old_vendor ON public.tbl_rfq_product_tech_eval_vendor_replacements USING btree (old_vendor_id);


--
-- Name: idx_tech_eval_replacements_rfq_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_replacements_rfq_product ON public.tbl_rfq_product_tech_eval_vendor_replacements USING btree (rfq_id, rfq_product_id);


--
-- Name: idx_tech_eval_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_rfq ON public.tbl_rfq_product_tech_evaluation USING btree (rfq_id);


--
-- Name: idx_tech_eval_rounds_eval_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_rounds_eval_id ON public.tbl_tech_evaluation_rounds USING btree (tbl_rfq_product_tech_evaluation_id);


--
-- Name: idx_tech_eval_rounds_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_rounds_status ON public.tbl_tech_evaluation_rounds USING btree (status);


--
-- Name: idx_tech_eval_vendor_resp_clause; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_eval_vendor_resp_clause ON public.tbl_rfq_product_tech_evaluation_vendors_response USING btree (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id);


--
-- Name: idx_tp_active_flags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tp_active_flags ON public.tbl_product USING btree (id) WHERE ((status = 1) AND (is_deleted = 0) AND (is_review = 0) AND (is_approve = 1));


--
-- Name: idx_tp_name_fts_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tp_name_fts_active ON public.tbl_product USING gin (to_tsvector('english'::regconfig, (name)::text)) WHERE ((status = 1) AND (is_deleted = 0) AND (is_review = 0) AND (is_approve = 1));


--
-- Name: idx_tp_name_trgm_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tp_name_trgm_active ON public.tbl_product USING gin (name public.gin_trgm_ops) WHERE ((status = 1) AND (is_deleted = 0) AND (is_review = 0) AND (is_approve = 1));


--
-- Name: idx_tpc_category_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tpc_category_product ON public.tbl_product_categories USING btree (category_id, product_id);


--
-- Name: idx_tpc_product_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tpc_product_category ON public.tbl_product_categories USING btree (product_id, category_id);


--
-- Name: idx_tpi_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tpi_product ON public.tbl_product_images USING btree (product_id);


--
-- Name: idx_tpv_name_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tpv_name_fts ON public.tbl_product_variant USING gin (to_tsvector('english'::regconfig, (name)::text)) WHERE (is_approve = 1);


--
-- Name: idx_tpv_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tpv_name_trgm ON public.tbl_product_variant USING gin (name public.gin_trgm_ops) WHERE (is_approve = 1);


--
-- Name: idx_tpv_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tpv_slug ON public.tbl_product_variant USING btree (slug) WHERE (is_approve = 1);


--
-- Name: idx_unique_approver_per_step; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_unique_approver_per_step ON public.tbl_approval_step_approvers USING btree (approval_instance_step_id, approver_user_id);


--
-- Name: idx_unique_instance_step_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_unique_instance_step_order ON public.tbl_approval_instance_steps USING btree (approval_instance_id, step_order);


--
-- Name: idx_unique_step_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_unique_step_order ON public.tbl_approval_policy_steps USING btree (approval_policy_id, step_order);


--
-- Name: idx_urs_process; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_urs_process ON public.tbl_user_role_scopes USING btree (process_id);


--
-- Name: idx_urs_user_covering; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_urs_user_covering ON public.tbl_user_role_scopes USING btree (user_id) INCLUDE (id, role_id, company_id, hotel_id, department_id, process_id);


--
-- Name: idx_user_department_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_department_user_id ON public.tbl_user_department USING btree (user_id, id DESC);


--
-- Name: idx_user_role_scopes_user_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_role_scopes_user_company ON public.tbl_user_role_scopes USING btree (user_id, company_id);


--
-- Name: idx_user_role_scopes_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_role_scopes_user_id ON public.tbl_user_role_scopes USING btree (user_id);


--
-- Name: idx_users_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_company_id ON public.tbl_users USING btree (company_id);


--
-- Name: idx_users_company_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_company_type ON public.tbl_users USING btree (company_id, user_type);


--
-- Name: idx_users_company_user_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_company_user_type_id ON public.tbl_users USING btree (company_id, user_type, id) INCLUDE (organization_name, name, email, mobile);


--
-- Name: idx_vendor_clause_combo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_clause_combo ON public.tbl_rfq_product_tech_evaluation_vendors_response USING btree (vendor_id, tbl_rfq_product_tech_evaluation_clauses_id);


--
-- Name: idx_vendor_documents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_documents_type ON public.tbl_vendor_documents USING btree (document_type);


--
-- Name: idx_vendor_documents_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_documents_vendor_id ON public.tbl_vendor_documents USING btree (vendor_id);


--
-- Name: idx_vendor_hotel_category_sub_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_hotel_category_sub_item ON public.tbl_vendor_hotel_category_subscription USING btree (item_type, item_id);


--
-- Name: idx_vendor_hotel_category_sub_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_hotel_category_sub_vendor ON public.tbl_vendor_hotel_category_subscription USING btree (vendor_id);


--
-- Name: idx_vendor_payments_payment_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_payment_type ON public.tbl_vendor_payments USING btree (payment_type);


--
-- Name: idx_vendor_payments_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_rfq ON public.tbl_vendor_payments USING btree (rfq_id);


--
-- Name: idx_vendor_payments_vendor_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_vendor_rfq ON public.tbl_vendor_payments USING btree (vendor_id, rfq_id);


--
-- Name: idx_vendor_response_buyer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_response_buyer_id ON public.tbl_rfq_product_tech_evaluation_vendors_response USING btree (buyer_id);


--
-- Name: idx_vendor_response_buyer_marks; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_response_buyer_marks ON public.tbl_rfq_product_tech_evaluation_vendors_response USING btree (buyer_marks);


--
-- Name: idx_vendor_response_clause_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_response_clause_id ON public.tbl_rfq_product_tech_evaluation_vendors_response USING btree (tbl_rfq_product_tech_evaluation_clauses_id);


--
-- Name: idx_vendor_response_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_response_vendor_id ON public.tbl_rfq_product_tech_evaluation_vendors_response USING btree (vendor_id);


--
-- Name: idx_vendor_sub_active_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_sub_active_dates ON public.tbl_vendor_hotel_category_subscription USING btree (start_date, end_date) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_vendor_sub_category_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_sub_category_active ON public.tbl_vendor_hotel_category_subscription USING btree (item_id, vendor_id) WHERE (((item_type)::text = 'category'::text) AND ((status)::text = 'active'::text));


--
-- Name: idx_vendor_sub_hotel_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_sub_hotel_active ON public.tbl_vendor_hotel_category_subscription USING btree (item_id, vendor_id) WHERE (((item_type)::text = 'hotel'::text) AND ((status)::text = 'active'::text));


--
-- Name: idx_vhcs_vendor_item_active_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vhcs_vendor_item_active_dates ON public.tbl_vendor_hotel_category_subscription USING btree (vendor_id, item_type, item_id, start_date, end_date) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_vhcs_vendor_status_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vhcs_vendor_status_end ON public.tbl_vendor_hotel_category_subscription USING btree (vendor_id, status, end_date);


--
-- Name: idx_vum_product_vendor_approve; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vum_product_vendor_approve ON public.tbl_vendorapprove_product_mapping USING btree (product_id, vendor_approve_id);


--
-- Name: tbl_units_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tbl_units_created_by_idx ON public.tbl_units USING btree (created_by);


--
-- Name: tbl_units_name_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tbl_units_name_scope_idx ON public.tbl_units USING btree (lower((name)::text), COALESCE(created_by, 0));


--
-- Name: uq_approval_policy_scope_process; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_approval_policy_scope_process ON public.tbl_approval_policies USING btree (entity_type, hospitality_company_id, COALESCE(hotel_id, 0), COALESCE(department_id, 0), COALESCE(process_id, 0)) WHERE (is_active = true);


--
-- Name: uq_neg_round_quote_arc_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_neg_round_quote_arc_item ON public.tbl_negotiation_round_quotes USING btree (negotiation_round_id, vendor_id, arc_item_id) WHERE (arc_item_id IS NOT NULL);


--
-- Name: uq_tbl_arc_amendment_document_amendment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tbl_arc_amendment_document_amendment ON public.tbl_arc_amendment_document USING btree (arc_amendment_id);


--
-- Name: uq_user_role_scope_tuple; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_role_scope_tuple ON public.tbl_user_role_scopes USING btree (user_id, role_id, company_id, COALESCE(hotel_id, 0), COALESCE(department_id, 0), COALESCE(process_id, 0));


--
-- Name: uq_vendor_hotel_category_sub_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_vendor_hotel_category_sub_active ON public.tbl_vendor_hotel_category_subscription USING btree (vendor_id, item_type, item_id, end_date) WHERE ((status)::text = 'active'::text);


--
-- Name: vw_approval_policies_summary _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.vw_approval_policies_summary AS
 SELECT p.id,
    p.entity_type,
    p.hospitality_company_id,
    p.hotel_id,
    p.department_id,
    p.is_active,
    p.created_by,
    p.created_at,
    p.updated_at,
    hc.name AS company_name,
    hh.name AS hotel_name,
    d.title AS department_name,
    u.name AS created_by_name,
    count(DISTINCT ps.id) AS step_count,
        CASE
            WHEN (p.department_id IS NOT NULL) THEN 'Company + Hotel + Department'::text
            WHEN (p.hotel_id IS NOT NULL) THEN 'Company + Hotel'::text
            ELSE 'Company Only'::text
        END AS scope_level
   FROM (((((public.tbl_approval_policies p
     LEFT JOIN public.tbl_hospitality_companies hc ON ((p.hospitality_company_id = hc.id)))
     LEFT JOIN public.tbl_hospitality_company_hotels hh ON ((p.hotel_id = hh.id)))
     LEFT JOIN public.tbl_department d ON ((p.department_id = d.id)))
     LEFT JOIN public.tbl_users u ON ((p.created_by = u.id)))
     LEFT JOIN public.tbl_approval_policy_steps ps ON ((ps.approval_policy_id = p.id)))
  GROUP BY p.id, hc.name, hh.name, d.title, u.name;


--
-- Name: tbl_coupon tbl_coupon_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_coupon_update BEFORE UPDATE ON public.tbl_coupon FOR EACH ROW EXECUTE FUNCTION public.update_at_timestamp();


--
-- Name: tbl_faq tbl_faq_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_faq_update BEFORE UPDATE ON public.tbl_faq FOR EACH ROW EXECUTE FUNCTION public.update_at_timestamp();


--
-- Name: tbl_offer tbl_offer_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_offer_update BEFORE UPDATE ON public.tbl_offer FOR EACH ROW EXECUTE FUNCTION public.update_at_timestamp();


--
-- Name: tbl_quote_finalization tbl_quote_finalization_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_quote_finalization_audit AFTER DELETE OR UPDATE ON public.tbl_quote_finalization FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_quote_item_files tbl_quote_item_files_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_quote_item_files_audit AFTER DELETE OR UPDATE ON public.tbl_quote_item_files FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_quote_item_history tbl_quote_item_history_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_quote_item_history_audit AFTER DELETE OR UPDATE ON public.tbl_quote_item_history FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_quote_items tbl_quote_items_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_quote_items_audit AFTER DELETE OR UPDATE ON public.tbl_quote_items FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_quote_items tbl_quote_items_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_quote_items_updated_at_trigger BEFORE UPDATE ON public.tbl_quote_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_column();


--
-- Name: tbl_quotes tbl_quotes_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_quotes_audit AFTER DELETE OR UPDATE ON public.tbl_quotes FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_quotes_files tbl_quotes_files_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_quotes_files_audit AFTER DELETE OR UPDATE ON public.tbl_quotes_files FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq tbl_rfq_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_audit AFTER DELETE OR UPDATE ON public.tbl_rfq FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_files tbl_rfq_files_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_files_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_files FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_files tbl_rfq_product_files_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_files_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_files FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_files tbl_rfq_product_files_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_files_updated_at_trigger BEFORE UPDATE ON public.tbl_rfq_product_files FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_column();


--
-- Name: tbl_rfq_product_target_price tbl_rfq_product_target_price_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_target_price_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_target_price FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_tech_evaluation tbl_rfq_product_tech_evaluation_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_tech_evaluation_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_tech_evaluation FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_tech_evaluation_clauses tbl_rfq_product_tech_evaluation_clauses_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_tech_evaluation_clauses_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_tech_evaluation_clauses FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_files tbl_rfq_product_tech_evaluation_clauses_files_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_tech_evaluation_clauses_files_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_tech_evaluation_clauses_files FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors tbl_rfq_product_tech_evaluation_cleared_vendors_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_tech_evaluation_cleared_vendors_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_tech_evaluation_cleared_vendors FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_tech_evaluation_comments tbl_rfq_product_tech_evaluation_comments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_tech_evaluation_comments_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_tech_evaluation_comments FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_tech_evaluation_comments_files tbl_rfq_product_tech_evaluation_comments_files_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_tech_evaluation_comments_files_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_tech_evaluation_comments_files FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response tbl_rfq_product_tech_evaluation_vendors_response_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_tech_evaluation_vendors_response_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_tech_evaluation_vendors_response FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_files tbl_rfq_product_tech_evaluation_vendors_response_files_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_tech_evaluation_vendors_response_files_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_tech_evaluation_vendors_response_files FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_vendors tbl_rfq_product_vendors_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_vendors_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_product_vendors FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_product_vendors tbl_rfq_product_vendors_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_product_vendors_updated_at_trigger BEFORE UPDATE ON public.tbl_rfq_product_vendors FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_column();


--
-- Name: tbl_rfq_products tbl_rfq_products_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_products_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_products FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_products_specs tbl_rfq_products_specs_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_products_specs_audit AFTER DELETE OR UPDATE ON public.tbl_rfq_products_specs FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();


--
-- Name: tbl_rfq_products_specs tbl_rfq_products_specs_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_products_specs_updated_at_trigger BEFORE UPDATE ON public.tbl_rfq_products_specs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_column();


--
-- Name: tbl_rfq_products tbl_rfq_products_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_rfq_products_updated_at_trigger BEFORE UPDATE ON public.tbl_rfq_products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_column();


--
-- Name: tbl_subscription_feature_plan_mapping tbl_subscription_feature_plan_mapping_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_subscription_feature_plan_mapping_update BEFORE UPDATE ON public.tbl_subscription_feature_plan_mapping FOR EACH ROW EXECUTE FUNCTION public.update_at_timestamp();


--
-- Name: tbl_subscription_plans_offer_mapping tbl_subscription_plans_offer_mapping_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_subscription_plans_offer_mapping_update BEFORE UPDATE ON public.tbl_subscription_plans_offer_mapping FOR EACH ROW EXECUTE FUNCTION public.update_at_timestamp();


--
-- Name: tbl_subscription_plans tbl_subscription_plans_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_subscription_plans_update BEFORE UPDATE ON public.tbl_subscription_plans FOR EACH ROW EXECUTE FUNCTION public.update_at_timestamp();


--
-- Name: tbl_user_subscription_feature tbl_user_subscription_feature_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_user_subscription_feature_update BEFORE UPDATE ON public.tbl_user_subscription_feature FOR EACH ROW EXECUTE FUNCTION public.update_at_timestamp();


--
-- Name: tbl_user_subscriptions tbl_user_subscriptions_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tbl_user_subscriptions_update BEFORE UPDATE ON public.tbl_user_subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_at_timestamp();


--
-- Name: tbl_negotiation_rounds trg_tbl_negotiation_rounds_fill_source; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tbl_negotiation_rounds_fill_source BEFORE INSERT ON public.tbl_negotiation_rounds FOR EACH ROW EXECUTE FUNCTION public.tbl_negotiation_rounds_fill_source();


--
-- Name: tbl_approval_policies trigger_approval_policies_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_approval_policies_updated_at BEFORE UPDATE ON public.tbl_approval_policies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tbl_approval_actions fk_action_instance; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_actions
    ADD CONSTRAINT fk_action_instance FOREIGN KEY (approval_instance_id) REFERENCES public.tbl_approval_instances(id) ON DELETE CASCADE;


--
-- Name: tbl_approval_actions fk_action_step; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_actions
    ADD CONSTRAINT fk_action_step FOREIGN KEY (approval_instance_step_id) REFERENCES public.tbl_approval_instance_steps(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_actions fk_action_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_actions
    ADD CONSTRAINT fk_action_user FOREIGN KEY (approver_user_id) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_step_approvers fk_approver_step; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_step_approvers
    ADD CONSTRAINT fk_approver_step FOREIGN KEY (approval_instance_step_id) REFERENCES public.tbl_approval_instance_steps(id) ON DELETE CASCADE;


--
-- Name: tbl_approval_step_approvers fk_approver_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_step_approvers
    ADD CONSTRAINT fk_approver_user FOREIGN KEY (approver_user_id) REFERENCES public.tbl_users(id) ON DELETE CASCADE;


--
-- Name: tbl_buyer_private_vendors_mapping fk_buyer_private_vendors_mapping_company_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_buyer_private_vendors_mapping
    ADD CONSTRAINT fk_buyer_private_vendors_mapping_company_id FOREIGN KEY (company_id) REFERENCES public.tbl_company(id);


--
-- Name: tbl_users fk_company_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_users
    ADD CONSTRAINT fk_company_id FOREIGN KEY (company_id) REFERENCES public.tbl_company(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_instances fk_instance_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instances
    ADD CONSTRAINT fk_instance_company FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id) ON DELETE CASCADE;


--
-- Name: tbl_approval_instances fk_instance_department; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instances
    ADD CONSTRAINT fk_instance_department FOREIGN KEY (department_id) REFERENCES public.tbl_department(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_instances fk_instance_hotel; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instances
    ADD CONSTRAINT fk_instance_hotel FOREIGN KEY (hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_instances fk_instance_initiator; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instances
    ADD CONSTRAINT fk_instance_initiator FOREIGN KEY (initiated_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_instances fk_instance_policy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instances
    ADD CONSTRAINT fk_instance_policy FOREIGN KEY (approval_policy_id) REFERENCES public.tbl_approval_policies(id) ON DELETE RESTRICT;


--
-- Name: tbl_approval_instance_steps fk_instance_step_instance; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instance_steps
    ADD CONSTRAINT fk_instance_step_instance FOREIGN KEY (approval_instance_id) REFERENCES public.tbl_approval_instances(id) ON DELETE CASCADE;


--
-- Name: tbl_approval_instance_steps fk_instance_step_policy_step; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instance_steps
    ADD CONSTRAINT fk_instance_step_policy_step FOREIGN KEY (policy_step_id) REFERENCES public.tbl_approval_policy_steps(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_policies fk_policy_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policies
    ADD CONSTRAINT fk_policy_company FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id) ON DELETE CASCADE;


--
-- Name: tbl_approval_policies fk_policy_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policies
    ADD CONSTRAINT fk_policy_created_by FOREIGN KEY (created_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_policies fk_policy_department; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policies
    ADD CONSTRAINT fk_policy_department FOREIGN KEY (department_id) REFERENCES public.tbl_department(id) ON DELETE SET NULL;


--
-- Name: tbl_approval_policies fk_policy_hotel; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policies
    ADD CONSTRAINT fk_policy_hotel FOREIGN KEY (hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE SET NULL;


--
-- Name: tbl_product_tech_spec fk_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_tech_spec
    ADD CONSTRAINT fk_product FOREIGN KEY (product_id) REFERENCES public.tbl_product(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: tbl_project_team fk_project; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_project_team
    ADD CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES public.tbl_projects(id) ON DELETE CASCADE;


--
-- Name: tbl_quote_item_files fk_quote_item; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_item_files
    ADD CONSTRAINT fk_quote_item FOREIGN KEY (quote_item_id) REFERENCES public.tbl_quote_items(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_activity fk_rfq_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_activity
    ADD CONSTRAINT fk_rfq_id FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id);


--
-- Name: tbl_rfq_product_files fk_rfq_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_files
    ADD CONSTRAINT fk_rfq_product FOREIGN KEY (rfq_product_id) REFERENCES public.tbl_rfq_products(id) ON DELETE CASCADE;


--
-- Name: tbl_approval_policy_steps fk_step_policy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policy_steps
    ADD CONSTRAINT fk_step_policy FOREIGN KEY (approval_policy_id) REFERENCES public.tbl_approval_policies(id) ON DELETE CASCADE;


--
-- Name: tbl_quotes_files fk_tbl_quotes; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quotes_files
    ADD CONSTRAINT fk_tbl_quotes FOREIGN KEY (quote_id) REFERENCES public.tbl_quotes(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_files fk_tbl_rfq; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_files
    ADD CONSTRAINT fk_tbl_rfq FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id) ON DELETE CASCADE;


--
-- Name: tbl_project_team fk_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_project_team
    ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.tbl_users(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_activity fk_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_activity
    ADD CONSTRAINT fk_user_id FOREIGN KEY (user_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_admin_rfq_service tbl_admin_rfq_service_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_admin_rfq_service
    ADD CONSTRAINT tbl_admin_rfq_service_rfq_id_fkey FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id);


--
-- Name: tbl_admin_rfq_service tbl_admin_rfq_service_subadmin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_admin_rfq_service
    ADD CONSTRAINT tbl_admin_rfq_service_subadmin_id_fkey FOREIGN KEY (subadmin_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_approval_instance_change_log tbl_approval_instance_change_log_policy_change_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instance_change_log
    ADD CONSTRAINT tbl_approval_instance_change_log_policy_change_log_id_fkey FOREIGN KEY (policy_change_log_id) REFERENCES public.tbl_approval_policy_change_log(id);


--
-- Name: tbl_approval_instances tbl_approval_instances_process_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_instances
    ADD CONSTRAINT tbl_approval_instances_process_id_fkey FOREIGN KEY (process_id) REFERENCES public.tbl_approval_processes(id);


--
-- Name: tbl_approval_policies tbl_approval_policies_process_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_policies
    ADD CONSTRAINT tbl_approval_policies_process_id_fkey FOREIGN KEY (process_id) REFERENCES public.tbl_approval_processes(id) ON DELETE CASCADE;


--
-- Name: tbl_approval_processes tbl_approval_processes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_processes
    ADD CONSTRAINT tbl_approval_processes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.tbl_company(id);


--
-- Name: tbl_approval_processes tbl_approval_processes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_approval_processes
    ADD CONSTRAINT tbl_approval_processes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_arc_amendment tbl_arc_amendment_arc_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment
    ADD CONSTRAINT tbl_arc_amendment_arc_contract_id_fkey FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_amendment tbl_arc_amendment_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment
    ADD CONSTRAINT tbl_arc_amendment_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_amendment_document tbl_arc_amendment_document_arc_amendment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_document
    ADD CONSTRAINT tbl_arc_amendment_document_arc_amendment_id_fkey FOREIGN KEY (arc_amendment_id) REFERENCES public.tbl_arc_amendment(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_amendment_document tbl_arc_amendment_document_arc_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_document
    ADD CONSTRAINT tbl_arc_amendment_document_arc_contract_id_fkey FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_amendment_document tbl_arc_amendment_document_signed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_document
    ADD CONSTRAINT tbl_arc_amendment_document_signed_by_fkey FOREIGN KEY (signed_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_arc_amendment_edit_history tbl_arc_amendment_edit_history_arc_amendment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_edit_history
    ADD CONSTRAINT tbl_arc_amendment_edit_history_arc_amendment_id_fkey FOREIGN KEY (arc_amendment_id) REFERENCES public.tbl_arc_amendment(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_amendment_edit_history tbl_arc_amendment_edit_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment_edit_history
    ADD CONSTRAINT tbl_arc_amendment_edit_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_amendment tbl_arc_amendment_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_amendment
    ADD CONSTRAINT tbl_arc_amendment_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_callof_po tbl_arc_callof_po_arc_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_callof_po
    ADD CONSTRAINT tbl_arc_callof_po_arc_contract_id_fkey FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_callof_po tbl_arc_callof_po_arc_contract_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_callof_po
    ADD CONSTRAINT tbl_arc_callof_po_arc_contract_line_id_fkey FOREIGN KEY (arc_contract_line_id) REFERENCES public.tbl_arc_contract_line(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_callof_po tbl_arc_callof_po_mr_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_callof_po
    ADD CONSTRAINT tbl_arc_callof_po_mr_id_fkey FOREIGN KEY (mr_id) REFERENCES public.tbl_material_requisition(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc tbl_arc_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc
    ADD CONSTRAINT tbl_arc_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.tbl_category(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_comm_evaluation tbl_arc_comm_evaluation_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation
    ADD CONSTRAINT tbl_arc_comm_evaluation_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_comm_evaluation_award tbl_arc_comm_evaluation_award_arc_comm_evaluation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_award
    ADD CONSTRAINT tbl_arc_comm_evaluation_award_arc_comm_evaluation_id_fkey FOREIGN KEY (arc_comm_evaluation_id) REFERENCES public.tbl_arc_comm_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_comm_evaluation_award tbl_arc_comm_evaluation_award_arc_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_award
    ADD CONSTRAINT tbl_arc_comm_evaluation_award_arc_item_id_fkey FOREIGN KEY (arc_item_id) REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_comm_evaluation_award tbl_arc_comm_evaluation_award_awarded_quote_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_award
    ADD CONSTRAINT tbl_arc_comm_evaluation_award_awarded_quote_line_id_fkey FOREIGN KEY (awarded_quote_line_id) REFERENCES public.tbl_arc_quote_line(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_comm_evaluation_award tbl_arc_comm_evaluation_award_awarded_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_award
    ADD CONSTRAINT tbl_arc_comm_evaluation_award_awarded_vendor_id_fkey FOREIGN KEY (awarded_vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_comm_evaluation tbl_arc_comm_evaluation_finalized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation
    ADD CONSTRAINT tbl_arc_comm_evaluation_finalized_by_fkey FOREIGN KEY (finalized_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_comm_evaluation_history tbl_arc_comm_evaluation_history_arc_comm_evaluation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_history
    ADD CONSTRAINT tbl_arc_comm_evaluation_history_arc_comm_evaluation_id_fkey FOREIGN KEY (arc_comm_evaluation_id) REFERENCES public.tbl_arc_comm_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_comm_evaluation_history tbl_arc_comm_evaluation_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_comm_evaluation_history
    ADD CONSTRAINT tbl_arc_comm_evaluation_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_contract tbl_arc_contract_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract
    ADD CONSTRAINT tbl_arc_contract_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_contract_clarification tbl_arc_contract_clarification_arc_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_clarification
    ADD CONSTRAINT tbl_arc_contract_clarification_arc_contract_id_fkey FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_contract_clarification tbl_arc_contract_clarification_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_clarification
    ADD CONSTRAINT tbl_arc_contract_clarification_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_contract_clarification tbl_arc_contract_clarification_arc_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_clarification
    ADD CONSTRAINT tbl_arc_contract_clarification_arc_item_id_fkey FOREIGN KEY (arc_item_id) REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_contract_clarification tbl_arc_contract_clarification_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_clarification
    ADD CONSTRAINT tbl_arc_contract_clarification_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_contract_clarification tbl_arc_contract_clarification_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_clarification
    ADD CONSTRAINT tbl_arc_contract_clarification_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_contract_clarification tbl_arc_contract_clarification_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_clarification
    ADD CONSTRAINT tbl_arc_contract_clarification_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_contract_line tbl_arc_contract_line_arc_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_line
    ADD CONSTRAINT tbl_arc_contract_line_arc_contract_id_fkey FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_contract_line tbl_arc_contract_line_arc_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_line
    ADD CONSTRAINT tbl_arc_contract_line_arc_item_id_fkey FOREIGN KEY (arc_item_id) REFERENCES public.tbl_arc_item(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_contract_signature_otp tbl_arc_contract_signature_otp_arc_amendment_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_signature_otp
    ADD CONSTRAINT tbl_arc_contract_signature_otp_arc_amendment_document_id_fkey FOREIGN KEY (arc_amendment_document_id) REFERENCES public.tbl_arc_amendment_document(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_contract_signature_otp tbl_arc_contract_signature_otp_arc_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_signature_otp
    ADD CONSTRAINT tbl_arc_contract_signature_otp_arc_contract_id_fkey FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_contract_signature_otp tbl_arc_contract_signature_otp_vendor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract_signature_otp
    ADD CONSTRAINT tbl_arc_contract_signature_otp_vendor_user_id_fkey FOREIGN KEY (vendor_user_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_contract tbl_arc_contract_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_contract
    ADD CONSTRAINT tbl_arc_contract_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc tbl_arc_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc
    ADD CONSTRAINT tbl_arc_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc tbl_arc_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc
    ADD CONSTRAINT tbl_arc_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.tbl_department(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_event_log tbl_arc_event_log_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_event_log
    ADD CONSTRAINT tbl_arc_event_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_event_log tbl_arc_event_log_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_event_log
    ADD CONSTRAINT tbl_arc_event_log_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc tbl_arc_hospitality_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc
    ADD CONSTRAINT tbl_arc_hospitality_company_id_fkey FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc tbl_arc_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc
    ADD CONSTRAINT tbl_arc_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_invitation tbl_arc_invitation_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_invitation
    ADD CONSTRAINT tbl_arc_invitation_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_invitation tbl_arc_invitation_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_invitation
    ADD CONSTRAINT tbl_arc_invitation_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_item tbl_arc_item_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item
    ADD CONSTRAINT tbl_arc_item_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_item_history_snapshot tbl_arc_item_history_snapshot_arc_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_history_snapshot
    ADD CONSTRAINT tbl_arc_item_history_snapshot_arc_item_id_fkey FOREIGN KEY (arc_item_id) REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_item_history_snapshot tbl_arc_item_history_snapshot_last_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_history_snapshot
    ADD CONSTRAINT tbl_arc_item_history_snapshot_last_vendor_id_fkey FOREIGN KEY (last_vendor_id) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_item tbl_arc_item_product_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item
    ADD CONSTRAINT tbl_arc_item_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES public.tbl_product_variant(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_item_tech_evaluation_clauses_files tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_cla_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_clauses_files
    ADD CONSTRAINT tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_cla_fkey FOREIGN KEY (arc_item_tech_evaluation_clauses_id) REFERENCES public.tbl_arc_item_tech_evaluation_clauses(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_id_fkey1 FOREIGN KEY (arc_item_tech_evaluation_id) REFERENCES public.tbl_arc_item_tech_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response_files tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_ven_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response_files
    ADD CONSTRAINT tbl_arc_item_tech_evaluation__arc_item_tech_evaluation_ven_fkey FOREIGN KEY (arc_item_tech_evaluation_vendors_response_id) REFERENCES public.tbl_arc_item_tech_evaluation_vendors_response(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_item_tech_evaluation tbl_arc_item_tech_evaluation_arc_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_arc_item_id_fkey FOREIGN KEY (arc_item_id) REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response tbl_arc_item_tech_evaluation_arc_item_tech_evaluation_cla_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_arc_item_tech_evaluation_cla_fkey1 FOREIGN KEY (arc_item_tech_evaluation_clauses_id) REFERENCES public.tbl_arc_item_tech_evaluation_clauses(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_item_tech_evaluation_clauses tbl_arc_item_tech_evaluation_c_arc_item_tech_evaluation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_clauses
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_c_arc_item_tech_evaluation_id_fkey FOREIGN KEY (arc_item_tech_evaluation_id) REFERENCES public.tbl_arc_item_tech_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors tbl_arc_item_tech_evaluation_cleared_vendors_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_cleared_vendors_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_item_tech_evaluation_cleared_vendors tbl_arc_item_tech_evaluation_cleared_vendors_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_cleared_vendors_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response tbl_arc_item_tech_evaluation_vendors_response_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_vendors_response_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_item_tech_evaluation_vendors_response tbl_arc_item_tech_evaluation_vendors_response_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_item_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_item_tech_evaluation_vendors_response_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_manual_entry tbl_arc_manual_entry_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_manual_entry
    ADD CONSTRAINT tbl_arc_manual_entry_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_manual_entry tbl_arc_manual_entry_committee_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_manual_entry
    ADD CONSTRAINT tbl_arc_manual_entry_committee_decided_by_fkey FOREIGN KEY (committee_decided_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_arc_manual_entry tbl_arc_manual_entry_entered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_manual_entry
    ADD CONSTRAINT tbl_arc_manual_entry_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_arc tbl_arc_process_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc
    ADD CONSTRAINT tbl_arc_process_id_fkey FOREIGN KEY (process_id) REFERENCES public.tbl_approval_processes(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_quote tbl_arc_quote_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote
    ADD CONSTRAINT tbl_arc_quote_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_quote_line tbl_arc_quote_line_arc_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line
    ADD CONSTRAINT tbl_arc_quote_line_arc_item_id_fkey FOREIGN KEY (arc_item_id) REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_quote_line tbl_arc_quote_line_arc_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line
    ADD CONSTRAINT tbl_arc_quote_line_arc_quote_id_fkey FOREIGN KEY (arc_quote_id) REFERENCES public.tbl_arc_quote(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_quote_line_history tbl_arc_quote_line_history_arc_quote_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line_history
    ADD CONSTRAINT tbl_arc_quote_line_history_arc_quote_line_id_fkey FOREIGN KEY (arc_quote_line_id) REFERENCES public.tbl_arc_quote_line(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_quote_line_history tbl_arc_quote_line_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line_history
    ADD CONSTRAINT tbl_arc_quote_line_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_quote_line tbl_arc_quote_line_negotiated_round_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote_line
    ADD CONSTRAINT tbl_arc_quote_line_negotiated_round_id_fkey FOREIGN KEY (negotiated_round_id) REFERENCES public.tbl_negotiation_rounds(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_quote tbl_arc_quote_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_quote
    ADD CONSTRAINT tbl_arc_quote_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_tech_eval_edit_history tbl_arc_tech_eval_edit_history_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_eval_edit_history
    ADD CONSTRAINT tbl_arc_tech_eval_edit_history_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_tech_eval_edit_history tbl_arc_tech_eval_edit_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_eval_edit_history
    ADD CONSTRAINT tbl_arc_tech_eval_edit_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_tech_eval_edit_history tbl_arc_tech_eval_edit_history_response_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_eval_edit_history
    ADD CONSTRAINT tbl_arc_tech_eval_edit_history_response_id_fkey FOREIGN KEY (response_id) REFERENCES public.tbl_arc_item_tech_evaluation_vendors_response(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_tech_evaluation_rounds tbl_arc_tech_evaluation_rounds_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_evaluation_rounds
    ADD CONSTRAINT tbl_arc_tech_evaluation_rounds_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_tech_evaluation_rounds tbl_arc_tech_evaluation_rounds_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_evaluation_rounds
    ADD CONSTRAINT tbl_arc_tech_evaluation_rounds_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_tech_shortlist tbl_arc_tech_shortlist_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_shortlist
    ADD CONSTRAINT tbl_arc_tech_shortlist_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_tech_shortlist tbl_arc_tech_shortlist_promoted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_shortlist
    ADD CONSTRAINT tbl_arc_tech_shortlist_promoted_by_fkey FOREIGN KEY (promoted_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_tech_shortlist tbl_arc_tech_shortlist_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_tech_shortlist
    ADD CONSTRAINT tbl_arc_tech_shortlist_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_universal_tech_evaluation_clauses_files tbl_arc_universal_tech_evalu_arc_universal_tech_evaluatio_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_clauses_files
    ADD CONSTRAINT tbl_arc_universal_tech_evalu_arc_universal_tech_evaluatio_fkey1 FOREIGN KEY (arc_universal_tech_evaluation_clauses_id) REFERENCES public.tbl_arc_universal_tech_evaluation_clauses(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response tbl_arc_universal_tech_evalu_arc_universal_tech_evaluatio_fkey2; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_universal_tech_evalu_arc_universal_tech_evaluatio_fkey2 FOREIGN KEY (arc_universal_tech_evaluation_clauses_id) REFERENCES public.tbl_arc_universal_tech_evaluation_clauses(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response_files tbl_arc_universal_tech_evalu_arc_universal_tech_evaluatio_fkey3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response_files
    ADD CONSTRAINT tbl_arc_universal_tech_evalu_arc_universal_tech_evaluatio_fkey3 FOREIGN KEY (arc_universal_tech_evaluation_vendors_response_id) REFERENCES public.tbl_arc_universal_tech_evaluation_vendors_response(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors tbl_arc_universal_tech_evalu_arc_universal_tech_evaluatio_fkey4; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_universal_tech_evalu_arc_universal_tech_evaluatio_fkey4 FOREIGN KEY (arc_universal_tech_evaluation_id) REFERENCES public.tbl_arc_universal_tech_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_universal_tech_evaluation_clauses tbl_arc_universal_tech_evalua_arc_universal_tech_evaluatio_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_clauses
    ADD CONSTRAINT tbl_arc_universal_tech_evalua_arc_universal_tech_evaluatio_fkey FOREIGN KEY (arc_universal_tech_evaluation_id) REFERENCES public.tbl_arc_universal_tech_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_universal_tech_evaluation tbl_arc_universal_tech_evaluation_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors tbl_arc_universal_tech_evaluation_cleared_vendo_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_cleared_vendo_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_universal_tech_evaluation_cleared_vendors tbl_arc_universal_tech_evaluation_cleared_vendor_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_cleared_vendor_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response tbl_arc_universal_tech_evaluation_vendors_respon_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_vendors_respon_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_arc_universal_tech_evaluation_vendors_response tbl_arc_universal_tech_evaluation_vendors_respons_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_universal_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_arc_universal_tech_evaluation_vendors_respons_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.tbl_users(id) ON DELETE SET NULL;


--
-- Name: tbl_arc_vendor_alias tbl_arc_vendor_alias_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_vendor_alias
    ADD CONSTRAINT tbl_arc_vendor_alias_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.tbl_arc(id) ON DELETE CASCADE;


--
-- Name: tbl_arc_vendor_alias tbl_arc_vendor_alias_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_arc_vendor_alias
    ADD CONSTRAINT tbl_arc_vendor_alias_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_category_department tbl_category_department_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_category_department
    ADD CONSTRAINT tbl_category_department_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.tbl_category(id) ON DELETE CASCADE;


--
-- Name: tbl_category_department tbl_category_department_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_category_department
    ADD CONSTRAINT tbl_category_department_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.tbl_department(id) ON DELETE CASCADE;


--
-- Name: tbl_charge_names tbl_charge_names_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_charge_names
    ADD CONSTRAINT tbl_charge_names_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_company_buyer_account_limit tbl_company_buyer_account_limit_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_company_buyer_account_limit
    ADD CONSTRAINT tbl_company_buyer_account_limit_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.tbl_company(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_companies tbl_hospitality_companies_buyer_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_companies
    ADD CONSTRAINT tbl_hospitality_companies_buyer_company_id_fkey FOREIGN KEY (buyer_company_id) REFERENCES public.tbl_company(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_companies tbl_hospitality_companies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_companies
    ADD CONSTRAINT tbl_hospitality_companies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_hospitality_companies tbl_hospitality_companies_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_companies
    ADD CONSTRAINT tbl_hospitality_companies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_hospitality_company_documents tbl_hospitality_company_documents_hospitality_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_documents
    ADD CONSTRAINT tbl_hospitality_company_documents_hospitality_company_id_fkey FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_company_hotels tbl_hospitality_company_hotels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_hotels
    ADD CONSTRAINT tbl_hospitality_company_hotels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_hospitality_company_hotels tbl_hospitality_company_hotels_hospitality_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_hotels
    ADD CONSTRAINT tbl_hospitality_company_hotels_hospitality_company_id_fkey FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_company_hotels tbl_hospitality_company_hotels_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_company_hotels
    ADD CONSTRAINT tbl_hospitality_company_hotels_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_hospitality_hotel_documents tbl_hospitality_hotel_documents_hospitality_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_hotel_documents
    ADD CONSTRAINT tbl_hospitality_hotel_documents_hospitality_hotel_id_fkey FOREIGN KEY (hospitality_hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_project_mappings tbl_hospitality_project_mappings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_project_mappings
    ADD CONSTRAINT tbl_hospitality_project_mappings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_hospitality_project_mappings tbl_hospitality_project_mappings_hospitality_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_project_mappings
    ADD CONSTRAINT tbl_hospitality_project_mappings_hospitality_company_id_fkey FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_project_mappings tbl_hospitality_project_mappings_hospitality_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_project_mappings
    ADD CONSTRAINT tbl_hospitality_project_mappings_hospitality_hotel_id_fkey FOREIGN KEY (hospitality_hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_project_mappings tbl_hospitality_project_mappings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_project_mappings
    ADD CONSTRAINT tbl_hospitality_project_mappings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.tbl_projects(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_user_mappings tbl_hospitality_user_mappings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_user_mappings
    ADD CONSTRAINT tbl_hospitality_user_mappings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_hospitality_user_mappings tbl_hospitality_user_mappings_hospitality_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_user_mappings
    ADD CONSTRAINT tbl_hospitality_user_mappings_hospitality_company_id_fkey FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_user_mappings tbl_hospitality_user_mappings_hospitality_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_user_mappings
    ADD CONSTRAINT tbl_hospitality_user_mappings_hospitality_hotel_id_fkey FOREIGN KEY (hospitality_hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE CASCADE;


--
-- Name: tbl_hospitality_user_mappings tbl_hospitality_user_mappings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_hospitality_user_mappings
    ADD CONSTRAINT tbl_hospitality_user_mappings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.tbl_users(id) ON DELETE CASCADE;


--
-- Name: tbl_lifecycle_history tbl_lifecycle_history_performed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_lifecycle_history
    ADD CONSTRAINT tbl_lifecycle_history_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_material_requisition tbl_material_requisition_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition
    ADD CONSTRAINT tbl_material_requisition_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.tbl_department(id) ON DELETE RESTRICT;


--
-- Name: tbl_material_requisition tbl_material_requisition_hospitality_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition
    ADD CONSTRAINT tbl_material_requisition_hospitality_company_id_fkey FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id) ON DELETE RESTRICT;


--
-- Name: tbl_material_requisition tbl_material_requisition_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition
    ADD CONSTRAINT tbl_material_requisition_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT;


--
-- Name: tbl_material_requisition_item tbl_material_requisition_item_arc_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition_item
    ADD CONSTRAINT tbl_material_requisition_item_arc_contract_id_fkey FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE RESTRICT;


--
-- Name: tbl_material_requisition_item tbl_material_requisition_item_arc_contract_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition_item
    ADD CONSTRAINT tbl_material_requisition_item_arc_contract_line_id_fkey FOREIGN KEY (arc_contract_line_id) REFERENCES public.tbl_arc_contract_line(id) ON DELETE RESTRICT;


--
-- Name: tbl_material_requisition_item tbl_material_requisition_item_mr_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition_item
    ADD CONSTRAINT tbl_material_requisition_item_mr_id_fkey FOREIGN KEY (mr_id) REFERENCES public.tbl_material_requisition(id) ON DELETE CASCADE;


--
-- Name: tbl_material_requisition_item tbl_material_requisition_item_product_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition_item
    ADD CONSTRAINT tbl_material_requisition_item_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES public.tbl_product_variant(id) ON DELETE RESTRICT;


--
-- Name: tbl_material_requisition tbl_material_requisition_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_material_requisition
    ADD CONSTRAINT tbl_material_requisition_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.tbl_users(id) ON DELETE RESTRICT;


--
-- Name: tbl_negotiation_round_approvals tbl_negotiation_round_approvals_approver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_approvals
    ADD CONSTRAINT tbl_negotiation_round_approvals_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_negotiation_round_approvals tbl_negotiation_round_approvals_negotiation_round_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_approvals
    ADD CONSTRAINT tbl_negotiation_round_approvals_negotiation_round_id_fkey FOREIGN KEY (negotiation_round_id) REFERENCES public.tbl_negotiation_rounds(id) ON DELETE CASCADE;


--
-- Name: tbl_negotiation_round_quotes tbl_negotiation_round_quotes_arc_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_quotes
    ADD CONSTRAINT tbl_negotiation_round_quotes_arc_item_id_fkey FOREIGN KEY (arc_item_id) REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE;


--
-- Name: tbl_negotiation_round_quotes tbl_negotiation_round_quotes_negotiation_round_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_quotes
    ADD CONSTRAINT tbl_negotiation_round_quotes_negotiation_round_id_fkey FOREIGN KEY (negotiation_round_id) REFERENCES public.tbl_negotiation_rounds(id) ON DELETE CASCADE;


--
-- Name: tbl_negotiation_round_quotes tbl_negotiation_round_quotes_rfq_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_quotes
    ADD CONSTRAINT tbl_negotiation_round_quotes_rfq_product_id_fkey FOREIGN KEY (rfq_product_id) REFERENCES public.tbl_rfq_products(id);


--
-- Name: tbl_negotiation_round_quotes tbl_negotiation_round_quotes_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_round_quotes
    ADD CONSTRAINT tbl_negotiation_round_quotes_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_negotiation_rounds tbl_negotiation_rounds_arc_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_rounds
    ADD CONSTRAINT tbl_negotiation_rounds_arc_item_id_fkey FOREIGN KEY (arc_item_id) REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE;


--
-- Name: tbl_negotiation_rounds tbl_negotiation_rounds_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_rounds
    ADD CONSTRAINT tbl_negotiation_rounds_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_negotiation_rounds tbl_negotiation_rounds_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_rounds
    ADD CONSTRAINT tbl_negotiation_rounds_rfq_id_fkey FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id) ON DELETE CASCADE;


--
-- Name: tbl_negotiation_rounds tbl_negotiation_rounds_rfq_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_negotiation_rounds
    ADD CONSTRAINT tbl_negotiation_rounds_rfq_product_id_fkey FOREIGN KEY (rfq_product_id) REFERENCES public.tbl_rfq_products(id) ON DELETE CASCADE;


--
-- Name: tbl_product_cms tbl_product_cms_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_cms
    ADD CONSTRAINT tbl_product_cms_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.tbl_product(id) ON DELETE CASCADE;


--
-- Name: tbl_product_variant_spec tbl_product_variant_spec_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant_spec
    ADD CONSTRAINT tbl_product_variant_spec_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.tbl_product_variant(id) ON DELETE CASCADE;


--
-- Name: tbl_product_variant_vendor_make tbl_product_variant_vendor_make_variant_vendor_map_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_product_variant_vendor_make
    ADD CONSTRAINT tbl_product_variant_vendor_make_variant_vendor_map_id_fkey FOREIGN KEY (variant_vendor_map_id) REFERENCES public.tbl_product_variant_vendor_mapping(id) ON DELETE CASCADE;


--
-- Name: tbl_project_files tbl_project_files_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_project_files
    ADD CONSTRAINT tbl_project_files_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.tbl_projects(id) ON DELETE CASCADE;


--
-- Name: tbl_projects tbl_projects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_projects
    ADD CONSTRAINT tbl_projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_push_subscriptions tbl_push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_push_subscriptions
    ADD CONSTRAINT tbl_push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.tbl_users(id) ON DELETE CASCADE;


--
-- Name: tbl_query_message_files tbl_query_message_files_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_message_files
    ADD CONSTRAINT tbl_query_message_files_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.tbl_query_messages(id) ON DELETE CASCADE;


--
-- Name: tbl_query_message_reads tbl_query_message_reads_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_message_reads
    ADD CONSTRAINT tbl_query_message_reads_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.tbl_query_messages(id) ON DELETE CASCADE;


--
-- Name: tbl_query_message_reads tbl_query_message_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_message_reads
    ADD CONSTRAINT tbl_query_message_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.tbl_users(id) ON DELETE CASCADE;


--
-- Name: tbl_query_messages tbl_query_messages_receiver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_messages
    ADD CONSTRAINT tbl_query_messages_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_query_messages tbl_query_messages_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_messages
    ADD CONSTRAINT tbl_query_messages_rfq_id_fkey FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id) ON DELETE CASCADE;


--
-- Name: tbl_query_messages tbl_query_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_query_messages
    ADD CONSTRAINT tbl_query_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_quote_item_history tbl_quote_item_history_quote_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quote_item_history
    ADD CONSTRAINT tbl_quote_item_history_quote_item_id_fkey FOREIGN KEY (quote_item_id) REFERENCES public.tbl_quote_items(id);


--
-- Name: tbl_quotes tbl_quotes_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quotes
    ADD CONSTRAINT tbl_quotes_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.tbl_vendor_payments(id) ON DELETE SET NULL;


--
-- Name: tbl_quotes_payment_terms tbl_quotes_payment_terms_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_quotes_payment_terms
    ADD CONSTRAINT tbl_quotes_payment_terms_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES public.tbl_quotes(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_change_history tbl_rfq_change_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_change_history
    ADD CONSTRAINT tbl_rfq_change_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_rfq_change_history tbl_rfq_change_history_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_change_history
    ADD CONSTRAINT tbl_rfq_change_history_rfq_id_fkey FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_clarification_files tbl_rfq_clarification_files_clarification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_files
    ADD CONSTRAINT tbl_rfq_clarification_files_clarification_id_fkey FOREIGN KEY (clarification_id) REFERENCES public.tbl_rfq_clarifications(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_clarification_message_files tbl_rfq_clarification_message_files_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_message_files
    ADD CONSTRAINT tbl_rfq_clarification_message_files_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.tbl_rfq_clarification_messages(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_clarification_messages tbl_rfq_clarification_messages_clarification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_messages
    ADD CONSTRAINT tbl_rfq_clarification_messages_clarification_id_fkey FOREIGN KEY (clarification_id) REFERENCES public.tbl_rfq_clarifications(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_clarification_messages tbl_rfq_clarification_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarification_messages
    ADD CONSTRAINT tbl_rfq_clarification_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_rfq_clarifications tbl_rfq_clarifications_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarifications
    ADD CONSTRAINT tbl_rfq_clarifications_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_rfq_clarifications tbl_rfq_clarifications_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarifications
    ADD CONSTRAINT tbl_rfq_clarifications_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_rfq_clarifications tbl_rfq_clarifications_responded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarifications
    ADD CONSTRAINT tbl_rfq_clarifications_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_rfq_clarifications tbl_rfq_clarifications_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_clarifications
    ADD CONSTRAINT tbl_rfq_clarifications_rfq_id_fkey FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id);


--
-- Name: tbl_rfq tbl_rfq_copied_from_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq
    ADD CONSTRAINT tbl_rfq_copied_from_rfq_id_fkey FOREIGN KEY (copied_from_rfq_id) REFERENCES public.tbl_rfq(id) ON DELETE SET NULL;


--
-- Name: tbl_rfq tbl_rfq_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq
    ADD CONSTRAINT tbl_rfq_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.tbl_department(id);


--
-- Name: tbl_rfq tbl_rfq_hospitality_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq
    ADD CONSTRAINT tbl_rfq_hospitality_company_id_fkey FOREIGN KEY (hospitality_company_id) REFERENCES public.tbl_hospitality_companies(id);


--
-- Name: tbl_rfq tbl_rfq_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq
    ADD CONSTRAINT tbl_rfq_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id);


--
-- Name: tbl_rfq_hotel_mappings tbl_rfq_hotel_mappings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_hotel_mappings
    ADD CONSTRAINT tbl_rfq_hotel_mappings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_rfq_hotel_mappings tbl_rfq_hotel_mappings_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_hotel_mappings
    ADD CONSTRAINT tbl_rfq_hotel_mappings_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_hotel_mappings tbl_rfq_hotel_mappings_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_hotel_mappings
    ADD CONSTRAINT tbl_rfq_hotel_mappings_rfq_id_fkey FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq tbl_rfq_process_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq
    ADD CONSTRAINT tbl_rfq_process_id_fkey FOREIGN KEY (process_id) REFERENCES public.tbl_approval_processes(id);


--
-- Name: tbl_rfq_product_tech_evaluation_clauses_files tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_clauses_files
    ADD CONSTRAINT tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey1 FOREIGN KEY (tbl_rfq_product_tech_evaluation_clauses_id) REFERENCES public.tbl_rfq_product_tech_evaluation_clauses(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey2; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey2 FOREIGN KEY (tbl_rfq_product_tech_evaluation_clauses_id) REFERENCES public.tbl_rfq_product_tech_evaluation_clauses(id);


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey3 FOREIGN KEY (tbl_rfq_product_tech_evaluation_id) REFERENCES public.tbl_rfq_product_tech_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_product_tech_evaluation_comments tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey4; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_comments
    ADD CONSTRAINT tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey4 FOREIGN KEY (tbl_rfq_product_tech_evaluation_clauses_id) REFERENCES public.tbl_rfq_product_tech_evaluation_clauses(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_product_tech_evaluation_comments_files tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey5; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_comments_files
    ADD CONSTRAINT tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey5 FOREIGN KEY (tbl_rfq_product_tech_evaluation_comments_id) REFERENCES public.tbl_rfq_product_tech_evaluation_comments(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response_files tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_vendors_response_files
    ADD CONSTRAINT tbl_rfq_product_tech_evaluat_tbl_rfq_product_tech_evaluat_fkey6 FOREIGN KEY (tbl_rfq_product_tech_evaluation_vendors_response_id) REFERENCES public.tbl_rfq_product_tech_evaluation_vendors_response(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_product_tech_evaluation_clauses tbl_rfq_product_tech_evaluati_tbl_rfq_product_tech_evaluat_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_clauses
    ADD CONSTRAINT tbl_rfq_product_tech_evaluati_tbl_rfq_product_tech_evaluat_fkey FOREIGN KEY (tbl_rfq_product_tech_evaluation_id) REFERENCES public.tbl_rfq_product_tech_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors tbl_rfq_product_tech_evaluation_clea_replaced_by_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_clea_replaced_by_vendor_id_fkey FOREIGN KEY (replaced_by_vendor_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_rfq_product_tech_evaluation_cleared_vendors tbl_rfq_product_tech_evaluation_clear_approval_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_cleared_vendors
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_clear_approval_instance_id_fkey FOREIGN KEY (approval_instance_id) REFERENCES public.tbl_approval_instances(id);


--
-- Name: tbl_rfq_product_tech_evaluation_vendors_response tbl_rfq_product_tech_evaluation_vendors_response_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_product_tech_evaluation_vendors_response
    ADD CONSTRAINT tbl_rfq_product_tech_evaluation_vendors_response_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_rfq_purchase_order tbl_rfq_purchase_order_approval_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_purchase_order
    ADD CONSTRAINT tbl_rfq_purchase_order_approval_instance_id_fkey FOREIGN KEY (approval_instance_id) REFERENCES public.tbl_approval_instances(id);


--
-- Name: tbl_rfq_purchase_order tbl_rfq_purchase_order_arc_contract_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_purchase_order
    ADD CONSTRAINT tbl_rfq_purchase_order_arc_contract_fkey FOREIGN KEY (arc_contract_id) REFERENCES public.tbl_arc_contract(id) ON DELETE RESTRICT;


--
-- Name: tbl_rfq_purchase_order tbl_rfq_purchase_order_source_mr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq_purchase_order
    ADD CONSTRAINT tbl_rfq_purchase_order_source_mr_fkey FOREIGN KEY (source_mr_id) REFERENCES public.tbl_material_requisition(id) ON DELETE RESTRICT;


--
-- Name: tbl_rfq tbl_rfq_technical_evaluation_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_rfq
    ADD CONSTRAINT tbl_rfq_technical_evaluation_by_fkey FOREIGN KEY (technical_evaluation_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_tech_evaluation_rounds tbl_tech_evaluation_rounds_approval_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_tech_evaluation_rounds
    ADD CONSTRAINT tbl_tech_evaluation_rounds_approval_instance_id_fkey FOREIGN KEY (approval_instance_id) REFERENCES public.tbl_approval_instances(id);


--
-- Name: tbl_tech_evaluation_rounds tbl_tech_evaluation_rounds_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_tech_evaluation_rounds
    ADD CONSTRAINT tbl_tech_evaluation_rounds_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_tech_evaluation_rounds tbl_tech_evaluation_rounds_tbl_rfq_product_tech_evaluation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_tech_evaluation_rounds
    ADD CONSTRAINT tbl_tech_evaluation_rounds_tbl_rfq_product_tech_evaluation_fkey FOREIGN KEY (tbl_rfq_product_tech_evaluation_id) REFERENCES public.tbl_rfq_product_tech_evaluation(id) ON DELETE CASCADE;


--
-- Name: tbl_user_role_scopes tbl_user_role_scopes_process_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_user_role_scopes
    ADD CONSTRAINT tbl_user_role_scopes_process_id_fkey FOREIGN KEY (process_id) REFERENCES public.tbl_approval_processes(id) ON DELETE SET NULL;


--
-- Name: tbl_users_spoc tbl_users_spoc_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_users_spoc
    ADD CONSTRAINT tbl_users_spoc_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_vendor_documents tbl_vendor_documents_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_documents
    ADD CONSTRAINT tbl_vendor_documents_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE CASCADE;


--
-- Name: tbl_vendor_hotel_category_subscription tbl_vendor_hotel_category_subscription_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_hotel_category_subscription
    ADD CONSTRAINT tbl_vendor_hotel_category_subscription_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.tbl_users(id);


--
-- Name: tbl_vendor_hotel_category_subscription tbl_vendor_hotel_category_subscription_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_hotel_category_subscription
    ADD CONSTRAINT tbl_vendor_hotel_category_subscription_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.tbl_vendor_payments(id) ON DELETE SET NULL;


--
-- Name: tbl_vendor_hotel_category_subscription tbl_vendor_hotel_category_subscription_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_hotel_category_subscription
    ADD CONSTRAINT tbl_vendor_hotel_category_subscription_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE CASCADE;


--
-- Name: tbl_vendor_payment_terms tbl_vendor_payment_terms_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_payment_terms
    ADD CONSTRAINT tbl_vendor_payment_terms_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id);


--
-- Name: tbl_vendor_payments tbl_vendor_payments_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_payments
    ADD CONSTRAINT tbl_vendor_payments_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES public.tbl_quotes(id) ON DELETE SET NULL;


--
-- Name: tbl_vendor_payments tbl_vendor_payments_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_payments
    ADD CONSTRAINT tbl_vendor_payments_rfq_id_fkey FOREIGN KEY (rfq_id) REFERENCES public.tbl_rfq(id) ON DELETE CASCADE;


--
-- Name: tbl_vendor_payments tbl_vendor_payments_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tbl_vendor_payments
    ADD CONSTRAINT tbl_vendor_payments_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.tbl_users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



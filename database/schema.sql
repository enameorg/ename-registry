--
-- PostgreSQL database dump
--

\restrict enameschemadump

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: enames; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enames (
    id uuid NOT NULL,
    subject_id uuid NOT NULL,
    name_part text NOT NULL,
    number_part bigint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT enames_name_part_charset CHECK ((name_part ~ '^[a-z0-9-]+$'::text)),
    CONSTRAINT enames_name_part_length CHECK (((length(name_part) >= 1) AND (length(name_part) <= 50))),
    CONSTRAINT enames_number_part_range CHECK (((number_part >= 1) AND (number_part <= '999999999999'::bigint))),
    CONSTRAINT enames_total_length CHECK ((((length(name_part) + 1) + length((number_part)::text)) <= 52))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    sequence bigint NOT NULL,
    idempotency_key uuid NOT NULL,
    kind text NOT NULL,
    request jsonb NOT NULL,
    outcome jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT events_kind_allowed CHECK ((kind = ANY (ARRAY['subject.registered'::text, 'subject.ename-added'::text])))
);


--
-- Name: events_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.events ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    name text NOT NULL,
    hash text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subjects (
    id uuid NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT subjects_kind_allowed CHECK ((kind = 'person'::text))
);


--
-- Name: enames enames_name_part_number_part_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enames
    ADD CONSTRAINT enames_name_part_number_part_key UNIQUE (name_part, number_part);


--
-- Name: enames enames_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enames
    ADD CONSTRAINT enames_pkey PRIMARY KEY (id);


--
-- Name: enames enames_subject_id_name_part_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enames
    ADD CONSTRAINT enames_subject_id_name_part_key UNIQUE (subject_id, name_part);


--
-- Name: events events_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (sequence);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: subjects subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);


--
-- Name: enames enames_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enames
    ADD CONSTRAINT enames_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id);


--
-- PostgreSQL database dump complete
--

\unrestrict enameschemadump


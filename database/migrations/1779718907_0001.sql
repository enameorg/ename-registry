-- 1779718907_0001
-- Initial schema: subjects and enames.
--
-- Naming, application-generated ids and timestamps, and the Zod/CHECK validation
-- split follow ename-internals.md. The CHECKs keep only what survives any format
-- change: name_part length and character class, number_part range.

CREATE TABLE subjects (
  id          UUID        PRIMARY KEY,
  kind        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,

  CONSTRAINT subjects_kind_allowed CHECK (kind IN ('person'))
);

CREATE TABLE enames (
  id           UUID        PRIMARY KEY,
  subject_id   UUID        NOT NULL REFERENCES subjects (id),
  name_part    TEXT        NOT NULL,
  number_part  BIGINT      NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,

  CONSTRAINT enames_name_part_length     CHECK (length(name_part) BETWEEN 1 AND 50),
  CONSTRAINT enames_name_part_charset    CHECK (name_part ~ '^[a-z0-9-]+$'),
  CONSTRAINT enames_number_part_range    CHECK (number_part BETWEEN 1 AND 999_999_999_999),
  UNIQUE (name_part, number_part)
);

CREATE INDEX enames_subject_id_idx ON enames (subject_id);

-- 1793349986_add_platforms_keys_and_signatures
-- Accredited platforms, the public keys that sign events, and the signature
-- every event carries. The CHECKs keep only absolute bounds and the broadest
-- character classes; the formats (ISO 3166 jurisdiction, GLEIF code, SPKI key,
-- P1363 signature) are validated by the application.
--
-- The NOT NULL columns added to subjects and events take no default: a
-- database holding rows written before signatures is reset, not migrated.

CREATE TABLE platforms (
  id                          UUID        PRIMARY KEY,
  legal_name                  TEXT        NOT NULL,
  jurisdiction                TEXT        NOT NULL,
  registration_authority_code TEXT        NOT NULL,
  registration_identifier     TEXT        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL,

  CONSTRAINT platforms_legal_name_length                  CHECK (length(legal_name) BETWEEN 1 AND 500),
  CONSTRAINT platforms_jurisdiction_charset               CHECK (jurisdiction ~ '^[A-Z0-9-]{2,6}$'),
  CONSTRAINT platforms_registration_authority_code_length CHECK (length(registration_authority_code) BETWEEN 1 AND 50),
  CONSTRAINT platforms_registration_identifier_length     CHECK (length(registration_identifier) BETWEEN 1 AND 100),
  -- One legal entity holds one platform at a time. Named explicitly: the
  -- automatic name would be truncated at 63 characters.
  CONSTRAINT platforms_registration_key UNIQUE (registration_authority_code, registration_identifier)
);

-- A key with no platform is a registry key.
CREATE TABLE keys (
  id          UUID        PRIMARY KEY,
  platform_id UUID        REFERENCES platforms (id),
  algorithm   TEXT        NOT NULL,
  value       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,

  CONSTRAINT keys_algorithm_allowed CHECK (algorithm IN ('ecdsa-p256-sha256')),
  CONSTRAINT keys_value_charset     CHECK (value ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT keys_value_length      CHECK (length(value) BETWEEN 1 AND 4096)
);

CREATE INDEX keys_platform_id_idx ON keys (platform_id);

ALTER TABLE subjects
  ADD COLUMN home_platform_id UUID NOT NULL REFERENCES platforms (id);

CREATE INDEX subjects_home_platform_id_idx ON subjects (home_platform_id);

-- signature_key_id has no foreign key: the log references no projection,
-- which a rebuild must be able to empty beneath it. The key is the one an
-- earlier event of the log added.
ALTER TABLE events
  ADD COLUMN signature_key_id UUID NOT NULL,
  ADD COLUMN signature_value  TEXT NOT NULL,
  ADD CONSTRAINT events_signature_value_charset CHECK (signature_value ~ '^[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT events_signature_value_length  CHECK (length(signature_value) BETWEEN 1 AND 4096),
  DROP CONSTRAINT events_kind_allowed,
  ADD CONSTRAINT events_kind_allowed CHECK (
    kind IN (
      'registry.anchored',
      'platform.accredited',
      'platform.key-added',
      'subject.registered',
      'subject.ename-added'
    )
  );

-- The anchor, signed by the key it records, is written once: the log holds at
-- most one event of its kind.
CREATE UNIQUE INDEX events_single_anchor_idx ON events (kind) WHERE kind = 'registry.anchored';

-- 1780120000_add_enames_subject_name_part_unique (up)
-- A subject may hold multiple enames, but not two with the same name_part.
-- number_part remains globally allocated per name_part by the existing
-- (name_part, number_part) UNIQUE constraint.

ALTER TABLE enames
  ADD CONSTRAINT enames_subject_id_name_part_key UNIQUE (subject_id, name_part);

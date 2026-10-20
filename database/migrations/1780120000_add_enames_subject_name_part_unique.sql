-- 1780120000_add_enames_subject_name_part_unique
-- A subject may hold multiple enames, but not two with the same name_part.
-- number_part remains globally allocated per name_part by the existing
-- (name_part, number_part) UNIQUE constraint.

ALTER TABLE enames
  ADD UNIQUE (subject_id, name_part);

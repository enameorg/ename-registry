-- 1780120000_add_enames_subject_name_part_unique (down)

ALTER TABLE enames
  DROP CONSTRAINT enames_subject_id_name_part_key;

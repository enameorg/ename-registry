-- 1780200000_drop_redundant_enames_subject_id_idx (down)

CREATE INDEX enames_subject_id_idx ON enames (subject_id);

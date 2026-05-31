-- 1780200000_drop_redundant_enames_subject_id_idx (up)
-- enames_subject_id_name_part_key covers subject_id as its leftmost column,
-- so the plain FK index is redundant.

DROP INDEX enames_subject_id_idx;

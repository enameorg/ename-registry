-- 1792421402_add_enames_total_length_check
-- The full ename, <name_part>#<number_part>, is capped at 52 characters. The
-- cap depends on the digit count of the allocated number_part, so it holds as
-- a CHECK on the row rather than on the input; like the name_part length, it
-- is an absolute bound that survives any format change.

ALTER TABLE enames
  ADD CONSTRAINT enames_total_length
    CHECK (length(name_part) + 1 + length(number_part::text) <= 52);

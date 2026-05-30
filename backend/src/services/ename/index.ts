// Public surface of the `ename` concept
export {
  enforceMaxEnameLength,
  EnameSchema,
  findEnames,
  getEname,
  insertEnameWithNextNumber,
  MAX_ENAME_LENGTH,
  MAX_NAME_PART_LENGTH,
  MAX_NUMBER_PART,
  NAME_PART_REGEX,
  NumberPartFieldSchema,
} from './ename.ts';
export type { Ename } from './ename.ts';

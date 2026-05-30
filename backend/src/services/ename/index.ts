// Public surface of the `ename` concept (see ename-internals.md: the barrel is
// the concept's encapsulation boundary). Intra-folder code imports ./ename.ts
// directly; other folders import through here.
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

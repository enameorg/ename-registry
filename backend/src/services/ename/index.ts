// Public surface of the `ename` concept
export {
  enforceMaxEnameLength,
  EnameSchema,
  findEnames,
  getEnameByNamePartAndNumberPart,
  insertEnameWithNextNumber,
  MAX_ENAME_LENGTH,
  MAX_NUMBER_PART,
  NamePartSchema,
  NumberPartSchema,
} from './ename.ts';
export type { Ename } from './ename.ts';

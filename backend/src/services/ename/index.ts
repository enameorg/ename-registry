// Public surface of the `ename` concept
export {
  EnameInputSchema,
  EnameSchema,
  findEnames,
  getEnameByNamePartAndNumberPart,
  insertEname,
  insertEnameWithNextNumber,
  MAX_NUMBER_PART,
  NamePartSchema,
  NumberPartSchema,
} from './ename.ts';
export type { Ename } from './ename.ts';

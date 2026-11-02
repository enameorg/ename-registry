// Public surface of the Service's `common` folder: the sub-concepts several
// concepts share, with no table and no use case of their own.
export {
  assertPortableValues,
  createSignature,
  isSignatureValid,
  SignatureSchema,
} from './signature.ts';
export type { Signature, SignableDocument } from './signature.ts';

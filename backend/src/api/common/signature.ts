import * as commonService from '../../services/common/index.ts';

// The `signature` object every write body carries beside the request it signs:
// one wire component, shared by every write route, whatever its URL root. The
// schema is the Service's, strict, wrapped in place with its example (cf.
// ename-internals.md); what is signed is in docs/ename-signature.md.
export const SignatureSchema = commonService.SignatureSchema.openapi('Signature', {
  example: {
    keyId: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e2c',
    value: 'conZ143ZmXnjabp53VoZ9ng3_bcW8UbWTrqdBjyt_-dXQhqQVkK7BmOy2gzHz75clmlBDpEn3SDurH5taRqn1w',
  },
});

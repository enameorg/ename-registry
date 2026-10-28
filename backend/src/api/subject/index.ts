// Public surface of the API's `subject` folder, through which api/index.ts
// mounts it: its routes, their handlers, and the wire schemas of the subject
// and ename concepts.
export { SubjectInputSchema, SubjectReferenceSchema, SubjectSchema } from './subject.ts';
export { EnameInputSchema, EnameSchema, NamePartSchema } from './ename.ts';
export { addEnameToSubjectHandler, addEnameToSubjectRoute } from './add-ename-to-subject.ts';
export { registerSubjectHandler, registerSubjectRoute } from './register-subject.ts';

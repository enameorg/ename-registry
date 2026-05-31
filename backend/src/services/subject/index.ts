// Public surface of the `subject` concept
export { findSubjects, getSubject, insertSubject, SubjectSchema } from './subject.ts';
export type { Subject } from './subject.ts';
export { addEnameToSubject } from './add-ename-to-subject.ts';
export type { AddEnameToSubjectInput, AddEnameToSubjectResult } from './add-ename-to-subject.ts';
export { registerSubject } from './register-subject.ts';
export type { RegisterSubjectInput, RegisterSubjectResult } from './register-subject.ts';

// Public surface of the `subject` concept (see ename-internals.md: the barrel
// is the concept's encapsulation boundary). Intra-folder code imports the files
// directly; other folders import through here.
//
// insertSubject is exposed because sibling concepts seed a subject through it
// (enames.subject_id FK) — e.g. the ename primitive tests.
export { findSubjects, getSubject, insertSubject, SubjectSchema } from './subject.ts';
export type { Subject } from './subject.ts';
export { registerSubject } from './register-subject.ts';
export type { RegisterSubjectInput, RegisterSubjectResult } from './register-subject.ts';

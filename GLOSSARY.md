# Ename

Public registry of verified human identifiers, operated by a nonprofit organization and designed to last for centuries. This glossary is the project's vocabulary; the mission, decisions and open questions live in `docs/ename-synthesis.md` and `docs/ename-internals.md`.

## Identity

**Ename**:
The human digital identity registry and the nonprofit organization that maintains it; both senses are used interchangeably when context disambiguates.
_Avoid_: the Ename company, the Ename service

**ename** (lowercase):
An identifier in `<name>#<number>` format (e.g. `john-doe#1`), definitively linked to one person.
_Avoid_: handle, username, nickname, account name

**Verified ename**:
An ename issued for a person whose identity an accredited platform has verified under Ename's rules. The central and only operational case today.

**Unverified ename**:
A purely declarative ename, visually distinguished by a prefix, planned for uses compatible with anonymity. Operational framework not yet defined.
_Avoid_: anonymous ename, pseudonym

**Subject**:
The registry's record of one person holding one or more enames, referenced publicly by a stable `subject_id`. The registry stores nothing about the person beyond what binding and verification require.
_Avoid_: user, account, holder, customer

**Home platform**:
The accredited platform currently serving a given ename, as recorded in the registry.
_Avoid_: provider, host

## Institutions

**Registry**:
The public database maintained by Ename that binds each ename to its subject, public keys, home platform and lifecycle metadata; by extension, the organization maintaining it and its institutional role (the ICANN model).
_Avoid_: directory, database (when the institutional sense is meant)

**Platform**:
A third-party entity accredited by Ename to verify identities, manage keys, host portable user data and serve end users. Several platforms coexist and compete.
_Avoid_: registrar, operator, provider, app

**Accreditation**:
The institutional contract by which Ename authorizes an organization to operate as a platform, with commitments on verification, security, portability and standardization. Platforms' own accreditation of apps is out of the registry's scope.
_Avoid_: certification, licensing, partnership

**Verification**:
Either identity verification (a platform establishing that a person is who they claim, before issuing a verified ename; KYC in common vocabulary) or cryptographic verification (validating a signature against a published key). Context disambiguates; name the sense when it does not.
_Avoid_: authentication

**Review** (of a standard):
The institutional process by which Ename examines a standard proposed by a platform and adopts or rejects it.
_Avoid_: validation, approval

**Governance**:
Ename's internal governance (board, bylaws, rules of procedure) unless specified otherwise.

**College**:
A subset of board members representing one stakeholder category: accredited platforms, civil society, technical experts, founding members.
_Avoid_: chamber, group, constituency

**Appeal mechanism**:
The independent path through which platforms and end users contest registry decisions.
_Avoid_: dispute process, complaint

## Mechanisms

**Cryptographic anchoring**:
The registry function by which every signature, attestation or transfer is verified against keys published by Ename, independently of the platform that transmitted them.
_Avoid_: trust anchor (as a synonym), certification

**Interoperability standards**:
The portable data formats, relation types and shared semantics defined by Ename and implemented by platforms.
_Avoid_: protocols, specifications (unqualified)

**Portable user data**:
Data whose loss would lock a user in: credentials, correspondence, publications, address book, subscriptions and subscribers. Scope of usage-proven standardization; design, brand and ergonomics are excluded.
_Avoid_: user content, profile data

**Usage-proven standardization**:
The Ename-specific obligation for a platform to propose a growing proprietary feature touching portable user data as an Ename standard, within a defined period.
_Avoid_: forced standardization, open-sourcing

**Structural modifications**:
Changes to registry rules affecting ename format, accreditation conditions or user rights; subject to prior public consultation.

**Registry fee**:
The amount a platform owes Ename for each ename registered or renewed, collected from the end user and remitted to Ename.
_Avoid_: subscription, license fee

**Accreditation fee**:
The initial fee a platform owes to obtain accreditation, complemented by an annual membership fee.

## Registry data model

**Event**:
One immutable record of a registry mutation in the append-only log, the single source of truth. Named `<entity>.<verb_past_tense>` (e.g. `subject.registered`).
_Avoid_: transaction, mutation, log entry, record

**Projection**:
A table reconstructible by replaying the event log, serving fast reads (today `subjects` and `enames`).
_Avoid_: read model, cache, view

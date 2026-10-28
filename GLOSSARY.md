# Ename

Public registry of verified human identifiers, operated by a nonprofit organization and designed to last for centuries. This glossary is the project's vocabulary; the mission, decisions and open questions live in `docs/ename-synthesis.md` and `docs/ename-internals.md`. A term listed under _Avoid_ is rejected as a synonym of that entry, not banned from the corpus: it may be used in its own distinct sense.

## Identity

**Ename**:
The human digital identity registry and the nonprofit organization that maintains it; both senses are used interchangeably when context disambiguates.
_Avoid_: the Ename company, the Ename service

**ename** (lowercase):
An identifier in `<name>#<number>` format (e.g. `john-doe#1`), definitively linked to one person.
_Avoid_: handle, username, nickname, account name

**Name part**:
The part of an ename before the `#` (`<name>` in the format): a normalized, transliterated form of the person's name, which several people may share.
_Avoid_: name (alone: also the person's civil name), handle, slug

**Number part**:
The part of an ename after the `#` (`<number>` in the format), distinguishing the people who share a name part: allocated in order from 1 within each name part, never chosen.
_Avoid_: discriminator, suffix, tag

**Verified ename**:
An ename issued for a person whose identity an accredited platform has verified under Ename's rules. The central and only operational case today.

**Unverified ename**:
A purely declarative ename, visually distinguished by a prefix, planned for uses compatible with anonymity. Operational framework not yet defined.
_Avoid_: anonymous ename, pseudonym

**Organization ename**:
An ename for an organization (company, association, public body), on the same principle as a person's. Operational framework not yet defined.
_Avoid_: business account, corporate ename

**Affiliation**:
The link by which a person acts on behalf of an organization, attested by the organization and written by joining both enames with `@` (e.g. `john-doe#1@acme-inc#1`). Syntax not yet fixed.
_Avoid_: membership

**Subject**:
The registry's record of one person holding one or more enames, referenced publicly by a stable `subject_id`. The registry stores nothing about the person beyond what binding and verification require.
_Avoid_: user, account, holder, customer (when the registry's record is meant)

**End user**:
The person a platform serves: they hold one or more enames, sign with their keys, and entrust their portable user data to a platform. Distinct from the Subject, the registry's record of that person. "User" alone is acceptable where the platform context is clear.
_Avoid_: customer, member, account

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

**App**:
A third-party service that relies on a platform to identify end users. Apps are neither accredited by Ename nor known to the registry.
_Avoid_: client (the caller of the registry's API, a platform), relying party

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

**Transfer**:
The change of an ename's home platform from one accredited platform to another, the end user's portable user data moving with it.
_Avoid_: migration (a database schema change), move, port

**Per-app identifier**:
The opaque identifier by which a platform designates an end user to one app: stable for that app and different for each app, so that apps cannot correlate a user across them. It stands in for the ename, which the platform discloses to an app only with the end user's explicit consent.
_Avoid_: subject identifier (a Subject is the registry's record), pseudonym

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

## Keys

**Key rotation**:
The replacement of the key bound to an ename by a new one, signed by the current key.
_Avoid_: key renewal, key update

**Revocation**:
A declaration, signed by the current key, that a key bound to an ename must no longer be trusted.
_Avoid_: cancellation, suspension

**Recovery**:
A change of the key bound to an ename that the current key did not sign, submitted by a platform after the end user proved their right to it, and publicly labeled as such in the event log. Regaining access to the existing key, through a synced or reconstituted copy, leaves the binding unchanged and is not a recovery in this sense.
_Avoid_: key reset, re-registration

## Registry data model

**Event log**:
The append-only, public sequence of every event, the registry's single source of truth: the projections are rebuilt from it, and third parties verify the registry's history against it.
_Avoid_: journal, ledger, blockchain, audit trail

**Event**:
One immutable record of a registry mutation in the event log.
_Avoid_: transaction, mutation, log entry, record

**Event kind**:
The named category of an event (`subject.registered`, `subject.ename-added`), declared once, by the use case that emits it, with the pair of strict schemas that parse its request and outcome, the mapping between the rows the use case writes and the event that records them, and how those rows are written again at a rebuild. Every event has exactly one kind.
_Avoid_: event type

**Request** (of an event):
What the actor submitted for a registry mutation, recorded in its event exactly as submitted: the part of the event the actor's signature covers.
_Avoid_: payload, body (its HTTP carrier)

**Outcome** (of an event):
What the registry allocated in performing a mutation (identifiers, number parts), recorded in the event beside its request: the part the registry's signed commitments cover.
_Avoid_: result (request and outcome together), response (the HTTP answer)

**Idempotency key**:
The client-supplied identifier carried in every write request and stored with the event it produces: the same request sent again gets a replay of the prior result, and the same key with a different request is a conflict.
_Avoid_: request id (the server-generated correlation id), nonce

**Replay**:
The registry's answer to a write request whose idempotency key and request match a stored event: the result of the first write, read back from that event, with nothing executed again. The client sends the request again; the server replays the result, not the write.
_Avoid_: retry (the client's resend; also the counter allocation's retry), duplicate (a conflicting value, answered by 409), cached response

**Projection**:
A table that can be rebuilt from the event log, serving fast reads.
_Avoid_: read model, cache, view

**Rebuild**:
The reconstruction of the projections from the event log: the projections emptied, then the rows each event records written again, in log order.
_Avoid_: replay (the idempotent answer to a write), rehydration

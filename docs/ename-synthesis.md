# Ename — Reference Synthesis

## Preamble

This document is the internal source of truth for the **Ename** project: the human digital identity registry and the organization that maintains it. Its primary reader is the AI assistant, which uses it to produce derivative materials (public documents, technical documents, governance documents, operator-facing communications), check the consistency of new decisions, and preserve vocabulary stability. The text therefore favors terminological stability and explicit density over marketing readability.

This document is about the **Ename registry**. It describes operators as an institutional category accredited by the registry, not as individual projects. The technical format of enames is described in `ename-format-v0.7-fr.md`; the association bylaws in `ename-statuts-v0.2-fr.md`; the registry's internal implementation decisions (stack, hosting, schema) in `ename-internals.md`. This synthesis does not restate those contents, but may refer to them.

Conventions:
- **Concept-based headings**, not numbered headings, so anchors survive reordering.
- **Explicit status markers** on decisions: `[settled]`, `[settled in principle]`, `[strong intuition]`, `[working hypothesis]`, `[open]`.
- **Stable Q-IDs** for open topics (`[Q-XXX]`), referenced from the body.
- **No external-communication wording here**: no user promises, no pitches, no ornate prose. Dense, explicit text.
- **Registry / operator distinction**: this document describes the registry. When an operator-side decision is mentioned, it is as a registry expectation (what the operator must do), not as operator-internal architecture.
- **Ename / registry naming convention**: "Ename" by default means the organization (the non-profit association); "the registry" by default means the public database it maintains. Both terms may be used metonymically for either meaning (the organization is the registry, and vice versa), and are used interchangeably when context disambiguates. On the equivalent institutional role (ICANN model), see glossary entry *Registry*.

---

## Glossary

- **Ename**: human digital identity registry and the non-profit association that maintains it. Maintains verified identifiers (`<name>#<number>`), their associated public keys, the current home operator, and ecosystem standards. Refers equally to the organization and to the registry it maintains.
- **ename** (lowercase): identifier in `<name>#<number>` format (e.g. `john-doe#1`). The central case and only current operational case is a verified natural person. Variants are planned but their operational framework remains to be defined: unverified enames (distinctive prefix, cf. [Q-NONVERIF]), organization enames (cf. [Q-ORG]), secondary/alias enames (cf. [Q-ALIAS]). See also *verified ename*, *unverified ename*.
- **Verified ename**: ename issued for a person whose identity has been verified by an accredited operator under the rules defined by Ename. Central case and only operational case at this stage.
- **Unverified ename**: purely declarative ename, planned for uses compatible with anonymity (gaming, forums, social pseudonymity). Visually distinguished (prefix). Operational framework to define — cf. [Q-NONVERIF].
- **Registry**: context-dependent term. Main sense: public database maintained by Ename, which associates each ename with its public key (including rotation history), current home operator, and lifecycle metadata. Source of truth for cryptographic verification and cross-operator routing. Derived senses: (b) the organization maintaining this database (synonym of "Ename"); (c) the institutional role equivalent to a *registry* in the ICANN/AFNIC/VeriSign model. Context disambiguates; cf. naming convention in the preamble.
- **Operator (digital identity operator)**: third-party entity accredited by Ename, which provides the interface with end users — identity verification, cryptographic key management, hosting of portable user data, associated services. May be commercial, non-profit, or otherwise structured. Several operators coexist. Institutionally inherits the role of *registrar* in the domain-name registry model, renamed to reflect the actual breadth of its responsibilities.
- **Accreditation**: context-dependent term in the ecosystem, to be disambiguated at each use. (a) *Accreditation of operators by Ename*: institutional contract authorizing an organization to operate enames, with commitments (KYC, security, portability, proposal for standardization). (b) *Accreditation of apps by operators*: mechanism specific to each operator, outside the scope of the Ename registry. Unless specified otherwise, "accreditation" in this document refers to (a).
- **Verification**: context-dependent term. (a) *Identity verification*: operation by which an operator establishes that a person is who they claim to be, as a prerequisite to issuing a verified ename. KYC in common vocabulary. Performed by operators under requirements set by the registry. (b) *Cryptographic verification*: technical operation validating a signature or attestation against a public key. Performed by any ecosystem actor against the keys published by the registry. The two meanings are distinct: the first grounds issuance, the second guarantees authenticity in use. Unless specified otherwise, context disambiguates.
- **Validation / review**: "validation" commonly denotes cryptographic verification (validation of a signature). For the institutional process by which Ename reviews a standard proposed by an operator, this document prefers "review" and "adoption", in line with the disambiguation of *verification*.
- **Governance**: term covering (a) Ename's internal governance (board, bylaws, rules of procedure); (b) the governance of a particular process (e.g. triggering usage-proven standardization); (c) the domain of Internet governance (ICANN, IETF, etc.). Unless specified otherwise, means (a).
- **Interoperability standards**: portable data formats, relation types between elements, shared semantics, defined by Ename and implemented by operators. They ensure that data follows the user during migration and that interactions cross operator boundaries.
- **Portable user data**: data whose loss would create user lock-in — credentials, correspondence, publications, address book, subscriptions and subscribers (both directions: whom I subscribe to, and who subscribes to me), and other data whose hosting operators provide under Ename standards. Scope of the usage-proven standardization mechanism. Distinct from aesthetic or experiential elements (design, brand, ergonomics, internal workflows), which remain proprietary.
- **Cryptographic anchoring**: registry function by which all signature, attestation, and transfer verifications are performed against keys published by Ename, independently of the operator that transmitted them. Makes trust independent of transport.
- **Usage-proven standardization**: Ename-specific mechanism. A proprietary operator feature touching portable user data, if it grows in usage, must be proposed as an Ename standard within a defined period, under penalty of contractual sanction. Ename reviews the proposal and adopts it if it enriches the commons.
- **Structural modifications**: modifications to registry rules that affect ename format, operator accreditation conditions, or user rights. Subject to prior public consultation.
- **College**: subset of board members representing a stakeholder category. Four colleges: accredited operators, civil society, technical experts, founding members.
- **Appeal mechanism**: independent path through which operators and end users may contest registry decisions. Modalities set by the rules of procedure.
- **Registry fee**: amount owed to the registry by an operator for each ename registered or renewed, collected by the operator from the end user and remitted to Ename. Main funding source under consideration; exact profile (recurrence, amount) depends on the renewal-periodicity decision (cf. [Q-RENEW]).
- **Accreditation fee**: initial fee owed by an operator to obtain accreditation, complemented by an annual membership fee. Complementary funding source.

---

## Structural Decisions

### Vision and Rationale

The project addresses a fundamental double gap in digital life that no general mechanism has ever filled: the absence of an equivalent to what the physical world has in **civil identity** (a reliable identity to which social, economic, and legal relationships attach) and **signature** (a verifiable link between content and its author). Existing solutions — email addresses, platform handles, raw cryptographic identifiers, state-issued identities — address at best a fragment of the problem. In the age of generative AI, the absence of a general mechanism for authenticating authorship becomes critical: without a way to establish who wrote, photographed, filmed, or signed content, trust in information erodes.

Decisions:
- **Constitutive properties of the Ename identifier**: human (usable in daily life: easy to dictate, memorable), verified (attached to a person whose identity has been established), carrying a cryptographic key (to sign what that person produces), governed as a commons (neither private property nor state instrument). The four properties are inseparable; removing one breaks the model. `[settled]`
- **Project scope**: foundation, not applications. Ename builds the substrate — registry + keys + standards — and leaves accredited operators to build above it (user services, viewers, features). `[settled]`
- **Identifier format**: `<name>#<number>`, defined in `ename-format-v0.7-fr.md`. This document does not restate the syntax rules. `[settled]`
- **Scaling horizon**: universal human identity — billions of users, not millions. Every architecture and governance decision is validated against that horizon. `[settled]`
- **Reference positioning sentence** (for internal terminological consistency, not for public quotation): Ename is the public registry of verified human digital identity, governed as a commons by a non-profit association. `[settled]`

Rejected alternatives: see dedicated section.

### Mission and Boundary

The association pursues a single mission: **maintaining the public registry of enames and operating the infrastructure that makes it a useful commons for the ecosystem**. This mission breaks down into five operational objectives, which form an indivisible whole (each supports the others).

Decisions:
- **Five registry objectives**: (1) maintain the registry of enames, associated public keys, and home operator; (2) define and evolve identity rules (format, syntax, eligibility, attribution, cryptographic mechanisms); (3) define and evolve interoperability standards that operators implement; (4) serve as the ecosystem's trusted cryptographic anchor; (5) accredit and supervise operators. `[settled]`
- **Negative boundary**: Ename **does not manage end users as customers or administrative subjects**. It does not sell enames, process end-user identity verification data or application data, or provide application services. Ordinary contractual relationships are with accredited operators. `[settled]`
- **Key custody**: the registry holds and publishes **public keys**. Private keys remain under the control of their holder, never transmitted to the registry or to operators beyond what recovery mechanisms require (cf. operator responsibilities and [Q-KEYREC]). `[settled]`

### Registry / Operator Model

The project adopts the proven model of domain-name registries — ICANN, AFNIC, VeriSign — and adapts it to digital identity. The Ename registry plays the institutional role equivalent to central registries in that model; operators are the *registrars* of this model, renamed "digital identity operators" to reflect the actual breadth of their responsibilities, which goes beyond simply distributing enames.

Decisions:
- **Strict registry / operator decoupling**, each with a role the other cannot absorb. `[settled]`
- **Registry role**: maintain the registry, define rules and standards, anchor cryptographic trust, accredit operators. No end-user relationship (cf. negative boundary above). `[settled]`
- **Operator role** (expectations formalized by the registry in accreditation): offer ename creation and renewal; verify registrants' identity under registry requirements; support key management (creation, rotation, revocation, recovery); host portable user data under Ename standards; implement inter-operator transfers; propose growing proprietary features for standardization; provide associated services; collect and process personal data in compliance with applicable regulations (GDPR in particular). `[settled]`
- **Competition and diversity**: several operators coexist. Varied legal forms allowed (commercial companies, associations, others). No structural monopoly, no registry-imposed quota. `[settled]`
- **Local adaptation**: identity verification varies across jurisdictions. Local operators may adapt to the regulatory contexts of their jurisdiction; the registry sets common minimum requirements. `[settled in principle]`
- **Five advantages of the model**: (1) registry neutrality (no conflict of interest with users), (2) competition and diversity (user choice of operator), (3) local adaptation, (4) resilience (operator failure does not affect enames themselves, which remain in the registry and may be transferred), (5) real user portability (combination of common registry + standards + contractual accreditation, as opposed to a mere voluntary federation mechanism). `[settled]`
- **Structural reference model**: email + DNS (central name registry + operators hosting associated data). Decades-long precedent, useful when explaining the model to non-technical audiences. `[settled]`

### Usage-Proven Standardization

Original mechanism in the Ename model, with no equivalent in domain-name registries. It addresses a structural risk: that a dominant operator imposes its proprietary formats and makes their adoption a condition for access to its users, hollowing out portability.

Principle: an operator may freely innovate with proprietary features. As long as the feature remains marginal, there is no obligation. Once it grows in usage, the operator contractually commits to proposing it for standardization by Ename within a defined period. Ename reviews the request: accepted if it is meant to enrich the commons, rejected if it serves only a single operator.

Decisions:
- **Mechanism scope**: features touching **portable user data**, i.e. data whose loss would create lock-in. Purely aesthetic or experiential elements (design, brand, ergonomics, internal workflows) remain proprietary without issue. `[settled]`
- **Combined trigger criteria**: internal usage threshold (% of the operator's users) + externalization threshold (>=1 other interested operator) + absolute time threshold (feature age). Exact values and threshold logic remain open. `[settled in principle; values: Q-STAND-PARAM]`
- **Delay between trigger and submission**: 12-month intuition. Shorter = punitive; longer = complacent. `[working hypothesis; Q-STAND-PARAM]`
- **Trigger governance**: by Ename, upon report by any actor (user, other operator, observer). Public and enforceable. Not by the operator itself (conflict of interest). `[settled]`
- **Validation of proposed standards**: Ename reviews, rejects standards that serve only one operator. Open consultation, public review, reasoned decision. Precise modalities (arbitration body, timelines, appeal paths) in the rules of procedure. `[settled in principle; details: Q-STAND-PARAM]`
- **Productive tension**: similar balance to patents — limited monopoly against disclosure, except here the counterpart is enrichment of a commons, not disclosure to the state. Use as pedagogical analogy. `[settled]`
- **Terminological disambiguation**: "standardization" in the ecosystem denotes two distinct things — (a) Ename's establishment of interoperability standards (registry objective #3), (b) the specific usage-proven mechanism described here. Mechanism (b) feeds corpus (a); they are not synonyms. `[settled]`

### Cryptographic Anchoring

Fourth registry objective. Orthogonal layer superimposed on transport — it does not change the path of data, but ensures that what arrives can be trusted independently of the emitting operator.

Decisions:
- **Signature by the user, not by the operator**. Non-negotiable consequence of three project properties: multi-century durability (an operator may disappear; the registry endures), operator portability (no re-signature on migration), cross-operator trust (verification happens against the Ename key, not the operator's reputation). `[settled]`
- **Cross-operator verification**: every signature, attestation, or transfer verification is performed against keys published by Ename, never against the emitting operator's reputation. A malicious operator can at worst omit (censor by invisibilization), not fabricate. `[settled]`
- **Key history in the registry**: Ename publishes the public-key history of each ename, with validity periods. A signature remains verifiable as long as its timestamp falls within the validity period of the key that produced it. `[settled in principle]`
- **Revocation policy in case of compromise**: three possible options (invalidate everything during the presumed compromise period — purist; only elements after report — pragmatic; let the recipient choose — responsibility-shifting). To be settled in Ename rules. `[open: Q-REVOC]`
- **Key recovery mechanisms**: three mechanisms the user may freely combine depending on risk profile — cloud-sync via passkey, social recovery by quorum of contacts, re-KYC with the operator as last resort. None is free of tradeoffs (each balances convenience, third-party dependence, and identity exposure differently). Interface standardization to be led by Ename; operational experimentation by operators. `[settled in principle; Q-KEYREC]`
- **Implementation choices** (signature algorithm such as Ed25519, canonical format such as CBOR or canonical JSON, content hash algorithm such as SHA-256 or BLAKE3, rotation-attestation mechanics in the registry, revocation granularity): belong in the Ename standards document, to be produced. `[open: Q-CRYPTO-IMPL]`

### Governance

The Ename organization is a non-profit association. The adopted bylaws (cf. `ename-statuts-v0.2-fr.md`) set the legal framework; this section restates the structural decisions underlying them.

Decisions:
- **Legal form**: non-profit association. Chosen to align governance and mission (no profit distribution, neutrality by construction). `[settled]`
- **Board composition — four colleges**: (1) accredited operators, elected by their peers; (2) civil society (digital-rights associations, commons actors, consumer organizations); (3) technical experts (digital identity, security, Internet governance); (4) founding members, whose share decreases progressively over time. `[settled]`
- **Initial board size**: twelve members, three seats per college (cf. bylaws art. 12). This size makes renewal by thirds legible (four outgoing members per term). `[settled]`
- **Non-domination rule**: no college alone holds a majority. Guarantees the pluralistic nature of governance and registry neutrality. `[settled]`
- **One-third renewal** of mandates, limited duration (bylaws art. 12: three years, bounded re-eligibility). Aims for continuity while avoiding concentration of power. `[settled]`
- **Structural modifications** (rules affecting format, accreditation conditions, user rights): subject to **prior public consultation**, with a public summary before the final decision. `[settled]`
- **Validation of interoperability standards** proposed by operators: follows the same principle — open consultation, public review, reasoned decision. Precise modalities (arbitration body, timelines, appeal paths) in the rules of procedure. `[settled in principle; details: Q-STAND-PARAM]`
- **Independent appeal mechanism**: allows operators and end users to contest registry decisions. Precise modalities in the rules of procedure. `[settled in principle; Q-RECOURS]`
- **Founder-seat decrease**: main mechanism settled by the bylaws (arts. 12 and 17) — re-eligibility limited to once for founders (vs twice for other colleges), vacant founder seats not refilled but redistributed to the other colleges, transition to the target composition to be completed within a period defined by transitional provisions. Practical redistribution modalities remain to be specified (rules of procedure). `[partly settled; practical details: Q-FOUND-DECREASE]`
- **Precise operator accreditation criteria**: required KYC level, operational security requirements, financial capacity, accreditation duration, withdrawal conditions. Minimal framework to set in the rules of procedure or an accreditation-standards document. `[open: Q-ACCRED-CRITERES]`

### Funding

The registry is funded by **accreditation fees and registry fees** paid by operators. Each registered or renewed ename gives rise to a registry fee, collected by the operator from the user and remitted to Ename. Initial accreditation fees and annual membership fees, owed by each operator, are added to this.

Decisions:
- **Main source under consideration**: per-ename registry fees + accreditation fees + annual operator membership fees. No data resale, no advertising, no direct funding by end users (who pay the operator, which remits to the registry). The exact profile of the registry fee depends on the renewal-periodicity decision (cf. [Q-RENEW]) — hence the nuance "under consideration". `[settled in principle]`
- **Articulation with the bylaws**: art. 9 of the bylaws lists resource categories without explicitly naming the "per-ename registry fee"; the implicit connection is the category "amounts received in exchange for services". Verify that no bylaw adjustment is needed as the model becomes more precise. `[settled in principle]`
- **Three claimed advantages**: (1) sustainable over the long term, without dependence on one-off grants or a single patron; (2) alignment of interests between the registry and service quality/durability (not profitability); (3) independence from states as well as large economic actors. `[settled]`
- **Bootstrap phase**: a complement through donations, patronage, or targeted grants may be mobilized. Transparent, time-limited, without structural dependence. `[settled in principle]`
- **Ename renewal periodicity** (annual, other periodicity, free after initial period, perpetual with upfront payment): not settled at this stage. To settle consistently with the durability principle (an ename must remain valid well beyond its holder's lifetime). `[open: Q-RENEW]`
- **Inter-operator cost-allocation modalities** in Ename rules (indicative schedule, free pricing, publication of deviations): Ename's position to arbitrate. `[open: Q-TARIF-INTEROP]`

### Founding Principles

The organization is built around **six fundamental principles** that guide its functioning and are translated into the bylaws, standards, and accreditation contracts.

- **Non-profit purpose**: no profit distribution. Any financial surplus is reinvested in the registry mission.
- **Neutrality**: the registry favors no operator, no specific use, no economic or political actor. Rules apply uniformly.
- **Transparency**: rules, standards, accreditation decisions, registry evolutions, organizational accounts — everything is public.
- **Durability**: registry designed to last for several centuries. An ename created today must remain valid and accessible well beyond its holder's lifetime, and signatures made with its keys must remain verifiable over the same horizon. The horizon of enames is aligned with that of the registry: if the registry lasts for centuries, the enames it guarantees must last on the same order of magnitude, otherwise the principle is emptied of meaning.
- **Independence**: no dependence on a single actor (funder, technical partner, state).
- **Portability**: everything that constitutes a user's digital life with an operator (identity, keys, credentials, correspondence, publications, address book, subscribers) must be able to follow them when changing operator, without degradation and without excessive friction. Guaranteed by the combination of common registry + interoperability standards + contractual accreditation commitments.

These principles are not independent: they form a structural whole. Durability relies on independence and non-profit purpose; portability relies on neutrality and transparency; etc. Treat them together in any derivative that uses them.

### Identifier Format and Evolutions

The ename format (syntax, structure, transliteration rules, length, name changes) is defined in `ename-format-v0.7-fr.md` and is not restated here. Structurally:

- **General form `<name>#<number>`**, readable, easy to dictate, stable. `[settled]`
- **Definitive person <-> ename link**: once assigned, an ename remains definitively linked to the same person, even if that person changes name (they then obtain a new ename; the old one remains linked to them). `[settled]`
- **Central case: verified ename** of a natural person, only operational case at this stage (cf. glossary *verified ename*). `[settled]`
- **Planned extensions** (operational frameworks to define, handled in section *Upcoming Workstreams*): organization enames, secondary enames (aliases), unverified enames, affiliation syntax (`person#1@organization#1`). `[settled in principle for scope; open for implementation]`

### Upcoming Workstreams

Several major workstreams structure the project's evolution over the coming years. Each is tracked by a dedicated Q-ID when implementation raises substantive open questions.

- **Extension to organizations**: extension of the registry to support organization enames (companies, associations, public bodies). Format and verification process adapted. Tension to resolve during implementation: the reference framing presents Ename as a **human** identity registry; admitting organizations shifts that framing and requires either reformulating the mission, or making explicit that "human" denotes the central case by default, not the registry's full universe. `[settled in principle; Q-ORG]`
- **Secondary enames (aliases)**: a person or organization may link other enames to its main identity (stage names, brands, products). Framework to define. `[settled in principle; Q-ALIAS]`
- **Framework for unverified enames**: purely declarative enames for uses compatible with anonymity (gaming, forums, social pseudonymity). Visual distinction by prefix planned in the format. Operational framework distinct from verified enames, to define: who may issue them, under what conditions, with what guarantees (is the prefix enough to avoid UX-level impersonation?), how they interact with verified enames (citation, follow, sending). `[open: Q-NONVERIF]`
- **Progressive opening of the operator ecosystem**: careful and gradual accreditation. The bootstrap phase relies on a first operator; accreditation then opens to other operators. `[settled in principle]`
- **Progressive constitution of the standards corpus**: iterative approach accompanying ecosystem maturation rather than anticipating every need. The arrival of the second operator will be a particularly structuring moment: it will force the first inter-operator standards to become concrete (exchange formats, shared semantics, transfer mechanics). `[settled in principle]`
- **Specification of inter-operator transfers**: workstream to conduct in connection with the operational experience of the first operators and the registry's cryptographic requirements. `[open: Q-MIGR-SPEC]`
- **Internationalization**: project designed from the start for global scale, which implies partnerships with operators in several jurisdictions and an adapted governance framework. Articulation with a jurisdictional-continuity plan for the registry itself (cf. [Q-JURISDICT]). `[settled in principle; Q-INTL]`
- **Articulation with content provenance standards (C2PA)**: so that signatures emitted from enames integrate with existing content-verification ecosystems (notably the C2PA specification, an open standard carried by a coalition including software vendors, device manufacturers, and media organizations). Alignment and partnership work throughout deployment. `[settled in principle; Q-C2PA]`
- **Articulation with EUDI Wallet**: the European digital identity wallet covers essentially sovereign/public-authority uses; Ename covers everyday online uses. Complementary rather than competing. Concrete articulation to design as EUDI deploys, in particular for identity verification at registry enrollment (an EUDI Wallet may serve as a KYC support for an accredited operator). Framing tension to monitor: the reading "EUDI = sovereign/public-authority only" may be contested if EUDI's scope expands to private uses. Reassess as deployment progresses. `[settled in principle; Q-EUDI]`

---

## Rejected Alternatives

Section to consult before suggesting options for the project — avoids re-proposing what has been decided against. Only alternatives explicitly rejected in this synthesis, or unambiguously inferable, appear here; inferences are called out.

### Alternatives to the Identifier Itself

- **Email address as identifier**: receives messages, but does not mean *being* someone. No anchoring to a verified identity, no associated cryptographic key, dependence on a mail operator. Rejected by construction.
- **Platform handle** (`@jean.dupont` on a given network): property of a private company, which can delete it, resell it, or disappear with it. No portability, no durability. Rejected.
- **Raw cryptographic identifier** (public key, DID, crypto address): portable but unreadable and unusable by the general public. Lacks the constitutive "human" dimension. Rejected as primary identifier; the cryptographic key is, however, attached to the ename.
- **State-issued digital identity** (FranceConnect, EUDI Wallet): national, administrative, designed for official procedures. Not for everyday online life. No cross-border portability. Complementary (cf. EUDI workstream), not substitutable.

### Alternatives to the Institutional Model

- **Private company operating the registry**: breaks neutrality (structural conflict of interest), durability (the company may be acquired, fail, change strategy), independence (a majority shareholder may influence policy). Rejected.
- **State instrument** (public body of one state): confines identity to a jurisdiction, makes it dependent on national political decisions. Breaks cross-border portability and web-scale use. Rejected.
- **Federation without a central standardization mechanism** (ActivityPub/Mastodon, Bluesky/AT Protocol, XMPP): no KYC-verified identity, no viable commercial layer, no central accreditation or rigorous standardization mechanism. Federations drift, de facto standards are set by the dominant actor, portability erodes. Rejected as reference model. Ecosystem names cited here are examples.

### Alternatives to the Standardization Mechanism

- **Standards frozen ex ante** (everything standardized upfront, no proprietary innovation by operators): stifles innovation, condemns the ecosystem to the pace of central governance. The usage-proven mechanism corrects this: free innovation while marginal, forced standardization if successful. Rejected implicitly.
- **Purely voluntary standards** (no contractual obligation to propose for standardization): leaves the dominant operator the option to capture users through proprietary drift. This is precisely the risk addressed by usage-proven standardization. Rejected.
- **Operator-initiated trigger** (the operator itself judges whether its feature must be standardized): obvious conflict of interest. Trigger by external report and Ename review neutralizes this bias. Rejected.

### Alternatives to the Funding Model

- **Funding by a single public grant or single patron**: creates structural dependence that threatens independence. Rejected.
- **Funding through data resale or advertising**: incompatible with the mission (no relationship with end users, no processing of their data by the registry). Rejected by construction.
- **Direct funding by end users**: would break the registry / operator boundary that grounds neutrality. Users pay the operator, which remits to the registry. Rejected.

### Alternatives to Multi-College Governance

- **Board composed of a single college** (only operators, or only civil society, or only experts): capture risk by that category. Multi-college governance + non-domination rule prevents it. Rejected.
- **Governance by the state or a public body**: confines authority to one jurisdiction. Incompatible with the project's international horizon. Rejected.

---

## Open Questions

Stable identifiers, grouped by domain. Reference them from the body when a point depends on them.

### Architecture, Standards, Registry

- **[Q-STAND-PARAM]** Precise parameters of the usage-proven standardization contract: threshold values (% internal usage, external interest), exact delay (12-month intuition), logic between the three thresholds (AND or OR — current intuition: OR, any isolated threshold is enough to trigger the obligation to propose), reporting procedure, arbitration body, sanctions for non-compliance. To specify in Ename's rules of procedure.
- **[Q-MIGR-SPEC]** Precise inter-operator transfer specification: export format, encryption mechanism, attestation, integrity verification by receiver, continuity of sessions and pairwise secrets.
- **[Q-TARIF-INTEROP]** Inter-operator pricing in Ename rules. Hybrid option to examine: indicative schedule + free pricing + publication of deviations. Ename's position to arbitrate.
- **[Q-RENEW]** Ename renewal periodicity. The funding model mentions enames "registered or renewed" without specifying periodicity or the status of a non-renewed ename. Must be reconciled with the durability principle (an ename must remain valid well beyond its holder's lifetime). To make explicit.

### Cryptography

- **[Q-CRYPTO-IMPL]** Implementation choices: signature algorithm (Ed25519 or other), canonical metadata format for signature (CBOR, canonical JSON, etc.), content hash algorithm (SHA-256, BLAKE3, etc.), rotation-attestation mechanics in the registry, revocation granularity.
- **[Q-REVOC]** Revocation policy in case of compromise. Three options: invalidate everything during the presumed compromise period (purist), only elements after report (pragmatic), let the recipient choose (responsibility-shifting). To settle in Ename rules.
- **[Q-KEYREC]** Standardization of interfaces for the three key-recovery mechanisms (cloud-sync via passkey, social recovery, re-KYC). Determines what every accredited operator must offer. To conduct early because it shapes onboarding UX and user trust.

### Format and Extensions

- **[Q-NONVERIF]** Operational framework for unverified enames. Tension to resolve: the central framing of the project presents Ename as a registry of verified identities, but an unverified extension is planned. Open questions: who may issue unverified enames (the same operators? other actors?); under what guarantees (is the distinctive prefix enough to avoid UX-level impersonation?); how they interact with verified enames (citation, follow, inter-class sending); what accreditation obligations apply to their issuance; what associated economic model.
- **[Q-ORG]** Operational framework for organization enames: format (same `<name>#<number>` or variant?), verification process (KYB equivalent? which source registry — RCS, international equivalents?), eligibility conditions, affiliation syntax (`person#1@organization#1`). Framing tension: extending to organizations shifts the "human" qualification of the registry — to arbitrate (reformulate the mission, or clarify that "human" denotes the central case and not the registry's full universe). To specify with the operators concerned.
- **[Q-ALIAS]** Operational framework for secondary enames (aliases): link to main identity, disclosure rules (can one prove that an alias is linked to an identity without revealing it?), lifespan, transfer conditions.

### External Articulations

- **[Q-C2PA]** Articulation with C2PA: positioning (Ename as identity authority for C2PA manifests? simple format compatibility?), integration work to conduct, partnerships.
- **[Q-EUDI]** Articulation with EUDI Wallet: complementary positioning affirmed in principle; concrete integration to design as EUDI deploys. In particular: using an EUDI Wallet as KYC support for registry enrollment through an accredited operator. Tension to monitor: the "EUDI = sovereign/public-authority only" framing is an interpretation, not an established fact; reassess if EUDI extends its scope to private uses.
- **[Q-INTL]** Internationalization: partnerships with operators in several jurisdictions, adaptation of the governance framework to global scale, articulation with local legal regimes (notably those imposing specific KYC or data-localization requirements).
- **[Q-JURISDICT]** Jurisdictional-continuity plan for the registry itself: mirror scenario outside a given jurisdiction for resilience against strong legal pressure on the organization.

### Governance and Accreditation

- **[Q-FOUND-DECREASE]** Practical modalities for redistributing vacant founder seats among the other colleges. The main mechanism is settled by the bylaws (arts. 12 and 17: founder re-eligibility limited to once, vacant seats not refilled but redistributed, transition to be completed within the period set by transitional provisions). Exact redistribution procedure remains to be specified (rules of procedure).
- **[Q-ACCRED-CRITERES]** Precise operator accreditation criteria: required KYC level, operational security requirements, financial capacity requirements, accreditation conditions, accreditation duration, withdrawal conditions. Minimal framework to set in the rules of procedure or an accreditation-standards document.
- **[Q-RECOURS]** Precise modalities of the independent appeal mechanism: composition, referral, procedure, appeal paths. To set in the rules of procedure.

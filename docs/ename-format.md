# Ename — Format

> This document describes only the **format** of enames: their syntax, structure, and governing rules. The Ename project's mission, its model of the registry and operators, and its governance principles are described in [Ename — Reference Synthesis](./ename-synthesis.md).

## Overview (Formal Grammar)

```
ename            ::= <name> "#" <number>
<name>           ::= <letter> ( <letter> | "-" <letter> )*
<number>         ::= <nonzero-digit> <digit>*
<letter>         ::= "a" | "b" | ... | "z"
<digit>          ::= "0" | "1" | ... | "9"
<nonzero-digit>  ::= "1" | "2" | ... | "9"
```

Total length of an ename: **52 characters maximum**. The sections below detail these rules and their special cases.

## 1. What Is an Ename?

An ename is a public, human-readable identifier that uniquely designates a person in the Ename registry.

Every ename refers to a person whose identity has been verified before registration in the registry. The conditions and methods for this verification belong to the issuance process and are described in a separate document.

An ename is designed to be:

- stable over time once issued;
- permanently linked to exactly one person;
- easy to read, write, and transmit.

An ename always has the following general form:

`<name>#<number>`

For example:

- `john-doe#1`
- `jean-dupont#123`
- `maria-do-carmo-santos#7`

## 2. General Structure

An ename consists of two elements:

`<name>#<number>`

- `<name>`: a normalized representation of the person's name;
- `<number>`: a number that distinguishes several people with the same `<name>`.

## 3. Rules for `<name>` (Syntax)

`<name>` is the name part of the ename.

Rules:

- Allowed characters:
  - lowercase letters `a` to `z`,
  - hyphens `-`.
- The hyphen `-` cannot appear:
  - at the beginning,
  - at the end,
  - twice in a row.

Names containing characters outside this set (accented letters, other alphabets, etc.) must be transliterated according to rules defined in a separate document.

Examples of valid `<name>` values:

- `john-doe`
- `jean-michel-dupont`
- `maria-do-carmo-santos`

Examples of invalid `<name>` values:

- `-john-doe` (hyphen at the beginning)
- `john-doe-` (hyphen at the end)
- `jean--michel-dupont` (consecutive hyphens)
- `Jean-Michel-Dupont` (uppercase letters are forbidden)
- `john_doe` (underscore is forbidden)
- `john.doe` (period is forbidden)

## 4. Rules for `<number>`

`<number>` is the numeric part after the `#`.

Rules:

- It consists only of digits from `0` to `9`, and must not begin with `0`.
- Its value ranges from `1` to `999999999999` (1 to 12 digits maximum).

For a given `<name>`, `<number>` values are issued in order, starting at `1`.

In practice:

- the first ename created with a given `<name>` receives `#1`:
  - `jean-dupont#1`;
- the next one with the same `<name>` receives `#2`:
  - `jean-dupont#2`;
- then `#3`, `#4`, etc., up to `#999999999999` at most.

## 5. Maximum Length of an Ename

An ename cannot exceed **52 characters** in total, counting `<name>`, the `#` character, and `<number>`.

Examples:

- `jean-dupont#123` -> 15 characters, <= 52 -> accepted;
- a very long `<name>` combined with `#123456789012` -> accepted if the total length remains <= 52, rejected otherwise.

## 6. Name Changes and Successive Enames

A person may change their name over time, for example because of marriage, divorce, or adoption.

In that case:

- the person may request a new ename that reflects their new name;
- the old ename is not modified or deleted: it continues to refer to the same person;
- new enames may be used in interfaces and links, without old enames ceasing to work.

The same person may therefore have several enames over their lifetime. However, each ename remains permanently linked to exactly one person.

## 7. Planned Format Evolutions

This first version of the format provides a minimal foundation. Several extensions are planned for later versions, including:

- **Organization enames**  
  The format may support enames for organizations (companies, institutions, associations, etc.) on the same principle as for people. It may also represent links such as `john-doe#1@acme-inc#1` (under a syntax still to be defined), for a person acting on behalf of an organization.

- **Secondary enames (aliases)**  
  A person may link other enames to their main identity in order to manage distinct public identities (for example, a stage name), such as `mr-beast#1` linked to `jimmy-donaldson#1`. Similarly, an organization may create secondary enames for its brands, products, or projects.

- **Unverified enames**  
  To cover uses that allow anonymity (gaming, forums, social networks), the format will support purely declarative enames. These unverified enames will be visually distinguished by a prefix, such as a period (for example, `.pixel-cat#12`), ensuring immediate differentiation from verified enames.

## 8. Summary

- An ename has the form `<name>#<number>` and is permanently linked to exactly one person in the registry.
- The syntax rules are strict (lowercase letters and hyphens for `<name>`, digits for `<number>`) to avoid any ambiguity.
- A person may have several successive enames (after a name change), but each ename remains permanently linked to exactly one person.
- Future format evolutions (organizations, aliases, unverified enames) will complete this foundation in later versions.

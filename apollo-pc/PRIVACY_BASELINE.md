# Apollo PC privacy engineering baseline

Apollo PC uses a NIST-oriented technical baseline for reducing direct-identification and credential risk before a personal-context bundle can upload. This is a product control baseline, not a legal certification and not a claim that pseudonymized records are anonymous.

## Release invariants

- Originals, the real-to-alias map, parsing, filtering, and editing remain local until the participant presses Submit.
- Every protected person receives one stable synthetic name, email, and phone across all imported sources.
- The signed-in participant uses the same protected identity in the manifest, bundle path, and upload routing metadata.
- Contact birthdays do not serialize. Message IDs, chat IDs, order IDs, and financial account labels are removed or replaced by non-identifying placeholders by default.
- Record fields and participant-authored tasks pass through replacement rules, hard masks, and entity aliases before serialization.
- A separate final DLP pass scans every string in records, tasks, and manifest metadata. Any unapproved original identity or unmasked direct identifier blocks all network upload.
- Keep-real entities are permitted only as explicit user choices and appear as residual-risk warnings in the privacy audit.
- Privacy-audit findings contain detector names and JSON paths, never matched values.
- Production presign and upload URLs must use HTTPS. Plain HTTP is accepted only for localhost development.

## Direct identifiers and secrets

The hard-mask layer covers email addresses; international phone numbers; common US and international street formats; labeled postal codes and PO boxes; dates of birth; SSNs; IBANs; payment cards with Luhn validation; bank and routing numbers; passports; driver's licenses; national, employee, student, and medical-record IDs; passwords; OTPs; private keys; common API/token formats; IP and MAC addresses; usernames; license plates; and precise coordinate pairs.

Known names, emails, and phones are also matched from the local entity graph across structured fields and free text. Labeled free-text names are masked when they are not in the graph.

## Residual risk

Pseudonymized personal-context data remains personal data. Exact dates and times, non-address venue names, uncommon narrative details, relationships between records, and intentionally retained merchants or people can permit singling out or re-identification. The audit reports these as warnings instead of claiming anonymity because those fields may be required for benchmark utility.

## Verification gate

A release must pass type checking, the complete unit suite, adversarial detector tests, a bundle-level leak test, an exact-preview audit, and a production browser test showing that blocking findings prevent Submit. Detector changes require both positive and negative regression cases.

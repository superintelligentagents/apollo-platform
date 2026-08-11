import type { SourceKind } from "../types";
import { icsParser } from "./ics";
import { mboxParser } from "./mbox";
import { vcardParser } from "./vcard";
import { whatsappParser } from "./whatsapp";
import type { SourceParser } from "./types";

export type SourceCard = {
  kind: SourceKind;
  parser: SourceParser | null; // null = derived or deferred source, no file import
  title: string;
  howTo: string[]; // participant export instructions, rendered on the import card
  derived?: string; // explanation for sources mined from other imports
};

// v1 scope: email + calendar only (user decision) — orders ride along for
// free because they're mined from receipt emails. The contacts/messages
// parsers stay built and tested; re-add their cards here to re-enable.
export const SOURCE_CARDS: SourceCard[] = [
  {
    kind: "email",
    parser: mboxParser,
    title: "Import Mail",
    howTo: [
      "Go to takeout.google.com and sign in.",
      "“Deselect all”, then check only Mail.",
      "Optional: “All Mail data included” → pick just Inbox/Sent (or a label) if your archive is huge.",
      "“Next step” → “Create export”. Google emails you a download link — usually minutes, up to a few hours for big inboxes.",
      "Download the .zip, unzip it, and import the .mbox file(s) here (e.g. “All mail Including Spam and Trash.mbox”).",
    ],
  },
  {
    kind: "calendar",
    parser: icsParser,
    title: "Import Calendar",
    howTo: [
      "Go to calendar.google.com → Settings → Import & export → Export.",
      "Unzip the download — one .ics per calendar.",
      "Import the .ics file(s) here. Apple/Outlook .ics exports work too.",
    ],
  },
];

// Kept registered for schema/meta purposes even while their import cards are
// hidden (old local data may still hold these kinds).
const HIDDEN_CARDS: SourceCard[] = [
  { kind: "contacts", parser: vcardParser, title: "Contacts", howTo: [] },
  { kind: "messages", parser: whatsappParser, title: "Messages", howTo: [] },
  {
    kind: "orders",
    parser: null,
    title: "Purchases from email",
    howTo: [],
    derived: "Detected from receipt and order-confirmation emails and kept linked to the source message.",
  },
  { kind: "transactions", parser: null, title: "Bank transactions", howTo: [], derived: "deferred" },
];

export function cardFor(kind: SourceKind): SourceCard {
  const card = SOURCE_CARDS.find((c) => c.kind === kind) ?? HIDDEN_CARDS.find((c) => c.kind === kind);
  if (!card) throw new Error(`Unknown source kind ${kind}`);
  return card;
}

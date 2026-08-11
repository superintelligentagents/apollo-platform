import type { CalendarRecord, EmailRecord, SourceRecord } from "./types";

export type DataCategory = { id: string; label: string };

export const EMAIL_CATEGORIES: DataCategory[] = [
  { id: "purchases", label: "Parsed purchases" },
  { id: "shopping", label: "Shopping" },
  { id: "groceries", label: "Groceries" },
  { id: "food-delivery", label: "Food delivery" },
  { id: "dining", label: "Dining reservations" },
  { id: "rides", label: "Rides & taxis" },
  { id: "flights", label: "Flights & airlines" },
  { id: "lodging", label: "Hotels & stays" },
  { id: "banking", label: "Banking & payments" },
  { id: "investing", label: "Investing" },
  { id: "taxes", label: "Taxes" },
  { id: "betting", label: "Prediction & betting" },
  { id: "work", label: "Work & technology" },
  { id: "newsletters", label: "Newsletters" },
  { id: "personal", label: "Personal & other" },
];

export const CALENDAR_CATEGORIES: DataCategory[] = [
  { id: "flights", label: "Flights & airports" },
  { id: "lodging", label: "Hotels & stays" },
  { id: "rides", label: "Rides & transport" },
  { id: "kids", label: "Kids & family" },
  { id: "work", label: "Work" },
  { id: "workout", label: "Workout" },
  { id: "meals", label: "Dining & meals" },
  { id: "medical", label: "Medical" },
  { id: "personal", label: "Personal & other" },
];

const has = (text: string, pattern: RegExp) => pattern.test(text);

export function emailCategory(record: EmailRecord): string {
  // Deliberately exclude the body snippet: incidental mentions of a brand or
  // activity in newsletters caused false positives (for example, a sports
  // story mentioning a flight or wager). Website identity + subject + Gmail
  // labels are the stable signals for these automatic filters.
  const sender = `${record.from.name} ${record.from.email}`.toLowerCase();
  const message = `${record.subject} ${record.labels.join(" ")}`.toLowerCase();
  const text = `${sender} ${message}`;

  // A service mentioned in a job alert or course notification is not activity
  // on that service. Route known professional/education senders before looking
  // for commerce brands in the subject.
  if (has(sender, /linkedin|joinhandshake|instructure|canvaslms|piazza|github|gitlab|slack|notion|jira|confluence|asana|trello|amazon web services|@aws\.com|yutori|microsoft teams|google workspace|zoom\.us/)) return "work";

  // Precedence matters: Uber Eats is delivery rather than rides; Instacart is
  // groceries rather than generic delivery; OpenTable is dining rather than a
  // generic travel "reservation"; TurboTax is taxes rather than banking.
  if (has(sender, /instacart|shipt\.com|freshdirect|whole foods|wholefoodsmarket|kroger|safeway|wegmans/) || has(message, /grocery (?:order|delivery)|costco (?:order|delivery)/)) return "groceries";
  if (has(sender, /doordash|grubhub|uber\s?eats|ubereats|postmates|seamless|deliveroo/) || has(message, /receipt from (?:doordash|grubhub|uber\s?eats|postmates)|food delivery receipt|restaurant delivery/)) return "food-delivery";
  if (has(sender, /opentable|resy\.com|exploretock|sevenrooms/) || has(message, /restaurant reservation|table reservation|dinner reservation|lunch reservation/)) return "dining";
  if (has(sender, /(?:^|\s)uber(?:\s|@)|\blyft\b|grab\.com|gotaxi|curb mobility/) || has(message, /receipt from (?:uber|lyft)|ride receipt|trip receipt|taxi receipt/)) return "rides";
  if (has(text, /(?:@|\.)delta\.com|(?:@|\.)united\.com|@aa\.com|southwest|jetblue|alaskaair|air canada|lufthansa|korean air|asiana|\b(?:delta|united|american) airlines?\b|flight (?:confirmation|receipt|itinerary|status|delay|cancell?ation)|boarding pass|fare confirmation|travel credit/)) return "flights";
  if (has(text, /airbnb|vrbo|booking\.com|hotels\.com|expedia|trip\.com|marriott|hilton|hyatt|ihg\.com|accor|hotel (?:booking|confirmation)|lodging reservation|check-in instructions/)) return "lodging";
  if (has(text, /(?:@|\.)amazon\.(?:com|co\.uk)|(?:@|\.)ebay\.|(?:@|\.)etsy\.|(?:@|\.)walmart\.|(?:@|\.)target\.com|best\s?buy|shopify|aliexpress|temu|wayfair|amazon (?:order|shipment|delivery|purchase)|order confirm|order confirmation|shipped|your order|purchase receipt/)) return "shopping";
  if (has(sender, /robinhood|fidelity|schwab|vanguard|e-?trade|webull|coinbase|kraken/) || has(message, /brokerage|portfolio statement|trade confirmation|dividend|stock (?:order|trade)/)) return "investing";
  if (has(sender, /turbotax|intuit tax|h&r block|hrblock|freetaxusa|taxslayer|irs\.gov/) || has(message, /tax return (?:accepted|documents?)|tax refund|estimated tax|\bw-?2\b|\b1099\b/)) return "taxes";
  if (has(sender, /polymarket|kalshi|draftkings|fanduel|betmgm|caesars sportsbook/) || has(message, /betting statement|wager (?:receipt|confirmation)|prediction market (?:trade|statement)/)) return "betting";
  if (has(sender, /\bchase\b|bank of america|wells fargo|capital one|citibank|citi card|american express|\bamex\b|discover card|paypal|venmo|\bzelle\b|cash app|stripe|wise\.com|revolut/) || has(message, /\bbank\b|credit card|account statement|payment receipt|invoice|wire transfer/)) return "banking";
  if (has(text, /category forums|meeting|project|deadline|candidate|interview|github|gitlab|slack|notion|jira|confluence|asana|trello|linkedin|instructure|canvaslms|piazza|amazon web services|\baws\b|yutori|microsoft teams|google workspace|zoom\.us/)) return "work";
  if (record.hasListUnsubscribe || has(text, /category promotions|newsletter|digest|weekly update/)) return "newsletters";
  return "personal";
}

export function calendarCategory(record: CalendarRecord): string {
  const text = `${record.summary} ${record.description} ${record.location}`.toLowerCase();
  if (has(text, /\buber\b|\blyft\b|taxi|rideshare|car service|airport pickup|airport transfer/)) return "rides";
  if (has(text, /flight|airport|boarding|airline|departure|arrival/)) return "flights";
  if (has(text, /hotel|airbnb|resort|lodging|check[ -]?in|check[ -]?out/)) return "lodging";
  if (has(text, /kid|child|children|family|school|daycare|parent|soccer|piano lesson|birthday/)) return "kids";
  if (has(text, /gym|workout|run\b|running|yoga|pilates|swim|training|exercise|crossfit|tennis|basketball|climbing/)) return "workout";
  if (has(text, /lunch|dinner|breakfast|brunch|coffee|meal|restaurant/)) return "meals";
  if (has(text, /doctor|dentist|clinic|hospital|therapy|medical|checkup|appointment/)) return "medical";
  if (has(text, /meeting|standup|sync|review|planning|project|interview|office|client|1:1|one-on-one/)) return "work";
  return "personal";
}

export type EmailCalendarLink = { emailId: string; calendarId: string };

const STOP = new Set(["with", "from", "your", "this", "that", "have", "will", "meeting", "calendar", "event", "invite"]);
function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])].filter((token) => !STOP.has(token));
}

/** Local-only, conservative linkage: a shared meaningful term or participant, plus temporal proximity. */
export function linkEmailAndCalendar(records: Iterable<SourceRecord>): EmailCalendarLink[] {
  const emails: EmailRecord[] = [];
  const calendars: CalendarRecord[] = [];
  for (const record of records) {
    if (record.source === "email") emails.push(record);
    else if (record.source === "calendar") calendars.push(record);
  }
  const tokenIndex = new Map<string, Set<number>>();
  const addressIndex = new Map<string, Set<number>>();
  calendars.forEach((record, index) => {
    for (const token of tokens(`${record.summary} ${record.location}`)) addIndex(tokenIndex, token, index);
    for (const address of [record.organizer, ...record.attendees]) if (address?.email) addIndex(addressIndex, address.email, index);
  });
  const uncommonAddress = (address: string) => (addressIndex.get(address)?.size ?? 0) <= Math.max(10, calendars.length * 0.15);
  const links: EmailCalendarLink[] = [];
  for (const email of emails) {
    const candidates = new Set<number>();
    const subjectTokens = tokens(email.subject);
    const emailTokens = tokens(`${email.subject} ${email.from.name} ${email.from.email.replace(/[^a-z0-9]+/gi, " ")}`);
    for (const token of emailTokens) for (const index of tokenIndex.get(token) ?? []) candidates.add(index);
    const addresses = [email.from, ...email.to, ...email.cc].map((a) => a.email).filter(Boolean);
    for (const address of addresses) if (uncommonAddress(address)) for (const index of addressIndex.get(address) ?? []) candidates.add(index);
    let best: { index: number; score: number } | null = null;
    for (const index of candidates) {
      const calendar = calendars[index];
      const days = dateDistanceDays(email.timestamp, calendar.timestamp);
      if (days === null) continue;
      const sharedTokens = subjectTokens.filter((token) => tokenIndex.get(token)?.has(index)).length;
      const sharedAddress = addresses.some((address) => uncommonAddress(address) && addressIndex.get(address)?.has(index));
      if (!((sharedTokens >= 2 && days <= 3) || (sharedAddress && sharedTokens >= 1 && days <= 7))) continue;
      const score = sharedTokens * 10 + (sharedAddress ? 12 : 0) - days;
      if (!best || score > best.score) best = { index, score };
    }
    if (best) links.push({ emailId: email.id, calendarId: calendars[best.index].id });
  }
  return links;
}

function addIndex(index: Map<string, Set<number>>, key: string, value: number): void {
  const values = index.get(key) ?? new Set<number>();
  values.add(value);
  index.set(key, values);
}

function dateDistanceDays(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) / 86_400_000 : null;
}

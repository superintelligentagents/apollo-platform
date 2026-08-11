// Receipt-miner: derives OrderRecords from already-parsed emails. This is the
// cheapest cross-source-correlation win in the app — every mined order carries
// relatedRecordIds: [emailId], linking a real purchase to the email that
// announced it. Precision over recall: a missed receipt costs nothing; a
// hallucinated one is annotator noise.

import { recordId } from "../ids";
import type { EmailRecord, OrderRecord } from "../types";

type MerchantRule = {
  merchant: string;
  domains: RegExp;
  orderId?: RegExp;
};

const MERCHANTS: MerchantRule[] = [
  { merchant: "Amazon", domains: /(^|\.)amazon\./, orderId: /\b(\d{3}-\d{7}-\d{7})\b/ },
  { merchant: "DoorDash", domains: /(^|\.)doordash\.com$/ },
  { merchant: "Uber", domains: /(^|\.)uber\.com$/ },
  { merchant: "Uber Eats", domains: /(^|\.)ubereats\.com$/ },
  { merchant: "Lyft", domains: /(^|\.)lyft\.com$/ },
  { merchant: "Grubhub", domains: /(^|\.)grubhub\.com$/ },
  { merchant: "Instacart", domains: /(^|\.)instacart\.com$/ },
  { merchant: "Apple", domains: /(^|\.)(apple\.com|itunes\.com)$/ },
  { merchant: "Steam", domains: /(^|\.)steampowered\.com$/ },
  { merchant: "Airbnb", domains: /(^|\.)airbnb\.com$/, orderId: /\b(HM[A-Z0-9]{8,})\b/ },
  { merchant: "Booking.com", domains: /(^|\.)booking\.com$/, orderId: /\b(\d{9,12})\b/ },
  { merchant: "OpenTable", domains: /(^|\.)opentable\.com$/ },
  { merchant: "Ticketmaster", domains: /(^|\.)ticketmaster\.com$/ },
  { merchant: "StubHub", domains: /(^|\.)stubhub\.com$/ },
  { merchant: "Walmart", domains: /(^|\.)walmart\.com$/ },
  { merchant: "Target", domains: /(^|\.)target\.com$/ },
  { merchant: "Best Buy", domains: /(^|\.)bestbuy\.com$/ },
  { merchant: "Etsy", domains: /(^|\.)etsy\.com$/ },
  { merchant: "eBay", domains: /(^|\.)ebay\.com$/ },
];

const SUBJECT_TRIGGER = /order|receipt|confirmation|your trip|itinerary|invoice|reservation|booking|shipped|delivered/i;
const AMOUNT = /[$£€]\s?\d[\d,]*\.\d{2}/g;
const AMOUNT_NEAR_TOTAL = /(total|charged|amount due|amount paid|grand total)[^$£€\n]{0,40}([$£€]\s?\d[\d,]*\.\d{2})/i;

export function merchantForSender(senderEmail: string): MerchantRule | null {
  const domain = senderEmail.split("@")[1]?.toLowerCase() || "";
  if (!domain) return null;
  return MERCHANTS.find((m) => m.domains.test(domain)) ?? null;
}

export function isReceiptCandidate(email: EmailRecord): boolean {
  return !!merchantForSender(email.from.email) && SUBJECT_TRIGGER.test(email.subject);
}

export function mineReceipt(email: EmailRecord, bodyText: string): OrderRecord | null {
  const rule = merchantForSender(email.from.email);
  if (!rule || !SUBJECT_TRIGGER.test(email.subject)) return null;

  const haystack = `${email.subject}\n${bodyText}`;
  const nearTotal = haystack.match(AMOUNT_NEAR_TOTAL);
  let total: number | null = null;
  let currency = "USD";
  const parseAmount = (s: string) => {
    currency = s.includes("£") ? "GBP" : s.includes("€") ? "EUR" : "USD";
    return parseFloat(s.replace(/[^0-9.]/g, ""));
  };
  if (nearTotal) {
    total = parseAmount(nearTotal[2]);
  } else {
    // Fall back to the largest amount in the body.
    const amounts = [...haystack.matchAll(AMOUNT)].map((m) => m[0]);
    if (amounts.length) total = Math.max(...amounts.map(parseAmount));
  }
  const orderId = rule.orderId ? (haystack.match(rule.orderId)?.[1] ?? null) : null;
  if (total === null && !orderId) return null; // not enough signal — skip

  return {
    id: recordId("email-receipt", email.id),
    source: "orders",
    sourceDetail: "email-receipt",
    timestamp: email.timestamp,
    searchText: `${rule.merchant} ${email.subject}`.toLowerCase(),
    merchant: rule.merchant,
    orderId,
    total,
    currency,
    items: [],
    shippingAddress: null,
    relatedRecordIds: [email.id],
  };
}

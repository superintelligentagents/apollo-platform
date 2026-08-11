// Auto-scrub detectors. Two tiers:
//  - HARD-MASK: credentials and financial numbers — auto-replaced in the
//    serialized output, shown masked in the UI with a per-match restore. Any
//    restored protected value is still subject to the fail-closed bundle scan.
//  - FLAG: advisory chips only. The current production baseline defaults all
//    direct identifiers to HARD-MASK; flags are reserved for future contextual
//    classifiers.

export type ScrubTier = "mask" | "flag";

export type ScrubMatch = {
  matchId: string; // recordId + field + index — stable across re-runs
  detector: string;
  tier: ScrubTier;
  field: string;
  start: number;
  end: number;
  excerpt: string;
  replacement: string; // "[card-number]" etc.
};

type Detector = {
  name: string;
  tier: ScrubTier;
  regex: RegExp;
  replacement: string;
  validate?: (match: string) => boolean;
};

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const DETECTORS: Detector[] = [
  {
    name: "private-key",
    tier: "mask",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{0,4000}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replacement: "[private-key]",
  },
  {
    name: "card-number",
    tier: "mask",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    replacement: "[card-number]",
    validate: luhnValid,
  },
  {
    name: "ssn",
    tier: "mask",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[ssn]",
  },
  {
    name: "iban",
    tier: "mask",
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    replacement: "[iban]",
  },
  {
    name: "passport-number",
    tier: "mask",
    regex: /\bpassport(?:\s*(?:number|no\.?|#))?\s*(?::|#|\bis\b)?\s*[A-Z0-9]{6,12}\b/gi,
    replacement: "[passport-number]",
  },
  {
    name: "drivers-license",
    tier: "mask",
    regex: /\b(?:driver'?s?|driving)\s+licen[cs]e(?:\s*(?:number|no\.?|#))?\s*(?::|#|\bis\b)?\s*[A-Z0-9-]{4,18}\b/gi,
    replacement: "[drivers-license]",
  },
  {
    name: "national-id",
    tier: "mask",
    regex: /\b(?:national|citizen|taxpayer|tax)\s+(?:id|identification)(?:\s*(?:number|no\.?|#))?\s*(?::|#|\bis\b)?\s*[A-Z0-9-]{5,24}\b/gi,
    replacement: "[national-id]",
  },
  {
    name: "medical-record-number",
    tier: "mask",
    regex: /\b(?:mrn|medical\s+record(?:\s*(?:number|no\.?|#))?)\s*(?::|#|\bis\b)?\s*[A-Z0-9-]{5,24}\b/gi,
    replacement: "[medical-record-number]",
  },
  {
    name: "employee-student-id",
    tier: "mask",
    regex: /\b(?:employee|student)\s*(?:id|number|no\.?)\s*(?::|#|\bis\b)?\s*[A-Z0-9-]{4,24}\b/gi,
    replacement: "[person-id]",
  },
  {
    name: "routing-number",
    tier: "mask",
    regex: /\b(?:aba\s+)?routing(?:\s*(?:number|no\.?|#))?\s*(?::|#|\bis\b)?\s*\d{9}\b/gi,
    replacement: "[routing-number]",
  },
  {
    name: "bank-account",
    tier: "mask",
    regex: /\b(?:bank\s+)?account(?:\s*(?:number|no\.?|#))?\s*(?::|#|\bis\b)?\s*\d[\d -]{5,22}\b/gi,
    replacement: "[bank-account]",
  },
  {
    name: "password",
    tier: "mask",
    regex: /\b(?:password|passcode|pwd)\b[^\n]{0,10}?(?::|\bis\b)\s*(\S+)/gi,
    replacement: "[password]",
  },
  {
    name: "otp-code",
    tier: "mask",
    regex: /\b(?:code|verification|otp|pin|2fa)\b[^\n]{0,30}?\b(\d{5,8})\b|\b(\d{5,8})\b[^\n]{0,30}?\b(?:is your|verification|code)\b/gi,
    replacement: "[otp]",
  },
  {
    name: "api-secret",
    tier: "mask",
    regex: /\b(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|secret[-_ ]?key|bearer)\b\s*(?::|=|\bis\b)?\s*["']?[A-Z0-9_\-./+=]{16,}["']?/gi,
    replacement: "[api-secret]",
  },
  {
    name: "credential-token",
    tier: "mask",
    regex: /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Z0-9]{20,}|sk_(?:live|test)_[A-Z0-9]{16,})\b/gi,
    replacement: "[credential-token]",
  },
  {
    name: "email-address",
    tier: "mask",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[email]",
  },
  {
    name: "phone-number",
    tier: "mask",
    regex: /(?<![\p{L}\p{N}])(?:\+\d{1,3}[\s().-]*)?(?:\(?\d{1,4}\)?[\s.-]*){2,5}\d{2,4}(?![\p{L}\p{N}])/gu,
    replacement: "[phone]",
    validate: (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length <= 15 && (digits.length >= 10 || (match.trim().startsWith("+") && digits.length >= 8));
    },
  },
  {
    name: "ipv4-address",
    tier: "mask",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "[ip-address]",
    validate: (match) => match.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255),
  },
  {
    name: "ipv6-address",
    tier: "mask",
    regex: /\b(?:ipv6|ip(?:\s+address)?)\s*(?::|\bis\b)?\s*(?:[A-F0-9]{0,4}:){2,7}[A-F0-9]{0,4}\b/gi,
    replacement: "[ip-address]",
  },
  {
    name: "mac-address",
    tier: "mask",
    regex: /\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/gi,
    replacement: "[device-id]",
  },
  {
    name: "precise-coordinates",
    tier: "mask",
    regex: /\b(?:coordinates?|lat(?:itude)?|lon(?:gitude)?)\b[^\n]{0,20}?[-+]?\d{1,3}\.\d{4,}(?:\s*[,/]\s*[-+]?\d{1,3}\.\d{4,})?/gi,
    replacement: "[precise-location]",
  },
  {
    name: "coordinate-pair",
    tier: "mask",
    regex: /(?<![\d.])[-+]?\d{1,2}\.\d{4,}\s*,\s*[-+]?\d{1,3}\.\d{4,}(?![\d.])/g,
    replacement: "[precise-location]",
    validate: (match) => {
      const [lat, lon] = match.split(",").map(Number);
      return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    },
  },
  {
    name: "po-box",
    tier: "mask",
    regex: /\bP\.?\s*O\.?\s+Box\s+\d+[A-Z]?\b/gi,
    replacement: "[address]",
  },
  {
    name: "labeled-address",
    tier: "mask",
    regex: /\b(?:home|mailing|billing|shipping|street)\s+address\b\s*(?::|\bis\b)?\s*[^\n;]{5,140}/gi,
    replacement: "[address]",
  },
  {
    name: "postal-code",
    tier: "mask",
    regex: /\b(?:zip|postal\s+code|postcode)\b\s*(?::|#|\bis\b)?\s*[A-Z0-9][A-Z0-9 -]{2,10}\b/gi,
    replacement: "[postal-code]",
  },
  {
    name: "street-address",
    tier: "mask",
    regex: /\b\d{1,5}[A-Z]?\s+(?:[\p{L}\p{N}'’.-]+\s+){1,7}(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Ct|Court|Way|Pl(?:ace)?|Terrace|Highway|Hwy|Strasse|Straße|Str|Rue|Calle|Via|Viale|Piazza)\b(?:\s*(?:Apt|Apartment|Unit|Suite|#)\s*[\p{L}\p{N}-]+)?/giu,
    replacement: "[address]",
  },
  {
    name: "international-street-address",
    tier: "mask",
    regex: /\b\d{1,5}[A-Z]?\s+(?:Rue|Calle|Via|Viale|Piazza|Strasse|Straße)\s+(?:[\p{L}\p{N}'’.-]+\s*){1,8}/giu,
    replacement: "[address]",
  },
  {
    name: "dob",
    tier: "mask",
    regex: /\b(?:date\s+of\s+birth|birth(?:day|date)?|dob)\b[^\n]{0,24}?\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/gi,
    replacement: "[dob]",
  },
  {
    name: "license-plate",
    tier: "mask",
    regex: /\b(?:license|registration)\s+plate(?:\s*(?:number|no\.?|#))?\s*(?::|#|\bis\b)?\s*[A-Z0-9-]{3,12}\b/gi,
    replacement: "[license-plate]",
  },
  {
    name: "online-identifier",
    tier: "mask",
    regex: /\b(?:username|user\s*id|handle)\b\s*(?::|=|\bis\b)?\s*@?[A-Z0-9._-]{3,64}\b/gi,
    replacement: "[online-identifier]",
  },
  {
    name: "labeled-person-name",
    tier: "mask",
    regex: /\b(?:[Ff]ull\s+[Nn]ame|[Cc]ontact\s+[Nn]ame|[Ll]egal\s+[Nn]ame|[Nn]ame)\b\s*(?::|\bis\b)\s*\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,4}/gu,
    replacement: "[person-name]",
  },
];

export function scrubText(recordIdStr: string, field: string, text: string): ScrubMatch[] {
  if (!text) return [];
  const out: ScrubMatch[] = [];
  for (const det of DETECTORS) {
    det.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = det.regex.exec(text))) {
      const value = m[0];
      if (det.validate && !det.validate(value)) continue;
      const start = m.index;
      const end = m.index + value.length;
      // Detector order is priority order. Avoid applying a phone/address mask
      // over a card, SSN, or another higher-confidence overlapping match.
      if (out.some((existing) => existing.tier === "mask" && existing.start < end && start < existing.end)) continue;
      out.push({
        matchId: `${recordIdStr}::${field}::${det.name}::${idx++}`,
        detector: det.name,
        tier: det.tier,
        field,
        start,
        end,
        excerpt: value.length > 60 ? `${value.slice(0, 57)}…` : value,
        replacement: det.replacement,
      });
      if (out.length > 200) return out; // pathological input guard
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Apply mask-tier matches to a text (skipping user-restored ones). Applied
// back-to-front so earlier offsets stay valid.
export function applyMasks(
  text: string,
  matches: ScrubMatch[],
  overrides: Record<string, boolean>
): { text: string; applied: string[] } {
  const applied: string[] = [];
  let result = text;
  const masks = matches
    .filter((m) => m.tier === "mask" && !overrides[m.matchId])
    .sort((a, b) => b.start - a.start);
  for (const m of masks) {
    result = result.slice(0, m.start) + m.replacement + result.slice(m.end);
    applied.push(m.detector);
  }
  return { text: result, applied: [...new Set(applied)] };
}

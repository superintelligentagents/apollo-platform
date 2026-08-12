// Task metadata vocabularies: where a task is anchored, which sites it runs
// through, and what it is about.
//
// These exist to make collection *distribution* measurable. Authors draw on
// their own browsing history, so a regionally concentrated cohort produces a
// regionally concentrated task set unless we can see the skew and correct it.
// Region and subject are author-declared; primary domains are derived from the
// task's own sites and left editable.
//
// The subject vocabulary is taken from the `categories` labels already present
// in the public Odysseys dataset (data/odysseys.json), so newly collected tasks
// pool with the published 200 without a remapping step. Every top-level group
// ends in an "- Other" leaf: seven groups had no such leaf in the observed
// labels and one was added, so the vocabulary is total and an author is never
// forced into a wrong-but-close leaf. Add a leaf only when "- Other" is
// genuinely collecting unlike things, and prefer a name the upstream taxonomy
// would plausibly use.

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

// Sentinel for tasks with no geographic anchor at all — the work would read the
// same for someone in Chennai, São Paulo, or Toronto. This is a first-class
// answer, not a fallback: location-agnostic tasks are the cheapest kind to keep
// portable and the collection is short on them.
export const REGION_GLOBAL = "GLOBAL";

// ISO 3166-1 alpha-2. Names are not stored here — `regionLabel` resolves them
// through Intl at render time, which keeps this list to codes and keeps the
// spelling consistent with whatever the platform already shows the user.
const ISO_3166_ALPHA2 =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN " +
  "BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL " +
  "GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM " +
  "JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME " +
  "MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP " +
  "NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD " +
  "SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO " +
  "TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

export const REGION_CODES: readonly string[] = Object.freeze(ISO_3166_ALPHA2.split(" "));

const REGION_SET = new Set<string>(REGION_CODES);

// `RegionCode` is the wire value: an ISO alpha-2 code or the GLOBAL sentinel.
export type RegionCode = string;

export function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === "string" && (value === REGION_GLOBAL || REGION_SET.has(value));
}

let regionNames: Intl.DisplayNames | null | undefined;

function displayNames(): Intl.DisplayNames | null {
  if (regionNames !== undefined) return regionNames;
  try {
    regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    // Very old runtimes, or an ICU build without region display names.
    regionNames = null;
  }
  return regionNames;
}

// The picker needs the parenthetical to say what the option means. Charts and
// chips have already established that context and only have room for the name.
export function regionShortLabel(code: string): string {
  return code === REGION_GLOBAL ? "No specific country" : regionLabel(code);
}

export function regionLabel(code: string): string {
  if (code === REGION_GLOBAL) return "No specific country (location-agnostic)";
  if (!REGION_SET.has(code)) return code;
  try {
    return displayNames()?.of(code) ?? code;
  } catch {
    return code;
  }
}

// Codes sorted by the name the author will actually read, with GLOBAL pinned
// first because it is the answer we most want people to reach for when it is
// true. Computed once — `regionLabel` is stable for the life of the page.
let sortedRegions: { code: string; label: string }[] | null = null;

export function regionOptions(): { code: string; label: string }[] {
  if (!sortedRegions) {
    const countries = REGION_CODES.map((code) => ({ code, label: regionLabel(code) })).sort((a, b) =>
      a.label.localeCompare(b.label, "en")
    );
    sortedRegions = [{ code: REGION_GLOBAL, label: regionLabel(REGION_GLOBAL) }, ...countries];
  }
  return sortedRegions;
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export type SubjectGroup = { top: string; subs: readonly string[] };

export const SUBJECT_GROUPS: readonly SubjectGroup[] = Object.freeze([
  {
    top: "Travel and Tourism",
    subs: [
      "Accommodation and Hotels",
      "Air Travel",
      "Car Rentals",
      "Ground Transportation",
      "Tourist Attractions",
      "Travel and Tourism - Other",
    ],
  },
  {
    top: "Science and Education",
    subs: [
      "Business Training",
      "Education",
      "Grants Scholarships and Financial Aid",
      "Math",
      "Universities and Colleges",
      "Weather",
      "Science and Education - Other",
    ],
  },
  {
    top: "Computers Electronics and Technology",
    subs: [
      "Computer Hardware",
      "Consumer Electronics",
      "Graphics Multimedia and Web Design",
      "Programming and Developer Software",
      "Social Media Networks",
      "Telecommunications",
      "Computers Electronics and Technology - Other",
    ],
  },
  {
    top: "Ecommerce & Shopping",
    subs: ["Coupons and Rebates", "Price Comparison", "Tickets", "Ecommerce and Shopping - Other"],
  },
  {
    top: "Health",
    subs: ["Medicine", "Mental Health", "Nutrition Diets and Fitness", "Health - Other"],
  },
  {
    top: "Food and Drink",
    subs: ["Beverages", "Cooking and Recipes", "Restaurants and Delivery", "Food and Drink - Other"],
  },
  {
    top: "Community and Society",
    subs: ["Holidays and Seasonal Events", "Philanthropy", "Community and Society - Other"],
  },
  {
    top: "Arts & Entertainment",
    subs: [
      "Books and Literature",
      "Music",
      "Performing Arts",
      "Streaming & Online TV",
      "Visual Arts and Design",
      "Arts and Entertainment - Other",
    ],
  },
  {
    top: "Lifestyle",
    subs: ["Childcare", "Fashion and Apparel", "Gifts and Flowers", "Weddings", "Lifestyle - Other"],
  },
  {
    top: "Business and Consumer Services",
    subs: [
      "Business Services",
      "Moving & Relocation",
      "Real Estate",
      "Business and Consumer Services - Other",
    ],
  },
  {
    top: "Law and Government",
    subs: ["Government", "Immigration and Visas", "Legal", "Law and Government - Other"],
  },
  {
    top: "Finance",
    subs: ["Banking Credit and Lending", "Insurance", "Finance - Other"],
  },
  {
    top: "Games",
    subs: ["Video Games Consoles and Accessories", "Games - Other"],
  },
  {
    top: "Sports",
    subs: ["Baseball", "Basketball", "Sports - Other"],
  },
  {
    top: "Jobs and Career",
    subs: ["Jobs and Employment", "Jobs and Career - Other"],
  },
  {
    top: "Hobbies and Leisure",
    subs: ["Crafts", "Photography", "Hobbies and Leisure - Other"],
  },
  {
    top: "Vehicles",
    subs: ["Makes and Models", "Vehicles - Other"],
  },
  {
    top: "Home and Garden",
    subs: ["Home Improvement and Maintenance", "Home and Garden - Other"],
  },
  {
    top: "Reference Materials",
    subs: ["Dictionaries and Encyclopedias", "Maps", "Reference Materials - Other"],
  },
  {
    top: "News & Media Publishers",
    subs: ["News & Media Publishers - Other"],
  },
  {
    top: "Heavy Industry and Engineering",
    subs: ["Construction and Maintenance", "Heavy Industry and Engineering - Other"],
  },
]);

export const SUBJECT_SEPARATOR = " > ";

// Flattened "Top > Sub" leaves, matching the dataset's `categories` strings
// exactly. This is the stored form.
export const SUBJECTS: readonly string[] = Object.freeze(
  SUBJECT_GROUPS.flatMap((g) => g.subs.map((sub) => `${g.top}${SUBJECT_SEPARATOR}${sub}`))
);

const SUBJECT_SET = new Set<string>(SUBJECTS);

// A handful of published labels name only the top-level group ("News & Media
// Publishers") with no leaf. Map those onto the group's "- Other" leaf so the
// dataset's own labels round-trip into this vocabulary without hand-editing.
const TOP_LEVEL_FALLBACK = new Map<string, string>(
  SUBJECT_GROUPS.flatMap((g) => {
    const other = g.subs.find((s) => s.endsWith("- Other"));
    return other ? [[g.top, `${g.top}${SUBJECT_SEPARATOR}${other}`] as [string, string]] : [];
  })
);

// The canonical leaf for a stored label, or null if it is not in the
// vocabulary at all. The authoring UI only ever emits canonical leaves; this
// exists for labels arriving from the published dataset or an older record.
export function normalizeSubject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (SUBJECT_SET.has(trimmed)) return trimmed;
  return TOP_LEVEL_FALLBACK.get(trimmed) ?? null;
}

export function isSubject(value: unknown): value is string {
  return normalizeSubject(value) !== null;
}

export function subjectTop(subject: string): string {
  const i = subject.indexOf(SUBJECT_SEPARATOR);
  return i === -1 ? subject : subject.slice(0, i);
}

export function subjectSub(subject: string): string {
  const i = subject.indexOf(SUBJECT_SEPARATOR);
  return i === -1 ? "" : subject.slice(i + SUBJECT_SEPARATOR.length);
}

// The dataset labels 1–3 categories per task (mode 2). One is the honest answer
// for most tasks; a cap keeps the field a classification rather than a tag
// cloud, which is what makes the distribution counts meaningful.
export const MIN_SUBJECTS = 1;
export const MAX_SUBJECTS = 3;

// ---------------------------------------------------------------------------
// Primary domains
// ---------------------------------------------------------------------------

// Derived, not asked for: the author has already named their sites via the
// scope chips, key URLs, and attachments. Asking again would get worse data.
export const MAX_PRIMARY_DOMAINS = 8;

export function normalizeDomain(raw: string): string {
  let value = (raw || "").trim().toLowerCase();
  if (!value) return "";
  // Accept a full URL, a bare host, or a host someone typed with a path.
  if (value.includes("://")) {
    try {
      value = new URL(value).host;
    } catch {
      return "";
    }
  } else {
    value = value.split("/")[0];
  }
  value = value.replace(/^www\./, "").replace(/:\d+$/, "");
  // A domain needs at least one dot and no whitespace or credentials.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return "";
  return value;
}

export function dedupeDomains(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const domain = normalizeDomain(value);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
    if (out.length >= MAX_PRIMARY_DOMAINS) break;
  }
  return out;
}

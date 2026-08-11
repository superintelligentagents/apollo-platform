import type { GuidedStep } from "./types";

// Blueprints for guided task authoring. Modeled on the anatomy of the
// benchmark's strongest hand-written tasks (KBO stadium trip, Palm Springs
// wedding, CS faculty job sweep): a first-person motive, site-anchored
// substeps, comparisons across several platforms, constraints woven in, and a
// concrete deliverable. Each filled substep later becomes one rubric item.

export type TemplateStepDef = {
  title: string;
  // Concrete example text shown as the placeholder — teaches the level of
  // specificity we want without demanding it in the UI copy.
  placeholder: string;
  hint?: string;
};

export type TaskTemplate = {
  id: string;
  title: string;
  tagline: string;
  intro_placeholder: string;
  steps: TemplateStepDef[];
};

export const DELIVERABLE_OPTIONS = [
  { value: "doc", label: "A written plan / document" },
  { value: "sheet", label: "A spreadsheet / tracker" },
  { value: "ranked", label: "A ranked list with reasoning" },
  { value: "none", label: "No artifact — the answer itself" },
  { value: "custom", label: "Something else…" },
] as const;

export type DeliverableKind = (typeof DELIVERABLE_OPTIONS)[number]["value"];

export function requiredOutputsForDeliverable(kind: DeliverableKind, custom = ""): string[] {
  if (kind === "none") return [];
  if (kind === "custom") {
    const output = custom.trim();
    return output ? [output] : [];
  }
  const option = DELIVERABLE_OPTIONS.find((candidate) => candidate.value === kind);
  return option ? [option.label] : [];
}

// The blank flow teaches task anatomy with one coherent example. The stages
// stay collapsed after the first, and authors can rename, reorder, or remove
// them, so the example remains useful without dictating the finished task.
export const BLANK_TEMPLATE: TaskTemplate = {
  id: "blank",
  title: "Write your own",
  tagline: "Build any task step by step.",
  intro_placeholder:
    "Plan a seven-day East Coast MLB trip for one traveler in the first suitable window at least 30 days from now. Include exactly three games at three different ballparks, one ticket per game, two intercity trips, and one hotel room for six total nights. Keep the complete trip under $2,500 and give me exactly seven dated daily entries with prices and booking links. Do not purchase anything; leave the choices ready for me to review.",
  steps: [
    {
      title: "Choose the games",
      placeholder:
        "Check official MLB schedules and select exactly three games at three different East Coast ballparks. For each game, record the matchup, date, start time, and one available single-seat ticket with its price including fees.",
    },
    {
      title: "Plan the route",
      placeholder:
        "For each of the two intercity legs, compare at least two train, flight, or bus options. Choose one option per leg that arrives at least three hours before the next game, and record its departure time, arrival time, duration, and price.",
    },
    {
      title: "Find places to stay",
      placeholder:
        "Choose one hotel in each of the three cities for a total of six nights. Each hotel should be rated at least 8/10 and within 30 minutes of its ballpark by public transit; record the assigned nights, nightly price, total price, and cancellation terms.",
    },
    {
      title: "Check the budget",
      placeholder:
        "Add the three game tickets, two intercity trips, six hotel nights, and $150 for local transit. Keep the total for one traveler under $2,500, show each subtotal, and flag any price that still needs confirmation.",
    },
    {
      title: "Build the itinerary",
      placeholder:
        "Produce exactly seven dated daily entries covering all three games, both intercity trips, and all six hotel nights. Include the final cost total and a source or booking link for every selected option; leave everything ready for review and do not purchase it.",
    },
  ],
};

// Journey-backed tasks stay neutral — the selected journeys ride along as a
// reference rail and should not inherit the MLB teaching example.
export const JOURNEYS_TEMPLATE: TaskTemplate = {
  id: "journeys",
  title: "Build the task from your journeys",
  tagline: "Write the steps in your own words — your journeys stay on the side for reference.",
  intro_placeholder: "In a sentence or two: what was this project about?",
  steps: [
    {
      title: "Step 1",
      placeholder: "Describe one phase of the web work: what to open, compare, verify, create, or leave ready.",
    },
  ],
};

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "trip",
    title: "Plan a trip",
    tagline: "Flights, stays, ground transport, and the things worth doing — compared, not just listed.",
    intro_placeholder:
      "I'm flying from Pittsburgh to a wedding in Palm Springs on the 3rd of next month and need a full plan I can actually see.",
    steps: [
      {
        title: "Flights",
        placeholder:
          "Search round-trip flights from Pittsburgh to LAX and separately to PSP, landing at least 2 days before the 3rd and back by the 5th; prefer non-stop, open the best option from each airport in its own tab so I can compare.",
        hint: "Compare at least two airports or platforms.",
      },
      {
        title: "Lodging",
        placeholder:
          "Find a hotel near the venue on Booking.com for those nights under $200/night, weighing price against location and review scores; leave the best listing open.",
        hint: "Say what to compare on — price, location, reviews.",
      },
      {
        title: "Ground transport",
        placeholder:
          "Check rental car options at whichever airport wins, open one listing showing vehicle type and daily rate, and check the drive time on Google Maps — I only want to drive between 9am and 4pm.",
      },
      {
        title: "Food & things to do",
        placeholder:
          "Find 2–3 places worth a stop between the airport and the hotel (I've heard good things about Soban and Holbox) — check how much each detour adds and recommend one.",
      },
      {
        title: "Put it together",
        placeholder:
          "Lay out the full day-by-day itinerary — flights, drive, hotel, car, the wedding on the 3rd, and the detour stop.",
      },
    ],
  },
  {
    id: "job-hunt",
    title: "Run a job hunt",
    tagline: "A real sweep of openings with a tracker, verified postings, and a shortlist.",
    intro_placeholder:
      "I'm getting serious about the job market and want a thorough sweep of relevant openings, not a skim of one board.",
    steps: [
      {
        title: "Set up a tracker",
        placeholder:
          "Create a spreadsheet with columns for company, role, team, location, deadline, posting link, and a verification note.",
      },
      {
        title: "Sweep the sources",
        placeholder:
          "Go through the top 50 companies on my list (or a ranking site as the master checklist) plus LinkedIn and one niche board, checking each careers page directly.",
        hint: "Name the sources and how many to cover.",
      },
      {
        title: "Verify each posting",
        placeholder:
          "Open every relevant posting's real page — not a search snippet — and record rank, area, and deadline; note verified absences too.",
      },
      {
        title: "Shortlist & next actions",
        placeholder:
          "Rank the 10 best fits for my profile, and note which have the earliest deadlines and what each application needs.",
      },
    ],
  },
  {
    id: "purchase",
    title: "Research a big purchase",
    tagline: "Build a real candidate pool, cross-check reviews, hunt prices, decide.",
    intro_placeholder:
      "I want to buy a robot vacuum that handles pet hair on hardwood, under $500, and I want the decision to be airtight.",
    steps: [
      {
        title: "Build the candidate pool",
        placeholder:
          "Find at least 10 current models that fit my constraints, using two different retailers' category pages as the backbone.",
        hint: "Say how many candidates and where from.",
      },
      {
        title: "Cross-check quality",
        placeholder:
          "For each candidate, cross-check at least two independent review sources (e.g. RTINGS, Wirecutter, verified user reviews) and capture scores or 'not reviewed'.",
      },
      {
        title: "Hunt the price",
        placeholder:
          "Compare the current price for the top contenders across at least three retailers, including any open-box or coupon options; open the best deal pages in tabs.",
      },
      {
        title: "Decide",
        placeholder:
          "Rank the top 3 with reasoning — best overall, best value, and what I'd avoid — and link the exact listing I should buy.",
      },
    ],
  },
  {
    id: "event",
    title: "Plan an event",
    tagline: "Venue, vendors, guests, budget — the whole production.",
    intro_placeholder:
      "I'm planning a 30-person rehearsal dinner in Chicago for the second Saturday of next month, budget $2,000.",
    steps: [
      {
        title: "Venue",
        placeholder:
          "Compare at least 4 private-dining venues on capacity, minimum spend, and availability for that date; open each venue's page and flag the two best.",
      },
      {
        title: "Food & vendors",
        placeholder:
          "Get sample menus or catering options for the two finalists, and check one backup option (e.g. a restaurant buyout vs. catering a rented space).",
      },
      {
        title: "Guest logistics",
        placeholder:
          "Draft the invitation details and figure out parking or transit guidance guests will need for each finalist venue.",
      },
      {
        title: "Budget it out",
        placeholder:
          "Lay out the full cost picture per finalist — venue minimum, food per head, extras — against the $2,000 budget, and recommend one.",
      },
    ],
  },
  {
    id: "catalog",
    title: "Audit a catalog or subscription",
    tagline: "Is the service actually deep enough? Sweep it, cross-check it, rank it.",
    intro_placeholder:
      "I want to know whether Netflix alone can carry a great mystery-TV run for the next few months.",
    steps: [
      {
        title: "Sweep the catalog",
        placeholder:
          "Identify at least 20 mystery series actually available on the service, using its own browse/search pages as the backbone.",
        hint: "Set the pool size — 20 is a real sweep.",
      },
      {
        title: "Cross-check each candidate",
        placeholder:
          "For each title, capture the hook, sub-genre, episode commitment, and an IMDb or Rotten Tomatoes score from outside pages — or 'not shown'.",
      },
      {
        title: "Narrow with diversity",
        placeholder:
          "Cut to the 10 strongest, making sure they aren't all the same flavor and include at least 2 non-English picks if the catalog supports it.",
      },
      {
        title: "Rank and recommend",
        placeholder:
          "Rank 1–10 with what to start first, best short run, best long binge — and the verdict: is the service enough on its own?",
      },
    ],
  },
  {
    id: "move",
    title: "Plan a move",
    tagline: "Housing, neighborhoods, costs, logistics — a decision you can defend.",
    intro_placeholder:
      "I'm relocating to Seattle in three months for work and need to pick a neighborhood and a plan before my visit.",
    steps: [
      {
        title: "Housing search",
        placeholder:
          "Pull at least 8 current listings matching my budget and needs across two platforms (e.g. Zillow and Apartments.com); open the best 4 in tabs.",
      },
      {
        title: "Neighborhood research",
        placeholder:
          "For each candidate neighborhood, check commute time to the office, walkability, and one local forum or guide's take.",
      },
      {
        title: "Costs & logistics",
        placeholder:
          "Estimate the full move cost — movers or truck across two quotes, deposits, utility setup — and note lease timing against my start date.",
      },
      {
        title: "Decide",
        placeholder:
          "Rank the neighborhoods with reasoning and lay out the visit-day schedule for touring the top listings.",
      },
    ],
  },
];

// Chosen to read naturally in front of a bare verb phrase ("…, search flights…").
const CONNECTORS = ["First,", "Then", "After that,", "Next,", "From there,", "Finally,"];

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const ended = /[.!?]$/.test(t) ? t : `${t}.`;
  return ended;
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

const DELIVERABLE_SENTENCES: Record<DeliverableKind, string> = {
  doc: "When it all comes together, put everything into a single document laying out the full plan, and leave it open so I can review it.",
  sheet: "Keep the spreadsheet updated as you go so every row reflects a page you actually verified, and leave it open at the end.",
  ranked: "End with a clear ranked list with your reasoning, so I can act on it without re-doing the research.",
  none: "",
  custom: "", // replaced by the author's own words (customDeliverable)
};

// Assemble the first-person request from the intro + filled substeps, in the
// register of the benchmark's hand-written tasks. The participant can still
// edit the result freely in the form.
export function assembleRequest(
  intro: string,
  steps: GuidedStep[],
  deliverable: DeliverableKind,
  customDeliverable = ""
): string {
  const parts: string[] = [];
  const cleanIntro = sentence(intro);
  if (cleanIntro) parts.push(cleanIntro);

  const filled = steps.filter((s) => s.description.trim());
  filled.forEach((s, i) => {
    const connector = CONNECTORS[Math.min(i, CONNECTORS.length - 1)];
    parts.push(sentence(`${connector} ${lowerFirst(s.description.trim())}`));
  });

  const custom = customDeliverable.trim();
  // A noun phrase ("a booking confirmation") reads as "At the end, I want …";
  // an imperative ("Book the flight and email me") stands as its own sentence.
  const NOUNISH = /^(a|an|the|my|our|some|one|two|three|\d)\b/i;
  const closing =
    deliverable === "custom"
      ? custom
        ? NOUNISH.test(custom)
          ? sentence(`At the end, I want ${lowerFirst(custom)}`)
          : sentence(custom.charAt(0).toUpperCase() + custom.slice(1))
        : ""
      : DELIVERABLE_SENTENCES[deliverable];
  if (closing) parts.push(closing);
  return parts.join(" ");
}

export const MIN_STEP_LENGTH = 15;

// The single definition of which guided steps count: substantive description,
// never a blank title. Used by the editor gate, the payload, and validation.
export function substantiveSteps(steps: GuidedStep[]): GuidedStep[] {
  return steps
    .filter((s) => s.description.trim().length >= MIN_STEP_LENGTH)
    .map((s, i) => ({
      order: i,
      title: s.title.trim() || `Step ${i + 1}`,
      description: s.description.trim(),
    }));
}

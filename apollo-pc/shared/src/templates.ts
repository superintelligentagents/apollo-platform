// Task templates matching the MyPCBench behavioral taxonomy. Same anatomy as
// apollo-v2's blueprints: steps with teaching placeholders in [brackets] the
// author must replace; constraints are advisory (soft gates) except where a
// category is meaningless without them.

import type { PCTaskCategory, PCTaskStep, SourceKind } from "./types";

export type PCTemplate = {
  id: string;
  category: PCTaskCategory;
  title: string;
  tagline: string;
  minSourceKinds: number;
  suggestedSources: SourceKind[];
  requiresExpectedAnswer: boolean;
  requestScaffold: string;
  steps: { title: string; placeholder: string }[];
};

export const PC_TEMPLATES: PCTemplate[] = [
  {
    id: "free-form-long-horizon",
    category: "multi_step_orchestration",
    title: "Free-form personal workflow",
    tagline: "Turn a larger goal into clear, editable steps. Attaching imported records is optional.",
    minSourceKinds: 0,
    suggestedSources: [],
    requiresExpectedAnswer: false,
    requestScaffold: "",
    steps: [
      {
        title: "Choose the games",
        placeholder:
          "Example: Check official MLB schedules and select exactly three games at three different East Coast ballparks. For each game, record the matchup, date, start time, and one available single-seat ticket with its price including fees.",
      },
      {
        title: "Plan the route",
        placeholder:
          "Example: For each of the two intercity legs, compare at least two train, flight, or bus options. Choose one option per leg that arrives at least three hours before the next game, and record its departure time, arrival time, duration, and price.",
      },
      {
        title: "Find places to stay",
        placeholder:
          "Example: Choose one hotel in each of the three cities for a total of six nights. Each hotel should be rated at least 8/10 and within 30 minutes of its ballpark by public transit; record the assigned nights, nightly price, total price, and cancellation terms.",
      },
      {
        title: "Check the budget",
        placeholder:
          "Example: Add the three game tickets, two intercity trips, six hotel nights, and $150 for local transit. Keep the total for one traveler under $2,500, show each subtotal, and flag any price that still needs confirmation.",
      },
      {
        title: "Build the itinerary",
        placeholder:
          "Example: Produce exactly seven dated daily entries covering all three games, both intercity trips, and all six hotel nights. Include the final cost total and a source or booking link for every selected option; leave everything ready for review and do not purchase it.",
      },
    ],
  },
  {
    id: "match-money",
    category: "cross_source_reconciliation",
    title: "Match the money",
    tagline: "Tie a purchase to its confirmation email and calendar fallout.",
    minSourceKinds: 2,
    suggestedSources: ["orders", "email", "calendar"],
    requiresExpectedAnswer: false,
    requestScaffold:
      "Check my recent [merchant] order and verify everything lines up: find the order confirmation email, confirm the amount matches what was charged, and [what else should the agent cross-check?].",
    steps: [
      { title: "Find the order", placeholder: "Which order or purchase should the agent start from?" },
      { title: "Locate the confirmation", placeholder: "Where is the matching email/receipt, and what should match?" },
      { title: "Reconcile", placeholder: "What discrepancy or confirmation should the agent report?" },
    ],
  },
  {
    id: "add-it-up",
    category: "aggregation_reporting",
    title: "Add it up",
    tagline: "Total spend, meetings, or messages over a window.",
    minSourceKinds: 1,
    suggestedSources: ["orders", "email", "calendar"],
    requiresExpectedAnswer: true,
    requestScaffold:
      "Go through my [source, e.g. food delivery receipts] from [time window] and put together a summary: total spent, [breakdown you want], and [anything notable].",
    steps: [
      { title: "Gather", placeholder: "What should the agent collect, over which dates?" },
      { title: "Compute", placeholder: "What totals or breakdowns should it produce?" },
      { title: "Report", placeholder: "What does the final summary look like?" },
    ],
  },
  {
    id: "find-detail",
    category: "personal_lookup",
    title: "Find the detail",
    tagline: "A confirmation number, an address, a specific attachment.",
    minSourceKinds: 1,
    suggestedSources: ["email", "calendar"],
    requiresExpectedAnswer: true,
    requestScaffold: "Find [the specific detail — confirmation number, address, name, date] for [the event/purchase/trip it belongs to].",
    steps: [
      { title: "Identify", placeholder: "What exactly is the agent looking for?" },
      { title: "Locate", placeholder: "Roughly where does it live (without giving the answer away)?" },
    ],
  },
  {
    id: "spot-pattern",
    category: "pattern_inference",
    title: "Spot the pattern",
    tagline: "Subscriptions, recurring meetups, habits hiding in the data.",
    minSourceKinds: 1,
    suggestedSources: ["orders", "calendar", "email"],
    requiresExpectedAnswer: true,
    requestScaffold:
      "Look through my [emails/orders/calendar] and figure out [the recurring pattern — e.g. which subscriptions I pay for, who I meet most often, my usual coffee order].",
    steps: [
      { title: "Scan", placeholder: "What data should the agent look across?" },
      { title: "Infer", placeholder: "What pattern should it find? (Put the answer in Expected answer, not here.)" },
    ],
  },
  {
    id: "get-it-done",
    category: "multi_step_orchestration",
    title: "Get it done",
    tagline: "A real errand spanning calendar, contacts, and mail.",
    minSourceKinds: 2,
    suggestedSources: ["calendar", "email"],
    requiresExpectedAnswer: false,
    requestScaffold:
      "Help me [the errand — e.g. schedule a catch-up with X]: check my calendar for [constraints], find [the contact/detail needed], and draft [the message/output].",
    steps: [
      { title: "Check", placeholder: "What state should the agent gather first (availability, addresses…)?" },
      { title: "Decide", placeholder: "What choice does it need to make, under which constraints?" },
      { title: "Produce", placeholder: "What is the final deliverable — a draft email, an event, a list?" },
    ],
  },
];

export const MIN_STEP_LENGTH = 12;

export function substantiveSteps(steps: PCTaskStep[]): PCTaskStep[] {
  return steps
    .filter((s) => s.description.trim().length >= MIN_STEP_LENGTH)
    .map((s, i) => ({ ...s, order: i }));
}

export function seedCriteriaFromSteps(steps: PCTaskStep[]): string[] {
  return steps.map((s) => s.description.trim()).filter(Boolean);
}

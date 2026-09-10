import type { PCTaskCategory, SourceKind, SourceRecord } from "./types";
import { emailService } from "./email-services";

export type AppCategory = "communication" | "productivity" | "career" | "finance" | "travel" | "food" | "shopping";

export type MyPCBenchApp = {
  id: string;
  name: string;
  analogue: string;
  category: AppCategory;
  url: string;
  description: string;
  keywords: string[];
  nativeSources?: SourceKind[];
  task: {
    category: PCTaskCategory;
    title: string;
    request: string;
    steps: Array<{ title: string; description: string }>;
    successCriteria: string[];
    requiredOutputs: string[];
    subjects: string[];
  };
};

export type AppRecommendation = {
  app: MyPCBenchApp;
  score: number;
  recordIds: string[];
  reason: string;
};

export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
  communication: "Communication",
  productivity: "Work & planning",
  career: "Career",
  finance: "Money",
  travel: "Travel",
  food: "Food & dining",
  shopping: "Shopping",
};

const EMAIL_SERVICE_TO_APP: Record<string, string> = {
  "google-calendar": "hoolicalendar",
  gmail: "hoolimail",
  whatsapp: "hoolichat",
  slack: "hooliwork",
  sprintboard: "sprintboard",
  linkedin: "lockedin",
  chase: "gringotts",
  robinhood: "batbucks",
  turbotax: "speedtax",
  delta: "dinoco",
  airbnb: "cheskepdia",
  uber: "etaxi",
  doordash: "hangrydash",
  opentable: "tablefind",
  amazon: "hoolishop",
  instacart: "kwik-e-mart",
  polymarket: "oddsmarket",
};

export const MYPCBENCH_APPS: MyPCBenchApp[] = [
  app("hoolimail", "HooliMail", "Gmail", "communication", "https://hoolimail.mypcbench.app/?_autologin=1", "Search, organize, and act on mail.", ["gmail", "email", "mailbox", "inbox", "newsletter", "follow up", "reply"], ["email"], "personal_lookup", "Handle an email follow-up", "Use HooliMail to find the relevant conversation in my attached mail history, identify the latest open request, and prepare the appropriate reply or mailbox action. Report what you found and what you changed.", [step("Find the conversation", "Search HooliMail for the conversation or sender represented by the attached records and open the latest relevant thread."), step("Resolve the request", "Determine the open request or next action from the thread, then complete the requested mail action."), step("Report the result", "Summarize the thread used, the action taken, and anything that still needs a decision.")], ["Uses the latest relevant HooliMail thread", "Completes or drafts the requested mail action", "Reports the result without exposing unrelated mail"], ["Conversation identified", "Mail action result", "Brief completion summary"], ["Telecommunications"]),
  app("hoolicalendar", "HooliCalendar", "Google Calendar", "productivity", "https://hoolicalendar.mypcbench.app/?_autologin=1", "Plan and update calendar events.", ["google calendar", "calendar", "meeting", "appointment", "schedule", "invite", "availability"], ["calendar"], "multi_step_orchestration", "Turn a plan into a calendar event", "Use HooliCalendar and the attached history to identify the relevant date, attendees, and constraints, then create or update the matching event. Avoid changing unrelated events and report the final event details.", [step("Read the constraints", "Use the attached mail and calendar context to identify the date, time, attendees, location, and any conflicts."), step("Update the calendar", "Create or edit the matching HooliCalendar event with the supported details and invitees."), step("Verify", "Confirm the final date, time, title, attendees, and location after the change.")], ["Uses the attached scheduling constraints", "Leaves unrelated events unchanged", "Verifies the final event"], ["Final event details", "Conflict or constraint notes"], ["Business Services"]),
  app("hoolichat", "HooliChat", "WhatsApp", "communication", "https://buzzchat.mypcbench.app/?_autologin=1", "Coordinate through personal chat.", ["whatsapp", "chat", "message", "group chat", "text message", "dm"], ["messages"], "multi_step_orchestration", "Send the right chat update", "Use HooliChat and the attached context to find the appropriate conversation, prepare the requested update, and send it to the correct person or group. Verify the sent message and avoid unrelated chats.", [step("Find the chat", "Locate the correct HooliChat conversation using the attached context."), step("Prepare the update", "Write a concise message that includes the required details and respects the conversation context."), step("Send and verify", "Send the message and verify that it appears in the intended conversation.")], ["Uses the correct conversation", "Includes the required details", "Verifies the sent message"], ["Recipient or group", "Sent message", "Verification"], ["Telecommunications"]),
  app("hooliwork", "HooliWork", "Slack", "communication", "https://workbuzz.mypcbench.app/?_autologin=1", "Coordinate work in channels and direct messages.", ["slack", "teams", "channel", "standup", "coworker", "work message"], undefined, "multi_step_orchestration", "Post a work update", "Use HooliWork and the attached history to find the relevant project channel or direct message, write a complete update, and post it in the right place. Include decisions, owners, and next steps when the source material supports them.", [step("Locate the work context", "Find the HooliWork channel or conversation that matches the attached project context."), step("Draft the update", "Write an accurate update with the current status, decisions, owners, and next steps supported by the records."), step("Post and verify", "Post it in the correct place and verify the message is visible.")], ["Uses the correct work conversation", "Preserves facts from the attached context", "Makes ownership and next steps clear"], ["Channel or recipient", "Posted update", "Next steps"], ["Business Services"]),
  app("sprintboard", "SprintBoard", "Jira / Asana", "productivity", "https://sprintboard.mypcbench.app/?_autologin=1", "Turn work history into trackable issues.", ["jira", "asana", "ticket", "issue", "sprint", "backlog", "project", "deadline", "bug"], undefined, "multi_step_orchestration", "Create or update a project issue", "Use SprintBoard and the attached work context to create or update the correct issue. Capture the goal, acceptance criteria, owner, priority, and due date when available, then verify the board state.", [step("Find the project", "Identify the SprintBoard project and check for an existing matching issue."), step("Write the issue", "Create or update the issue with a clear summary, description, acceptance criteria, owner, priority, and due date supported by the context."), step("Verify the board", "Confirm the issue appears in the intended project and status.")], ["Avoids creating a duplicate issue", "Captures the supported requirements", "Verifies the final board state"], ["Issue link or identifier", "Final issue fields", "Board status"], ["Business Services"]),
  app("lockedin", "LockedIn", "LinkedIn", "career", "https://lockedin.mypcbench.app/profile?_autologin=1", "Keep a professional profile current.", ["linkedin", "resume", "résumé", "curriculum vitae", "cv", "job", "career", "employment", "experience", "skills"], ["documents"], "cross_source_reconciliation", "Update my LockedIn profile from my resume", "Using the attached resume or career records, update my LockedIn profile so the headline, experience, education, and skills reflect the source material. Preserve existing facts that are not superseded, avoid inventing details, and report each profile change.", [step("Compare the sources", "Open the LockedIn profile and compare its headline, experience, education, and skills with the attached resume or career records."), step("Update the profile", "Apply supported corrections and additions without inventing employers, dates, credentials, or skills."), step("Verify and report", "Re-open the updated sections and list every change plus any ambiguity left unresolved.")], ["Every change is supported by an attached source", "Existing accurate information remains intact", "The final profile is re-checked"], ["Changed profile sections", "Before-and-after summary", "Unresolved discrepancies"], ["Jobs and Employment"]),
  app("gringotts", "Gringotts", "Chase", "finance", "https://vaultbank.mypcbench.app/?_autologin=1", "Review banking activity and payments.", ["chase", "bank", "checking", "savings", "credit card", "statement", "payment", "charge", "deposit"], ["transactions"], "cross_source_reconciliation", "Reconcile a banking item", "Use Gringotts and the attached records to locate the relevant account activity, reconcile the amount and date against the source evidence, and report whether they agree. Do not move money unless the request explicitly requires it.", [step("Find the activity", "Locate the relevant account, transaction, statement, or payment in Gringotts."), step("Reconcile", "Compare the amount, date, merchant, and status with the attached evidence."), step("Report", "State whether the records agree and identify any discrepancy that needs follow-up.")], ["Uses the correct account activity", "Compares the supported fields", "Clearly reports discrepancies"], ["Matched activity", "Reconciliation result", "Follow-up items"], ["Banking Credit and Lending"]),
  app("batbucks", "BatBucks", "Robinhood", "finance", "https://batbucks.mypcbench.app/?_autologin=1", "Inspect investments and trade decisions.", ["robinhood", "brokerage", "stock", "shares", "portfolio", "dividend", "investment", "trade", "ticker"], undefined, "aggregation_reporting", "Review an investment position", "Use BatBucks and the attached context to inspect the relevant position or watchlist item, calculate the requested portfolio facts, and report them with the exact values shown in the app. Only place a trade when the request explicitly calls for one.", [step("Locate the asset", "Find the relevant asset, position, or watchlist entry in BatBucks."), step("Analyze", "Collect the requested price, quantity, gain or loss, and account values shown in the app."), step("Report or act", "Provide the requested result and verify any explicitly requested portfolio change.")], ["Uses values shown in BatBucks", "Shows the requested calculation", "Verifies any change"], ["Position details", "Calculation", "Action status"], ["Finance - Other"]),
  app("speedtax", "SpeedTax", "TurboTax", "finance", "https://speedtax.mypcbench.app/?_autologin=1", "Reconcile tax forms and filing details.", ["turbotax", "irs", "tax", "w-2", "w2", "1099", "deduction", "filing", "refund"], ["documents"], "cross_source_reconciliation", "Reconcile a tax document", "Use SpeedTax and the attached tax document or records to verify the matching filing fields. Correct only values supported by the source, flag discrepancies, and report the final values without exposing unrelated sensitive information.", [step("Open the matching section", "Find the SpeedTax form or filing section represented by the attached source."), step("Compare fields", "Check names, employer or payer, income, withholding, and other requested fields against the source document."), step("Correct and verify", "Apply supported corrections, re-check the section, and report discrepancies that remain.")], ["Uses the matching source document", "Does not invent tax values", "Verifies corrected fields"], ["Compared fields", "Corrections made", "Remaining discrepancies"], ["Government"]),
  app("dinoco", "Dinoco Airlines", "Delta", "travel", "https://dinoco.mypcbench.app/book?_autologin=1", "Search and manage air travel.", ["delta", "united", "american airlines", "airline", "flight", "airport", "boarding", "itinerary", "fare", "flymiles"], undefined, "multi_step_orchestration", "Plan a flight from my history", "Use Dinoco Airlines and the attached mail or calendar records to search for flights that fit the trip dates, route, baggage, and timing constraints. Compare viable options and leave the best one ready for review without purchasing it.", [step("Read the trip constraints", "Extract the route, dates, timing, passenger, and baggage constraints from the attached records."), step("Search Dinoco", "Search Dinoco Airlines and compare viable itineraries, fare classes, and total prices."), step("Prepare the result", "Select the best supported option, leave it ready for review, and record the itinerary and total price without purchasing.")], ["Uses the dates and route in the attached records", "Compares more than one viable flight when available", "Does not purchase the itinerary"], ["Compared flight options", "Recommended itinerary", "Total price and fare conditions"], ["Air Travel"]),
  app("cheskepdia", "Cheskepdia", "Airbnb", "travel", "https://cheskepdia.mypcbench.app/?_autologin=1", "Find and manage places to stay.", ["airbnb", "hotel", "lodging", "accommodation", "check-in", "checkout", "check-out", "guest", "stay", "reservation"], undefined, "multi_step_orchestration", "Find a stay for an upcoming trip", "Use Cheskepdia and the attached trip context to find lodging that fits the dates, location, guest count, budget, and amenity constraints. Compare viable stays and report the best option without booking it.", [step("Read the stay constraints", "Identify the dates, destination, guests, budget, and required amenities from the attached history."), step("Compare stays", "Search Cheskepdia and compare available properties using total price, location, rating, and cancellation terms."), step("Recommend", "Report the best supported stay and alternatives, including total prices, without booking.")], ["Uses the attached trip constraints", "Compares viable available stays", "Does not book"], ["Compared stays", "Recommended property", "Total price and cancellation terms"], ["Accommodation and Hotels"]),
  app("etaxi", "eTaxi", "Uber", "travel", "https://etaxi.mypcbench.app/?_autologin=1", "Plan and manage rides.", ["uber", "lyft", "taxi", "ride", "pickup", "dropoff", "drop-off", "driver", "car service"], undefined, "multi_step_orchestration", "Plan a ride around my schedule", "Use eTaxi and the attached calendar or travel history to prepare a ride with the correct pickup, destination, timing, and ride type. Confirm the estimate and leave it ready for review unless the request explicitly asks to book.", [step("Read the ride constraints", "Identify pickup, destination, arrival time, passengers, and any luggage or accessibility needs."), step("Prepare the ride", "Enter the route and compare the supported eTaxi ride options and estimates."), step("Verify", "Report the chosen option, pickup time, arrival estimate, and price before any booking.")], ["Uses the correct route and timing", "Reports the estimate", "Avoids unintended booking"], ["Ride option", "Pickup and arrival estimate", "Price"], ["Ground Transportation"]),
  app("hangrydash", "HangryDash", "DoorDash", "food", "https://hangrydash.mypcbench.app/?_autologin=1", "Order meals and review delivery history.", ["doordash", "uber eats", "grubhub", "delivery", "takeout", "restaurant", "lunch", "dinner", "food order"], undefined, "multi_step_orchestration", "Prepare a meal order", "Use HangryDash and the attached context to choose a meal that fits the requested people, dietary constraints, timing, and budget. Build the order, verify fees and delivery details, and leave it ready for review without placing it.", [step("Read the meal constraints", "Identify the people, dietary needs, delivery location, timing, and budget from the attached context."), step("Build the order", "Choose a suitable restaurant and add items that satisfy the constraints."), step("Check the total", "Verify quantities, substitutions, fees, address, and estimated delivery time, then leave the cart ready for review.")], ["Satisfies stated dietary and quantity constraints", "Shows the full total and delivery estimate", "Does not place the order"], ["Cart contents", "Fees and total", "Delivery estimate"], ["Restaurants and Delivery"]),
  app("tablefind", "TableFind", "OpenTable", "food", "https://tablefind.mypcbench.app/?_autologin=1", "Find and manage restaurant reservations.", ["opentable", "resy", "reservation", "restaurant", "dinner", "lunch", "brunch", "party of", "table"], undefined, "multi_step_orchestration", "Find a restaurant reservation", "Use TableFind and the attached plans to find a reservation that fits the date, time, party size, location, cuisine, and accessibility constraints. Compare openings and leave the best one ready for review without booking.", [step("Read the dining plan", "Identify date, time, party size, location, cuisine, budget, and accessibility constraints."), step("Compare openings", "Search TableFind and compare available restaurants using the stated constraints."), step("Recommend", "Report the best available time and restaurant plus alternatives, without booking.")], ["Uses the attached dining constraints", "Checks live availability", "Does not book"], ["Available reservations", "Recommended table", "Constraint check"], ["Restaurants and Delivery"]),
  app("hoolishop", "HooliShop", "Amazon", "shopping", "https://hoolishop.mypcbench.app/?_autologin=1", "Research products and manage orders.", ["amazon", "online order", "shipping", "delivery date", "return", "wishlist", "product", "purchase"], ["orders"], "multi_step_orchestration", "Research a product from my history", "Use HooliShop and the attached history to find products that satisfy the requested specifications, budget, and delivery date. Compare viable options and leave the best one ready for review without purchasing it.", [step("Read the requirements", "Identify the specifications, quantity, budget, and delivery deadline in the attached context."), step("Compare products", "Search HooliShop and compare viable items using price, rating, seller, and delivery date."), step("Prepare the result", "Report the best option and alternatives with totals, and leave the cart unchanged unless asked.")], ["Matches the stated specifications", "Compares viable products", "Does not purchase"], ["Compared products", "Recommended item", "Price and delivery date"], ["Ecommerce and Shopping - Other"]),
  app("kwik-e-mart", "Kwik-E-Mart", "Instacart", "shopping", "https://kwik-e-mart.mypcbench.app/?_autologin=1", "Build and manage grocery orders.", ["instacart", "grocery", "groceries", "supermarket", "pantry", "shopping list", "ingredients"], undefined, "multi_step_orchestration", "Build a grocery cart", "Use Kwik-E-Mart and the attached meal plan, list, or history to build a grocery cart with the correct quantities, substitutions, budget, and delivery timing. Verify the total and leave it ready for review without ordering.", [step("Read the list", "Extract the needed items, quantities, dietary constraints, budget, and delivery timing."), step("Build the cart", "Find suitable products in Kwik-E-Mart and choose supported substitutions when necessary."), step("Verify", "Check quantities, substitutions, fees, total, and delivery window, then leave the cart ready for review.")], ["Includes every required item or flags it unavailable", "Respects dietary and budget constraints", "Does not order"], ["Cart contents", "Substitutions", "Fees, total, and delivery window"], ["Ecommerce and Shopping - Other"]),
  app("oddsmarket", "OddsMarket", "Polymarket", "finance", "https://oddsmarket.mypcbench.app/?_autologin=1", "Inspect prediction markets and positions.", ["polymarket", "prediction market", "odds", "probability", "market outcome", "contract", "forecast"], undefined, "aggregation_reporting", "Research a prediction market", "Use OddsMarket and the attached context to locate the relevant market, compare the current probabilities and position details, and report the requested analysis. Only place or close a position when the request explicitly requires it.", [step("Find the market", "Locate the OddsMarket question or category that matches the attached context."), step("Analyze", "Collect the current probabilities, market status, and any relevant position details."), step("Report or act", "Provide the requested comparison and verify any explicitly requested change.")], ["Uses the correct live market", "Reports current values shown in the app", "Verifies any position change"], ["Market and status", "Probability comparison", "Position or action result"], ["Finance - Other"]),
];

function app(
  id: string,
  name: string,
  analogue: string,
  category: AppCategory,
  url: string,
  description: string,
  keywords: string[],
  nativeSources: SourceKind[] | undefined,
  taskCategory: PCTaskCategory,
  title: string,
  request: string,
  steps: Array<{ title: string; description: string }>,
  successCriteria: string[],
  requiredOutputs: string[],
  subjects: string[]
): MyPCBenchApp {
  return { id, name, analogue, category, url, description, keywords, nativeSources, task: { category: taskCategory, title, request, steps, successCriteria, requiredOutputs, subjects } };
}

function step(title: string, description: string): { title: string; description: string } {
  return { title, description };
}

export function recordAppScore(record: SourceRecord, candidate: MyPCBenchApp): number {
  const text = recordSignal(record);
  let score = candidate.nativeSources?.includes(record.source) ? 2 : 0;
  if (record.source === "email") {
    const service = emailService(record);
    if (service && EMAIL_SERVICE_TO_APP[service.id] === candidate.id) score += 12;
  }
  for (const keyword of candidate.keywords) {
    if (containsPhrase(text, keyword)) score += keyword.includes(" ") ? 5 : 3;
  }
  return score;
}

export function appIdsForRecord(record: SourceRecord): string[] {
  return MYPCBENCH_APPS.filter((candidate) => recordAppScore(record, candidate) > 0).map((candidate) => candidate.id);
}

export function historyAppCounts(records: Iterable<SourceRecord>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const id of appIdsForRecord(record)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function recommendApps(records: Iterable<SourceRecord>, limit = 6): AppRecommendation[] {
  const rows = [...records];
  return MYPCBENCH_APPS.map((candidate) => {
    const matches = rows
      .map((record) => ({ record, score: recordAppScore(record, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || (b.record.timestamp || "").localeCompare(a.record.timestamp || ""));
    const score = matches.reduce((sum, entry) => sum + entry.score, 0);
    return {
      app: candidate,
      score,
      recordIds: matches.slice(0, 24).map((entry) => entry.record.id),
      reason: recommendationReason(candidate, matches.map((entry) => entry.record)),
    };
  })
    .filter((recommendation) => recommendation.score > 0)
    .sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name))
    .slice(0, Math.max(0, limit));
}

function recommendationReason(candidate: MyPCBenchApp, records: SourceRecord[]): string {
  const counts = new Map<SourceKind, number>();
  for (const record of records) counts.set(record.source, (counts.get(record.source) ?? 0) + 1);
  const parts = [...counts].map(([kind, count]) => `${count.toLocaleString()} ${sourceLabel(kind, count)}`);
  return parts.length
    ? `${parts.join(" and ")} ${records.length === 1 ? "suggests" : "suggest"} a ${candidate.analogue}-style workflow.`
    : `A ${candidate.analogue}-style workflow fits this history.`;
}

function sourceLabel(kind: SourceKind, count: number): string {
  if (kind === "email") return count === 1 ? "mail item" : "mail items";
  if (kind === "calendar") return count === 1 ? "calendar event" : "calendar events";
  if (kind === "documents") return count === 1 ? "document" : "documents";
  if (kind === "orders") return count === 1 ? "purchase" : "purchases";
  if (kind === "messages") return count === 1 ? "message" : "messages";
  if (kind === "transactions") return count === 1 ? "transaction" : "transactions";
  return count === 1 ? "contact" : "contacts";
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = phrase.toLowerCase();
  if (normalized.length <= 3) return new RegExp(`(^|[^a-z0-9])${escapeRegex(normalized)}([^a-z0-9]|$)`, "i").test(text);
  return text.includes(normalized);
}

function recordSignal(record: SourceRecord): string {
  switch (record.source) {
    case "email":
      return [record.from.name, record.from.email, ...record.to.flatMap((address) => [address.name, address.email]), record.subject, record.snippet, ...record.labels].join(" ").toLowerCase();
    case "calendar":
      return [record.summary, record.description, record.location, record.organizer?.name, record.organizer?.email].filter(Boolean).join(" ").toLowerCase();
    case "documents":
      return [record.filename, record.title, record.text].join(" ").toLowerCase();
    case "contacts":
      return [record.fullName, record.org, ...record.emails].filter(Boolean).join(" ").toLowerCase();
    case "messages":
      return [record.chatName, record.sender, record.text].join(" ").toLowerCase();
    case "orders":
      return [record.merchant, ...record.items.map((item) => item.title)].join(" ").toLowerCase();
    case "transactions":
      return [record.description, record.account, record.category].filter(Boolean).join(" ").toLowerCase();
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

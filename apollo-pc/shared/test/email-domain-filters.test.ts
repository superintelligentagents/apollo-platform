// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type Ctx } from "../src/ui/context";
import { emailActivitySummary, emailDirection } from "../src/email-activity";
import { MYPCBENCH_EMAIL_SERVICES, emailMatchesService, emailService, emailServiceOptions, registrableSenderDomain } from "../src/email-services";
import { emailDomainCounts, renderEmailItems, senderDomain } from "../src/ui/screens/items";
import type { EmailRecord, ItemDecision } from "../src/types";

const email = (id: string, from: string, subject: string): EmailRecord => ({
  id,
  source: "email",
  sourceDetail: "gmail-mbox",
  timestamp: "2026-08-01T00:00:00Z",
  searchText: `${from} ${subject}`.toLowerCase(),
  messageId: id,
  from: { name: subject, email: from },
  to: [],
  cc: [],
  subject,
  snippet: "",
  bodyRef: true,
  bodyTruncated: false,
  labels: [],
  hasListUnsubscribe: false,
  attachments: [],
});

function testCtx(records: EmailRecord[]): Ctx {
  const state = initialState();
  state.filters.source = "email";
  state.records = new Map(records.map((record) => [record.id, record]));
  const decision = (): ItemDecision => ({ included: true, edits: {}, bodyEdit: null, maskOverrides: {} });
  return {
    state,
    rerender: vi.fn(),
    autosave: vi.fn(),
    actions: {
      defaultIncluded: () => true,
      isIncluded: () => true,
      decisionFor: decision,
      toggleInclude: vi.fn(),
      bulkInclude: vi.fn(),
      bulkIncludeSources: vi.fn(),
      openItem: vi.fn(),
      updateEntity: vi.fn(),
      goto: vi.fn(),
    },
  } as unknown as Ctx;
}

describe("actual email sender-domain filters", () => {
  afterEach(() => vi.useRealTimers());

  it("normalizes and ranks the domains found in From addresses", () => {
    const records = [
      email("a1", "orders@Amazon.com", "Amazon one"),
      email("a2", "shipping@amazon.com", "Amazon two"),
      email("i1", "orders@instacart.com", "Instacart"),
      email("u1", "receipts@uber.com", "Uber"),
    ];
    expect(senderDomain(records[0])).toBe("amazon.com");
    expect(emailDomainCounts(records)).toEqual([
      { label: "amazon.com", count: 2 },
      { label: "instacart.com", count: 1 },
      { label: "uber.com", count: 1 },
    ]);
  });

  it("builds options from the import and filters by an exact domain", () => {
    const ctx = testCtx([
      email("a1", "orders@amazon.com", "Amazon"),
      email("i1", "orders@instacart.com", "Instacart"),
      email("u1", "receipts@uber.com", "Uber"),
      email("n1", "alerts@notuber.com", "Not Uber"),
    ]);
    const root = renderEmailItems(ctx);
    const select = root.querySelector<HTMLSelectElement>('[data-testid="email-domain-filter"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "All sender domains (4 messages)",
      "amazon.com · 1",
      "instacart.com · 1",
      "notuber.com · 1",
      "uber.com · 1",
    ]);

    select.value = "uber.com";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ctx.state.filters.domain).toBe("uber.com");

    const filtered = renderEmailItems(ctx);
    expect(filtered.querySelectorAll(".item-row")).toHaveLength(1);
    expect(filtered.querySelector(".item-row")?.textContent).toContain("Uber");
    expect(filtered.querySelector(".item-row")?.textContent).not.toContain("Not Uber");
  });

  it("keeps the sender field focused long enough to accept a complete typed value", () => {
    vi.useFakeTimers();
    const ctx = testCtx([
      email("u1", "receipts@uber.com", "Uber Receipts"),
      email("n1", "alerts@notuber.com", "Negative Control"),
    ]);
    const root = renderEmailItems(ctx);
    const sender = root.querySelector<HTMLInputElement>('[data-testid="email-sender-filter"]')!;

    for (const character of "Uber Receipts") {
      sender.value += character;
      sender.dispatchEvent(new Event("input", { bubbles: true }));
    }

    expect(ctx.state.filters.sender).toBe("Uber Receipts");
    expect(ctx.rerender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(ctx.rerender).toHaveBeenCalledTimes(1);

    const filtered = renderEmailItems(ctx);
    expect(filtered.querySelectorAll(".item-row")).toHaveLength(1);
    expect(filtered.querySelector(".item-row")?.textContent).toContain("Uber Receipts");
  });
});

describe("MyPCBench real-service and clone filters", () => {
  it("covers all 17 canonical apps and the legacy clone names", () => {
    expect(MYPCBENCH_EMAIL_SERVICES).toHaveLength(17);
    expect(MYPCBENCH_EMAIL_SERVICES.map(({ realName, cloneName }) => `${realName} ↔ ${cloneName}`)).toEqual([
      "Google Calendar ↔ HooliCalendar",
      "Gmail ↔ HooliMail",
      "WhatsApp ↔ HooliChat",
      "Slack ↔ HooliWork",
      "Jira / Asana ↔ SprintBoard",
      "LinkedIn ↔ LockedIn",
      "Chase Bank ↔ Gringotts",
      "Robinhood ↔ BatBucks",
      "TurboTax ↔ SpeedTax",
      "Delta ↔ Dinoco",
      "Airbnb ↔ Cheskepdia",
      "Uber ↔ eTaxi",
      "DoorDash ↔ HangryDash",
      "OpenTable ↔ TableFind",
      "Amazon ↔ HooliShop",
      "Instacart ↔ Kwik-E-Mart",
      "Polymarket ↔ OddsMarket",
    ]);
    expect(emailService(email("legacy-work", "updates@example.test", "WorkBuzz"))?.id).toBe("slack");
    expect(emailService(email("legacy-chat", "updates@example.test", "BuzzChat"))?.id).toBe("whatsapp");
    expect(emailService(email("legacy-bank", "updates@example.test", "VaultBank"))?.id).toBe("chase");
  });

  it.each([
    ["google-calendar", "calendar.google.com", "Google Calendar"],
    ["gmail", "gmail.com", "Gmail"],
    ["whatsapp", "whatsapp.com", "WhatsApp"],
    ["slack", "slack.com", "Slack"],
    ["sprintboard", "asana.com", "Asana"],
    ["linkedin", "linkedin.com", "LinkedIn"],
    ["chase", "chase.com", "Chase Bank"],
    ["robinhood", "robinhood.com", "Robinhood"],
    ["turbotax", "turbotax.com", "TurboTax"],
    ["delta", "delta.com", "Delta Air Lines"],
    ["airbnb", "airbnb.com", "Airbnb"],
    ["uber", "uber.com", "Uber Receipts"],
    ["doordash", "doordash.com", "DoorDash"],
    ["opentable", "opentable.com", "OpenTable"],
    ["amazon", "mail.amazon.jobs", "Amazon Jobs"],
    ["instacart", "instacart.com", "Instacart"],
    ["polymarket", "polymarket.com", "Polymarket"],
  ])("matches the real sender identity for %s", (serviceId, domain, senderName) => {
    expect(emailMatchesService(email(serviceId, `updates@${domain}`, senderName), serviceId)).toBe(true);
  });

  it("matches clone sender domains without accepting lookalike domains", () => {
    expect(emailMatchesService(email("clone", "orders@hoolishop.mypcbench.app", "HooliShop"), "amazon")).toBe(true);
    expect(emailMatchesService(email("clone", "orders@kwik-e-mart.mypcbench.app", "Kwik-E-Mart"), "instacart")).toBe(true);
    expect(emailMatchesService(email("negative", "alerts@notuber.com", "Negative Control"), "uber")).toBe(false);
  });

  it("renders every service option and filters real and clone senders together", () => {
    const ctx = testCtx([
      email("real", "orders@amazon.com", "Amazon Orders"),
      email("clone", "orders@hoolishop.mypcbench.app", "HooliShop Orders"),
      email("other", "orders@instacart.com", "Instacart Orders"),
    ]);
    const root = renderEmailItems(ctx);
    const select = root.querySelector<HTMLSelectElement>('[data-testid="email-service-filter"]')!;
    expect(select.options).toHaveLength(18);
    expect([...select.options].find((option) => option.value === "amazon")?.textContent).toBe("Amazon · 2");
    expect(select.textContent).not.toContain("HooliShop");
    expect(select.textContent).not.toContain("Kwik-E-Mart");
    expect(select.textContent).not.toContain("eTaxi");

    select.value = "amazon";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ctx.state.filters.service).toBe("amazon");

    const filtered = renderEmailItems(ctx);
    const rows = [...filtered.querySelectorAll(".item-row")].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    expect(rows.join(" ")).toContain("Amazon Orders");
    expect(rows.join(" ")).toContain("HooliShop Orders");
    expect(rows.join(" ")).not.toContain("Instacart Orders");
  });
});

describe("sent and received email activity", () => {
  it("ranks incoming senders and outgoing recipients by address and domain", () => {
    const receivedOne = email("r1", "orders@amazon.com", "Amazon Orders");
    const receivedTwo = email("r2", "orders@amazon.com", "Amazon Orders");
    const sent = email("s1", "ui-check@example.com", "Sent message");
    sent.labels = ["Sent"];
    sent.to = [
      { name: "Instacart Support", email: "help@instacart.com" },
      { name: "Amazon Support", email: "help@amazon.com" },
    ];

    expect(emailDirection(receivedOne, "ui-check@example.com")).toBe("received");
    expect(emailDirection(sent, "ui-check@example.com")).toBe("sent");
    expect(emailActivitySummary([receivedOne, receivedTwo, sent], "ui-check@example.com")).toEqual({
      received: {
        messages: 2,
        people: [{ key: "orders@amazon.com", label: "Amazon Orders", count: 2 }],
        domains: [{ key: "amazon.com", label: "amazon.com", count: 2 }],
      },
      sent: {
        messages: 1,
        people: [
          { key: "help@amazon.com", label: "Amazon Support", count: 1 },
          { key: "help@instacart.com", label: "Instacart Support", count: 1 },
        ],
        domains: [
          { key: "amazon.com", label: "amazon.com", count: 1 },
          { key: "instacart.com", label: "instacart.com", count: 1 },
        ],
      },
    });
  });

  it("filters by a top domain and bulk-selects only the matching records", () => {
    const ctx = testCtx([
      email("a1", "orders@amazon.com", "Amazon one"),
      email("a2", "shipping@amazon.com", "Amazon two"),
      email("u1", "receipts@uber.com", "Uber"),
    ]);
    ctx.state.identity = {
      kind: "internal",
      participantId: "ui-check",
      name: "UI Check",
      email: "ui-check@example.com",
      consent: { version: "test", accepted_at: "2026-08-01T00:00:00Z" },
    };
    const root = renderEmailItems(ctx);
    const amazonDomain = [...root.querySelectorAll<HTMLButtonElement>(".activity-chip")].find((button) => button.textContent === "amazon.com2")!;
    amazonDomain.click();
    expect(ctx.state.filters.direction).toBe("received");
    expect(ctx.state.filters.correspondent).toBe("domain:amazon.com");

    const filtered = renderEmailItems(ctx);
    expect(filtered.querySelectorAll(".item-row")).toHaveLength(2);
    const selectMatching = [...filtered.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Select 2 matching filters")!;
    selectMatching.click();
    expect(ctx.actions.bulkInclude).toHaveBeenCalledWith(["a1", "a2"], true);
  });

  it("offers one-click selection and privacy actions for every imported record", () => {
    const ctx = testCtx([
      email("a1", "orders@amazon.com", "Amazon"),
      email("u1", "receipts@uber.com", "Uber"),
      email("i1", "orders@instacart.com", "Instacart"),
    ]);
    const root = renderEmailItems(ctx);
    root.querySelector<HTMLButtonElement>('[data-testid="select-all-imported"]')!.click();
    expect(ctx.actions.bulkIncludeSources).toHaveBeenLastCalledWith(["email", "orders"], true);

    root.querySelector<HTMLButtonElement>('[data-testid="keep-all-imported-private"]')!.click();
    expect(ctx.actions.bulkIncludeSources).toHaveBeenLastCalledWith(["email", "orders"], false);
  });
});

describe("automatic sender-service detection and search", () => {
  it("groups an unknown sender by registrable domain and adds a supported option", () => {
    const spotify = email("spotify", "hello@news.spotify.com", "Weekly mix");
    spotify.from.name = "Music Updates";
    expect(registrableSenderDomain(spotify)).toBe("spotify.com");
    expect(emailServiceOptions([spotify]).find((service) => service.id === "detected:spotify.com")).toEqual({
      id: "detected:spotify.com",
      label: "Spotify",
      count: 1,
      detected: true,
    });

    const ctx = testCtx([spotify, email("other", "alerts@example.org", "Account notice")]);
    const root = renderEmailItems(ctx);
    const select = root.querySelector<HTMLSelectElement>('[data-testid="email-service-filter"]')!;
    expect([...select.options].find((option) => option.value === "detected:spotify.com")?.textContent).toBe("Spotify · 1");

    select.value = "detected:spotify.com";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const filtered = renderEmailItems(ctx);
    const rows = [...filtered.querySelectorAll(".item-row")].map((row) => row.textContent).join(" ");
    expect(rows).toContain("Weekly mix");
    expect(rows).not.toContain("Account notice");
  });

  it("searches detected service, sender domain, and recipient fields", () => {
    vi.useFakeTimers();
    const spotify = email("spotify", "hello@news.spotify.com", "Your weekly mix");
    spotify.from.name = "Music Updates";
    const sent = email("sent", "ui-check@example.com", "Following up");
    sent.labels = ["Sent"];
    sent.to = [{ name: "Jane Recipient", email: "jane@customer.test" }];
    const ctx = testCtx([spotify, sent, email("other", "alerts@example.org", "Account notice")]);

    const root = renderEmailItems(ctx);
    const search = root.querySelector<HTMLInputElement>('[data-testid="record-search-filter"]')!;
    search.value = "spotify";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(180);
    expect([...renderEmailItems(ctx).querySelectorAll(".item-row")].map((row) => row.textContent).join(" ")).toContain("Your weekly mix");

    ctx.state.filters.query = "jane@customer.test";
    const recipientResult = [...renderEmailItems(ctx).querySelectorAll(".item-row")].map((row) => row.textContent).join(" ");
    expect(recipientResult).toContain("Following up");
    expect(recipientResult).not.toContain("Account notice");
    vi.useRealTimers();
  });
});

describe("inline email privacy controls", () => {
  it("shows detected people with protected aliases and lets the user keep one real", () => {
    const ctx = testCtx([email("a1", "jane@example.com", "Hello")]);
    ctx.state.entities = [{
      entityId: "person-jane",
      category: "person",
      realNames: ["Jane Doe"],
      realEmails: ["jane@example.com"],
      realPhones: ["+1 412 555 0187"],
      alias: "Maya Chen",
      aliasEmail: "maya.chen@personamail.test",
      aliasPhone: "+1 202 555 0100",
      keepReal: false,
      occurrences: { email: 1 },
      mergedFrom: [],
    }];

    const root = renderEmailItems(ctx);
    const panel = root.querySelector<HTMLElement>('[data-testid="inline-privacy-panel"]')!;
    expect(panel.textContent).toContain("Jane Doe");
    expect(panel.textContent).toContain("uploads as Maya Chen");
    expect(panel.textContent).toContain("1 of 1 people protected");

    const protect = panel.querySelector<HTMLInputElement>('[data-testid="protect-entity-person-jane"]')!;
    expect(protect.checked).toBe(true);
    protect.checked = false;
    protect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ctx.actions.updateEntity).toHaveBeenCalledWith("person-jane", { keepReal: true });
  });

  it("limits email-address search to structured sender and recipient addresses", () => {
    const ctx = testCtx([
      email("sender", "alerts@sender.example", "Ordinary subject"),
      email("subject", "other@example.org", "alerts@sender.example mentioned in subject"),
    ]);
    ctx.state.filters.query = "alerts@sender.example";
    ctx.state.filters.queryScope = "email";
    const rows = [...renderEmailItems(ctx).querySelectorAll(".item-row")].map((row) => row.textContent).join(" ");
    expect(rows).toContain("Ordinary subject");
    expect(rows).not.toContain("mentioned in subject");
  });
});

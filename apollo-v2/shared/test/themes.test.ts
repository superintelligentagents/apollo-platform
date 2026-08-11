import { describe, expect, it } from "vitest";
import { siteFamily, stemToken, suggestThemes, tokenize, cleanTokens, overlapRatio } from "../src/themes";
import { prepareJourneys } from "../src/clustering";
import { cluster, themedClusters, visit } from "./fixtures";

describe("siteFamily", () => {
  it("collapses subdomains to the registrable family", () => {
    expect(siteFamily("www.mlb.com")).toBe("mlb.com");
    expect(siteFamily("boards.greenhouse.io")).toBe("greenhouse.io");
    expect(siteFamily("shop.example.co.uk")).toBe("example.co.uk");
    expect(siteFamily("example.com")).toBe("example.com");
    expect(siteFamily("")).toBe("");
  });
});

describe("token helpers", () => {
  it("tokenizes, stems, and drops stopwords", () => {
    expect(tokenize("Best MLB Stadiums 2026!")).toEqual(["best", "mlb", "stadiums", "2026"]);
    expect(stemToken("stadiums")).toBe("stadium");
    expect(stemToken("applies")).toBe("apply");
    const cleaned = cleanTokens(["best", "stadiums", "the", "2026", "tickets"]);
    expect(cleaned).toContain("stadium");
    expect(cleaned).toContain("ticket");
    expect(cleaned).not.toContain("best");
    expect(cleaned).not.toContain("2026");
  });

  it("drops short mixed URL identifiers without losing recognizable product tokens", () => {
    const cleaned = cleanTokens(["3m1", "1e2", "4d", "8m2", "gpt4", "iphone15", "cs231n"]);
    expect(cleaned).not.toContain("3m1");
    expect(cleaned).not.toContain("1e2");
    expect(cleaned).not.toContain("4d");
    expect(cleaned).not.toContain("8m2");
    expect(cleaned).toContain("gpt4");
    expect(cleaned).toContain("iphone15");
    expect(cleaned).toContain("cs231n");
  });

  it("computes dice overlap", () => {
    expect(overlapRatio(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(0.5);
    expect(overlapRatio(new Set(), new Set(["x"]))).toBe(0);
  });
});

describe("suggestThemes", () => {
  it("does not join unrelated projects merely because they used ChatGPT", () => {
    const clusters = [
      cluster(1101, [
        visit("https://chatgpt.com/c/trip", "2026-06-01T10:00:00.000Z", "ChatGPT travel draft"),
        visit("https://airbnb.com/s/new-york", "2026-06-01T10:10:00.000Z", "New York apartment stays"),
        visit("https://maps.google.com/nyc", "2026-06-01T10:20:00.000Z", "New York neighborhoods map"),
      ]),
      cluster(1102, [
        visit("https://chatgpt.com/c/finance", "2026-06-10T10:00:00.000Z", "ChatGPT portfolio notes"),
        visit("https://fidelity.com/portfolio", "2026-06-10T10:10:00.000Z", "Retirement portfolio allocation"),
        visit("https://morningstar.com/funds", "2026-06-10T10:20:00.000Z", "Index fund analysis"),
      ]),
      cluster(1103, [
        visit("https://chatgpt.com/c/research", "2026-06-20T10:00:00.000Z", "ChatGPT paper notes"),
        visit("https://arxiv.org/abs/2601.00001", "2026-06-20T10:10:00.000Z", "Agent evaluation paper"),
        visit("https://github.com/example/evals", "2026-06-20T10:20:00.000Z", "Evaluation benchmark code"),
      ]),
    ];
    const suggestions = suggestThemes(prepareJourneys(clusters, new Set()));
    expect(suggestions.some((s) => s.cluster_fingerprints.length >= 2)).toBe(false);
  });

  it("does not join distant unrelated sessions merely because they used the same site", () => {
    const clusters = [
      cluster(1201, [
        visit("https://market.example/flights", "2026-04-01T10:00:00.000Z", "Tokyo airfare comparison"),
        visit("https://market.example/hotels", "2026-04-01T10:10:00.000Z", "Tokyo hotel shortlist"),
        visit("https://market.example/trips", "2026-04-01T10:20:00.000Z", "Tokyo itinerary"),
      ]),
      cluster(1202, [
        visit("https://market.example/laptops", "2026-06-20T10:00:00.000Z", "Laptop processor benchmark"),
        visit("https://market.example/monitors", "2026-06-20T10:10:00.000Z", "Desktop monitor specifications"),
        visit("https://market.example/keyboards", "2026-06-20T10:20:00.000Z", "Mechanical keyboard comparison"),
      ]),
    ];
    expect(suggestThemes(prepareJourneys(clusters, new Set()))).toEqual([]);
  });

  it("groups multi-day same-topic sessions and drops single-day noise", () => {
    const journeys = prepareJourneys(themedClusters(), new Set());
    const suggestions = suggestThemes(journeys);

    expect(suggestions.length).toBe(2);

    const families = suggestions.map((s) => s.site_families.join(","));
    const trip = suggestions.find((s) => s.site_families.includes("mlb.com"));
    const jobs = suggestions.find((s) => s.site_families.includes("greenhouse.io"));
    expect(trip, `expected an mlb.com theme in ${families}`).toBeDefined();
    expect(jobs, `expected a greenhouse.io theme in ${families}`).toBeDefined();

    expect(trip!.cluster_fingerprints).toHaveLength(3);
    expect(jobs!.cluster_fingerprints).toHaveLength(3);
    expect(trip!.distinct_days).toBe(3);
    expect(jobs!.distinct_days).toBe(3);

    // single-day nytimes/allrecipes sessions must not appear anywhere
    const allFps = new Set(suggestions.flatMap((s) => s.cluster_fingerprints));
    const noise = journeys.filter((j) =>
      j.visits.some((v) => v.url.includes("nytimes") || v.url.includes("allrecipes"))
    );
    for (const n of noise) {
      expect(allFps.has(n.fingerprint!)).toBe(false);
    }
  });

  it("returns nothing for fewer than two clusters", () => {
    expect(suggestThemes([])).toEqual([]);
  });

  it("matches non-English (Korean) vocabulary across sites", () => {
    const clusters = [
      cluster(901, [
        visit("https://www.tickets-a.kr/야구", "2026-06-02T18:00:00.000Z", "기아 타이거즈 야구 티켓 예매"),
        visit("https://www.tickets-a.kr/좌석", "2026-06-02T18:10:00.000Z", "타이거즈 야구 좌석 선택"),
        visit("https://www.tickets-a.kr/결제", "2026-06-02T18:20:00.000Z", "야구 티켓 결제"),
      ]),
      cluster(902, [
        visit("https://www.stadium-b.kr/일정", "2026-06-06T19:00:00.000Z", "기아 타이거즈 경기 일정 야구"),
        visit("https://www.stadium-b.kr/구장", "2026-06-06T19:10:00.000Z", "야구 구장 안내 타이거즈"),
        visit("https://www.stadium-b.kr/교통", "2026-06-06T19:20:00.000Z", "구장 교통 야구"),
      ]),
      ...themedClusters(),
      ...Array.from({ length: 16 }, (_, k) =>
        cluster(950 + k, [
          visit(`https://www.pad${k}.org/a`, `2026-05-${String(2 + k).padStart(2, "0")}T06:00:00.000Z`, `Pad nu${k} xi${k}`),
          visit(`https://www.pad${k}.org/b`, `2026-05-${String(2 + k).padStart(2, "0")}T06:05:00.000Z`, `Pad omi${k} rho${k}`),
          visit(`https://www.pad${k}.org/c`, `2026-05-${String(2 + k).padStart(2, "0")}T06:10:00.000Z`, `Pad sig${k} tau${k}`),
        ])
      ),
    ];
    const journeys = prepareJourneys(clusters, new Set());
    const suggestions = suggestThemes(journeys, 14);
    const korean = suggestions.find((s) => s.shared_tokens.some((t) => /[가-힣]/.test(t)));
    expect(korean, "Korean cross-site thread should surface").toBeDefined();
    expect(korean!.cluster_fingerprints).toHaveLength(2);
  });

  it("topic matcher catches cross-site threads the cohesion matcher misses", () => {
    const clusters = [
      ...themedClusters(),
      // pottery-kiln research across two unrelated site families
      cluster(401, [
        visit("https://www.ceramicsupplyco.com/kilns", "2026-06-03T20:00:00.000Z", "Pottery kiln buying guide"),
        visit("https://www.ceramicsupplyco.com/kilns/cone-6", "2026-06-03T20:10:00.000Z", "Cone 6 kiln pottery glaze firing"),
        visit("https://www.ceramicsupplyco.com/glaze", "2026-06-03T20:20:00.000Z", "Glaze firing pottery kiln"),
      ]),
      cluster(402, [
        visit("https://www.soulceramics.com/kiln-comparison", "2026-06-08T19:00:00.000Z", "Kiln comparison pottery glaze"),
        visit("https://www.soulceramics.com/kilns/evenheat", "2026-06-08T19:12:00.000Z", "Evenheat kiln pottery firing"),
        visit("https://www.soulceramics.com/guides/firing", "2026-06-08T19:25:00.000Z", "Firing guide glaze kiln"),
      ]),
    ];
    const journeys = prepareJourneys(clusters, new Set());
    const suggestions = suggestThemes(journeys);
    const pottery = suggestions.find((s) => s.shared_tokens.includes("kiln"));
    expect(pottery, "cross-site kiln thread should surface").toBeDefined();
    expect(pottery!.cluster_fingerprints).toHaveLength(2);
    expect(pottery!.algo).toBe("topic");
    // the same-site trip thread still comes from the cohesion matcher
    const trip = suggestions.find((s) => s.site_families.includes("mlb.com"));
    expect(trip!.algo).toBe("cohesion");
  });

  it("chains related themes into one thread group via shared vocabulary", () => {
    // Two separate single-site threads that both revolve around "kbo":
    // a team-site thread and a streaming-site thread.
    const clusters = [
      cluster(701, [
        visit("https://www.tigersclub.kr/schedule", "2026-06-01T18:00:00.000Z", "KBO kia tigers baseball schedule"),
        visit("https://www.tigersclub.kr/roster", "2026-06-01T18:10:00.000Z", "Tigers roster batting"),
        visit("https://www.tigersclub.kr/news", "2026-06-01T18:20:00.000Z", "Tigers kbo baseball news"),
      ]),
      cluster(702, [
        visit("https://www.tigersclub.kr/tickets", "2026-06-05T18:00:00.000Z", "Tigers kbo baseball tickets"),
        visit("https://www.tigersclub.kr/stadium", "2026-06-05T18:10:00.000Z", "Stadium seating kia"),
        visit("https://www.tigersclub.kr/shop", "2026-06-05T18:20:00.000Z", "Tigers gear batting"),
      ]),
      cluster(703, [
        visit("https://www.streamly.kr/baseball", "2026-06-10T20:00:00.000Z", "Watch kbo baseball streaming"),
        visit("https://www.streamly.kr/live", "2026-06-10T20:10:00.000Z", "Live kbo games streaming"),
        visit("https://www.streamly.kr/replays", "2026-06-10T20:20:00.000Z", "Game replays highlights baseball"),
      ]),
      cluster(704, [
        visit("https://www.streamly.kr/subscribe", "2026-06-14T20:00:00.000Z", "Subscribe streaming kbo plan"),
        visit("https://www.streamly.kr/devices", "2026-06-14T20:10:00.000Z", "Devices streaming setup"),
        visit("https://www.streamly.kr/highlights", "2026-06-14T20:20:00.000Z", "Kbo baseball highlights weekly"),
      ]),
      ...themedClusters(),
      // filler so a token in 4 sessions still counts as rare (df cap scales)
      ...Array.from({ length: 16 }, (_, k) =>
        cluster(800 + k, [
          visit(`https://www.filler${k}.org/a`, `2026-05-${String(2 + k).padStart(2, "0")}T07:00:00.000Z`, `Filler eta${k} theta${k}`),
          visit(`https://www.filler${k}.org/b`, `2026-05-${String(2 + k).padStart(2, "0")}T07:05:00.000Z`, `Filler iota${k} kappa${k}`),
          visit(`https://www.filler${k}.org/c`, `2026-05-${String(2 + k).padStart(2, "0")}T07:10:00.000Z`, `Filler lambda${k} mu${k}`),
        ])
      ),
    ];
    const journeys = prepareJourneys(clusters, new Set());
    const suggestions = suggestThemes(journeys, 14);
    const tigers = suggestions.find((s) => s.site_families.includes("tigersclub.kr"));
    const stream = suggestions.find((s) => s.site_families.includes("streamly.kr"));
    expect(tigers).toBeDefined();
    expect(stream).toBeDefined();
    expect(tigers!.thread_group).toBe(stream!.thread_group);
    // unrelated themes stay in their own groups
    const jobs = suggestions.find((s) => s.site_families.includes("greenhouse.io"));
    expect(jobs!.thread_group).not.toBe(tigers!.thread_group);
  });

  it("burst matcher captures a same-week arc too weak for pairwise matchers", () => {
    // One weekend of organizing a Jeju trip across four unrelated sites —
    // each pair shares only the single token "jeju".
    const arc = [
      cluster(501, [
        visit("https://www.jejuair.net/routes", "2026-06-05T10:00:00.000Z", "Jeju flight routes"),
        visit("https://www.jejuair.net/booking", "2026-06-05T10:10:00.000Z", "Booking flow"),
        visit("https://www.jejuair.net/fares", "2026-06-05T10:20:00.000Z", "Fare rules"),
      ]),
      cluster(502, [
        visit("https://www.yeha.co.kr/tours", "2026-06-06T11:00:00.000Z", "Jeju day tours"),
        visit("https://www.yeha.co.kr/tours/east", "2026-06-06T11:10:00.000Z", "East course"),
        visit("https://www.yeha.co.kr/pickup", "2026-06-06T11:20:00.000Z", "Pickup points"),
      ]),
      cluster(503, [
        visit("https://www.stayfolio.kr/pool-villa", "2026-06-07T12:00:00.000Z", "Jeju pool villa"),
        visit("https://www.stayfolio.kr/rooms", "2026-06-07T12:10:00.000Z", "Room options"),
        visit("https://www.stayfolio.kr/reserve", "2026-06-07T12:20:00.000Z", "Reserve"),
      ]),
      cluster(504, [
        visit("https://www.mangoplate.kr/black-pork", "2026-06-08T13:00:00.000Z", "Jeju black pork restaurants"),
        visit("https://www.mangoplate.kr/noodles", "2026-06-08T13:10:00.000Z", "Noodle spots"),
        visit("https://www.mangoplate.kr/cafes", "2026-06-08T13:20:00.000Z", "Seaside cafes"),
      ]),
      // filler on other days so the corpus is big enough that a token
      // appearing in 4 sessions still counts as rare (df cap scales with n)
      ...themedClusters(),
      ...Array.from({ length: 16 }, (_, k) =>
        cluster(600 + k, [
          visit(`https://www.site${k}.org/a`, `2026-05-${String(2 + k).padStart(2, "0")}T09:00:00.000Z`, `Unique alpha${k} beta${k}`),
          visit(`https://www.site${k}.org/b`, `2026-05-${String(2 + k).padStart(2, "0")}T09:05:00.000Z`, `Unique gamma${k} delta${k}`),
          visit(`https://www.site${k}.org/c`, `2026-05-${String(2 + k).padStart(2, "0")}T09:10:00.000Z`, `Unique epsilon${k} zeta${k}`),
        ])
      ),
    ];
    const journeys = prepareJourneys(arc, new Set());
    const suggestions = suggestThemes(journeys, 12);
    const burst = suggestions.find((s) => s.algo === "burst");
    expect(burst, "same-week jeju arc should surface as a burst").toBeDefined();
    expect(burst!.cluster_fingerprints.length).toBeGreaterThanOrEqual(4);
    expect(burst!.shared_tokens).toContain("jeju");
  });

  it("links a slow-burn thread whose sessions are many weeks apart", () => {
    // Wedding-venue research resumed at ~5-week intervals over 10 weeks —
    // the old 30-day window could never even compare these sessions.
    const slow = [
      cluster(301, [
        visit("https://www.theknot.com/marketplace/wedding-venues-chicago", "2026-05-01T18:00:00.000Z", "Chicago wedding venues"),
        visit("https://www.theknot.com/marketplace/venue/garfield-park", "2026-05-01T18:10:00.000Z", "Garfield Park venue wedding"),
        visit("https://www.theknot.com/wedding-budget", "2026-05-01T18:25:00.000Z", "Wedding venue budget"),
      ]),
      cluster(302, [
        visit("https://www.theknot.com/marketplace/venue/bridgeport-art", "2026-06-06T17:00:00.000Z", "Bridgeport Art Center wedding venue"),
        visit("https://www.theknot.com/marketplace/wedding-venues-chicago/2", "2026-06-06T17:15:00.000Z", "More Chicago wedding venues"),
        visit("https://www.theknot.com/real-weddings", "2026-06-06T17:30:00.000Z", "Real weddings venue photos"),
      ]),
      cluster(303, [
        visit("https://www.theknot.com/marketplace/venue/garfield-park/tour", "2026-07-11T16:00:00.000Z", "Book venue tour Garfield Park wedding"),
        visit("https://www.theknot.com/wedding-checklist", "2026-07-11T16:20:00.000Z", "Wedding venue checklist"),
        visit("https://www.theknot.com/marketplace/wedding-venues-chicago/saved", "2026-07-11T16:35:00.000Z", "Saved wedding venues"),
      ]),
      // unrelated filler sessions between the slow-burn ones
      cluster(304, [
        visit("https://www.allrecipes.com/soup", "2026-05-20T01:00:00.000Z", "Soup recipes"),
        visit("https://www.allrecipes.com/soup/ramen", "2026-05-20T01:05:00.000Z", "Ramen recipe"),
        visit("https://www.allrecipes.com/tips/broth", "2026-05-20T01:12:00.000Z", "Broth tips"),
      ]),
      cluster(305, [
        visit("https://www.espn.com/nba/scores", "2026-06-20T02:00:00.000Z", "NBA scores"),
        visit("https://www.espn.com/nba/standings", "2026-06-20T02:05:00.000Z", "NBA standings"),
        visit("https://www.espn.com/nba/playoffs", "2026-06-20T02:12:00.000Z", "NBA playoffs"),
      ]),
    ];
    const journeys = prepareJourneys(slow, new Set());
    const suggestions = suggestThemes(journeys);
    const wedding = suggestions.find((s) => s.site_families.includes("theknot.com"));
    expect(wedding, "10-week wedding thread should be one theme").toBeDefined();
    expect(wedding!.cluster_fingerprints).toHaveLength(3);
    expect(wedding!.distinct_days).toBe(3);
  });

  it("treats a daily habit as routine, not a theme, while keeping bursty projects", () => {
    // 10 days of daily news reading (habit) + a 3-session apartment hunt (project)
    const clusters = [];
    for (let day = 1; day <= 10; day++) {
      const d = String(day).padStart(2, "0");
      clusters.push(
        cluster(100 + day, [
          visit(`https://www.nytimes.com/2026/06/${d}/politics`, `2026-06-${d}T12:00:00.000Z`, "Politics headlines today"),
          visit(`https://www.nytimes.com/2026/06/${d}/world`, `2026-06-${d}T12:05:00.000Z`, "World headlines today"),
          visit(`https://www.nytimes.com/2026/06/${d}/opinion`, `2026-06-${d}T12:10:00.000Z`, "Opinion columns today"),
        ])
      );
    }
    const hunt = [
      cluster(201, [
        visit("https://www.zillow.com/pittsburgh-pa/apartments", "2026-06-02T22:00:00.000Z", "Pittsburgh apartments Zillow"),
        visit("https://www.zillow.com/homedetails/shadyside-2br", "2026-06-02T22:10:00.000Z", "Shadyside 2BR apartment"),
        visit("https://www.zillow.com/pittsburgh-pa/rentals", "2026-06-02T22:20:00.000Z", "Pittsburgh rentals"),
      ]),
      cluster(202, [
        visit("https://www.zillow.com/homedetails/squirrelhill-2br", "2026-06-05T21:00:00.000Z", "Squirrel Hill 2BR apartment"),
        visit("https://www.zillow.com/pittsburgh-pa/apartments/2", "2026-06-05T21:15:00.000Z", "Pittsburgh apartments page 2"),
        visit("https://www.zillow.com/mortgage-calculator", "2026-06-05T21:30:00.000Z", "Rent vs buy apartment"),
      ]),
      cluster(203, [
        visit("https://www.zillow.com/homedetails/shadyside-2br/tour", "2026-06-08T20:00:00.000Z", "Schedule apartment tour Shadyside"),
        visit("https://www.zillow.com/renter-hub", "2026-06-08T20:12:00.000Z", "Apartment applications hub"),
        visit("https://www.zillow.com/pittsburgh-pa/apartments/saved", "2026-06-08T20:25:00.000Z", "Saved Pittsburgh apartments"),
      ]),
    ];
    clusters.push(...hunt);

    const journeys = prepareJourneys(clusters, new Set());
    const suggestions = suggestThemes(journeys);

    const zillowTheme = suggestions.find((s) => s.site_families.includes("zillow.com"));
    expect(zillowTheme, "apartment hunt should surface as a theme").toBeDefined();
    expect(zillowTheme!.cluster_fingerprints.length).toBe(3);

    // nytimes is visited on 10/13 active days — a habit, demoted below linking strength
    const newsTheme = suggestions.find((s) => s.site_families.includes("nytimes.com"));
    expect(newsTheme, "daily news habit should not become a theme").toBeUndefined();
  });
});

import type { Cluster, Visit } from "../src/types";

let visitId = 1;

export function visit(url: string, visitedAt: string, title = "", searchTerm = ""): Visit {
  let domain = "";
  try {
    domain = new URL(url).host;
  } catch {
    domain = "";
  }
  return {
    id: visitId++,
    url,
    title,
    visited_at: visitedAt,
    from_visit: 0,
    domain,
    search_term: searchTerm || undefined,
  };
}

export function cluster(clusterId: number, visits: Visit[]): Cluster {
  return { cluster_id: clusterId, visits };
}

// Three long-horizon themes spread over multiple days, plus single-day noise:
//  - trip: MLB stadium vacation planning (mlb.com + expedia.com, 3 sessions / 3 days)
//  - jobs: job hunt (greenhouse.io + lever.co, 3 sessions / 2 weeks)
//  - noise: one-off single-day sessions that must not become themes
export function themedClusters(): Cluster[] {
  return [
    cluster(1, [
      visit("https://www.mlb.com/schedule", "2026-06-01T18:00:00.000Z", "MLB Schedule 2026"),
      visit("https://www.mlb.com/yankees/ballpark", "2026-06-01T18:05:00.000Z", "Yankee Stadium Guide"),
      visit("https://www.expedia.com/Hotels-New-York", "2026-06-01T18:20:00.000Z", "New York hotels near stadium"),
    ]),
    cluster(2, [
      visit("https://www.expedia.com/Flights-Boston", "2026-06-04T20:00:00.000Z", "Flights to Boston stadium trip"),
      visit("https://www.mlb.com/redsox/ballpark/tours", "2026-06-04T20:10:00.000Z", "Fenway Park stadium tours"),
      visit("https://www.mlb.com/tickets", "2026-06-04T20:15:00.000Z", "MLB tickets stadium"),
    ]),
    cluster(3, [
      visit("https://www.mlb.com/tickets/season", "2026-06-09T17:00:00.000Z", "MLB stadium tickets"),
      visit("https://www.expedia.com/Cars", "2026-06-09T17:12:00.000Z", "Rental cars stadium road trip"),
      visit("https://www.expedia.com/trips", "2026-06-09T17:30:00.000Z", "My stadium trip itinerary"),
    ]),
    cluster(4, [
      visit("https://boards.greenhouse.io/acme/jobs/123", "2026-06-02T15:00:00.000Z", "Software Engineer job opening"),
      visit("https://boards.greenhouse.io/acme/jobs/456", "2026-06-02T15:10:00.000Z", "Data Engineer job opening"),
      visit("https://jobs.lever.co/globex", "2026-06-02T15:25:00.000Z", "Globex engineering jobs"),
    ]),
    cluster(5, [
      visit("https://jobs.lever.co/globex/apply", "2026-06-10T16:00:00.000Z", "Apply engineer job Globex"),
      visit("https://boards.greenhouse.io/acme/jobs/789", "2026-06-10T16:20:00.000Z", "Senior Engineer job opening"),
      visit("https://jobs.lever.co/initech", "2026-06-10T16:40:00.000Z", "Initech job listings engineer"),
    ]),
    cluster(6, [
      visit("https://boards.greenhouse.io/acme/application", "2026-06-15T14:00:00.000Z", "Job application status engineer"),
      visit("https://jobs.lever.co/globex/status", "2026-06-15T14:15:00.000Z", "Application status engineer job"),
      visit("https://boards.greenhouse.io/acme/jobs", "2026-06-15T14:30:00.000Z", "Acme engineering jobs"),
    ]),
    cluster(7, [
      visit("https://www.nytimes.com/2026/06/03/news", "2026-06-03T12:00:00.000Z", "Morning news headlines"),
      visit("https://www.nytimes.com/section/world", "2026-06-03T12:05:00.000Z", "World news"),
      visit("https://www.nytimes.com/section/business", "2026-06-03T12:10:00.000Z", "Business news"),
    ]),
    cluster(8, [
      visit("https://www.allrecipes.com/pasta", "2026-06-07T01:00:00.000Z", "Pasta recipes"),
      visit("https://www.allrecipes.com/pasta/carbonara", "2026-06-07T01:05:00.000Z", "Carbonara recipe"),
      visit("https://www.allrecipes.com/tips", "2026-06-07T01:12:00.000Z", "Cooking tips"),
    ]),
  ];
}

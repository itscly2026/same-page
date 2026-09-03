export function classifyPerformanceRequest(pathname) {
  if (pathname === "/api/auth/get-session") return "auth-session";
  if (pathname === "/api/choirs") return "drive-memberships";
  if (/\/api\/choirs\/[^/]+\/bootstrap$/.test(pathname)) return "drive-bootstrap";
  if (pathname.endsWith("/bootstrap")) return "score-bootstrap";
  if (pathname.endsWith("/pdf")) return "pdf";
  if (pathname.endsWith("/layers")) return "layers";
  if (pathname.endsWith("/annotations")) return "annotations";
  if (/\/choirs\/[^/]+\/scores$/.test(pathname)) return "score-list";
  if (pathname.startsWith("/api/guest/")) return "guest-session";
  return "other-api";
}

export function summarizeJourneySamples(samples) {
  const grouped = new Map();
  for (const sample of samples) {
    const key = `${sample.journey}:${sample.cacheCategory}`;
    const durations = grouped.get(key) ?? [];
    durations.push(sample.duration);
    grouped.set(key, durations);
  }
  return [...grouped.entries()].map(([key, durations]) => {
    const [journey, cacheCategory] = key.split(":");
    const sorted = durations.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
    return {
      journey,
      cacheCategory,
      samples: durations.map(roundDuration),
      median: roundDuration(median),
    };
  });
}

function roundDuration(duration) {
  return Math.round(duration * 10) / 10;
}

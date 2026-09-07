// Cold-start requests have a bound, and an auth mutation invalidates earlier responses.
export function createSessionFetch(transport: typeof fetch, acceptSession: (response: Response, requestedAt: number) => Promise<Response> = async response => response.clone()): typeof fetch {
  let generation = 0;
  let latest: { generation: number; url: string; requestedAt: number; result: Promise<Response> } | null = null;
  const fetchSession: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!new URL(url, "https://same-page.invalid").pathname.endsWith("/get-session")) {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method.toUpperCase() === "GET") return transport(input, init);
      generation++;
      latest = null;
      try { return await transport(input, init); }
      finally { generation++; latest = null; }
    }
    const started = generation;
    const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]);
    const requestedAt = Date.now();
    const request = transport(input, { ...init, signal });
    latest = { generation: started, url, requestedAt, result: request };
    try {
      const response = await request;
      if (generation === started && latest?.result === request) {
        const accepted = await acceptSession(response, requestedAt);
        if (generation === started && latest?.result === request) return accepted;
      }
    } catch (error) {
      if (generation === started && latest?.result === request) throw error;
    }
    // Reuse only a response for the current generation and exact session query.
    while (latest?.generation === generation && latest.url === url) {
      const current: { generation: number; url: string; requestedAt: number; result: Promise<Response> } = latest;
      try {
        const response = await current.result;
        if (current === latest && current.generation === generation) {
          const accepted = await acceptSession(response, current.requestedAt);
          if (current === latest && current.generation === generation) return accepted;
        }
      } catch (error) {
        if (current === latest && current.generation === generation) throw error;
      }
    }
    return fetchSession(input, init);
  };
  return fetchSession;
}

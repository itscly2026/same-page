/* The waiting worker asks every same-origin window, including installed PWAs.
 * Unknown/old/suspended clients veto: silence never means safe to reload. */
self.addEventListener("message", event => {
  if (event.data?.type !== "SAME_PAGE_SAFE_UPDATE") return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const approvals = await Promise.all(clients.map(client => new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1500);
      channel.port1.onmessage = reply => { clearTimeout(timer); channel.port1.close(); resolve(reply.data === true); };
      client.postMessage({ type: "SAME_PAGE_UPDATE_PROBE" }, [channel.port2]);
    })));
    const current = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const safe = approvals.every(Boolean) && current.every(client => clients.some(previous => previous.id === client.id));
    event.ports[0]?.postMessage({ safe });
    if (safe) await self.skipWaiting();
  })());
});

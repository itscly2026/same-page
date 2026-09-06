import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { MembershipSummary } from "../../shared/choirs";
import { readerScoreBootstrapSchema, type ScoreSummary } from "../../shared/scores";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { readSavedReaderPage } from "../reader/use-reader-preferences";
import { readLastOpenedScore } from "./library-view-state";
import { startLoadingJourney } from "../performance/loading-performance";

export function ContinueReading({ userId, memberships }: { userId: string; memberships: MembershipSummary[] }) {
  const recent = readLastOpenedScore(`user:${userId}`, memberships.map(entry => entry.choir.id));
  const choirId = recent?.choirId;
  const scoreId = recent?.scoreId;
  const [ready, setReady] = useState<{ userId: string; score: ScoreSummary } | null>(null);
  useEffect(() => {
    if (!choirId || !scoreId) return;
    const controller = new AbortController();
    void diagnosticFetch(`/api/choirs/${encodeURIComponent(choirId)}/scores/${encodeURIComponent(scoreId)}/bootstrap`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    }).then(async response => {
      if (!response.ok) return;
      const body = await parseDiagnosticResponse(response, readerScoreBootstrapSchema);
      if (!controller.signal.aborted && body.state === "active" && body.score.choirId === choirId && body.score.id === scoreId) {
        setReady({ userId, score: body.score });
      }
    }).catch(() => { /* Optional shortcut: never delay the drive list on failure. */ });
    return () => controller.abort();
  }, [userId, choirId, scoreId]);
  const choir = memberships.find(entry => entry.choir.id === choirId)?.choir;
  if (!choir || ready?.userId !== userId || ready.score.choirId !== choirId || ready.score.id !== scoreId) return null;
  const page = readSavedReaderPage(userId, choir.id, ready.score.id, ready.score.currentVersion.pageCount);
  return <section className="continue-reading" aria-label="继续上次阅读">
    <h2>继续上次阅读</h2>
    <Link to={`/choirs/${choir.id}/scores/${ready.score.id}`} onClick={() => startLoadingJourney("open-score", "warm")}>
      <span><strong>{ready.score.fileName}</strong><small>{choir.name} · 第 {page} 页</small></span><span aria-hidden="true">→</span>
    </Link>
  </section>;
}

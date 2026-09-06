import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { Link, Navigate } from "react-router-dom";

import {
  choirMembershipsResponseSchema,
  type MembershipSummary,
} from "../../shared/choirs";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { startLoadingJourney } from "../performance/loading-performance";
import { driveCacheOwnerKey, rememberDriveSummary } from "./drive-library-cache";
import { ContinueReading } from "./continue-reading";
import { readLastOpenedScore } from "./library-view-state";
import { SavedScoreLinks } from "./saved-score-links";
import "./library-ux.css";

type MembershipState =
  | { userId: string; kind: "loading" | "failed" }
  | { userId: string; kind: "loaded"; memberships: MembershipSummary[] };

export function MembershipList({
  userId,
  currentChoirId,
  onSelect,
  autoEnter = false,
  showContinue = false,
}: {
  userId: string;
  currentChoirId?: string;
  onSelect?: () => void;
  autoEnter?: boolean;
  showContinue?: boolean;
}) {
  const [state, setState] = useState<MembershipState>({ userId, kind: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setState({ userId, kind: "loading" });
      try {
        const response = await diagnosticFetch("/api/choirs", { signal: controller.signal });
        if (!response.ok) throw new Error("memberships_failed");
        const { memberships } = await parseDiagnosticResponse(response, choirMembershipsResponseSchema);
        if (controller.signal.aborted) return;
        memberships.forEach(({ choir }) =>
          rememberDriveSummary(driveCacheOwnerKey(userId, choir.id), choir),
        );
        setState({ userId, kind: "loaded", memberships });
      } catch {
        if (!controller.signal.aborted) setState({ userId, kind: "failed" });
      }
    }
    void load();
    return () => controller.abort();
  }, [userId, retry]);

  if (state.userId !== userId || state.kind === "loading") {
    return <p role="status">正在加载已加入的云盘…</p>;
  }
  if (state.kind !== "loaded") {
    return (
      <>
      <div role="alert">
        <p>暂时无法加载已加入的云盘。</p>
        <Button className="secondary-button" onPress={() => setRetry((value) => value + 1)}>
          重试
        </Button>
      </div>
      <SavedScoreLinks key={userId} userId={userId} />
      </>
    );
  }
  if (!state.memberships.length) {
    return (
      <p className="membership-empty">
        还没有已加入的云盘。请使用管理员提供的邀请码加入。
      </p>
    );
  }
  if (autoEnter && state.memberships.length === 1 && !(showContinue && readLastOpenedScore(`user:${userId}`, state.memberships.map(entry => entry.choir.id)))) {
    return <Navigate to={`/choirs/${state.memberships[0].choir.id}`} replace />;
  }
  return (
    <>
    {showContinue && <ContinueReading key={userId} userId={userId} memberships={state.memberships} />}
    <div className="membership-list">
      {state.memberships.map((membership) => (
        <Link
          className="membership-row"
          key={membership.id}
          to={`/choirs/${membership.choir.id}`}
          aria-current={membership.choir.id === currentChoirId ? "page" : undefined}
          onClick={() => {
            startLoadingJourney("enter-drive", "warm");
            onSelect?.();
          }}
        >
          <span>
            <strong>{membership.choir.name}</strong>
            <small>
              {membership.role === "admin" ? "管理员" : "成员"}
              {membership.choir.id === currentChoirId ? " · 当前云盘" : ""}
            </small>
          </span>
          <span aria-hidden="true">→</span>
        </Link>
      ))}
    </div>
    </>
  );
}

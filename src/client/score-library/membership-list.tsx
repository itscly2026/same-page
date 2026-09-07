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
import { readLastDrive } from "./last-drive";
import { readLocalDriveDirectories } from "./local-drive-directory";
import "./library-ux.css";

type MembershipState =
  | { userId: string; kind: "loading" | "failed" }
  | { userId: string; kind: "loaded"; memberships: MembershipSummary[] };

export function MembershipList({
  userId,
  currentChoirId,
  onSelect,
  autoEnter = false,
  localOnly = false,
}: {
  userId: string;
  currentChoirId?: string;
  onSelect?: () => void;
  autoEnter?: boolean;
  localOnly?: boolean;
}) {
  const [state, setState] = useState<MembershipState>({ userId, kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [local, setLocal] = useState<{ userId: string; drives: Awaited<ReturnType<typeof readLocalDriveDirectories>> } | null>(null);
  useEffect(() => {
    let active = true;
    void readLocalDriveDirectories(userId).then(drives => { if (active) setLocal({ userId, drives }); }).catch(() => { if (active) setLocal({ userId, drives: [] }); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    if (localOnly) return;
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
  }, [userId, retry, localOnly]);

  if (localOnly || (state.userId === userId && state.kind === "failed")) {
    const drives = local?.userId === userId ? local.drives.filter(entry => entry.membership) : [];
    const lastDrive = readLastDrive(userId);
    const destination = drives.find(entry => entry.choirId === lastDrive) ?? (!lastDrive && drives.length === 1 ? drives[0] : null);
    if (autoEnter && destination) return <Navigate to={`/choirs/${destination.choirId}`} replace />;
    return <>
      {!localOnly && <p role="status">暂时无法加载已加入的云盘。<Button onPress={() => setRetry(value => value + 1)}>重试</Button></p>}
      {local?.userId !== userId ? <p role="status">正在读取本机目录…</p> : drives.length ? <div className="membership-list">{drives.map(entry => <Link className="membership-row" key={entry.choirId} to={`/choirs/${entry.choirId}`} onClick={onSelect}><span><strong>{entry.choir.name}</strong></span></Link>)}</div> : localOnly && <p>本机尚未保存云盘目录，请联网后重试。</p>}
    </>;
  }
  if (state.userId !== userId || state.kind === "loading") {
    return <p role="status">正在加载已加入的云盘…</p>;
  }
  if (state.kind !== "loaded") return null;
  const lastDrive = readLastDrive(userId);
  const missingLastDrive = autoEnter && Boolean(lastDrive) && !state.memberships.some(entry => entry.choir.id === lastDrive);
  if (!state.memberships.length) {
    return (
      <p className="membership-empty">{missingLastDrive && "上次使用的云盘已不在可访问列表中。"}
        还没有已加入的云盘。请使用云盘提供的邀请码加入。
      </p>
    );
  }
  const destination = state.memberships.find(entry => entry.choir.id === lastDrive)
    ?? (state.memberships.length === 1 ? state.memberships[0] : null);
  if (autoEnter && !missingLastDrive && destination) return <Navigate to={`/choirs/${destination.choir.id}`} replace />;
  return (
    <>
    {missingLastDrive && <p role="status">上次使用的云盘已不在可访问列表中，请选择其他云盘。</p>}
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
              {membership.isOwner ? "拥有者" : "成员"}
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

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import type { ScoreSummary } from "../../shared/scores";
import { ACTIVE_LOCAL_OWNER_KEY, guestOwnerSystemKey, localDatabase } from "../platform/local-database";
import { authenticatedLocalOwnerKey, createLocalWorkspace, resolveLocalWorkspace, type LocalWorkspaceOwnerKey } from "../platform/local-workspace";
import { offlineScoreLabel, useOfflineScore } from "../offline/use-offline-score";
import "./offline-score-control.css";

export function OfflineScoreControl({ score, authenticatedUserId, disabled = false }: {
  score: ScoreSummary; authenticatedUserId: string | null; disabled?: boolean;
}) {
  const identity = `${authenticatedUserId ?? "guest"}:${score.choirId}:${score.id}:${score.currentVersion.id}`;
  const currentIdentity = useRef(identity);
  useEffect(() => { currentIdentity.current = identity; return () => { currentIdentity.current = ""; }; }, [identity]);
  const owner = useLiveQuery(async () => {
    try {
    const active = await localDatabase.system.get(ACTIVE_LOCAL_OWNER_KEY);
    if (authenticatedUserId) return active?.value === authenticatedLocalOwnerKey(authenticatedUserId) ? authenticatedLocalOwnerKey(authenticatedUserId) : null;
    if (active?.value.startsWith("user:")) return active.value as LocalWorkspaceOwnerKey;
    return (await localDatabase.system.get(guestOwnerSystemKey(score.choirId)))?.value as LocalWorkspaceOwnerKey | undefined;
    } catch { return null; }
  }, [authenticatedUserId, score.choirId]);
  const workspace = owner ? createLocalWorkspace(owner, score.choirId, score.id) : null;
  const offline = useOfflineScore(workspace);
  const [attempt, setAttempt] = useState<{ identity: string; phase: "downloading" | "failed" | "ready"; message?: string } | null>(null);
  const running = useRef(false);
  const phase = attempt?.identity === identity ? attempt.phase : null;
  const record = offline?.scopeKey === workspace?.scopeKey ? offline?.record ?? null : null;
  const invalid = offline?.scopeKey === workspace?.scopeKey && offline?.invalid;
  const label = offlineScoreLabel(record, score.currentVersion.id, invalid);
  const prepare = async () => {
    if (running.current) return;
    running.current = true;
    setAttempt({ identity, phase: "downloading" });
    try {
      const target = await resolveLocalWorkspace({ authenticatedUserId, choirId: score.choirId, scoreId: score.id });
      if (currentIdentity.current !== identity) return;
      if (target.ownerKey.startsWith("user:") && target.ownerKey !== authenticatedLocalOwnerKey(authenticatedUserId ?? "")) {
        setAttempt({ identity, phase: "failed", message: "请先登录，再准备新的离线副本。现有副本仍可使用。" });
        return;
      }
      const { prepareOfflineScore } = await import("../offline/offline-score");
      if (currentIdentity.current !== identity) return;
      await prepareOfflineScore(target, score);
      if (currentIdentity.current === identity) setAttempt({ identity, phase: "ready" });
    } catch {
      if (currentIdentity.current === identity) setAttempt({ identity, phase: "failed" });
    } finally {
      running.current = false;
    }
  };
  return <div className="offline-score-control">
    <span role="status">{phase === "downloading" ? "正在下载并校验…" : phase === "failed" ? `${attempt?.message ?? "下载未完成"} · ${label}` : label}</span>
    {(!record || record.versionId !== score.currentVersion.id || phase === "failed") && <Button
      aria-label={`${phase === "failed" ? "重试下载" : "下载离线副本"}：${score.fileName}`}
      isDisabled={disabled || phase === "downloading"} onPress={() => void prepare()}>
      {phase === "failed" ? "重试" : phase === "downloading" ? "下载中…" : "下载"}
    </Button>}
  </div>;
}

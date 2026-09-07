import { scoreDisplayName } from "../../shared/score-display-name";
import { captureOfflineFileFence } from "../offline/local-files";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useRef, useState } from "react";
import { Button,  Heading, Popover, Tooltip, TooltipTrigger } from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { CircleAlert, Download, HardDriveDownload, LoaderCircle, RefreshCw, HardDrive, Check } from "lucide-react";
import type { ScoreSummary } from "../../shared/scores";
import { ACTIVE_LOCAL_OWNER_KEY, guestOwnerSystemKey, localDatabase } from "../platform/local-database";
import { authenticatedLocalOwnerKey, createLocalWorkspace, resolveLocalWorkspace, type LocalWorkspaceOwnerKey } from "../platform/local-workspace";
import { offlineScoreLabel, offlineDownloadFailure, useOfflineScore } from "../offline/use-offline-score";
import "./offline-score-control.css";

export function OfflineScoreControl({ score, authenticatedUserId, disabled = false }: {
  score: ScoreSummary; authenticatedUserId: string | null; disabled?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
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
  const inspected = Boolean(workspace && offline?.scopeKey === workspace.scopeKey);
  const record = offline?.scopeKey === workspace?.scopeKey ? offline?.record ?? null : null;
  const invalid = offline?.scopeKey === workspace?.scopeKey && offline?.invalid;
  const label = offlineScoreLabel(record, score.currentVersion.id, invalid, undefined);
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
      const fileFence = await captureOfflineFileFence(target);
      const { prepareOfflineScore } = await import("../offline/offline-score");
      if (currentIdentity.current !== identity) return;
      await prepareOfflineScore(target, score, "pdf", undefined, undefined, fileFence);
      if (currentIdentity.current === identity) setAttempt({ identity, phase: "ready" });
    } catch {
      if (currentIdentity.current === identity) setAttempt({ identity, phase: "failed" });
    } finally {
      running.current = false;
    }
  };
  const downloading = phase === "downloading";
  const failed = phase === "failed";
  const stale = Boolean(record && record.versionId !== score.currentVersion.id);
  const needsDownload = !record || invalid || stale || failed;
  const state = downloading ? "downloading" : failed || invalid ? "error" : stale ? "stale" : record ? "ready" : "missing";
  const description = downloading ? "正在下载并校验…" : failed ? attempt?.message ?? (inspected ? offlineDownloadFailure(record, score.currentVersion.id, invalid, undefined) : "离线下载未完成，尚未确认本机副本，请重试校验。") : label;
  const actionLabel = failed ? "重试下载" : stale ? "下载新版离线副本" : "下载离线副本";
  const Icon = state === "downloading" ? LoaderCircle : state === "error" ? CircleAlert : state === "stale" ? RefreshCw : state === "ready" ? HardDrive : Download;

  return <div className="offline-score-control" data-state={state}>
    <TooltipTrigger delay={400}>
      <Button
        ref={triggerRef}
        className="offline-score-button"
        aria-label={`${needsDownload && !downloading ? actionLabel : "离线副本"}：${scoreDisplayName(score.fileName)} · ${description}`}
        aria-haspopup="dialog"
        aria-expanded={detailsOpen}
        aria-controls={detailsOpen ? detailsId : undefined}
        isDisabled={disabled}
        onPress={() => {
          setDetailsOpen(true);
          if (needsDownload && !downloading) void prepare();
        }}
      >
        <Icon aria-hidden="true" size={20} />
        {state === "ready" && <Check className="offline-score-check" aria-hidden="true" size={12} />}
      </Button>
      <Tooltip className="offline-score-tooltip">{description}</Tooltip>
    </TooltipTrigger>
    {!detailsOpen && <span className="visually-hidden" role="status">{description}</span>}
    <Popover triggerRef={triggerRef} isOpen={detailsOpen} onOpenChange={setDetailsOpen} placement="bottom end" className="offline-score-popover">
      <Dialog id={detailsId} className="offline-score-details">
        <Heading slot="title"><HardDriveDownload aria-hidden="true" size={18} />离线副本</Heading>
        <p role="status">{description}</p>
        <p>保存在合谱中，供这台设备离线使用。</p>
        {state === "ready" && <p>已保存在这台设备上，断网也能打开。</p>}
        {needsDownload && <Button className="secondary-button" isDisabled={disabled || downloading} onPress={() => void prepare()}>{downloading ? "正在下载…" : actionLabel}</Button>}
        <Button className="text-button" onPress={() => setDetailsOpen(false)}>关闭</Button>
      </Dialog>
    </Popover>
  </div>;
}

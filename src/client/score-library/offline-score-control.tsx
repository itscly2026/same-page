import { offlinePreparationDescription } from "../offline/offline-score-status";
import { scoreDisplayName } from "../../shared/score-display-name";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useRef, useState } from "react";
import { Button,  Heading, Popover, Tooltip, TooltipTrigger } from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { CircleAlert, Download, HardDriveDownload, LoaderCircle, RefreshCw, HardDrive, Check } from "lucide-react";
import type { ScoreSummary } from "../../shared/scores";
import { ACTIVE_LOCAL_OWNER_KEY, guestOwnerSystemKey, localDatabase } from "../platform/local-database";
import { authenticatedLocalOwnerKey, createLocalWorkspace, resolveLocalWorkspace, type LocalWorkspaceOwnerKey } from "../platform/local-workspace";
import { useOfflineScore, useOfflinePreparation } from "../offline/use-offline-score";
import "./offline-score-control.css";

export function OfflineScoreControl({ score, authenticatedUserId, authenticatedSessionId, disabled = false }: {
  score: ScoreSummary; authenticatedUserId: string | null; authenticatedSessionId: string | null; disabled?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
  const owner = useLiveQuery(async () => {
    try {
    const active = await localDatabase.system.get(ACTIVE_LOCAL_OWNER_KEY);
    if (authenticatedUserId) return active?.value === authenticatedLocalOwnerKey(authenticatedUserId) ? authenticatedLocalOwnerKey(authenticatedUserId) : null;
    if (active?.value.startsWith("user:")) return active.value as LocalWorkspaceOwnerKey;
    return (await localDatabase.system.get(guestOwnerSystemKey(score.choirId)))?.value as LocalWorkspaceOwnerKey | undefined ?? null;
    } catch { return null; }
  }, [authenticatedUserId, score.choirId]);
  useEffect(() => {
    if (owner !== null || disabled || authenticatedUserId) return;
    const controller = new AbortController();
    // A first-time guest has no owner until a workspace is established. The
    // live query observes its creation before downloads become available.
    void resolveLocalWorkspace({ authenticatedUserId: null, choirId: score.choirId, scoreId: score.id, signal: controller.signal }).catch(() => undefined);
    return () => controller.abort();
  }, [owner, disabled, authenticatedUserId, score.choirId, score.id]);
  const workspace = owner ? createLocalWorkspace(owner, score.choirId, score.id) : null;
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const offline = useOfflineScore(workspace, inspectionAttempt);
  const { state: attempt, prepare } = useOfflinePreparation(workspace, score, authenticatedUserId, authenticatedSessionId);
  const phase = attempt.phase;
  const inspected = Boolean(workspace && offline?.scopeKey === workspace.scopeKey);
  const record = offline?.scopeKey === workspace?.scopeKey ? offline?.record ?? null : null;
  const invalid = offline?.scopeKey === workspace?.scopeKey && offline?.invalid;
  const readFailed = inspected && offline?.readFailed;
  const downloading = phase === "preparing";
  const explicitDownload = attempt.phase === "preparing" && attempt.intent === "explicit";
  const failed = phase === "failed";
  const stale = Boolean(record && record.versionId !== score.currentVersion.id);
  const needsDownload = !record || invalid || stale || failed;
  const state = downloading ? "downloading" : failed || invalid || readFailed ? "error" : stale ? "stale" : record ? "ready" : "missing";
  const description = offlinePreparationDescription(attempt, inspected ? { record, invalid: Boolean(invalid), readFailed } : null, score.currentVersion.id);
  const actionLabel = failed ? "重试下载" : stale ? "下载新版离线副本" : "下载离线副本";
  const Icon = state === "downloading" ? LoaderCircle : state === "error" ? CircleAlert : state === "stale" ? RefreshCw : state === "ready" ? HardDrive : Download;

  return <div className="offline-score-control" data-state={state}>
    <TooltipTrigger delay={400}>
      <Button
        ref={triggerRef}
        className="offline-score-button"
        aria-label={`离线副本：${scoreDisplayName(score.fileName)} · ${description}`}
        aria-haspopup="dialog"
        aria-expanded={detailsOpen}
        aria-controls={detailsOpen ? detailsId : undefined}
        isDisabled={disabled || !workspace}
        onPress={() => {
          setDetailsOpen(true);
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
        <p>保存在这台设备上，供断网时打开。</p>
        {readFailed && <Button className="secondary-button" onPress={() => setInspectionAttempt(value => value + 1)}>重试校验</Button>}
        {!readFailed && needsDownload && <Button className="secondary-button" isDisabled={disabled || !workspace || explicitDownload} onPress={() => void prepare()}>{downloading ? explicitDownload ? "正在下载…" : "继续下载（切换页面不中断）" : actionLabel}</Button>}
        <Button className="text-button" onPress={() => setDetailsOpen(false)}>关闭</Button>
      </Dialog>
    </Popover>
  </div>;
}

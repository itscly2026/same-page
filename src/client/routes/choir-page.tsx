import { scoreDisplayName } from "../../shared/score-display-name";
import { hasManagement, type Operation } from "../../shared/drive-permissions";
import { BackButton } from "../navigation/back-button";
import { ScoreLink } from "../score-library/score-link";
import { useNetworkStatus } from "../platform/use-network-status";
import { DriveSettingsDialog } from "../score-library/drive-settings-dialog";
import { rememberLastDrive, forgetLastDrive } from "../score-library/last-drive";
import { useApplicationIdentity } from "../auth/application-identity";
import { IdentityNotice } from "../auth/local-entry";
import type { ApplicationIdentity } from "../auth/application-identity";
import { ChevronDown } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  Button,
  Form,
  Input,
  Label,

  MenuItem,
  MenuTrigger,
  Popover,
  TextField,
} from "react-aria-components";
import { Menu } from "../navigation/overlays";
import { Link, useParams } from "react-router-dom";

import type { ScoreSummary } from "../../shared/scores";
import { AppHeader } from "../components/app-header";
import {
  completeLoadingJourney,
  ensureLoadingJourney,
  isLoadingJourneyActive,
  startLoadingJourney,
} from "../performance/loading-performance";
import { rememberReaderScore } from "../reader/reader-score-cache";
import { classifyReaderOpen } from "../reader/reader-reopen-tracker";
import { scheduleReaderRuntimePreload } from "../reader/reader-runtime";
import { driveCacheOwnerKey, type DriveCacheOwnerKey } from "../score-library/drive-library-cache";
import { useDriveLibrary } from "../score-library/use-drive-library";
import {
  ScoreActionDialog,
  type ScoreAction,
  type ScoreActionSelection,
} from "../score-library/score-action-dialog";
import { formatBytes } from "../score-library/library-format";
import { UploadDialog } from "../score-library/upload-dialog";

import { DriveHeader } from "../score-library/drive-header";
import { UploadFab } from "../score-library/upload-fab";
import type { LibrarySort } from "../score-library/library-view-state";
import { OfflineScoreControl } from "../score-library/offline-score-control";

const LibraryExportDialog = lazy(() => import("../score-library/library-export-dialog").then(module => ({ default: module.LibraryExportDialog })));

export default function ChoirPage() {
  const { choirId = "" } = useParams();
  const identity = useApplicationIdentity();
  const cacheOwner = driveCacheOwnerKey(identity.localUserId, choirId);
  return <ChoirLibrary key={`${choirId}:${cacheOwner}`} choirId={choirId} identity={identity} cacheOwner={cacheOwner} />;
}

function ChoirLibrary({ choirId, identity, cacheOwner }: { choirId: string; identity: ApplicationIdentity; cacheOwner: DriveCacheOwnerKey }) {
  const { session } = identity;
  const userId = identity.localUserId ?? undefined;
  const online = useNetworkStatus();
  const { library, snapshot } = useDriveLibrary(cacheOwner, choirId, Boolean(identity.authenticatedUserId), !identity.restoring && (Boolean(userId) || identity.onlineState !== "checking"), identity.authenticatedSessionId);
  const { access, view: { search, sort }, scores: visibleScores, refreshMessage: searchMessage, joining: busy } = snapshot;
  const [openAdmissionDisplayName, setOpenAdmissionDisplayName] = useState("");
  const [displayName, setDisplayName] = useState<string>();
  const [settingsField, setSettingsField] = useState<"display-name" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [exportScore, setExportScore] = useState<ScoreSummary | null>(null);
  const [scoreAction, setScoreAction] = useState<ScoreActionSelection | null>(null);
  const refresh = library.refresh;
  const refreshAfterMutation = library.changed;
  const updateSearch = library.setSearch;
  const updateSort = library.setSort;

  useEffect(() => {
    if (!userId) return;
    if (access.kind === "opened" && !access.choir.isPreviewEntry && (access.isMember || access.rememberedMembership)) rememberLastDrive(userId, choirId);
    if (access.kind === "denied" || access.kind === "not-found" || (access.kind === "opened" && access.retained)) forgetLastDrive(userId, choirId);
  }, [access, userId, choirId]);

  useEffect(() => {
    if (!isLoadingJourneyActive("exit-score")) {
      ensureLoadingJourney("enter-drive", "direct");
    }
  }, []);

  useEffect(() => {
    if (access.kind !== "opened") return;
    const frame = window.requestAnimationFrame(() => {
      if (isLoadingJourneyActive("exit-score")) {
        completeLoadingJourney("exit-score", "drive-list-restored");
      } else {
        completeLoadingJourney("enter-drive", "drive-list-usable");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [access]);

  useEffect(() => {
    if (access.kind !== "opened") return;
    return scheduleReaderRuntimePreload();
  }, [access.kind]);

  const openScoreAction = (score: ScoreSummary, action: ScoreAction) => {
    setScoreAction({ score, action });
    setMessage(null);
  };

  const headerActions = <Link className="header-action" to="/drives">云盘列表</Link>;

  if (access.kind === "join-required") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <main className="page-shell compact-page access-page">
          <p className="eyebrow">开放准入</p>
          <h1>{access.choir.name}</h1>
          <p className="hero__copy">填写你在这个云盘中的显示名后即可加入。</p>
          <Form className="entry-form" data-update-busy={openAdmissionDisplayName.trim() || busy ? "true" : undefined} onSubmit={(event) => { event.preventDefault(); void library.join(openAdmissionDisplayName); }}>
            <TextField
              isRequired
              value={openAdmissionDisplayName}
              onChange={setOpenAdmissionDisplayName}
              maxLength={40}
            >
              <Label>显示名</Label>
              <Input autoComplete="nickname" placeholder="例如：小花" />
            </TextField>
            <Button type="submit" isDisabled={busy}>
              {busy ? "正在加入…" : "加入并进入"}
            </Button>
          </Form>
          {snapshot.joinMessage ? <p role="alert">{snapshot.joinMessage}</p> : null}
        </main>
      </div>
    );
  }

  if (access.kind === "loading") {
    return (
      <div className="app-page drive-page">
        <DriveHeader loading choirId={choirId} choirName={access.choir?.name ?? "云盘"} userId={userId} resolvingIdentity={identity.restoring || identity.onlineState === "checking"} search={search} onSearch={updateSearch} onRefresh={() => void refresh()} />
        <main className="page-shell file-library">{access.choir && <h1 className="visually-hidden">{access.choir.name}</h1>}<p className="route-loading" role="status">正在加载乐谱…</p></main>
      </div>
    );
  }

  if (access.kind !== "opened") return null;
  const { choir, result } = access;
  const capabilities = result.permissions.capabilities;
  const visibleCapabilities = access.local ? access.rememberedCapabilities ?? capabilities : capabilities;
  const visible = (operation: Operation) => visibleCapabilities.operations.operations.includes(operation);
  const can = (operation: Operation) => capabilities.operations.operations.includes(operation);
  const managementVisible = hasManagement(capabilities) || access.managementVisible;
  const localFilesOnly = Boolean(access.local);
  const storageRatio = result.storage.usedBytes / result.storage.limitBytes;

  return (
    <div className="app-page drive-page">
      <DriveHeader refreshing={snapshot.reading.request === "pending"} displayName={displayName} choirId={choirId} choirName={choir.name} userId={userId} localOnly={Boolean(access.local)} onEditDisplayName={(access.isMember || access.rememberedMembership) ? () => setSettingsField("display-name") : undefined} search={search} onSearch={updateSearch} onRefresh={() => void refresh()}
        management={() => <section className="drive-drawer-management">
          <h3>云盘管理</h3>
          <nav aria-label="云盘管理菜单">{[
            ["settings/info", "基本信息"], ["memberships", "成员与权限"], ["shared-layers", "共享层"], ["settings/admission", "加入方式"], ["settings/trash", "回收站"],
          ].map(([path, label]) => access.local ? <span key={path} aria-disabled="true">{label}</span> : <Link key={path} to={`/choirs/${choirId}/${path}`}>{label}</Link>)}</nav>
          {access.local && <p role="status">{!online ? "当前离线，联网后可使用管理操作。" : identity.onlineState === "signed-out" ? "重新登录后可使用管理操作。" : snapshot.reading.request === "pending" ? null : "访问权限尚未确认，请重试连接。"}</p>}
        </section>}
      />
      <main className="page-shell file-library">
        {access.retained && <p role="status">已无法访问此云盘，以下为本机保留内容</p>}
        {(!online || (Boolean(userId) && identity.onlineState === "signed-out") || identity.onlineState === "unreachable" || searchMessage) && <details className="drive-connection-notice"><summary>{!online ? "离线" : searchMessage ? "列表更新失败" : identity.onlineState === "unreachable" ? "连接暂不可用" : "需要重新登录"}</summary>
          <IdentityNotice identity={identity} />
          {searchMessage && <p role="status">{searchMessage}<Button onPress={() => void refresh()}>重试</Button></p>}
        </details>}
        <section className="library-workspace" aria-labelledby="library-content-title">
          <div className="library-toolbar">
            <div className="library-controls">
              <div className="library-title"><h1 id="library-content-title">{choir.name}</h1>{search.trim() && <p>找到 {visibleScores.length} 份乐谱</p>}</div>
              <label className="library-sort-label">
                排序
                <span className="library-sort-control">
                  <select
                    aria-label="乐谱排序"
                    value={sort}
                    onChange={(event) => updateSort(event.target.value as LibrarySort)}
                  >
                    <option value="name">名称</option>
                    <option value="updated">最近更新</option>
                    <option value="opened">本机最近打开</option>
                  </select>
                  <ChevronDown aria-hidden="true" size={16} />
                </span>
              </label>
            </div>
          </div>
          {search.trim() && <p className="visually-hidden" role="status">找到 {visibleScores.length} 份乐谱{localFilesOnly ? "，仅搜索本机记录" : ""}</p>}

          {can("uploadFiles") && (storageRatio >= 0.8 || quotaBlocked) ? (
            <p className="storage-warning" role="status">
              云盘存储已使用 {formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}。
              {quotaBlocked ? " 请根据上传提示释放空间或乐谱名额后再上传。" : " 接近上限，请留意后续上传。"}
            </p>
          ) : null}
          {message ? <p className="library-message" role="status">{message}</p> : null}

          {visibleScores.length > 0 ? (
            <section className="file-list" aria-label="PDF 文件">
              {visibleScores.map((score) => (
                <article className="file-row" key={score.id}>
                  <ScoreLink experience={choir.isPreviewEntry === true} label={scoreDisplayName(score.fileName)} description={`文件大小 ${formatFileSize(score.currentVersion.sizeBytes)}`} userId={userId} choirId={choirId} scoreId={score.id} local={localFilesOnly}
                    onOpen={() =>
                      {
                        startLoadingJourney(
                          "open-score",
                          classifyReaderOpen(userId ?? "guest", choirId, score.id),
                        );
                        library.prepareScoreOpen(window.scrollY);
                        rememberReaderScore(userId ?? "guest", score);
                      }
                    }
                  >
                    <span className="pdf-file-icon" aria-hidden="true">PDF</span>
                    <span className="file-row__info"><span className="file-row__name" title={scoreDisplayName(score.fileName)}>{scoreDisplayName(score.fileName)}</span><span className="file-row__size">{formatFileSize(score.currentVersion.sizeBytes)}</span></span>
                  </ScoreLink>
                  <div className="file-row__offline"><OfflineScoreControl experience={choir.isPreviewEntry === true} score={score} authenticatedUserId={userId ?? null} authenticatedSessionId={identity.authenticatedSessionId} disabled={session.isPending || access.local} /></div>
                  <MenuTrigger>
                      <Button className="file-menu-button" aria-label={`${scoreDisplayName(score.fileName)} 更多操作`}>
                        ···
                      </Button>
                      <Popover className="file-menu-popover">
                        <Menu
                          aria-label={`${scoreDisplayName(score.fileName)} 操作`}
                          disabledKeys={!online || access.local ? ["rename", "replace", "history", "trash"] : []}
                          onAction={(key) => key === "export" ? setExportScore(score) : openScoreAction(score, key as ScoreAction)}
                        >
                          <MenuItem id="export">导出 PDF</MenuItem>
                          <MenuItem id="info">文件信息</MenuItem>
                          {managementVisible && <>
                          {visible("modifyFiles") && <MenuItem id="rename">重命名</MenuItem>}
                          {visible("modifyFiles") && <MenuItem id="replace">替换 PDF</MenuItem>}
                          {visible("modifyFiles") && <MenuItem id="history">历史 PDF 版本</MenuItem>}
                          {visible("trashFiles") && <MenuItem id="trash">移到回收站</MenuItem>}
                          </>}
                        </Menu>
                      </Popover>
                    </MenuTrigger>
                </article>
              ))}
            </section>
          ) : (
            <div className="library-empty-state">{access.retained && <BackButton className="secondary-link" to="/drives">云盘列表</BackButton>}{search.trim() ? <><p>没有找到包含「{search}」的乐谱。</p><Button className="secondary-button" onPress={() => updateSearch("")}>清除搜索</Button></> : <><p>{access.retained ? "本机没有可用的保留副本。" : access.local ? "本机尚未保存这个云盘的目录或乐谱，请联网后下载。" : "这个云盘还没有乐谱。"}</p><p>{can("uploadFiles") ? "上传第一份 PDF，开始准备排练。" : access.isMember ? "有上传权限的成员上传乐谱后，会显示在这里。" : "暂时没有可浏览的乐谱，请稍后再来。"}</p>{can("uploadFiles") ? <Button className="secondary-button" onPress={() => setUploadOpen(true)}>上传第一份 PDF</Button> : null}</>}</div>
          )}
        </section>
      </main>

      {exportScore && <Suspense fallback={<p role="status">正在准备导出…</p>}><LibraryExportDialog key={`${exportScore.id}:${userId}`} score={exportScore} authenticatedUserId={userId ?? null} onClose={() => setExportScore(null)} /></Suspense>}
      {settingsField && !access.local && <DriveSettingsDialog key={`${choirId}:${userId}:${settingsField}`} choirId={choirId} userId={userId!} field={settingsField} onClose={() => setSettingsField(null)} onSaved={async value => { setDisplayName(value); setMessage(null); }} />}
      {visible("uploadFiles") && <UploadFab disabled={!online || Boolean(access.local)} onPress={() => setUploadOpen(true)} />}


      {userId && can("uploadFiles") ? <UploadDialog storage={result.storage}
        key={`upload:${choirId}:${userId}`}
        choirId={choirId}
        isOpen={uploadOpen}
        onOpenChange={setUploadOpen}
        onComplete={refreshAfterMutation}
        onQuotaChange={setQuotaBlocked}
        onInspect={(fileName) => {
          updateSearch(fileName.trim());
          setMessage("请核对同名文件；若刚中断上传，服务端可能仍在处理，可稍后再次刷新。不要在结果不明时重传。");
          void refreshAfterMutation();
        }}
      /> : null}
      {scoreAction && (scoreAction.action === "info" || can(scoreAction.action === "trash" ? "trashFiles" : "modifyFiles")) ? (
        <ScoreActionDialog canPurge={result.permissions.capabilities.isOwner}
          key={`${scoreAction.score.id}:${scoreAction.action}`}
          choirId={choirId}
          selection={scoreAction}
          onClose={() => setScoreAction(null)}
          onComplete={async (nextMessage) => {
            if (scoreAction.action === "trash") await library.confirmRemoval(scoreAction.score.id);
            await refreshAfterMutation();
            setScoreAction(null);
            setMessage(nextMessage);
          }}
        />
      ) : null}
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

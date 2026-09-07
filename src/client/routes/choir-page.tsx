import { scoreDisplayName } from "../../shared/score-display-name";
import { InstallSuggestion } from "../install/install-entry";
import { hasManagement, isDelegated, type Operation } from "../../shared/drive-permissions";
import { BackButton } from "../navigation/back-button";
import { ScoreLink } from "../score-library/score-link";
import { useNetworkStatus } from "../platform/use-network-status";
import { DriveSettingsDialog } from "../score-library/drive-settings-dialog";
import { rememberLastDrive, forgetLastDrive } from "../score-library/last-drive";
import { LocalLibrary } from "../score-library/local-library";
import { useApplicationIdentity } from "../auth/application-identity";
import { IdentityNotice } from "../auth/local-entry";
import type { ApplicationIdentity } from "../auth/application-identity";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
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
import { InviteCodeDialog } from "../score-library/invite-code-dialog";
import { TrashDialog } from "../score-library/trash-dialog";
import { UploadDialog } from "../score-library/upload-dialog";

import { DriveHeader } from "../score-library/drive-header";
import { UploadFab } from "../score-library/upload-fab";
import type { LibrarySort } from "../score-library/library-view-state";
import { OfflineScoreControl } from "../score-library/offline-score-control";

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
  const { library, snapshot } = useDriveLibrary(cacheOwner, choirId, Boolean(identity.authenticatedUserId) && online, !identity.restoring && (Boolean(userId) || identity.onlineState !== "checking"));
  const { access, view: { search, sort }, scores: visibleScores, refreshMessage: searchMessage, joining: busy } = snapshot;
  const [openAdmissionDisplayName, setOpenAdmissionDisplayName] = useState("");
  const [settingsField, setSettingsField] = useState<"name" | "display-name" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [inviteManagementOpen, setInviteManagementOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [scoreAction, setScoreAction] = useState<ScoreActionSelection | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const refresh = library.refresh;
  const refreshAfterMutation = library.changed;
  const updateSearch = library.setSearch;
  const updateSort = library.setSort;

  useEffect(() => {
    if (!userId) return;
    if (access.kind === "opened" && !access.choir.isPreviewEntry && (access.isMember || access.rememberedMembership)) rememberLastDrive(userId, choirId);
    if (access.kind === "denied" || access.kind === "not-found") forgetLastDrive(userId, choirId);
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

  const headerActions = <Link className="header-action" to="/drives">返回所有云盘</Link>;

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

  if (access.kind === "denied") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <main className="page-shell compact-page access-page">
          <p className="eyebrow">云盘</p>
          <h1>无法访问这个云盘</h1>
          <p className="hero__copy">请返回首页输入当前邀请码，或使用有成员关系的邮箱登录。</p>
          <BackButton className="primary-link" to="/drives">返回首页</BackButton>
          {userId && <LocalLibrary userId={userId} choirId={choirId} />}
        </main>
      </div>
    );
  }

  if (access.kind === "not-found") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <main className="page-shell compact-page access-page">
          <p className="eyebrow">云盘</p>
          <h1>这个云盘不存在</h1>
          <p className="hero__copy">链接可能已经失效，请返回首页重新选择云盘。</p>
          <BackButton className="primary-link" to="/drives">返回首页</BackButton>
          {userId && <LocalLibrary userId={userId} choirId={choirId} />}
        </main>
      </div>
    );
  }

  if (access.kind === "failed") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <main className="page-shell compact-page access-page">
          <p className="eyebrow">云盘</p>
          <h1>暂时无法打开云盘</h1>
          <p className="hero__copy">网络或服务暂时不可用，请稍后重试。</p>
          {userId && <LocalLibrary userId={userId} choirId={choirId} />}
          <Button className="primary-button" onPress={() => void refresh()}>
            重试
          </Button>
        </main>
      </div>
    );
  }

  if (access.kind === "loading") {
    return (
      <div className="app-page drive-page">
        <DriveHeader choirId={choirId} choirName={access.choir?.name ?? "云盘"} userId={userId} resolvingIdentity={identity.restoring || identity.onlineState === "checking"} search={search} onSearch={updateSearch} onRefresh={() => void refresh()} />
        <main className="page-shell file-library">{access.choir && <h1 className="visually-hidden">{access.choir.name}</h1>}<p className="route-loading" role="status">正在加载乐谱…</p></main>
      </div>
    );
  }

  const { choir, result } = access;
  const capabilities = result.permissions.capabilities;
  const visibleCapabilities = access.local ? access.rememberedCapabilities ?? capabilities : capabilities;
  const visible = (operation: Operation) => visibleCapabilities.operations.operations.includes(operation);
  const can = (operation: Operation) => capabilities.operations.operations.includes(operation);
  const managementVisible = hasManagement(capabilities) || access.managementVisible;
  const localFilesOnly = Boolean(access.local) && (!online || Boolean(searchMessage) || (Boolean(userId) && identity.onlineState !== "authenticated"));
  const storageRatio = result.storage.usedBytes / result.storage.limitBytes;

  return (
    <div className="app-page drive-page">
      <DriveHeader choirId={choirId} choirName={choir.name} userId={userId} localOnly={Boolean(access.local)} onEditDisplayName={access.isMember && !access.local ? () => setSettingsField("display-name") : undefined} search={search} onSearch={updateSearch} onRefresh={() => void refresh()}
        management={managementVisible ? close => <section className="drive-drawer-management">
          <h3>云盘管理</h3>
          <Menu aria-label="云盘管理菜单" disabledKeys={access.local ? ["name", "memberships", "layers", "trash", "invite"] : []} onAction={key => {
            close();
            if (key === "name") setSettingsField("name");
            if (key === "trash") setTrashOpen(true);
            if (key === "invite") setInviteManagementOpen(true);
          }}>
            {visible("editDriveInfo") && <MenuItem id="name">云盘名称</MenuItem>}
            {(visibleCapabilities.isOwner || isDelegated(visibleCapabilities.management) || visible("removeMembers")) && <MenuItem id="memberships" href={`/choirs/${choirId}/memberships`}>成员与权限</MenuItem>}
            {visible("configureLayers") && <MenuItem id="layers" href={`/choirs/${choirId}/shared-layers`}>共享层</MenuItem>}
            {visible("trashFiles") && <MenuItem id="trash">回收站</MenuItem>}
            {visible("manageInvites") && choir.guestAdmissionMode === "invite" && <MenuItem id="invite">邀请码</MenuItem>}
          </Menu>
          {access.local && <p role="status">管理操作需联网并确认权限后使用。</p>}
          <p className="drive-storage">云盘存储：{formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}</p>
        </section> : undefined}
      />
      <main className="page-shell file-library">
        <h1 className="visually-hidden">{choir.name}</h1>
        <InstallSuggestion />
        {(!online || identity.onlineState === "signed-out" || identity.onlineState === "unreachable" || searchMessage) && <details className="drive-connection-notice"><summary>{!online ? "离线" : searchMessage ? "列表更新失败" : identity.onlineState === "unreachable" ? "连接暂不可用" : "需要重新登录"}</summary>
          <IdentityNotice identity={identity} />
          {searchMessage && <p role="status">{searchMessage}<Button onPress={() => void refresh()}>重试</Button></p>}
        </details>}
        <section className="library-workspace" aria-labelledby="library-content-title">
          <div className="library-toolbar">
            <div className="library-controls">
              <h2 id="library-content-title">乐谱 <span className="drive-score-count">{result.scores.length}</span></h2>
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
          {search.trim() ? <p className="library-results-summary" role="status">{localFilesOnly ? "仅搜索本机记录 · " : ""}找到 {visibleScores.length} 份，共 {result.scores.length} 份乐谱</p> : null}

          {can("uploadFiles") && (storageRatio >= 0.8 || quotaBlocked) ? (
            <p className="storage-warning" role="status">
              云盘存储已使用 {formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}。
              {quotaBlocked ? " 请先释放空间后再上传。" : " 接近上限，请留意后续上传。"}
            </p>
          ) : null}
          {message ? <p className="library-message" role="status">{message}</p> : null}

          {visibleScores.length > 0 ? (
            <section className="file-list" aria-label="PDF 文件">
              {visibleScores.map((score) => (
                <article className="file-row" key={score.id}>
                  <ScoreLink userId={userId} choirId={choirId} scoreId={score.id} local={localFilesOnly}
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
                    <span className="file-row__name" title={scoreDisplayName(score.fileName)}>{scoreDisplayName(score.fileName)}</span>
                  </ScoreLink>
                  <div className="file-row__offline"><OfflineScoreControl score={score} authenticatedUserId={userId ?? null} authenticatedSessionId={identity.authenticatedSessionId} disabled={session.isPending || access.local} /></div>
                  <MenuTrigger>
                      <Button className="file-menu-button" aria-label={`${scoreDisplayName(score.fileName)} 更多操作`}>
                        ···
                      </Button>
                      <Popover className="file-menu-popover">
                        <Menu
                          aria-label={`${scoreDisplayName(score.fileName)} 操作`}
                          disabledKeys={access.local ? ["rename", "replace", "history", "trash"] : []}
                          onAction={(key) => openScoreAction(score, key as ScoreAction)}
                        >
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
            <div className="library-empty-state">{search.trim() ? <><p>没有找到包含「{search}」的乐谱。</p><Button className="secondary-button" onPress={() => updateSearch("")}>清除搜索</Button></> : <><p>{access.local ? "本机尚未保存这个云盘的目录或乐谱，请联网后下载。" : "这个云盘还没有乐谱。"}</p><p>{can("uploadFiles") ? "上传第一份 PDF，开始准备排练。" : access.isMember ? "有上传权限的成员上传乐谱后，会显示在这里。" : "暂时没有可浏览的乐谱，请稍后再来。"}</p>{can("uploadFiles") ? <Button className="secondary-button" onPress={() => setUploadOpen(true)}>上传第一份 PDF</Button> : null}</>}</div>
          )}
        </section>
      </main>

      {settingsField && !access.local && (settingsField === "display-name" || can("editDriveInfo")) && <DriveSettingsDialog key={`${choirId}:${userId}:${settingsField}`} choirId={choirId} field={settingsField} onClose={() => setSettingsField(null)} onSaved={async value => { if (settingsField === "name") await library.confirmName(value); await refreshAfterMutation(); setMessage("已保存。"); }} />}
      {visible("uploadFiles") && <UploadFab disabled={Boolean(access.local)} onPress={() => setUploadOpen(true)} />}

      {inviteManagementOpen && can("manageInvites") ? (
        <InviteCodeDialog
          key={`${choirId}:${userId}`}
          choirId={choirId}
          choirName={choir.name}
          onClose={() => setInviteManagementOpen(false)}
        />
      ) : null}

      {userId && can("uploadFiles") ? <UploadDialog
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
        <ScoreActionDialog
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
      {trashOpen && can("trashFiles") ? (
        <TrashDialog
          choirId={choirId}
          onClose={() => setTrashOpen(false)}
          onRestored={refreshAfterMutation}
        />
      ) : null}
    </div>
  );
}

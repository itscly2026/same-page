import { ConfirmDialog } from "../settings/confirm-dialog";
import { Copy, Download, Share2, Link as LinkIcon } from "lucide-react";
import { InviteCard } from "./invite-card";
import { createInviteCardFile, deliverInviteCard } from "./save-invite-card";
import { createInviteLink } from "../components/invite-link";
import { useRef, useEffect, useState, type FormEvent } from "react";
import { Button, Form } from "react-aria-components";

import { currentJoinCodeResponseSchema, rotateJoinCodeResponseSchema } from "../../shared/choirs";
import { JoinCodeField } from "../components/join-code-field";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { JOIN_CODE_LENGTH } from "../components/join-code";

export function InviteSharing({ choirId, choirName }: { choirId: string; choirName: string }) {
  const cardRef = useRef<SVGSVGElement>(null);
  const [confirmRotation, setConfirmRotation] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [currentCode, setCurrentCode] = useState<string | null>(null);
  const [cardFile, setCardFile] = useState<{ code: string; file: File } | null>(null);
  const [cardError, setCardError] = useState(false);
  const [cardAttempt, setCardAttempt] = useState(0);
  const [originalCode, setOriginalCode] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const endpoint = `/api/choirs/${choirId}/join-code`;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await diagnosticFetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("load_failed");
        const { joinCode } = await parseDiagnosticResponse(response, currentJoinCodeResponseSchema);
        if (controller.signal.aborted) return;
        setCurrentCode(joinCode);
        setLoaded(true);
        setMessage(null);
      } catch {
        if (!controller.signal.aborted) setMessage("暂时无法读取邀请码，请重试。");
      }
    })();
    return () => controller.abort();
  }, [endpoint, reload]);

  // Prepare before the share press so navigator.share retains user activation.
  useEffect(() => {
    if (!currentCode || !cardRef.current) return;
    let active = true;
    void createInviteCardFile(cardRef.current).then(file => {
      if (active) { setCardFile({ code: currentCode, file }); setCardError(false); }
    }).catch(() => { if (active) setCardError(true); });
    return () => { active = false; };
  }, [currentCode, choirName, cardAttempt]);
  const readyFile = cardFile?.code === currentCode ? cardFile.file : null;

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label}已复制。`);
    } catch {
      setMessage("复制失败，请重试或保存邀请卡分享。");
    }
  }

  async function deliver(share: boolean) {
    if (!readyFile) return;
    setSharing(true);
    try {
      const result = await deliverInviteCard(readyFile, share);
      setMessage(result === "saved" ? "邀请卡已生成，请在下载中查看。" : null);
    } catch {
      setMessage("邀请卡生成或分享失败，请重试。");
    } finally {
      setSharing(false);
    }
  }

  async function rotate() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await diagnosticFetch(`${endpoint}/rotate`, { method: "POST" });
      if (!response.ok) throw new Error("rotation_failed");
      setCurrentCode((await parseDiagnosticResponse(response, rotateJoinCodeResponseSchema)).joinCode);
      setMessage("邀请码已轮换，可随时在这里查看。");
    } catch {
      setMessage("邀请码轮换失败，请重新打开确认当前邀请码。");
      setLoaded(false);
      setCurrentCode(null);
    } finally {
      setBusy(false);
    }
  }

  async function saveOriginal(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await diagnosticFetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ joinCode: originalCode }),
      });
      if (!response.ok) {
        setMessage(response.status === 409 ? "输入的原码与当前有效邀请码不一致。" : "暂时无法保存邀请码，请重试。");
        return;
      }
      setCurrentCode(originalCode);
      setOriginalCode("");
      setMessage("已保存，原邀请码继续有效，可随时在这里查看。");
    } catch {
      setMessage("暂时无法保存邀请码，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="invite-sharing-dialog invite-sharing-page" aria-label="邀请加入云盘">
          {currentCode ? (
            <>
              <InviteCard ref={cardRef} choirName={choirName} code={currentCode} link={createInviteLink(window.location.origin, currentCode)} />
              <div className="invite-share-actions">
                <Button className="secondary-button" isDisabled={busy || sharing} onPress={() => void copy(createInviteLink(window.location.origin, currentCode), "邀请链接")}><LinkIcon size={18} />复制邀请链接</Button>
                <Button className="secondary-button" isDisabled={busy || sharing} onPress={() => void copy(currentCode, "邀请码")}><Copy size={18} />复制邀请码</Button>
                <Button className="secondary-button" isDisabled={busy || sharing || !readyFile} onPress={() => void deliver(true)}><Share2 size={18} />分享邀请卡</Button>
                <Button className="secondary-button" isDisabled={busy || sharing || !readyFile} onPress={() => void deliver(false)}><Download size={18} />保存邀请卡</Button>
              </div>
              {cardError && <p role="alert">邀请卡生成失败。<Button onPress={() => { setCardError(false); setCardAttempt(value => value + 1); }}>重新生成</Button></p>}
            </>
          ) : loaded ? (
            <>
              <p className="drive-management-copy">当前邀请码尚未保存为可查看的形式。如果你保留了原码，可以补录；也可以轮换生成新码。</p>
              <Form className="entry-form" onSubmit={saveOriginal}>
                <JoinCodeField value={originalCode} onChange={setOriginalCode} />
                <Button type="submit" isDisabled={busy || originalCode.length !== JOIN_CODE_LENGTH}>保存原邀请码</Button>
              </Form>
            </>
          ) : !message ? <p role="status">正在读取邀请码…</p> : null}
          <div className="invite-rotation"><p className="drive-management-copy">轮换后，旧邀请码、邀请链接和二维码将一同失效。</p>
          <Button className="secondary-button" isDisabled={busy || sharing || !loaded} onPress={() => setConfirmRotation(true)}>
            {busy ? "正在保存…" : "轮换邀请码"}
          </Button>
          </div><ConfirmDialog confirmation={confirmRotation ? { title: "轮换邀请码", action: "确认轮换", message: "当前邀请码、邀请链接和二维码会立即失效。请将新邀请方式发给需要加入的人。", onConfirm: rotate } : null} busy={busy} onClose={() => setConfirmRotation(false)} />
          {message ? <p className="library-message" role="status">{message}</p> : null}
          {!loaded && message ? <Button onPress={() => setReload((value) => value + 1)}>重试</Button> : null}
    </section>
  );
}

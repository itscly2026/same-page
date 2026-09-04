import { useEffect, useState, type FormEvent } from "react";
import { Button, Dialog, Form, Heading, Modal, ModalOverlay } from "react-aria-components";

import { currentJoinCodeResponseSchema, rotateJoinCodeResponseSchema } from "../../shared/choirs";
import { JoinCodeField } from "../components/join-code-field";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { JOIN_CODE_LENGTH } from "../components/join-code";

export function InviteCodeDialog({ choirId, onClose }: { choirId: string; onClose: () => void }) {
  const [currentCode, setCurrentCode] = useState<string | null>(null);
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

  async function rotate() {
    if (!window.confirm("轮换后当前邀请码会立即失效。确认继续吗？")) return;
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
    <ModalOverlay className="modal-overlay" isOpen onOpenChange={(open) => { if (!open) onClose(); }} isDismissable={!busy}>
      <Modal className="app-modal app-modal--compact">
        <Dialog className="app-dialog drive-management-dialog">
          <div className="dialog-heading">
            <div><p className="dialog-eyebrow">管理</p><Heading slot="title">邀请码</Heading></div>
            <Button className="icon-button" aria-label="关闭" isDisabled={busy} onPress={onClose}>×</Button>
          </div>
          {currentCode ? (
            <div className="join-code-result">
              <p>当前有效邀请码</p>
              <output aria-label="当前有效邀请码">{currentCode}</output>
            </div>
          ) : loaded ? (
            <>
              <p className="drive-management-copy">当前邀请码尚未保存为可查看的形式。如果你保留了原码，可以补录；也可以轮换生成新码。</p>
              <Form className="entry-form" onSubmit={saveOriginal}>
                <JoinCodeField value={originalCode} onChange={setOriginalCode} />
                <Button type="submit" isDisabled={busy || originalCode.length !== JOIN_CODE_LENGTH}>保存原邀请码</Button>
              </Form>
            </>
          ) : !message ? <p role="status">正在读取邀请码…</p> : null}
          <p className="drive-management-copy">管理员可随时查看当前邀请码。轮换会立即停用旧邀请码。</p>
          <Button className="secondary-button" isDisabled={busy || !loaded} onPress={() => void rotate()}>
            {busy ? "正在保存…" : "轮换邀请码"}
          </Button>
          {message ? <p className="library-message" role="status">{message}</p> : null}
          {!loaded && message ? <Button onPress={() => setReload((value) => value + 1)}>重试</Button> : null}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

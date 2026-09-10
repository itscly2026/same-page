import { useRef, useState } from "react";
import { Button, Form, Heading, Input, Label, Modal, ModalOverlay, TextField } from "react-aria-components";
import { useNavigate } from "react-router-dom";
import { Dialog } from "../navigation/overlays";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { captureSettingsLifetime, useSettingsLifetime } from "../settings/use-settings-lifetime";
import { trialMessage } from "./trial-messages";

export function CreateDrive({ userId }: { userId: string }) {
  const gate = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useSettingsLifetime();
  const navigate = useNavigate();
  async function create() {
    if (gate.current || uncertain) return;
    gate.current = true;
    const active = captureSettingsLifetime(lifetime);
    setBusy(true); setError(null);
    try {
      const response = await diagnosticFetch("/api/choirs", { method: "POST",
        headers: { "content-type": "application/json", "x-same-page-owner-user-id": userId },
        body: JSON.stringify({ name, displayName }) });
      const payload = await response.json();
      if (!active()) return;
      if (!response.ok) { setError(trialMessage(payload.error)); return; }
      navigate(`/choirs/${payload.choirId}`);
    } catch { if (active()) { setUncertain(true); setError("未能确认创建结果，请先关闭并刷新云盘列表，再决定是否重试。"); } }
    finally { gate.current = false; if (active()) setBusy(false); }
  }
  return <><Button className="primary-button" onPress={() => setOpen(true)}>创建云盘</Button>
    {open && <ModalOverlay className="modal-overlay" isOpen isDismissable={!busy} isKeyboardDismissDisabled={busy} onOpenChange={setOpen}>
      <Modal className="app-modal"><Dialog className="app-dialog" exitDisabled={busy}>
        <Heading slot="title">创建免费体验云盘</Heading>
        <p>每人可拥有一个云盘，支持 10 份乐谱、50 MB 空间、20 位成员（含你自己）。</p>
        <Form className="entry-form" onSubmit={event => { event.preventDefault(); void create(); }}>
          <TextField isRequired maxLength={100} value={name} onChange={setName}><Label>云盘名称</Label><Input autoFocus /></TextField>
          <TextField isRequired maxLength={40} value={displayName} onChange={setDisplayName}><Label>你在云盘内的显示名</Label><Input /></TextField>
          <p>你将成为拥有者，通过邀请码邀请其他人加入。</p>
          {error && <p role="alert">{error}</p>}
          <Button className="primary-button" type="submit" isDisabled={busy || uncertain}>{busy ? "正在创建…" : "免费创建"}</Button>
          <Button className="secondary-button" isDisabled={busy} onPress={() => setOpen(false)}>取消</Button>
        </Form>
      </Dialog></Modal>
    </ModalOverlay>}
  </>;
}

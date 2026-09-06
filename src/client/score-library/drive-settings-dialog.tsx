import { useEffect, useState } from "react";
import { Button, Dialog, Form, Heading, Input, Label, Modal, ModalOverlay, TextField } from "react-aria-components";
import { driveNameSchema, displayNameSchema, driveSettingsSchema } from "../../shared/choirs";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";

type Settings = ReturnType<typeof driveSettingsSchema.parse>;
export function DriveSettingsDialog({ choirId, field, onClose, onSaved }: {
  choirId: string; field: "name" | "display-name"; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const title = field === "name" ? "云盘名称" : "我在此云盘的显示名";
  useEffect(() => {
    const controller = new AbortController();
    void diagnosticFetch(`/api/choirs/${choirId}/settings`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("settings_unavailable");
      const next = await parseDiagnosticResponse(response, driveSettingsSchema);
      if (!controller.signal.aborted) { setSettings(next); setValue(field === "name" ? next.name : next.displayName); setMessage(null); }
    }).catch(() => { if (!controller.signal.aborted) setMessage("无法读取当前设置，请联网后重试。"); });
    return () => controller.abort();
  }, [choirId, field, attempt]);
  const save = async () => {
    if (!settings || busy) return;
    const parsed = (field === "name" ? driveNameSchema : displayNameSchema).safeParse(value);
    if (!parsed.success) { setMessage(`请输入 1–${field === "name" ? 100 : 40} 个字符，不能只含空白。`); return; }
    setBusy(true); setMessage(null);
    try {
      const response = await diagnosticFetch(`/api/choirs/${choirId}/${field}`, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify(field === "name" ? { name: parsed.data, expectedRevision: settings.nameRevision } : { displayName: parsed.data, expectedRevision: settings.membershipRevision }) });
      if (!response.ok) {
        if (response.status === 409) {
          const refreshed = await diagnosticFetch(`/api/choirs/${choirId}/settings`);
          if (!refreshed.ok) throw new Error("settings_unavailable");
          const next = await parseDiagnosticResponse(refreshed, driveSettingsSchema);
          setSettings(next);
          setMessage(`设置已被更新，当前值为“${field === "name" ? next.name : next.displayName}”。你的输入已保留，请核对后再保存。`);
        } else setMessage(response.status === 403 ? "当前没有修改权限，请关闭并刷新云盘。" : "保存失败，输入已保留，请重试。");
        return;
      }
      await onSaved();
      onClose();
    } catch { setMessage("保存结果未确认，输入已保留。请重新读取当前设置后核对。"); }
    finally { setBusy(false); }
  };
  return <ModalOverlay className="modal-overlay" isOpen onOpenChange={open => { if (!open && !busy) onClose(); }} isDismissable={!busy}>
    <Modal className="app-modal"><Dialog className="app-dialog" aria-label={title}>
      <Heading slot="title">{title}</Heading>
      <Form className="entry-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <TextField value={value} onChange={setValue} isDisabled={!settings || busy} maxLength={field === "name" ? 100 : 40} isRequired><Label>{title}</Label><Input autoFocus /></TextField>
        {message && <p role="status">{message}</p>}
        {!settings && !message && <p role="status">正在读取当前设置…</p>}
        {message && <Button isDisabled={busy} onPress={() => setAttempt(value => value + 1)}>重新读取</Button>}
        <div className="dialog-actions"><Button className="secondary-button" isDisabled={busy} onPress={onClose}>取消</Button><Button className="primary-button" type="submit" isDisabled={!settings || busy || (field === "name" && !settings.canManage)}>{busy ? "正在保存…" : "保存"}</Button></div>
      </Form>
    </Dialog></Modal>
  </ModalOverlay>;
}

import { useEffect, useRef, useState } from "react";
import { Button, Form, Heading, Input, Label, Modal, ModalOverlay, TextField } from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { driveNameSchema, displayNameSchema, driveSettingsSchema } from "../../shared/choirs";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { useReadResource } from "../settings/use-read-resource";
import { SettingsRequestError, settingsError } from "../settings/settings-request";
import { captureReadIdentity } from "../settings/read-resource";

type Settings = ReturnType<typeof driveSettingsSchema.parse>;
export function DriveSettingsDialog({ choirId, userId, field, onClose, onSaved }: {
  choirId: string; userId: string; field: "name" | "display-name"; onClose: () => void; onSaved: (value: string) => Promise<void>;
}) {
  const load = async (signal?: AbortSignal) => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/settings`, { signal, headers: { "x-same-page-owner-user-id": userId } });
    if (!response.ok) throw new SettingsRequestError(response.status);
    return parseDiagnosticResponse(response, driveSettingsSchema);
  };
  const resource = useReadResource(`${userId}:${choirId}:settings`, load);
  const fieldValue = (settings: Settings) => field === "name" ? settings.name : settings.displayName;
  const [value, setValue] = useState(() => resource.data ? fieldValue(resource.data) : "");
  const dirty = useRef(false);
  const base = useRef<Settings | null>(resource.data);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!dirty.current && resource.data) { base.current = resource.data; setValue(field === "name" ? resource.data.name : resource.data.displayName); }
  }, [resource.data, field]);
  const title = field === "name" ? "云盘名称" : "我在此云盘的显示名";
  const finish = async () => {
    await onSaved(value.trim());
    if (active.current) onClose();
  };
  const save = async () => {
    const settings = base.current;
    if (!settings || busy || !resource.canMutate || saved) return;
    const parsed = (field === "name" ? driveNameSchema : displayNameSchema).safeParse(value);
    if (!parsed.success) { setMessage(`请输入 1–${field === "name" ? 100 : 40} 个字符，不能只含空白。`); return; }
    const sameIdentity = captureReadIdentity();
    const current = () => active.current && sameIdentity();
    setBusy(true); setMessage(null);
    let confirmed = false;
    try {
      const response = await diagnosticFetch(`/api/choirs/${choirId}/${field}`, { method: "PATCH", headers: { "content-type": "application/json", "x-same-page-owner-user-id": userId },
        body: JSON.stringify(field === "name" ? { name: parsed.data, expectedRevision: settings.nameRevision } : { displayName: parsed.data, expectedRevision: settings.membershipRevision }) });
      if (!current()) return;
      if (response.status === 409) {
        const next = await load(); if (!current()) return;
        resource.confirm(next); base.current = next;
        setMessage(`设置已被更新，当前值为“${fieldValue(next)}”。你的输入已保留，请核对后再保存。`);
        return;
      }
      if (!response.ok) throw new SettingsRequestError(response.status);
      confirmed = true; setSaved(true);
      const result = await response.json(); if (!current()) return;
      const next = field === "name" ? { ...settings, name: parsed.data, nameRevision: result.revision }
        : { ...settings, displayName: parsed.data, membershipRevision: result.revision };
      resource.confirm(driveSettingsSchema.parse(next));
      await finish();
    } catch (error) {
      if (current()) {
        setMessage(confirmed ? "修改已保存，内容刷新失败。请重试刷新。" : settingsError(error, "保存结果未确认，输入已保留。请重新读取当前设置后核对。"));
        if (error instanceof SettingsRequestError && [401, 403].includes(error.status)) void resource.refresh().catch(() => undefined);
      }
    } finally { if (current()) setBusy(false); }
  };
  return <ModalOverlay className="modal-overlay" isOpen onOpenChange={open => { if (!open && !busy) onClose(); }} isDismissable={!busy}>
    <Modal className="app-modal"><Dialog className="app-dialog" aria-label={title}>
      <Heading slot="title">{title}</Heading>
      <Form className="entry-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <TextField value={value} onChange={next => { dirty.current = true; setValue(next); }} isDisabled={!resource.data || busy || saved} maxLength={field === "name" ? 100 : 40} isRequired><Label>{title}</Label><Input autoFocus /></TextField>
        {(message || Boolean(resource.error)) && <p role="status">{message ?? settingsError(resource.error, "暂时无法更新，已有内容已保留，请重试。")}</p>}
        {resource.loading && <p role="status">正在读取当前设置…</p>}
        {(message || Boolean(resource.error)) && <Button isDisabled={busy} onPress={() => {
          if (saved) void finish().catch(() => setMessage("修改已保存，内容刷新失败。请重试刷新。"));
          else void resource.refresh().catch(() => undefined);
        }}>{saved ? "重试刷新" : "重新读取"}</Button>}
        <div className="dialog-actions"><Button className="secondary-button" isDisabled={busy} onPress={onClose}>取消</Button><Button className="primary-button" type="submit" isDisabled={!resource.canMutate || busy || saved || (field === "name" && !resource.data?.canEditDriveInfo)}>{busy ? "正在保存…" : "保存"}</Button></div>
      </Form>
    </Dialog></Modal>
  </ModalOverlay>;
}

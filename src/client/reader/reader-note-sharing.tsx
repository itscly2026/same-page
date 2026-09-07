import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import type { LocalWorkspace } from "../platform/local-workspace";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { updateCachedLayer } from "../annotations/annotation-state";
import { syncAnnotations } from "../annotations/sync";

export function ReaderNoteSharing({ workspace, layer }: { workspace: LocalWorkspace; layer?: AnnotationLayerSummary }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef(true);
  const busy = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const save = async (sharing: boolean) => {
    if (!layer?.canShare || busy.current) return;
    busy.current = true; setPending(true); setMessage("");
    try {
      const response = await diagnosticFetch(`/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/personal-layer/sharing`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sharing }),
      });
      if (!response.ok) throw new Error("sharing_failed");
      await updateCachedLayer(workspace, layer.id, { sharing });
      if (active.current) setMessage(sharing ? "已分享我的笔记" : "已停止分享");
      await syncAnnotations(workspace, { pull: true });
    } catch { if (active.current) setMessage("未能完成保存或刷新，请检查网络后重试。"); }
    finally { busy.current = false; if (active.current) setPending(false); }
  };
  return <section className="reader-layer-panel reader-sharing-control" aria-label="分享我的笔记">
    <p>仅分享这份乐谱的笔记，只有你能编辑。</p>
    <p>云盘成员可以查看现有笔记及后续已同步修改。其他乐谱的分享设置不变。</p>
    {layer?.canShare ? <>
      <p><strong>{layer.sharing ? "云盘成员可见" : "仅自己可见"}</strong></p>
      <Button className="secondary-button" isDisabled={pending} onPress={() => void save(!layer.sharing)}>{pending ? "正在保存…" : layer.sharing ? "停止分享" : "向云盘成员分享"}</Button>
      {layer.sharing && <p>停止分享后，已下载的笔记会在对方设备重新联网并同步后移除。</p>}
    </> : <p>当前无法分享笔记，请联网确认成员关系后重试。</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

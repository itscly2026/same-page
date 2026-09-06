import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { LocalWorkspace } from "../platform/local-workspace";
import { AnnotationEditor, type PersistenceState } from "./annotation-editor";

const idle = (): PersistenceState => "idle";
const noSubscription = () => () => {};

export function useEditorPersistence(editor: AnnotationEditor | null) {
  return useSyncExternalStore(editor?.subscribe ?? noSubscription, editor?.getSnapshot ?? idle);
}

export function useAnnotationEditor(workspace: LocalWorkspace | null) {
  const { scopeKey, ownerKey, choirId, scoreId, sessionEpoch, syncLockToken } = workspace ?? {};
  const editor = useMemo(() => scopeKey !== undefined && ownerKey !== undefined && choirId !== undefined && scoreId !== undefined
    ? new AnnotationEditor({ scopeKey, ownerKey, choirId, scoreId, sessionEpoch, syncLockToken }) : null,
  [scopeKey, ownerKey, choirId, scoreId, sessionEpoch, syncLockToken]);
  const persistence = useEditorPersistence(editor);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!editor || editor.getSnapshot() === "idle") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => {
      window.removeEventListener("beforeunload", preventLoss);
      editor?.cancel();
    };
  }, [editor]);
  return { editor, persistence };
}

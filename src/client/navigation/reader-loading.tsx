import { ArrowLeft } from "lucide-react";
import { useAppNavigation } from "./navigation-context";
export function ReaderLoading({ choirId, fileName }: { choirId: string; fileName?: string }) {
  const navigation = useAppNavigation();
  return <main className="reader-loading" aria-label="正在加载乐谱">
    <button className="reader-loading__back icon-button" onClick={() => navigation.back(`/choirs/${choirId}`)} aria-label="返回云盘"><ArrowLeft size={22} aria-hidden="true" /></button>
    <div className="reader-loading__paper" aria-hidden="true" />
    <div className="reader-loading__label" role="status">{fileName && <strong>{fileName}</strong>}<span>正在打开乐谱…</span></div>
  </main>;
}

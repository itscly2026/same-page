import { useSyncExternalStore } from "react";
let status = "后台准备更新，完成当前操作后自动应用";
const listeners = new Set<() => void>();
export function setUpdateStatus(value: string) { status = value; listeners.forEach(listener => listener()); }
export function useUpdateStatus() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => status);
}

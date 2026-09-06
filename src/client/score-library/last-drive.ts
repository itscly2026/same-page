const prefix = "same-page:last-drive:";

export function readLastDrive(userId: string) {
  try { return window.localStorage.getItem(prefix + userId); } catch { return null; }
}
export function rememberLastDrive(userId: string, choirId: string) {
  try { window.localStorage.setItem(prefix + userId, choirId); } catch { /* Optional navigation state. */ }
}
export function forgetLastDrive(userId: string, choirId: string) {
  if (readLastDrive(userId) !== choirId) return;
  try { window.localStorage.removeItem(prefix + userId); } catch { /* Optional navigation state. */ }
}

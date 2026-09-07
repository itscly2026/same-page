// A route is only a candidate. Editors, operations and interaction veto reloads.
const tasks = new Set<symbol>();
let lastInteraction = Date.now();
let pathname = "/";

export function holdUpdate() {
  const key = Symbol();
  tasks.add(key);
  return () => { tasks.delete(key); };
}
export function noteUpdateInteraction() { lastInteraction = Date.now(); }
export function setUpdateRoute(path: string) { pathname = path; noteUpdateInteraction(); }
export function canApplyUpdate() {
  const candidate = pathname === "/" || pathname === "/drives" || pathname === "/about" || /^\/choirs\/[^/]+$/.test(pathname);
  return candidate && tasks.size === 0 && navigator.onLine && Date.now() - lastInteraction >= 3000 &&
    !document.querySelector('[role="dialog"], [role="menu"], [data-update-busy]') &&
    !(document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable="true"]'));
}

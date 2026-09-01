const identityChangeListeners = new Set<() => void>();

export function onReaderIdentityChange(listener: () => void) {
  identityChangeListeners.add(listener);
}

export function notifyReaderIdentityChange() {
  for (const listener of identityChangeListeners) listener();
}

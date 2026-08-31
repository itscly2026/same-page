import { useEffect, useState } from "react";
import { vi } from "vitest";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

export let shouldNeedRefresh = false;
export const updateServiceWorkerMock = vi.fn(async () => undefined);
export const registrationUpdateMock = vi.fn(async () => undefined);
const registration = {
  installing: null,
  update: registrationUpdateMock,
} as unknown as ServiceWorkerRegistration;

export function setShouldNeedRefresh(value: boolean) {
  shouldNeedRefresh = value;
}

export function useRegisterSW(options?: RegisterSWOptions) {
  const onRegisteredSW = options?.onRegisteredSW;
  useEffect(() => {
    onRegisteredSW?.("/sw.js", registration);
  }, [onRegisteredSW]);
  return {
    needRefresh: useState(shouldNeedRefresh),
    offlineReady: useState(false),
    updateServiceWorker: updateServiceWorkerMock,
  };
}

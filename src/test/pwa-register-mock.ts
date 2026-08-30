import { useState } from "react";
import { vi } from "vitest";

export let shouldNeedRefresh = false;
export const updateServiceWorkerMock = vi.fn(async () => undefined);

export function setShouldNeedRefresh(value: boolean) {
  shouldNeedRefresh = value;
}

export function useRegisterSW() {
  return {
    needRefresh: useState(shouldNeedRefresh),
    offlineReady: useState(false),
    updateServiceWorker: updateServiceWorkerMock,
  };
}

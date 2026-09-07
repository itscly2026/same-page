import { useEffect, useRef } from "react";

// Each page is keyed by user and drive. Also reject mutations completing after
// unmount (including StrictMode's effect cleanup) instead of publishing feedback.
export function useSettingsLifetime() {
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  return generation;
}

export function captureSettingsLifetime(lifetime: { current: number }) {
  const generation = lifetime.current;
  return () => generation === lifetime.current;
}

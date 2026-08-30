import { useCallback, useEffect, useState } from "react";

export type ReaderLayout = "page" | "continuous";

type ReaderPreferences = {
  layout: ReaderLayout;
  page: number;
};

const defaultPreferences: ReaderPreferences = {
  layout: "page",
  page: 1,
};

export function useReaderPreferences({
  identity,
  choirId,
  scoreId,
}: {
  identity: string;
  choirId: string;
  scoreId: string;
}) {
  const key = `reader-preferences:${identity}:${choirId}:${scoreId}`;
  const [state, setState] = useState<{ key: string; value: ReaderPreferences }>(
    () => ({ key, value: readPreferences(key) }),
  );
  const preferences = state.key === key ? state.value : readPreferences(key);

  const update = useCallback(
    (change: (current: ReaderPreferences) => ReaderPreferences) => {
      setState((current) => ({
        key,
        value: change(current.key === key ? current.value : readPreferences(key)),
      }));
    },
    [key],
  );
  const setLayout = useCallback(
    (layout: ReaderLayout) => update((current) => ({ ...current, layout })),
    [update],
  );
  const setPage = useCallback(
    (value: number | ((page: number) => number)) =>
      update((current) => ({
        ...current,
        page: typeof value === "function" ? value(current.page) : value,
      })),
    [update],
  );

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(preferences));
    } catch {
      // Reader remains usable when browser storage is unavailable.
    }
  }, [key, preferences]);

  return {
    layout: preferences.layout,
    currentPage: preferences.page,
    setLayout,
    setCurrentPage: setPage,
  };
}

function readPreferences(key: string): ReaderPreferences {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!stored || typeof stored !== "object") return defaultPreferences;
    const candidate = stored as Partial<ReaderPreferences>;
    return {
      layout: candidate.layout === "continuous" ? "continuous" : "page",
      page:
        Number.isInteger(candidate.page) && Number(candidate.page) > 0
          ? Number(candidate.page)
          : 1,
    };
  } catch {
    return defaultPreferences;
  }
}

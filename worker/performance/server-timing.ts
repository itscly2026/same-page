import type { Context, MiddlewareHandler } from "hono";

import type { AppEnvironment } from "../env";

export type ServerTimingPhase = "auth" | "access" | "d1" | "r2";

interface RequestServerTimingOptions {
  now?: () => number;
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface RequestServerTiming {
  measure<T>(phase: ServerTimingPhase, operation: () => Promise<T>): Promise<T>;
  header(): string;
}

export function createRequestServerTiming(
  options: RequestServerTimingOptions = {},
): RequestServerTiming {
  const currentTime = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const requestStartedAt = currentTime();
  const durations = new Map<ServerTimingPhase, number>();

  return {
    async measure<T>(phase: ServerTimingPhase, operation: () => Promise<T>) {
      const startedAt = currentTime();
      try {
        if (delayMs > 0) await sleep(delayMs);
        return await operation();
      } finally {
        durations.set(
          phase,
          (durations.get(phase) ?? 0) + Math.max(0, currentTime() - startedAt),
        );
      }
    },
    header() {
      const values = (["auth", "access", "d1", "r2"] as const)
        .flatMap((phase) => {
          const duration = durations.get(phase);
          return duration === undefined ? [] : [`${phase};dur=${duration.toFixed(1)}`];
        });
      values.push(`total;dur=${Math.max(0, currentTime() - requestStartedAt).toFixed(1)}`);
      return values.join(", ");
    },
  };
}

export const serverTimingMiddleware: MiddlewareHandler<AppEnvironment> =
  async (context, next) => {
    const requestedDelay = Number(context.env.PERFORMANCE_TEST_DELAY_MS ?? 0);
    const timing = createRequestServerTiming({
      delayMs: Number.isFinite(requestedDelay) ? requestedDelay : 0,
    });
    context.set("serverTiming", timing);
    try {
      await next();
    } finally {
      context.res.headers.set("Server-Timing", timing.header());
    }
  };

export function measureServerTiming<T>(
  context: Context<AppEnvironment>,
  phase: ServerTimingPhase,
  operation: () => Promise<T>,
) {
  const timing = context.get("serverTiming");
  return timing ? timing.measure(phase, operation) : operation();
}

/**
 * Session control-plane tracing.
 *
 * Controlled by `DEERHUX_SESSION_TRACE=1`. When disabled (the default) every
 * function here is effectively a no-op that still executes its callback — so
 * callers can wrap hot paths unconditionally without paying a perf cost when
 * tracing is off.
 *
 * Output format (when enabled):
 *   [session-trace] label key=value key2=value2 ...
 *
 * @see docs/session-performance-remediation-plan.md §7
 */

export function isSessionTraceEnabled(): boolean {
  return process.env.DEERHUX_SESSION_TRACE === "1";
}

function formatField(key: string, value: unknown): string {
  if (value === undefined) return key;
  if (value === null) return `${key}=null`;
  if (typeof value === "string") return `${key}=${value}`;
  if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`;
  // objects/arrays → compact JSON; keep it readable in a single log line
  try {
    return `${key}=${JSON.stringify(value)}`;
  } catch {
    return `${key}=[unserializable]`;
  }
}

/**
 * Emit a structured trace line. No-op when tracing is disabled.
 */
export function traceSession(label: string, fields: Record<string, unknown> = {}): void {
  if (!isSessionTraceEnabled()) return;
  const parts = Object.keys(fields).map((k) => formatField(k, fields[k]));
  const tail = parts.length ? ` ${parts.join(" ")}` : "";
  console.log(`[session-trace] ${label}${tail}`);
}

/**
 * Time an async step. The callback always runs (even when tracing is off);
 * only the log emission is gated.
 */
export async function timeSessionStep<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    const ms = Date.now() - start;
    if (isSessionTraceEnabled()) {
      console.log(`[session-trace] ${label} total=${ms}ms ok=false err=${String(err)}`);
    }
    throw err;
  }
  const ms = Date.now() - start;
  if (isSessionTraceEnabled()) {
    console.log(`[session-trace] ${label} total=${ms}ms ok=true`);
  }
  return { value, ms };
}

/**
 * Sync variant of {@link timeSessionStep}.
 */
export function timeSessionStepSync<T>(label: string, fn: () => T): { value: T; ms: number } {
  const start = Date.now();
  const value = fn();
  const ms = Date.now() - start;
  if (isSessionTraceEnabled()) {
    console.log(`[session-trace] ${label} total=${ms}ms`);
  }
  return { value, ms };
}

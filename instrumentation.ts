// ============================================================================
// Next.js Instrumentation — runs once at server startup
// Registers the scheduler engine for cron-based task execution
// ============================================================================

export async function register() {
  // Only start scheduler on the Node.js server side (not Edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/scheduler/engine");
    startScheduler();
  }
}

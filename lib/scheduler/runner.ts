// ============================================================================
// Task runner — executes scheduled tasks (prompt or shell)
// ============================================================================

import { exec } from "child_process";
import { promisify } from "util";
import type { ScheduledTask, PromptTaskConfig, ShellTaskConfig } from "./types";
import { updateTask } from "./store";

const execAsync = promisify(exec);

function recordResult(taskId: string, result: "success" | "error", error?: string): void {
  updateTask(taskId, {
    lastRunAt: new Date().toISOString(),
    lastResult: result,
    lastError: error,
  });
}

async function runShellTask(task: ScheduledTask, config: ShellTaskConfig): Promise<void> {
  try {
    const { stdout, stderr } = await execAsync(config.command, {
      cwd: config.cwd || process.cwd(),
      timeout: 300_000, // 5 minutes
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    const output = (stdout + stderr).trim();
    recordResult(task.id, "success");
    console.log(`[scheduler] Shell task "${task.name}" completed. Output: ${output.slice(0, 200)}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    recordResult(task.id, "error", message);
    console.error(`[scheduler] Shell task "${task.name}" failed: ${message}`);
  }
}

async function runPromptTask(task: ScheduledTask, config: PromptTaskConfig): Promise<void> {
  try {
    const { createAgentSession, SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");

    const agentDir = getAgentDir();
    const sessionManager = SessionManager.create(config.cwd, undefined);

    let toolNames: string[] | undefined;
    if (config.toolNames) {
      toolNames = config.toolNames;
    } else {
      // Default: enable all coding tools
      toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
    }

    const { session } = await createAgentSession({
      cwd: config.cwd,
      agentDir,
      sessionManager,
      tools: toolNames,
    });

    if (config.model) {
      try {
        const model = session.modelRegistry.find(config.model.provider, config.model.modelId);
        if (model) {
          await session.setModel(model);
        }
      } catch {
        // Use default model if specified model not found
      }
    }

    // Wait for the prompt to complete
    const maxWaitMs = 30 * 60 * 1000; // 30 minutes max

    let agentError: string | undefined;

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const startTime = Date.now();

      const unsubscribe = session.subscribe((event) => {
        if (finished) return;

        // agent_end signals the full run is complete
        if (event.type === "agent_end") {
          finished = true;
          unsubscribe();
          // Check for error messages in the agent's output
          const messages = (event as { messages?: Array<{ errorMessage?: string }> }).messages;
          if (messages) {
            for (const msg of messages) {
              if (msg.errorMessage) {
                agentError = msg.errorMessage;
                break;
              }
            }
          }
          resolve();
          return;
        }

        // Timeout check
        if (Date.now() - startTime > maxWaitMs) {
          finished = true;
          unsubscribe();
          reject(new Error("Prompt execution timed out (30 minutes)"));
        }
      });

      // Send the prompt
      session.prompt(config.message).catch((err: unknown) => {
        if (!finished) {
          finished = true;
          unsubscribe();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    if (agentError) {
      throw new Error(agentError);
    }

    recordResult(task.id, "success");
    console.log(`[scheduler] Prompt task "${task.name}" completed successfully`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    recordResult(task.id, "error", message);
    console.error(`[scheduler] Prompt task "${task.name}" failed: ${message}`);
  }
}

export async function executeTask(task: ScheduledTask): Promise<void> {
  console.log(`[scheduler] Executing task: "${task.name}" (${task.id})`);

  // Increment run count
  updateTask(task.id, {
    runCount: (task.runCount || 0) + 1,
  });

  if (task.type === "shell") {
    await runShellTask(task, task.config as ShellTaskConfig);
  } else if (task.type === "prompt") {
    await runPromptTask(task, task.config as PromptTaskConfig);
  }
}

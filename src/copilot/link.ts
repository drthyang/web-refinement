/**
 * The shell-owned link between the active engine and the Copilot: the engine
 * publishes its port here on every render (port.ts), and the executor waits on
 * it for an action's effects to render before it reads the result.
 *
 * React applies state asynchronously — a Copilot action calls a page handler,
 * the page re-renders, and the shell records the history step a tick later
 * (App's `requestStep`). `settle` waits through exactly that: the render that
 * applies the change, the shell's deferred step, and the render after it.
 */

import type { CopilotPort } from "@/copilot/port";

export class CopilotLink {
  private current: CopilotPort | null = null;
  private waiters: (() => void)[] = [];

  /** The engine's port for this render (null clears it: unmounted, inactive). */
  publish(port: CopilotPort | null): void {
    this.current = port;
    if (port) this.wake();
  }

  /** A shell commit: wake anyone waiting for a render. */
  notify(): void {
    this.wake();
  }

  port(): CopilotPort | null {
    return this.current;
  }

  /** The next render (the engine's publish or a shell commit), or `timeoutMs` if nothing renders. */
  nextRender(timeoutMs = 150): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.waiters.push(done);
    });
  }

  /**
   * Resolve once an action's state has rendered and the step it requested is
   * recorded: the render that applies it, a macrotask for the shell's deferred
   * step (queued during that render's effects), then the render it causes.
   */
  async settle(): Promise<void> {
    await this.nextRender();
    await new Promise((r) => setTimeout(r, 0));
    await this.nextRender();
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }
}

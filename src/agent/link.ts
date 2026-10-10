/**
 * The shell-owned link between the active engine and the Agent: the engine
 * publishes its port here on every render (port.ts), and the executor waits on
 * it for an action's effects to render before it reads the result.
 *
 * React applies state asynchronously — a Agent action calls a page handler,
 * the page re-renders, and the shell records the history step a tick later
 * (App's `requestStep`). `settle` waits through exactly that: the render that
 * applies the change, the shell's deferred step, and the render after it.
 */

import type { AgentPort } from "@/agent/port";

export class AgentLink {
  private current: AgentPort | null = null;
  private waiters: (() => void)[] = [];

  /** The engine's port for this render (null clears it: unmounted, inactive). */
  publish(port: AgentPort | null): void {
    this.current = port;
    if (port) this.wake();
  }

  /** A shell commit: wake anyone waiting for a render. */
  notify(): void {
    this.wake();
  }

  /**
   * An engine leaves: clear the port only if it is still that engine's. The
   * powder page stays mounted (inactive) under the PDF page, and must not clear
   * the PDF page's port when it re-renders.
   */
  release(technique: AgentPort["technique"]): void {
    if (this.current?.technique === technique) this.current = null;
  }

  port(): AgentPort | null {
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

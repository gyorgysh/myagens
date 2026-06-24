import type { WebSocket } from "ws";
import { getHealth } from "../core/health.js";

const HEALTH_PUSH_MS = 2000;

/**
 * Fan-out hub for all panel WebSocket clients. Pushes a health frame on an
 * interval (only while at least one client is connected) and lets other
 * subsystems (the worker manager) broadcast events to every client.
 */
export class PanelHub {
  private clients = new Set<WebSocket>();
  private timer?: ReturnType<typeof setInterval>;

  add(socket: WebSocket): void {
    this.clients.add(socket);
    // Send an immediate health frame so a fresh client isn't blank for 2s.
    void this.sendHealth(socket);
    if (!this.timer) this.startHealth();
    const drop = () => this.remove(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  }

  remove(socket: WebSocket): void {
    this.clients.delete(socket);
    if (this.clients.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Send a JSON message to every connected client. */
  broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const c of this.clients) {
      try {
        c.send(data);
      } catch {
        /* client went away mid-send */
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const c of this.clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  private startHealth(): void {
    this.timer = setInterval(() => {
      void getHealth().then((data) => this.broadcast({ type: "health", data }));
    }, HEALTH_PUSH_MS);
    this.timer.unref?.();
  }

  private async sendHealth(socket: WebSocket): Promise<void> {
    try {
      socket.send(JSON.stringify({ type: "health", data: await getHealth() }));
    } catch {
      /* ignore */
    }
  }
}

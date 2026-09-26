/**
 * The three ways an outbound message can leave the system.
 *
 * All implement the same `Transport` interface, so the domain has no idea which
 * one it is talking to — that substitutability is the entire point of the
 * adapter boundary.
 */

import type { OutboundMessage, Transport } from "../../domain/types";
import { renderOutbound } from "./outbound";

/** Production: POST to Meta's Cloud API. */
export class CloudApiTransport implements Transport {
  constructor(
    private readonly phoneNumberId: string,
    private readonly token: string,
    private readonly apiVersion = "v21.0",
  ) {}

  async send(message: OutboundMessage): Promise<void> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const body = renderOutbound(message);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text();
      // A 401 here on a previously-working deploy almost always means the Meta
      // dashboard's temporary token expired. See SETUP.md step 5.
      throw new Error(`Cloud API ${res.status}: ${detail}`);
    }
  }
}

/**
 * DEV_MODE: record into `dev_outbox` for the fake-WhatsApp harness to poll.
 *
 * Renders through `renderOutbound` first and discards the result, purely so the
 * harness exercises the same limit checks production would hit.
 */
export class DevOutboxTransport implements Transport {
  constructor(
    private readonly db: D1Database,
    private readonly now: number,
  ) {}

  async send(message: OutboundMessage): Promise<void> {
    renderOutbound(message);
    await this.db
      .prepare("INSERT INTO dev_outbox (phone, spec_json, at) VALUES (?, ?, ?)")
      .bind(message.to, JSON.stringify(message.spec), this.now)
      .run();
  }
}

/** Tests: collect in memory and assert against it. */
export class MemoryTransport implements Transport {
  readonly sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<void> {
    renderOutbound(message);
    this.sent.push(message);
  }

  to(phone: string): OutboundMessage[] {
    return this.sent.filter((m) => m.to === phone);
  }

  last(phone?: string): OutboundMessage | undefined {
    const pool = phone ? this.to(phone) : this.sent;
    return pool[pool.length - 1];
  }

  clear(): void {
    this.sent.length = 0;
  }
}

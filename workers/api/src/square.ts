import { DurableObject } from "cloudflare:workers";

// Babili square: one permanent public chat room on the homepage.
//
// Model (deliberately unlike the private E2E rooms):
// - Anyone may read: history over HTTP, live updates over WebSocket.
// - Posting requires membership. Membership is granted by a typed
//   invite code (single-use, 5-minute validity) issued by an existing
//   member. While the room has no members, the first join needs no
//   code (bootstrap).
// - A member's display name is chosen once at join and can never be
//   changed: the token -> name binding is the identity, and there is
//   no rename operation.
// - Messages are plaintext on the server (it is a public square) and
//   each message disappears 10 minutes after it was posted.
// - The room itself never self-destructs: no expiry, no destroy API.

const MESSAGE_TTL_MS = 10 * 60 * 1000;
const INVITE_TTL_MS = 5 * 60 * 1000;
const MAX_MESSAGES_KEPT = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_NAME_LENGTH = 24;
const MIN_POST_INTERVAL_MS = 800;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_LIMIT = 30;
const LOCK_MS = 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

const MEMBERS_KEY = "square:members";
const MESSAGES_KEY = "square:messages";
const INVITES_KEY = "square:invites";
const FAIL_KEY = "square:join-failures";

export type SquareMessage = {
  id: string;
  name: string;
  text: string;
  ts: number;
  expiresAt: number;
};

type Member = { name: string; joinedAt: number };
type Invite = { expiresAt: number; createdBy: string };
type Failures = { count: number; windowStart: number; lockedUntil: number };

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function randomCode(existing: Map<string, Invite>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    let code = "";
    for (const byte of bytes) {
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
    if (!existing.has(code)) return code;
  }
  return randomToken().slice(0, CODE_LENGTH).toUpperCase();
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export class SquareDurableObject extends DurableObject<Record<string, unknown>> {
  private members = new Map<string, Member>();
  private messages: SquareMessage[] = [];
  private invites = new Map<string, Invite>();
  private failures: Failures = { count: 0, windowStart: 0, lockedUntil: 0 };
  private lastPostAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.members = new Map(
        (await this.ctx.storage.get<[string, Member][]>(MEMBERS_KEY)) ?? []
      );
      this.messages =
        (await this.ctx.storage.get<SquareMessage[]>(MESSAGES_KEY)) ?? [];
      this.invites = new Map(
        (await this.ctx.storage.get<[string, Invite][]>(INVITES_KEY)) ?? []
      );
      this.failures =
        (await this.ctx.storage.get<Failures>(FAIL_KEY)) ?? {
          count: 0,
          windowStart: 0,
          lockedUntil: 0
        };
    });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(MEMBERS_KEY, [...this.members.entries()]);
    await this.ctx.storage.put(MESSAGES_KEY, this.messages);
    await this.ctx.storage.put(INVITES_KEY, [...this.invites.entries()]);
    await this.ctx.storage.put(FAIL_KEY, this.failures);
  }

  private prune(now: number): void {
    this.messages = this.messages
      .filter((message) => message.expiresAt > now)
      .slice(-MAX_MESSAGES_KEPT);
    for (const [code, invite] of this.invites) {
      if (invite.expiresAt <= now) this.invites.delete(code);
    }
  }

  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(data);
      } catch {
        // A closing socket must not break the broadcast for others.
      }
    }
  }

  private memberFor(request: Request, body?: { token?: string }): Member | null {
    const token =
      body?.token ??
      request.headers.get("x-member-token") ??
      new URL(request.url).searchParams.get("token") ??
      "";
    return token ? (this.members.get(token) ?? null) : null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    if (request.method === "GET" && url.pathname === "/api/square/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_required" }, 426);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.prune(now);
      server.send(
        JSON.stringify({ type: "sync", messages: this.messages })
      );
      return new Response(null, {
        status: 101,
        webSocket: client
      } as ResponseInit & { webSocket: WebSocket });
    }

    if (request.method === "GET" && url.pathname === "/api/square/state") {
      return json({
        memberCount: this.members.size,
        requiresCode: this.members.size > 0
      });
    }

    if (request.method === "GET" && url.pathname === "/api/square/messages") {
      this.prune(now);
      return json({ messages: this.messages });
    }

    if (request.method === "GET" && url.pathname === "/api/square/me") {
      const member = this.memberFor(request);
      if (!member) return json({ error: "not_a_member" }, 401);
      return json({ name: member.name });
    }

    if (request.method === "POST" && url.pathname === "/api/square/join") {
      const body = (await request.json().catch(() => null)) as {
        code?: string;
        name?: string;
      } | null;
      const name = (body?.name ?? "").trim();
      if (
        !name ||
        name.length > MAX_NAME_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(name)
      ) {
        return json({ error: "invalid_name" }, 400);
      }
      if (this.failures.lockedUntil > now) {
        return json({ error: "rate_limited" }, 429);
      }
      this.prune(now);
      if (this.members.size > 0) {
        const code = (body?.code ?? "").trim().toUpperCase();
        const invite = code ? this.invites.get(code) : undefined;
        if (!invite || invite.expiresAt <= now) {
          if (now - this.failures.windowStart > FAIL_WINDOW_MS) {
            this.failures = { count: 0, windowStart: now, lockedUntil: 0 };
          }
          this.failures.count += 1;
          if (this.failures.count >= FAIL_LIMIT) {
            this.failures.lockedUntil = now + LOCK_MS;
          }
          await this.persist();
          return json({ error: "invalid_code" }, 403);
        }
        this.invites.delete(code);
      }
      const nameTaken = [...this.members.values()].some(
        (member) => member.name.toLowerCase() === name.toLowerCase()
      );
      if (nameTaken) {
        await this.persist();
        return json({ error: "name_taken" }, 409);
      }
      const token = randomToken();
      this.members.set(token, { name, joinedAt: now });
      await this.persist();
      return json({ token, name });
    }

    if (request.method === "POST" && url.pathname === "/api/square/invites") {
      const body = (await request.json().catch(() => null)) as {
        token?: string;
      } | null;
      const member = this.memberFor(request, body ?? undefined);
      if (!member) return json({ error: "not_a_member" }, 401);
      this.prune(now);
      const code = randomCode(this.invites);
      const expiresAt = now + INVITE_TTL_MS;
      this.invites.set(code, { expiresAt, createdBy: member.name });
      await this.persist();
      return json({ code, expiresAt });
    }

    if (request.method === "POST" && url.pathname === "/api/square/messages") {
      const body = (await request.json().catch(() => null)) as {
        token?: string;
        text?: string;
      } | null;
      const member = this.memberFor(request, body ?? undefined);
      if (!member) return json({ error: "not_a_member" }, 401);
      const text = (body?.text ?? "").trim();
      if (!text || text.length > MAX_TEXT_LENGTH) {
        return json({ error: "invalid_text" }, 400);
      }
      const token =
        body?.token ?? request.headers.get("x-member-token") ?? "";
      const last = this.lastPostAt.get(token) ?? 0;
      if (now - last < MIN_POST_INTERVAL_MS) {
        return json({ error: "rate_limited" }, 429);
      }
      this.lastPostAt.set(token, now);
      this.prune(now);
      const message: SquareMessage = {
        id: randomToken().slice(0, 16),
        name: member.name,
        text,
        ts: now,
        expiresAt: now + MESSAGE_TTL_MS
      };
      this.messages.push(message);
      await this.persist();
      this.broadcast({ type: "message", message });
      return json({ message });
    }

    return json({ error: "not_found" }, 404);
  }

  async webSocketMessage(): Promise<void> {
    // Reading is one-way: clients never post over the socket, so there
    // is nothing to accept here. Posting goes through HTTP so the
    // member token is checked on every message.
  }

  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}
}

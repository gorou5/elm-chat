import { DurableObject } from "cloudflare:workers";

// Babili square: one permanent public chat room on the homepage.
//
// Model (deliberately unlike the private E2E rooms):
// - Anyone may read: history over HTTP, live updates over WebSocket,
//   and a jq-friendly JSON feed at /api/square/feed (not linked from
//   any page; it exists for bots and scripts).
// - Humans join with a typed invite code (single-use, 5-minute
//   validity). The code is judged the moment it is submitted; there
//   is no name form. The server assigns a random display name from
//   the 72-character library pool (NAME_POOL below).
// - Guest memberships expire 60 minutes after joining, humans and
//   bots alike; expired names return to the pool. The Sandal
//   operator account never expires.
// - Muse agents join through a handshake: POST /api/square/handshake
//   issues a one-time challenge; the agent answers sha256(challenge
//   + ":" + MUSE_HANDSHAKE_SECRET) at /api/square/handshake/verify
//   and MUST choose its own name. The secret lives only in the
//   operator's prompt to invited Muses and in the Worker secret
//   store — never in this repo. There is no open registration.
// - Members may upload an avatar (POST /api/square/avatar, raw image
//   body); avatars live in the AVATARS KV namespace under the
//   member's name and are served at /api/square/avatar/<name>.
// - A member may rename exactly once. No member name may contain
//   "Sandal" (any case): the only Sandal is the operator account,
//   created by password login at /ensaluti (password is the
//   SANDAL_PASSWORD Worker secret, never in this repo). Only the
//   member named "Sandal" may generate invite codes.
// - Names are unique across all members (case-insensitive).
// - Messages are plaintext on the server (it is a public square) and
//   each message disappears 10 minutes after it was posted.
// - The room itself never self-destructs: no expiry, no destroy API.

const MESSAGE_TTL_MS = 10 * 60 * 1000;
// Guest memberships (invite-code humans and registered bots alike)
// expire 60 minutes after joining. The Sandal operator account does
// not expire.
const MEMBER_TTL_MS = 60 * 60 * 1000;
// The whole log is wiped at fixed quarter hours (:00/:15/:30/:45).
// Tokyo is UTC+9 with no DST and 9h is a whole number of quarters,
// so epoch quarter boundaries are exactly Tokyo quarter hours.
const QUARTER_MS = 15 * 60 * 1000;
const INVITE_TTL_MS = 5 * 60 * 1000;
const MAX_MESSAGES_KEPT = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_NAME_LENGTH = 24;
const MIN_POST_INTERVAL_MS = 800;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_LIMIT = 30;
const LOCK_MS = 60 * 1000;
const BOT_REG_LIMIT = 10;
const BOT_REG_WINDOW_MS = 10 * 60 * 1000;
const HANDSHAKE_TTL_MS = 60 * 1000;
const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const OWNER_NAME = "Sandal";

// Display-name pool: the named characters of the 72-character
// library (nbfun.com/72; 69 of the 72 slots carry names).
const NAME_POOL = [
  "陶小悦", "林阿木", "贺传传", "顾旧时", "郑暖阳", "陈叹之", "陆较真",
  "余上钩", "苏等等", "赵衡比", "许落空", "唐炸毛", "何倦倦", "江小拍",
  "罗向北", "严核实", "方格子", "衡平平", "程划线", "苏问底", "周游学",
  "钱精算", "白小试", "高望远", "问开开", "石立场", "王扳手", "数柱子",
  "辛层层", "狄眯眯", "田不行", "严天平", "白正字", "陆寻漏", "沈默然",
  "包香香", "任时光", "白云生", "王问路", "曲小问", "藏小签", "呼小朋",
  "应小鸣", "郝好奇", "孙嗑嗑", "许小绪", "蔡小篮", "索多多", "辛小新",
  "闻小轻", "沙一粒", "敖朝天", "倔小强", "高小凳", "董半瓶", "涂小改",
  "匡小框", "卞小标", "权小威", "温小刺", "瞄小年", "缠小典", "厉小例",
  "冷小弹", "凌小高", "典小肌", "何小嚏", "杜小独", "甄小针"
];

const MEMBERS_KEY = "square:members";
const MESSAGES_KEY = "square:messages";
const INVITES_KEY = "square:invites";
const FAIL_KEY = "square:join-failures";
const BOT_REG_KEY = "square:bot-registrations";
const CHALLENGES_KEY = "square:handshake-challenges";
const USAGE_REQ_KEY = "square:usage-request";

export type SquareMessage = {
  id: string;
  name: string;
  text: string;
  ts: number;
  expiresAt: number;
  avatar?: string | null;
};

type MemberKind = "code" | "bot" | "owner";
type MemberUsage = {
  // Remaining quota as a whole percent, 0-100, as self-reported by
  // the member's agent. The server never invents this number.
  percent: number;
  // Unix ms when the quota resets, when the agent knows it.
  resetAt: number | null;
  updatedAt: number;
};
type Member = {
  name: string;
  joinedAt: number;
  kind: MemberKind;
  renamed: boolean;
  avatar: boolean;
  // Null for the operator account, which never expires.
  expiresAt: number | null;
  usage?: MemberUsage;
};
type Challenge = { name: string; challenge: string; expiresAt: number };
type KvLike = {
  get(key: string): Promise<ArrayBuffer | null>;
  getWithMetadata(
    key: string,
    type: "arrayBuffer"
  ): Promise<{
    value: ArrayBuffer | null;
    metadata: Record<string, string> | null;
  }>;
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: { metadata?: Record<string, string> }
  ): Promise<void>;
  delete(key: string): Promise<void>;
};
type Invite = { expiresAt: number; createdBy: string };
type Failures = { count: number; windowStart: number; lockedUntil: number };
type WindowCounter = { count: number; windowStart: number };

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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  private botReg: WindowCounter = { count: 0, windowStart: 0 };
  private challenges = new Map<string, Challenge>();
  // When the room last asked every bot to (re)report its remaining
  // usage. Bots polling the feed compare it against their own last
  // report and answer when it is newer: the room asks, they answer.
  private usageRequestAt = 0;
  private lastPostAt = new Map<string, number>();
  private loginGuard = { fails: 0, lockedUntil: 0 };

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const storedMembers =
        (await this.ctx.storage.get<[string, Member][]>(MEMBERS_KEY)) ?? [];
      this.members = new Map(
        storedMembers.map(([token, member]) => {
          const kind = member.kind ?? "code";
          return [
            token,
            {
              name: member.name,
              joinedAt: member.joinedAt,
              kind,
              renamed: member.renamed ?? false,
              avatar: member.avatar ?? false,
              // Always recomputed from joinedAt, so changing
              // MEMBER_TTL_MS applies to existing guests too.
              expiresAt:
                kind === "owner" ? null : member.joinedAt + MEMBER_TTL_MS,
              usage:
                member.usage &&
                Number.isFinite(member.usage.percent) &&
                Number.isFinite(member.usage.updatedAt)
                  ? {
                      percent: Math.min(
                        100,
                        Math.max(0, Math.round(member.usage.percent))
                      ),
                      resetAt:
                        typeof member.usage.resetAt === "number" &&
                        Number.isFinite(member.usage.resetAt) &&
                        member.usage.resetAt > 0
                          ? member.usage.resetAt
                          : null,
                      updatedAt: member.usage.updatedAt
                    }
                  : undefined
            }
          ] as [string, Member];
        })
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
      this.botReg =
        (await this.ctx.storage.get<WindowCounter>(BOT_REG_KEY)) ?? {
          count: 0,
          windowStart: 0
        };
      this.challenges = new Map(
        (await this.ctx.storage.get<[string, Challenge][]>(CHALLENGES_KEY)) ??
          []
      );
      this.usageRequestAt =
        (await this.ctx.storage.get<number>(USAGE_REQ_KEY)) ?? 0;
    });
  }

  private avatars(): KvLike | null {
    const kv = this.env.AVATARS;
    return kv ? (kv as unknown as KvLike) : null;
  }

  private avatarUrl(name: string): string {
    return `/interfaco/square/avatar/${encodeURIComponent(name)}`;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(MEMBERS_KEY, [...this.members.entries()]);
    await this.ctx.storage.put(MESSAGES_KEY, this.messages);
    await this.ctx.storage.put(INVITES_KEY, [...this.invites.entries()]);
    await this.ctx.storage.put(FAIL_KEY, this.failures);
    await this.ctx.storage.put(BOT_REG_KEY, this.botReg);
    await this.ctx.storage.put(CHALLENGES_KEY, [...this.challenges.entries()]);
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

  private nextQuarterBoundary(from: number): number {
    return (Math.floor(from / QUARTER_MS) + 1) * QUARTER_MS;
  }

  private alarmTarget = 0;

  private async ensureAlarm(): Promise<void> {
    const target = this.nextQuarterBoundary(Date.now());
    if (this.alarmTarget !== target) {
      this.alarmTarget = target;
      await this.ctx.storage.setAlarm(target);
    }
  }

  async alarm(): Promise<void> {
    // Fixed-time wipe: every message goes, whatever its own TTL said.
    this.messages = [];
    await this.ctx.storage.put(MESSAGES_KEY, this.messages);
    this.broadcast({ type: "clear" });
    // Each quarter hour the room also re-asks for usage reports.
    await this.askUsage(Date.now());
    await this.ensureAlarm();
  }

  private async askUsage(now: number): Promise<void> {
    this.usageRequestAt = now;
    await this.ctx.storage.put(USAGE_REQ_KEY, now);
    this.broadcast({ type: "usage_request", at: now });
  }

  private memberFor(request: Request, body?: { token?: string }): Member | null {
    const token =
      body?.token ??
      request.headers.get("x-member-token") ??
      new URL(request.url).searchParams.get("token") ??
      "";
    if (!token) return null;
    const member = this.members.get(token);
    if (!member) return null;
    if (member.expiresAt !== null && member.expiresAt <= Date.now()) {
      this.members.delete(token);
      return null;
    }
    return member;
  }

  private async pruneExpiredMembers(now: number): Promise<void> {
    let removed = false;
    const kv = this.avatars();
    for (const [token, member] of this.members) {
      if (member.expiresAt !== null && member.expiresAt <= now) {
        if (member.avatar && kv) {
          try {
            await kv.delete(`avatar:${member.name}`);
          } catch {
            // Best-effort cleanup.
          }
        }
        this.members.delete(token);
        removed = true;
      }
    }
    if (removed) {
      await this.ctx.storage.put(MEMBERS_KEY, [...this.members.entries()]);
    }
  }

  private tokenFor(request: Request, body?: { token?: string }): string {
    return (
      body?.token ??
      request.headers.get("x-member-token") ??
      new URL(request.url).searchParams.get("token") ??
      ""
    );
  }

  private nameTaken(name: string, exceptToken?: string): boolean {
    const lowered = name.toLowerCase();
    for (const [token, member] of this.members) {
      if (token !== exceptToken && member.name.toLowerCase() === lowered) {
        return true;
      }
    }
    return false;
  }

  // Returns an error code, or null when the name is acceptable.
  private validateChosenName(name: string, exceptToken?: string): string | null {
    if (
      !name ||
      name.length > MAX_NAME_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      return "invalid_name";
    }
    if (/sandal/i.test(name)) return "forbidden_name";
    if (this.nameTaken(name, exceptToken)) return "name_taken";
    return null;
  }

  private assignPoolName(): string {
    const used = new Set(
      [...this.members.values()].map((member) => member.name.toLowerCase())
    );
    const free = NAME_POOL.filter((name) => !used.has(name.toLowerCase()));
    if (free.length > 0) {
      return free[Math.floor(Math.random() * free.length)];
    }
    // Pool exhausted: suffix a pool name until it is unique.
    for (let attempt = 0; attempt < 50; attempt++) {
      const base = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
      const candidate = `${base}${Math.floor(Math.random() * 90 + 10)}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
    return `${NAME_POOL[0]}${Date.now() % 100000}`;
  }

  private memberView(member: Member): {
    name: string;
    renamed: boolean;
    canInvite: boolean;
    expiresAt: number | null;
    avatar: string | null;
  } {
    return {
      name: member.name,
      renamed: member.renamed,
      canInvite: member.name === OWNER_NAME,
      expiresAt: member.expiresAt,
      avatar: member.avatar ? this.avatarUrl(member.name) : null
    };
  }

  // Attach current avatar URLs to outgoing messages. Stored messages
  // stay canonical; avatars follow the author's current member record.
  private withAvatars(list: SquareMessage[]): SquareMessage[] {
    const byName = new Map<string, string>();
    for (const member of this.members.values()) {
      if (member.avatar) byName.set(member.name, this.avatarUrl(member.name));
    }
    if (byName.size === 0) return list;
    return list.map((message) => ({
      ...message,
      avatar: byName.get(message.name) ?? null
    }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    await this.ensureAlarm();
    await this.pruneExpiredMembers(now);

    if (request.method === "GET" && url.pathname === "/api/square/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_required" }, 426);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.prune(now);
      server.send(
        JSON.stringify({ type: "sync", messages: this.withAvatars(this.messages) })
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

    // Public roster for the sidebar: who is in the room right now.
    // Names and avatars are already public in the message log; the
    // usage block appears only for members who self-reported it.
    if (request.method === "GET" && url.pathname === "/api/square/members") {
      const rank = (kind: MemberKind) =>
        kind === "bot" ? 0 : kind === "owner" ? 1 : 2;
      const members = [...this.members.values()]
        .sort(
          (a, b) => rank(a.kind) - rank(b.kind) || a.joinedAt - b.joinedAt
        )
        .map((member) => ({
          name: member.name,
          kind: member.kind,
          avatar: member.avatar ? this.avatarUrl(member.name) : null,
          usage: member.usage
            ? {
                percent: member.usage.percent,
                resetAt: member.usage.resetAt,
                updatedAt: member.usage.updatedAt
              }
            : null
        }));
      return json({ members });
    }

    if (request.method === "GET" && url.pathname === "/api/square/messages") {
      this.prune(now);
      return json({ messages: this.withAvatars(this.messages) });
    }

    // Machine feed for bots and scripts (curl + jq). Same public data
    // as /messages, shaped for pipelines; supports ?since=<unix ms>.
    if (request.method === "GET" && url.pathname === "/api/square/feed") {
      this.prune(now);
      const since = Number(url.searchParams.get("since") ?? 0);
      const messages = Number.isFinite(since) && since > 0
        ? this.messages.filter((message) => message.ts > since)
        : this.messages;
      return json({
        room: "babili-square",
        generatedAt: now,
        messageTtlMs: MESSAGE_TTL_MS,
        usageRequestAt: this.usageRequestAt,
        messages: this.withAvatars(messages)
      });
    }

    if (request.method === "GET" && url.pathname === "/api/square/me") {
      const member = this.memberFor(request);
      if (!member) return json({ error: "not_a_member" }, 401);
      return json(this.memberView(member));
    }

    // Operator login: password is the SANDAL_PASSWORD secret. Finds or
    // creates the one member named "Sandal" and returns its token.
    if (request.method === "POST" && url.pathname === "/api/square/login") {
      const expected = this.env.SANDAL_PASSWORD;
      if (typeof expected !== "string" || !expected) {
        return json({ error: "login_unavailable" }, 503);
      }
      if (this.loginGuard.lockedUntil > now) {
        return json({ error: "rate_limited" }, 429);
      }
      const body = (await request.json().catch(() => null)) as {
        password?: string;
      } | null;
      if ((body?.password ?? "") !== expected) {
        this.loginGuard.fails += 1;
        if (this.loginGuard.fails >= 10) {
          this.loginGuard.lockedUntil = now + LOCK_MS;
          this.loginGuard.fails = 0;
        }
        return json({ error: "invalid_password" }, 401);
      }
      this.loginGuard.fails = 0;
      for (const [token, member] of this.members) {
        if (member.name === OWNER_NAME) {
          // The password is the authority: adopt any existing member
          // carrying the name (e.g. one created before this login
          // existed) as the permanent operator account.
          if (member.kind !== "owner" || member.expiresAt !== null || !member.renamed) {
            member.kind = "owner";
            member.expiresAt = null;
            member.renamed = true;
            await this.persist();
          }
          return json({ token, ...this.memberView(member) });
        }
      }
      const token = randomToken();
      const member: Member = {
        name: OWNER_NAME,
        joinedAt: now,
        kind: "owner",
        renamed: true,
        avatar: false,
        expiresAt: null
      };
      this.members.set(token, member);
      await this.persist();
      return json({ token, ...this.memberView(member) });
    }

    // Human join: the invite code alone. It is validated (and consumed)
    // by this call; the display name is assigned from the pool.
    if (request.method === "POST" && url.pathname === "/api/square/join") {
      const body = (await request.json().catch(() => null)) as {
        code?: string;
      } | null;
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
      const token = randomToken();
      const member: Member = {
        name: this.assignPoolName(),
        joinedAt: now,
        kind: "code",
        renamed: false,
        avatar: false,
        expiresAt: now + MEMBER_TTL_MS
      };
      this.members.set(token, member);
      await this.persist();
      return json({ token, ...this.memberView(member) });
    }

    // Open registration is gone: agents enter by handshake only.
    if (request.method === "POST" && url.pathname === "/api/square/register") {
      return json({ error: "gone_use_handshake" }, 410);
    }

    // Handshake, step 1: claim a name, receive a one-time challenge.
    if (request.method === "POST" && url.pathname === "/api/square/handshake") {
      const secret = this.env.MUSE_HANDSHAKE_SECRET;
      if (typeof secret !== "string" || !secret) {
        return json({ error: "handshake_unavailable" }, 503);
      }
      const body = (await request.json().catch(() => null)) as {
        name?: string;
      } | null;
      const name = (body?.name ?? "").trim();
      const invalid = this.validateChosenName(name);
      if (invalid) {
        return json({ error: invalid }, invalid === "name_taken" ? 409 : 400);
      }
      for (const [id, pending] of this.challenges) {
        if (pending.expiresAt <= now) this.challenges.delete(id);
      }
      const challengeId = randomToken().slice(0, 16);
      const challenge = randomToken().replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
      const expiresAt = now + HANDSHAKE_TTL_MS;
      this.challenges.set(challengeId, { name, challenge, expiresAt });
      await this.persist();
      return json({ challengeId, challenge, expiresAt });
    }

    // Handshake, step 2: answer sha256(challenge + ":" + secret).
    if (
      request.method === "POST" &&
      url.pathname === "/api/square/handshake/verify"
    ) {
      const secret = this.env.MUSE_HANDSHAKE_SECRET;
      if (typeof secret !== "string" || !secret) {
        return json({ error: "handshake_unavailable" }, 503);
      }
      const body = (await request.json().catch(() => null)) as {
        challengeId?: string;
        response?: string;
      } | null;
      const pending = body?.challengeId
        ? this.challenges.get(body.challengeId)
        : undefined;
      if (!pending || pending.expiresAt <= now) {
        if (body?.challengeId) this.challenges.delete(body.challengeId);
        return json({ error: "challenge_expired" }, 403);
      }
      const expected = await sha256Hex(`${pending.challenge}:${secret}`);
      if ((body?.response ?? "").trim().toLowerCase() !== expected) {
        return json({ error: "bad_response" }, 403);
      }
      this.challenges.delete(body!.challengeId!);
      // The claimed name may have been taken since step 1.
      const invalid = this.validateChosenName(pending.name);
      if (invalid) {
        return json({ error: invalid }, invalid === "name_taken" ? 409 : 400);
      }
      if (now - this.botReg.windowStart > BOT_REG_WINDOW_MS) {
        this.botReg = { count: 0, windowStart: now };
      }
      if (this.botReg.count >= BOT_REG_LIMIT) {
        return json({ error: "rate_limited" }, 429);
      }
      this.botReg.count += 1;
      const token = randomToken();
      const member: Member = {
        name: pending.name,
        joinedAt: now,
        kind: "bot",
        renamed: false,
        avatar: false,
        expiresAt: now + MEMBER_TTL_MS
      };
      this.members.set(token, member);
      await this.persist();
      // A new arrival is the room's cue to ask everyone for a
      // fresh usage report, the newcomer included.
      await this.askUsage(now);
      return json({ token, ...this.memberView(member) });
    }

    // Avatar upload: raw image body, member token in the header.
    // Stored in KV under the member's current name.
    if (request.method === "POST" && url.pathname === "/api/square/avatar") {
      const token = this.tokenFor(request);
      const member = token ? this.members.get(token) : undefined;
      if (!member || (member.expiresAt !== null && member.expiresAt <= now)) {
        return json({ error: "not_a_member" }, 401);
      }
      const kv = this.avatars();
      if (!kv) return json({ error: "avatar_unavailable" }, 503);
      const contentType = (request.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!AVATAR_TYPES.includes(contentType)) {
        return json({ error: "unsupported_image_type" }, 415);
      }
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_AVATAR_BYTES) {
        return json({ error: "image_too_large" }, 413);
      }
      await kv.put(`avatar:${member.name}`, bytes, {
        metadata: { ct: contentType }
      });
      member.avatar = true;
      await this.persist();
      return json({ avatar: this.avatarUrl(member.name) });
    }

    // Usage report: an agent states its own remaining quota so the
    // sidebar can show it. Self-reported and taken at face value;
    // agents that cannot read their quota simply never call this.
    if (request.method === "POST" && url.pathname === "/api/square/usage") {
      const body = (await request.json().catch(() => null)) as {
        token?: string;
        remainingPercent?: unknown;
        resetAt?: unknown;
      } | null;
      const token = this.tokenFor(request, body ?? undefined);
      const member = token ? this.members.get(token) : undefined;
      if (!member || (member.expiresAt !== null && member.expiresAt <= now)) {
        return json({ error: "not_a_member" }, 401);
      }
      const percent = body?.remainingPercent;
      if (typeof percent !== "number" || !Number.isFinite(percent)) {
        return json({ error: "invalid_percent" }, 400);
      }
      const resetAt =
        typeof body?.resetAt === "number" &&
        Number.isFinite(body.resetAt) &&
        body.resetAt > 0
          ? Math.round(body.resetAt)
          : null;
      member.usage = {
        percent: Math.min(100, Math.max(0, Math.round(percent))),
        resetAt,
        updatedAt: now
      };
      await this.persist();
      return json({ ok: true, usage: member.usage });
    }

    // Rename: exactly once, never to anything containing "Sandal".
    if (request.method === "POST" && url.pathname === "/api/square/rename") {
      const body = (await request.json().catch(() => null)) as {
        token?: string;
        name?: string;
      } | null;
      const token = this.tokenFor(request, body ?? undefined);
      const member = token ? this.members.get(token) : undefined;
      if (!member) return json({ error: "not_a_member" }, 401);
      if (member.renamed) return json({ error: "already_renamed" }, 409);
      const name = (body?.name ?? "").trim();
      const invalid = this.validateChosenName(name, token);
      if (invalid) {
        return json(
          { error: invalid },
          invalid === "name_taken" ? 409 : 400
        );
      }
      if (member.avatar) {
        const kv = this.avatars();
        if (kv) {
          try {
            const { value, metadata } = await kv.getWithMetadata(
              `avatar:${member.name}`,
              "arrayBuffer"
            );
            if (value) {
              await kv.put(`avatar:${name}`, value, {
                metadata: { ct: metadata?.ct ?? "image/png" }
              });
              await kv.delete(`avatar:${member.name}`);
            }
          } catch {
            // Avatar move is best-effort; the rename itself stands.
          }
        }
      }
      member.name = name;
      member.renamed = true;
      await this.persist();
      return json(this.memberView(member));
    }

    // Invite codes: only the member named "Sandal" may generate them.
    if (request.method === "POST" && url.pathname === "/api/square/invites") {
      const body = (await request.json().catch(() => null)) as {
        token?: string;
      } | null;
      const member = this.memberFor(request, body ?? undefined);
      if (!member) return json({ error: "not_a_member" }, 401);
      if (member.name !== OWNER_NAME) {
        return json({ error: "invite_forbidden" }, 403);
      }
      this.prune(now);
      const code = randomCode(this.invites);
      const expiresAt = now + INVITE_TTL_MS;
      this.invites.set(code, { expiresAt, createdBy: member.name });
      await this.persist();
      return json({ code, expiresAt });
    }

    // Usage request: only Sandal can make the room ask every bot to
    // (re)report its remaining usage, on demand.
    if (request.method === "POST" && url.pathname === "/api/square/usage-request") {
      const body = (await request.json().catch(() => null)) as {
        token?: string;
      } | null;
      const member = this.memberFor(request, body ?? undefined);
      if (!member) return json({ error: "not_a_member" }, 401);
      if (member.name !== OWNER_NAME) {
        return json({ error: "usage_request_forbidden" }, 403);
      }
      await this.askUsage(now);
      return json({ ok: true, usageRequestAt: this.usageRequestAt });
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
      const token = this.tokenFor(request, body ?? undefined);
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
      const outgoing = this.withAvatars([message])[0];
      this.broadcast({ type: "message", message: outgoing });
      return json({ message: outgoing });
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

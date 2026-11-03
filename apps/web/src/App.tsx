import {
  createIdentityKeyPair,
  createAuthenticatedPeerEvent,
  createAgreementKeyPair,
  decryptBytes,
  deriveRoomKey,
  encryptBytes,
  encryptMessage,
  exportIdentityPublicKey,
  exportIdentityPrivateKey,
  exportAgreementPrivateKey,
  exportAgreementPublicKey,
  generateMessageId,
  generateRoomSecret,
  generateSessionId,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  importAgreementPrivateKey,
  sha256Base64Url,
  verifyAuthenticatedPeerEvent,
  unwrapRoomSecret,
  wrapRoomSecret
} from "@elm-chat/crypto";
import {
  FILE_CHUNK_BYTES,
  MESSAGE_PROTOCOL_VERSION,
  isAcquisitionSource,
  isMarketingAcquisitionSource,
  MAX_FILE_BYTES,
  MAX_TRANSCRIPT_SYNC_MESSAGES,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type EncryptedMessageEnvelope,
  type AuthenticatedPeerEvent,
  type PeerDataEvent,
  type PeerFileChunk,
  type PeerDescriptor,
  type PresenceSnapshot,
  type RoomInvite,
  type RoomMetadata,
  type ServerEvent,
} from "@elm-chat/shared";
import { startTransition, useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { recordGrowthEvent, resolveExternalAcquisitionSource } from "./growth";
import { MarketingPage, type MarketingSlug } from "./MarketingPage";
import { locale, t } from "./localization";
import { InvalidMessageEnvelopeError, receiveTextMessage } from "./message-receive";
import { ReplayGuard } from "./replay";
import { handleComposerKeyDown } from "./composer";
import { ReconnectScheduler } from "./reconnect";
import { loadRoomMetadata, RoomMetadataError } from "./room-metadata";
import { ManualInviteLink } from "./ManualInviteLink";
import { canShareInvite } from "./manual-invite";
import { useConversationScroll } from "./use-conversation-scroll";
import { useConversationFind } from "./use-conversation-find";
import { useConversationConcealment } from "./use-conversation-concealment";

type View = "landing" | "marketing" | "room" | "square" | "create" | "ensaluti";

type FileTransferState =
  | "offered"
  | "requesting"
  | "transferring"
  | "ready"
  | "sent"
  | "error";

type UiFile = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  state: FileTransferState;
  progress: number;
  url?: string;
  outgoing: boolean;
};

type UiMessage = {
  id: string;
  senderSessionId: string;
  sentAt: number;
  expiresAt?: number;
  kind: "text" | "file";
  plaintext?: string;
  file?: UiFile;
};

type IncomingFile = {
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  received: number;
  receivedBytes: number;
  chunks: (Uint8Array | undefined)[];
  senderSessionId: string;
  sha256: string;
  keyEpoch: number;
  requested: boolean;
  timeoutId?: number;
};

type ActionFeedback = "idle" | "success";
type InviteFeedback = "idle" | "copied" | "shared";
type InviteAccess = "checking" | "granted" | "invalid" | "claimed" | "used";
type DurationUnit = "minutes" | "hours" | "days";
type DurationDraft = {
  amount: string;
  unit: DurationUnit;
  indefinite: boolean;
};
type InviteDurationDraft = {
  amount: string;
  unit: DurationUnit;
};

type DurationKind = "message" | "room";

function roomPathname(): { view: View; roomId?: string; marketingSlug?: MarketingSlug } {
  // Babili square: the homepage is the permanent public chat; the
  // classic private-room creation page moved to /new.
  if (window.location.pathname === "/") {
    return { view: "square" };
  }
  if (window.location.pathname === "/new") {
    return { view: "create" };
  }
  // Operator login page (Sandal). Checked before the 8-character
  // short-room pattern below, which "ensaluti" would otherwise match.
  if (window.location.pathname === "/ensaluti") {
    return { view: "ensaluti" };
  }
  const match = window.location.pathname.match(/^\/c\/([^/]+)$/);
  if (match) {
    return { view: "room", roomId: match[1] };
  }
  // Babili edition: short room URLs live at the root (/{8-char id}).
  // No marketing slug is a bare 8-character token, so this cannot
  // shadow a content page.
  const shortMatch = window.location.pathname.match(/^\/([A-Za-z0-9_-]{8})$/);
  if (shortMatch) {
    return { view: "room", roomId: shortMatch[1] };
  }
  const marketingSlug = window.location.pathname.replace(/^\/|\/$/g, "");
  if (isMarketingAcquisitionSource(marketingSlug)) {
    return { view: "marketing", marketingSlug };
  }
  return { view: "landing" };
}

function formatRelativeDuration(target: number): string {
  const deltaSeconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const minutes = Math.floor(deltaSeconds / 60);
  const seconds = deltaSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function formatStaticDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) {
    return "0s";
  }

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

// AGPL-3.0: the footer links to the source of this running instance.
const SOURCE_URL = "https://github.com/gorou5/elm-chat";

function creatorTokenKey(roomId: string): string {
  return `elm-chat:creator:${roomId}`;
}

function sessionKey(roomId: string): string {
  return `elm-chat:session:${roomId}`;
}

function identityKeyPairKey(roomId: string, sessionId: string): string {
  return `elm-chat:identity:${roomId}:${sessionId}`;
}

function replayStateKey(roomId: string, sessionId: string, kind: "message" | "event"): string {
  return `elm-chat:replay:${kind}:${roomId}:${sessionId}`;
}

async function loadIdentityKeyPair(roomId: string, sessionId: string): Promise<{
  privateKey: CryptoKey;
  publicKey: string;
  agreementPrivateKey: CryptoKey;
  agreementPublicKey: string;
}> {
  const storageKey = identityKeyPairKey(roomId, sessionId);
  const stored = safeStorageGet("session", storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as {
        privateKey: JsonWebKey;
        publicKey: string;
        agreementPrivateKey: JsonWebKey;
        agreementPublicKey: string;
      };
      return {
        privateKey: await importIdentityPrivateKey(parsed.privateKey),
        publicKey: parsed.publicKey,
        agreementPrivateKey: await importAgreementPrivateKey(parsed.agreementPrivateKey),
        agreementPublicKey: parsed.agreementPublicKey
      };
    } catch {
      // Replace corrupt or legacy identity state with a fresh tab-scoped key.
    }
  }
  const [pair, agreementPair] = await Promise.all([
    createIdentityKeyPair(),
    createAgreementKeyPair()
  ]);
  const result = {
    privateKey: pair.privateKey,
    publicKey: await exportIdentityPublicKey(pair.publicKey),
    agreementPrivateKey: agreementPair.privateKey,
    agreementPublicKey: await exportAgreementPublicKey(agreementPair.publicKey)
  };
  safeStorageSet("session", storageKey, JSON.stringify({
    privateKey: await exportIdentityPrivateKey(pair.privateKey),
    publicKey: result.publicKey,
    agreementPrivateKey: await exportAgreementPrivateKey(agreementPair.privateKey),
    agreementPublicKey: result.agreementPublicKey
  }));
  return result;
}

function safeStorageGet(storage: "local" | "session", key: string): string | null {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    return target.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(storage: "local" | "session", key: string, value: string): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    target.setItem(key, value);
  } catch {
    // Private browsing and restrictive browser contexts can block storage access.
  }
}

function safeStorageRemove(storage: "local" | "session", key: string): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    target.removeItem(key);
  } catch {
    // Storage cleanup is best effort in restrictive browser contexts.
  }
}

function durationUnitLabel(unit: DurationUnit): string {
  switch (unit) {
    case "minutes":
      return t("minutes").toLowerCase();
    case "hours":
      return t("hours").toLowerCase();
    case "days":
      return t("days").toLowerCase();
  }
}

function durationToMs(amount: number, unit: DurationUnit): number {
  switch (unit) {
    case "minutes":
      return amount * 60 * 1000;
    case "hours":
      return amount * 60 * 60 * 1000;
    case "days":
      return amount * 24 * 60 * 60 * 1000;
  }
}

function durationToSeconds(amount: number, unit: DurationUnit): number {
  return Math.floor(durationToMs(amount, unit) / 1000);
}

function formatSelectedDuration(amount: string, unit: DurationUnit, indefinite: boolean): string {
  if (indefinite) {
    return t("indefinite");
  }
  const value = Number(amount) || 0;
  const label = durationUnitLabel(unit);
  return `${value} ${label}`;
}

function DurationUnitButtons({
  disabled = false,
  label,
  onChange,
  value
}: {
  disabled?: boolean;
  label: string;
  onChange: (unit: DurationUnit) => void;
  value: DurationUnit;
}) {
  const units: DurationUnit[] = ["minutes", "hours", "days"];
  return (
    <div className="unit-toggle" role="group" aria-label={label}>
      {units.map((unit) => (
        <button
          aria-pressed={value === unit}
          className={`unit-toggle-button ${value === unit ? "unit-toggle-button-active" : ""}`}
          disabled={disabled}
          key={unit}
          onClick={() => onChange(unit)}
          type="button"
        >
          {t(unit)}
        </button>
      ))}
    </div>
  );
}

function parseDurationDraft(
  draft: DurationDraft,
  fallbackValue: number,
  fallbackUnit: DurationUnit,
  kind: "seconds" | "milliseconds"
): number | null {
  if (draft.indefinite) {
    return null;
  }

  const parsed = Number(draft.amount);
  const safeAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
  const unit = draft.unit || fallbackUnit;
  return kind === "seconds"
    ? durationToSeconds(safeAmount, unit)
    : durationToMs(safeAmount, unit);
}

function parseInviteDurationDraft(draft: InviteDurationDraft): number {
  const parsed = Number(draft.amount);
  const safeAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
  return durationToMs(safeAmount, draft.unit || "minutes");
}

function toggleIndefiniteDuration(
  current: DurationDraft,
  checked: boolean,
  fallbackAmount: string
): DurationDraft {
  if (checked) {
    return {
      ...current,
      indefinite: true
    };
  }

  return {
    ...current,
    indefinite: false,
    amount: current.amount || fallbackAmount
  };
}

let turnstileScriptPromise: Promise<void> | null = null;
let turnstileWidgetId: string | undefined;
let turnstilePendingResolve: ((token: string | undefined) => void) | null = null;

function resolveTurnstile(token: string | undefined): void {
  const resolve = turnstilePendingResolve;
  turnstilePendingResolve = null;
  resolve?.(token);
}

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) {
    return Promise.resolve();
  }
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("challenge script failed to load"));
      document.head.appendChild(script);
    });
  }
  return turnstileScriptPromise;
}

// Runs an invisible Turnstile challenge when a site key is configured. Returns
// the token, or undefined when Turnstile is not configured (local dev) or the
// challenge could not run — the server decides whether a token is required.
async function getTurnstileToken(): Promise<string | undefined> {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  if (!siteKey) {
    return undefined;
  }
  try {
    await loadTurnstileScript();
  } catch {
    return undefined;
  }
  const turnstile = window.turnstile;
  if (!turnstile) {
    return undefined;
  }
  return new Promise<string | undefined>((resolve) => {
    turnstilePendingResolve = resolve;
    let container = document.getElementById("turnstile-holder");
    if (!container) {
      container = document.createElement("div");
      container.id = "turnstile-holder";
      container.style.position = "fixed";
      container.style.bottom = "-9999px";
      container.style.left = "-9999px";
      document.body.appendChild(container);
    }
    try {
      if (turnstileWidgetId === undefined) {
        turnstileWidgetId = turnstile.render(container, {
          sitekey: siteKey,
          execution: "execute",
          appearance: "interaction-only",
          callback: (token: string) => resolveTurnstile(token),
          "error-callback": () => resolveTurnstile(undefined),
          "timeout-callback": () => resolveTurnstile(undefined),
          "expired-callback": () => resolveTurnstile(undefined)
        });
      } else {
        turnstile.reset(turnstileWidgetId);
      }
      turnstile.execute(turnstileWidgetId, { sitekey: siteKey });
    } catch {
      resolveTurnstile(undefined);
    }
    // Never let a stuck challenge block room creation indefinitely.
    window.setTimeout(() => resolveTurnstile(undefined), 8000);
  });
}

async function createRoom(body: CreateRoomRequest): Promise<CreateRoomResponse> {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? t("failedCreateRoom"));
  }
  return response.json();
}

async function destroyRoom(roomId: string, creatorToken: string): Promise<RoomMetadata> {
  const response = await fetch(`/api/rooms/${roomId}/destroy`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ creatorToken })
  });
  if (!response.ok) {
    throw new Error(t("destroyRoomFailed"));
  }
  return response.json();
}

async function createInvite(roomId: string, creatorToken: string, ttlMs = 10 * 60 * 1000): Promise<RoomInvite> {
  const response = await fetch(`/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatorToken, ttlMs })
  });
  if (!response.ok) {
    throw new Error(t("createInviteFailed"));
  }
  return response.json();
}

async function listInvites(roomId: string, creatorToken: string): Promise<RoomInvite[]> {
  const response = await fetch(`/api/rooms/${roomId}/invites`, {
    headers: { authorization: `Bearer ${creatorToken}` }
  });
  if (!response.ok) {
    throw new Error(t("failedLoadInvites"));
  }
  return response.json();
}

async function revokeInvite(roomId: string, creatorToken: string, token: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/invites/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatorToken, token })
  });
  if (!response.ok) {
    throw new Error(t("revokeInviteFailed"));
  }
}

async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function wsUrl(path: string): string {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  return url.toString();
}

function messageStatus(message: UiMessage): string {
  if (message.expiresAt) {
    return t("vanishesIn", { duration: formatRelativeDuration(message.expiresAt) });
  }
  return t("untilRoomCloses");
}

function upsertMessage(messages: UiMessage[], next: UiMessage): UiMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === next.id);
  if (existingIndex === -1) {
    return [...messages, next].sort((left, right) => left.sentAt - right.sentAt);
  }

  const copy = [...messages];
  copy[existingIndex] = {
    ...copy[existingIndex],
    ...next
  };
  return copy;
}

function colorFromSessionId(sessionId: string): string {
  let hash = 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = 62 + (hash % 12);
  const lightness = 48 + (hash % 10);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function inviteColor(invite: RoomInvite): string {
  return colorFromSessionId(invite.consumedBySessionId ?? invite.token);
}

function bubbleStyle(sessionId: string, mine: boolean): CSSProperties {
  const color = colorFromSessionId(sessionId);
  return {
    "--bubble-accent": color,
    "--bubble-surface": mine ? color : `color-mix(in srgb, ${color}, white 88%)`,
    "--bubble-surface-border": `color-mix(in srgb, ${color}, white 58%)`,
    "--bubble-text": mine ? "#fffaf3" : "var(--ink)"
  } as CSSProperties;
}

function inviteAccentStyle(invite: RoomInvite): CSSProperties | undefined {
  const color = inviteColor(invite);
  return {
    "--invite-accent": color,
    "--invite-surface": `color-mix(in srgb, ${color}, white 84%)`,
    "--invite-border": `color-mix(in srgb, ${color}, white 56%)`
  } as CSSProperties;
}

function inviteStatusLabel(invite: RoomInvite): string {
  if (invite.revokedAt) {
    return t("inviteStatusRevoked");
  }
  if (invite.consumedAt || invite.admittedAt) {
    return t("inviteStatusJoined");
  }
  if (invite.claimedAt) {
    return t("inviteStatusJoining");
  }
  if (invite.expiresAt <= Date.now()) {
    return t("inviteStatusExpired");
  }
  return t("inviteStatusExpires", { duration: formatRelativeDuration(invite.expiresAt) });
}

function buildInviteUrl(roomId: string, inviteToken: string, roomSecret: string): string {
  return `${window.location.origin}/${roomId}?invite=${encodeURIComponent(inviteToken)}#${roomSecret}`;
}

function roomStateMessage(status: RoomMetadata["status"], reason?: string): string {
  if (status === "destroyed") {
    return t("destroyed");
  }

  switch (reason) {
    case "join-timeout":
      return t("joinTimeout");
    case "inactive":
      return t("inactive");
    case "max-age":
      return t("maxAge");
    default:
      return t("unavailable");
  }
}

function recordMakeYourOwnClick() {
  recordGrowthEvent("make_your_own_clicked");
}

// Privacy-safe growth callout for an invite recipient. The aggregate event
// records no room, invite, participant, or message identifier.
function MakeYourOwnCallout({ compact = false }: { compact?: boolean }) {
  return (
    <p className={`make-your-own ${compact ? "make-your-own-compact" : ""}`}>
      {compact
        ? t("tryInvite")
        : t("madeWith")}
      <a
        className="make-your-own-link"
        href="/?source=invite"
        onClick={recordMakeYourOwnClick}
        rel={compact ? "noreferrer" : undefined}
        target={compact ? "_blank" : undefined}
      >
        {t("makeYourOwn")}
      </a>
    </p>
  );
}

type RecoveryFocusTarget = { focusRef?: React.RefCallback<HTMLElement> };

function InvalidInviteScreen({ reason, focusRef }: { reason: InviteAccess } & RecoveryFocusTarget) {
  const copy =
    reason === "claimed"
      ? t("inviteClaimed")
      : reason === "used"
        ? t("inviteUsed")
        : t("inviteInvalid");
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow">Babili</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("invalidLink")}</h1>
        <p className="access-copy">{copy}</p>
        <a
          className="secondary-button access-home-link"
          href="/?source=invite"
          onClick={recordMakeYourOwnClick}
        >
          {t("backHome")}
        </a>
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

function RemovedFromRoomScreen({ focusRef }: RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow">Babili</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("removedTitle")}</h1>
        <p className="access-copy">{t("removedCopy")}</p>
        <a
          className="secondary-button access-home-link"
          href="/?source=invite"
          onClick={recordMakeYourOwnClick}
        >
          {t("backHome")}
        </a>
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="currentColor" height={size} viewBox="0 0 16 16" width={size}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function NewChatIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </svg>
  );
}

function LogInIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={size}>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="m10 17 5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  );
}

function SendIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={size}>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

function PencilIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={size}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function CheckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={size}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function UserPlusIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={size}>
      <path d="M2 21a8 8 0 0 1 13.292-6.292" />
      <circle cx="10" cy="8" r="5" />
      <path d="M19 16v6" />
      <path d="M22 19h-6" />
    </svg>
  );
}

function FileCard({ file, onDownload }: { file: UiFile; onDownload: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const progress = file.progress ?? 0;
  const percent = Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0;
  return (
    <div aria-label={t("fileCardLabel", { name: file.name })} className="file-card" ref={cardRef} role="group" tabIndex={-1}>
      <div className="file-card-head">
        <span className="file-icon" aria-hidden="true">
          &#128206;
        </span>
        <div className="file-meta">
          <span className="file-name">{file.name}</span>
          <span className="file-size">{formatBytes(file.size)}</span>
        </div>
      </div>
      {file.outgoing ? (
        <span className="file-status">{t("fileShared")}</span>
      ) : file.state === "offered" ? (
        <button aria-label={t("downloadFileLabel", { name: file.name })} className="secondary-button file-action" onClick={(event) => {
          // Preserve the initiating control's focus before progress replaces it.
          if (document.activeElement === event.currentTarget) cardRef.current?.focus({ preventScroll: true });
          onDownload();
        }} type="button">
          {t("download")}
        </button>
      ) : file.state === "requesting" || file.state === "transferring" ? (
        <div
          aria-label={t("fileProgressLabel", { name: file.name })}
          aria-live="off"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="file-progress"
          role="progressbar"
        >
          <div className="file-progress-track">
            <div className="file-progress-bar" style={{ width: `${percent}%` }} />
          </div>
          <span className="file-progress-label">{percent}%</span>
        </div>
      ) : file.state === "ready" && file.url ? (
        <a aria-label={t("saveFileLabel", { name: file.name })} className="secondary-button file-action" download={file.name} href={file.url}>
          {t("saveFile")}
        </a>
      ) : file.state === "error" ? (
        <span className="file-status file-status-error">{t("transferFailed")}</span>
      ) : null}
    </div>
  );
}

function InviteCheckingScreen({ connection, error, onRetry, focusRef }: {
  connection: string;
  error: string | null;
  onRetry?: () => void;
} & RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow">Babili</p>
        <h1 className="access-title">{t("checkingInvite")}</h1>
        <p className="access-copy">{t("verifyingInvite")}</p>
        <p ref={focusRef} tabIndex={-1}>{connection}</p>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        {onRetry ? <button className="secondary-button" onClick={onRetry} type="button">{t("retryConnection")}</button> : null}
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

function RoomGoneScreen({ fromInvite, reason, focusRef }: { fromInvite: boolean; reason?: string } & RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow">Babili</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("roomGone")}</h1>
        <p className="access-copy">
          {reason ?? t("roomGoneCopy")}
        </p>
        <a
          className="primary-button access-home-link"
          href={fromInvite ? "/?source=invite" : "/"}
          onClick={fromInvite ? recordMakeYourOwnClick : undefined}
        >
          {t("startNew")} &rarr;
        </a>
        {fromInvite ? <MakeYourOwnCallout /> : null}
      </section>
    </main>
  );
}

type SquareMessageItem = {
  id: string;
  name: string;
  text: string;
  ts: number;
  expiresAt: number;
};

const SQUARE_MEMBER_KEY = "babili:square:member";
const SQUARE_QUARTER_MS = 15 * 60 * 1000;
const tokyoClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

type SquareMember = {
  token: string;
  name: string;
  renamed: boolean;
  canInvite: boolean;
};

function loadStoredMember(): SquareMember | null {
  try {
    const raw = window.localStorage.getItem(SQUARE_MEMBER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SquareMember> & { token: string; name: string };
    return {
      token: parsed.token,
      name: parsed.name,
      renamed: parsed.renamed ?? false,
      canInvite: parsed.canInvite ?? parsed.name === "Sandal"
    };
  } catch {
    return null;
  }
}

function storeMember(member: SquareMember): void {
  window.localStorage.setItem(SQUARE_MEMBER_KEY, JSON.stringify(member));
}

// Long messages (over 10 characters) that arrive live are revealed
// progressively, like a stream. History shown on arrival is static.
function StreamingText({ text, animate }: { text: string; animate: boolean }) {
  const chars = [...text];
  const [count, setCount] = useState(() => (animate ? 0 : chars.length));
  useEffect(() => {
    if (!animate) {
      setCount(chars.length);
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setCount(chars.length);
      return;
    }
    let shown = 0;
    const step = Math.max(1, Math.ceil(chars.length / 45));
    const timer = window.setInterval(() => {
      shown += step;
      if (shown >= chars.length) {
        setCount(chars.length);
        window.clearInterval(timer);
      } else {
        setCount(shown);
      }
    }, 30);
    return () => window.clearInterval(timer);
    // Runs once per message text; count is driven by the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, text]);
  return <>{chars.slice(0, count).join("")}</>;
}

function SquarePage() {
  const [messages, setMessages] = useState<SquareMessageItem[]>([]);
  const [member, setMember] = useState<SquareMember | null>(loadStoredMember);
  const [code, setCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef<HTMLOListElement | null>(null);
  const stickRef = useRef(true);
  const staticIdsRef = useRef<Set<string> | null>(null);
  const memberToken = member?.token ?? null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Local mirror of the server wipe: when a quarter hour rolls over,
  // clear the visible log even if the "clear" frame was missed.
  const quarterRef = useRef(Math.floor(Date.now() / SQUARE_QUARTER_MS));
  useEffect(() => {
    const quarter = Math.floor(now / SQUARE_QUARTER_MS);
    if (quarter !== quarterRef.current) {
      quarterRef.current = quarter;
      staticIdsRef.current = new Set();
      setMessages([]);
    }
  }, [now]);

  useEffect(() => {
    if (!memberToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/square/me", {
          headers: { "x-member-token": memberToken }
        });
        if (!response.ok) {
          if (!cancelled) {
            window.localStorage.removeItem(SQUARE_MEMBER_KEY);
            setMember(null);
          }
          return;
        }
        const view = (await response.json()) as {
          name: string;
          renamed: boolean;
          canInvite: boolean;
        };
        if (!cancelled) {
          setMember((previous) => {
            if (!previous) return previous;
            const next = { ...previous, ...view };
            storeMember(next);
            return next;
          });
        }
      } catch {
        // Transient failure: keep the stored membership.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberToken]);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    const appendMessage = (incoming: SquareMessageItem) => {
      setMessages((previous) =>
        previous.some((item) => item.id === incoming.id) ? previous : [...previous, incoming]
      );
    };
    // The first batch (history fetch or first sync) is shown as-is;
    // only messages arriving afterwards stream in.
    const primeStatic = (batch: SquareMessageItem[]) => {
      if (staticIdsRef.current === null) {
        staticIdsRef.current = new Set(batch.map((item) => item.id));
      }
    };
    const loadHistory = async () => {
      try {
        const response = await fetch("/api/square/messages");
        if (!response.ok || cancelled) return;
        const data = (await response.json()) as { messages: SquareMessageItem[] };
        if (!cancelled) {
          primeStatic(data.messages);
          setMessages(data.messages);
        }
      } catch {
        // The socket sync below covers the history.
      }
    };
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/square/ws`);
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as {
            type: string;
            messages?: SquareMessageItem[];
            message?: SquareMessageItem;
          };
          if (payload.type === "sync" && payload.messages) {
            primeStatic(payload.messages);
            setMessages(payload.messages);
          }
          if (payload.type === "clear") {
            staticIdsRef.current = new Set();
            setMessages([]);
          }
          if (payload.type === "message" && payload.message) {
            appendMessage(payload.message);
          }
        } catch {
          // Ignore malformed frames.
        }
      };
      socket.onclose = () => {
        if (!cancelled) retry = window.setTimeout(connect, 3000);
      };
      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          // Already closed.
        }
      };
    };
    void loadHistory();
    connect();
    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const log = logRef.current;
    if (log && stickRef.current) {
      log.scrollTop = log.scrollHeight;
    }
  }, [messages]);

  const visibleMessages = messages.filter((message) => message.expiresAt > now);
  const dockError = renaming ? renameError : member ? sendError : joinError;
  const msToBoundary = SQUARE_QUARTER_MS - (now % SQUARE_QUARTER_MS);

  // The invite code is judged by this call alone: valid code, and the
  // visitor is a member under a server-assigned name. No name form.
  const submitJoin = async (event: FormEvent) => {
    event.preventDefault();
    setJoining(true);
    setJoinError(null);
    try {
      const response = await fetch("/api/square/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() })
      });
      const data = (await response.json().catch(() => ({}))) as {
        token?: string;
        name?: string;
        renamed?: boolean;
        canInvite?: boolean;
        error?: string;
      };
      if (!response.ok || !data.token || !data.name) {
        setJoinError(
          data.error === "invalid_code"
            ? t("invalidInviteCode")
            : data.error === "rate_limited"
              ? t("squareRateLimited")
              : t("joinFailed")
        );
        return;
      }
      const next: SquareMember = {
        token: data.token,
        name: data.name,
        renamed: data.renamed ?? false,
        canInvite: data.canInvite ?? false
      };
      storeMember(next);
      setMember(next);
      setCode("");
    } catch {
      setJoinError(t("joinFailed"));
    } finally {
      setJoining(false);
    }
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!member) return;
    const name = renameValue.trim();
    if (!name) {
      setRenameError(t("invalidName"));
      return;
    }
    setRenameError(null);
    try {
      const response = await fetch("/api/square/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: member.token, name })
      });
      const data = (await response.json().catch(() => ({}))) as {
        name?: string;
        renamed?: boolean;
        canInvite?: boolean;
        error?: string;
      };
      if (!response.ok || !data.name) {
        setRenameError(
          data.error === "forbidden_name"
            ? t("sandalForbidden")
            : data.error === "name_taken"
              ? t("nameTaken")
              : data.error === "already_renamed"
                ? t("renameUsed")
                : t("joinFailed")
        );
        return;
      }
      const next: SquareMember = {
        ...member,
        name: data.name,
        renamed: data.renamed ?? true,
        canInvite: data.canInvite ?? member.canInvite
      };
      storeMember(next);
      setMember(next);
      setRenaming(false);
      setRenameValue("");
    } catch {
      setRenameError(t("joinFailed"));
    }
  };

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!member) return;
    const text = draft.trim();
    if (!text) return;
    setSendError(null);
    try {
      const response = await fetch("/api/square/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: member.token, text })
      });
      const data = (await response.json().catch(() => ({}))) as {
        message?: SquareMessageItem;
        error?: string;
      };
      if (!response.ok) {
        setSendError(data.error === "rate_limited" ? t("squareRateLimited") : t("joinFailed"));
        return;
      }
      setDraft("");
      if (data.message) {
        const posted = data.message;
        setMessages((previous) =>
          previous.some((item) => item.id === posted.id) ? previous : [...previous, posted]
        );
      }
    } catch {
      setSendError(t("joinFailed"));
    }
  };

  const generateInvite = async () => {
    if (!member) return;
    try {
      const response = await fetch("/api/square/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: member.token })
      });
      if (!response.ok) return;
      const data = (await response.json()) as { code: string; expiresAt: number };
      setInvite(data);
    } catch {
      // The previous code (if any) stays on screen.
    }
  };

  return (
    <main className="square-shell">
      <header className="square-header">
        <div className="square-brand">
          <span className="square-brand-name">Babili</span>
          <span className="square-brand-sub">论巴别塔的倒掉</span>
        </div>
        <div
          className={`square-clock${msToBoundary <= 10000 ? " square-clock--alert" : ""}`}
          id="square-clock"
          role="timer"
        >
          {tokyoClock.format(now)}
        </div>
        <div className="square-actions">
          {member ? (
            <>
              {renaming ? (
                <form className="square-rename" onSubmit={submitRename}>
                  <input
                    autoComplete="off"
                    id="rename-input"
                    maxLength={24}
                    onChange={(event) => setRenameValue(event.target.value)}
                    value={renameValue}
                  />
                  <button
                    aria-label={t("saveName")}
                    className="secondary-button icon-button"
                    id="rename-save"
                    title={t("saveName")}
                    type="submit"
                  >
                    <CheckIcon />
                  </button>
                </form>
              ) : (
                <>
                  <span className="square-member-name">{member.name}</span>
                  {!member.renamed ? (
                    <button
                      aria-label={t("changeName")}
                      className="secondary-button icon-button"
                      id="rename-button"
                      onClick={() => {
                        setRenameError(null);
                        setRenameValue(member.name);
                        setRenaming(true);
                      }}
                      title={t("changeName")}
                      type="button"
                    >
                      <PencilIcon />
                    </button>
                  ) : null}
                </>
              )}
              {member.canInvite ? (
                <button
                  aria-label={t("generateInviteCode")}
                  className="secondary-button icon-button"
                  id="generate-invite"
                  onClick={() => void generateInvite()}
                  title={t("generateInviteCode")}
                  type="button"
                >
                  <UserPlusIcon />
                </button>
              ) : null}
            </>
          ) : null}
          <a
            aria-label={t("viewSource")}
            className="footer-source"
            href={SOURCE_URL}
            rel="noreferrer"
            target="_blank"
            title={t("viewSource")}
          >
            <GithubMark size={20} />
          </a>
          <a
            aria-label={t("createChat")}
            className="primary-button square-new-chat"
            href="/new"
            id="create-chat"
            title={t("createChat")}
          >
            <NewChatIcon />
          </a>
        </div>
      </header>
      {invite && invite.expiresAt > now ? (
        <div className="square-invite-bar" role="status">
          <span>{t("inviteCode")}</span>
          <strong id="invite-code-display">{invite.code}</strong>
          <span>{t("inviteValidFor", { duration: formatRelativeDuration(invite.expiresAt) })}</span>
        </div>
      ) : null}
      <ol
        aria-live="polite"
        className="square-log"
        id="chat-log"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
        ref={logRef}
      >
        {visibleMessages.map((message) => (
          <li className="square-msg" key={message.id}>
            <span className="square-msg-name">{message.name}</span>
            <time className="square-msg-time" dateTime={new Date(message.ts).toISOString()}>
              {formatClock(message.ts)}
            </time>
            <p className="square-msg-text">
              <StreamingText
                animate={
                  staticIdsRef.current !== null &&
                  !staticIdsRef.current.has(message.id) &&
                  [...message.text].length > 10
                }
                text={message.text}
              />
            </p>
          </li>
        ))}
      </ol>
      {dockError ? (
        <p className="error-text square-error" role="alert">
          {dockError}
        </p>
      ) : null}
      <footer className="square-dock">
        {member ? (
          <form className="square-composer" onSubmit={submitMessage}>
            <input
              aria-label={t("writeMessage")}
              autoComplete="off"
              id="message-input"
              maxLength={500}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("writeMessage")}
              value={draft}
            />
            <button
              aria-label={t("sendMessage")}
              className="primary-button icon-button"
              disabled={!draft.trim()}
              id="send-button"
              title={t("sendMessage")}
              type="submit"
            >
              <SendIcon />
            </button>
          </form>
        ) : (
          <form className="square-join" onSubmit={submitJoin}>
            <input
              aria-label={t("inviteCode")}
              autoCapitalize="characters"
              autoComplete="off"
              id="invite-code"
              maxLength={6}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t("inviteCode")}
              value={code}
            />
            <button
              aria-label={t("joinChat")}
              className="primary-button icon-button"
              disabled={joining || !code.trim()}
              id="join-button"
              title={t("joinChat")}
              type="submit"
            >
              <LogInIcon />
            </button>
          </form>
        )}
      </footer>
    </main>
  );
}

function EnsalutiPage() {
  const [member, setMember] = useState<SquareMember | null>(loadStoredMember);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/square/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      const data = (await response.json().catch(() => ({}))) as {
        token?: string;
        name?: string;
        renamed?: boolean;
        canInvite?: boolean;
        error?: string;
      };
      if (!response.ok || !data.token || !data.name) {
        setError(
          data.error === "rate_limited" ? t("squareRateLimited") : t("loginFailed")
        );
        return;
      }
      const next: SquareMember = {
        token: data.token,
        name: data.name,
        renamed: data.renamed ?? true,
        canInvite: data.canInvite ?? true
      };
      storeMember(next);
      setMember(next);
      setPassword("");
    } catch {
      setError(t("loginFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="invite-shell">
      <section className="invite-card">
        <div className="square-brand">
          <span className="square-brand-name">Babili</span>
          <span className="square-brand-sub">论巴别塔的倒掉</span>
        </div>
        {member && member.name === "Sandal" ? (
          <div className="invite-panel">
            <span className="square-member-name">{member.name}</span>
          </div>
        ) : (
          <form className="square-join invite-join" onSubmit={submitLogin}>
            <input
              aria-label={t("passwordLabel")}
              autoComplete="current-password"
              id="sandal-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("passwordLabel")}
              type="password"
              value={password}
            />
            <button
              aria-label={t("loginAction")}
              className="primary-button icon-button"
              disabled={busy || !password}
              id="login-button"
              title={t("loginAction")}
              type="submit"
            >
              <LogInIcon />
            </button>
            {error ? (
              <p className="error-text" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </section>
    </main>
  );
}

export function App() {
  const route = roomPathname();
  useEffect(() => {
    // The standalone /invite page was removed; send its visitors home.
    if (window.location.pathname === "/invite") {
      window.location.replace("/");
    }
  }, []);
  if (window.location.pathname === "/invite") {
    return null;
  }
  useEffect(() => {
    const previousLanguage = document.documentElement.lang;
    // Marketing articles are English; the landing and room UI use the catalog locale.
    document.documentElement.lang = route.view === "marketing" ? "en" : locale;
    return () => {
      document.documentElement.lang = previousLanguage;
    };
  }, [route.view]);
  if (route.view === "room" && route.roomId) {
    return <RoomPage roomId={route.roomId} />;
  }
  if (route.view === "marketing" && route.marketingSlug) {
    const sourceParam = new URLSearchParams(window.location.search).get("source");
    const externalSource = resolveExternalAcquisitionSource(sourceParam, document.referrer);
    return <MarketingPage externalSource={externalSource} slug={route.marketingSlug} />;
  }
  if (route.view === "square") {
    return <SquarePage />;
  }
  if (route.view === "ensaluti") {
    return <EnsalutiPage />;
  }
  return <LandingPage />;
}

function LandingPage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageDuration, setMessageDuration] = useState<DurationDraft>({
    amount: "7",
    unit: "minutes",
    indefinite: false
  });
  const [roomDuration, setRoomDuration] = useState<DurationDraft>({
    amount: "10",
    unit: "minutes",
    indefinite: false
  });

  function updateDurationIndefinite(kind: DurationKind, checked: boolean) {
    if (kind === "message") {
      setMessageDuration((current) => toggleIndefiniteDuration(current, checked, "7"));
      return;
    }
    setRoomDuration((current) => toggleIndefiniteDuration(current, checked, "10"));
  }

  async function handleCreate() {
    try {
      setCreating(true);
      setError(null);
      const secret = generateRoomSecret();
      const turnstileToken = await getTurnstileToken();
      const source = new URLSearchParams(window.location.search).get("source");
      const room = await createRoom({
        acquisitionSource: isAcquisitionSource(source) ? source : undefined,
        disappearAfterReadSeconds: parseDurationDraft(
          messageDuration,
          7,
          "minutes",
          "seconds"
        ),
        inactivityTimeoutMs: parseDurationDraft(roomDuration, 10, "minutes", "milliseconds"),
        maxAgeMs: null,
        turnstileToken
      });
      safeStorageSet("local", creatorTokenKey(room.roomId), room.creatorToken);
      window.location.assign(`${room.roomUrl}#${secret}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("unableCreateRoom"));
      setCreating(false);
    }
  }

  return (
    <main className="landing-shell">
      <header className="landing-header">
        <p className="hero-brand">
          <span className="hero-brand-name">Babili</span>
        </p>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <h1>{t("heroTitle")}</h1>
          <div className="creation-panel">
            <div className="setting-row" role="group" aria-labelledby="message-policy-label">
              <div>
                <span className="setting-label" id="message-policy-label">{t("messageVanish")}</span>
              </div>
              <div
                className={`setting-controls ${messageDuration.indefinite ? "setting-controls-disabled" : ""}`}
              >
                <input
                  aria-label={t("messageDurationAmount")}
                  className="setting-input"
                  disabled={messageDuration.indefinite}
                  inputMode="numeric"
                  min="1"
                  onChange={(event) =>
                    setMessageDuration((current) => ({ ...current, amount: event.target.value }))
                  }
                  type="number"
                  value={messageDuration.indefinite ? "" : messageDuration.amount}
                />
                <DurationUnitButtons
                  disabled={messageDuration.indefinite}
                  label={t("messageDurationUnit")}
                  onChange={(unit) =>
                    setMessageDuration((current) => ({ ...current, unit }))
                  }
                  value={messageDuration.unit}
                />
                <label className="toggle-pill">
                  <input
                    aria-labelledby="message-policy-label message-indefinite-label"
                    checked={messageDuration.indefinite}
                    onChange={(event) =>
                      updateDurationIndefinite("message", event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span id="message-indefinite-label">{t("indefinite")}</span>
                </label>
              </div>
            </div>
            <div className="setting-row" role="group" aria-labelledby="room-policy-label">
              <div>
                <span className="setting-label" id="room-policy-label">{t("roomSelfDestruct")}</span>
                <p className="setting-note">
                  {roomDuration.indefinite
                    ? t("onlyManualDestroy")
                    : `${formatSelectedDuration(roomDuration.amount, roomDuration.unit, false)} ${t("idle")}`}
                </p>
              </div>
              <div
                className={`setting-controls ${roomDuration.indefinite ? "setting-controls-disabled" : ""}`}
              >
                <input
                  aria-label={t("roomDurationAmount")}
                  className="setting-input"
                  disabled={roomDuration.indefinite}
                  inputMode="numeric"
                  min="1"
                  onChange={(event) =>
                    setRoomDuration((current) => ({ ...current, amount: event.target.value }))
                  }
                  type="number"
                  value={roomDuration.indefinite ? "" : roomDuration.amount}
                />
                <DurationUnitButtons
                  disabled={roomDuration.indefinite}
                  label={t("roomDurationUnit")}
                  onChange={(unit) =>
                    setRoomDuration((current) => ({ ...current, unit }))
                  }
                  value={roomDuration.unit}
                />
                <label className="toggle-pill">
                  <input
                    aria-labelledby="room-policy-label room-indefinite-label"
                    checked={roomDuration.indefinite}
                    onChange={(event) =>
                      updateDurationIndefinite("room", event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span id="room-indefinite-label">{t("indefinite")}</span>
                </label>
              </div>
            </div>
          </div>
          <div className="hero-actions">
            <button className="primary-button" disabled={creating} onClick={handleCreate}>
              {creating ? t("creatingRoom") : t("createRoom")}
            </button>
            <p className="helper-text">{t("securityWarning")}</p>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
        </div>
      </section>
      <footer className="landing-footer">
        <a
          aria-label={t("viewSource")}
          className="footer-source"
          href={SOURCE_URL}
          rel="noreferrer"
          target="_blank"
          title={t("viewSource")}
        >
          <GithubMark size={20} />
        </a>
      </footer>
    </main>
  );
}

function RoomPage({ roomId }: { roomId: string }) {
  const roomSecret = window.location.hash.replace(/^#/, "");
  const inviteToken = new URLSearchParams(window.location.search).get("invite") ?? "";
  const storedCreatorToken = safeStorageGet("local", creatorTokenKey(roomId)) ?? "";
  const isInviteGuest = Boolean(inviteToken && !storedCreatorToken);
  const [room, setRoom] = useState<RoomMetadata | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  const [manualInvite, setManualInvite] = useState<{ token: string; trigger: HTMLButtonElement; focusOwner: Element | null } | null>(null);
  const inviteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inviteActionRef = useRef(0);
  const currentInvitesRef = useRef(invites);
  currentInvitesRef.current = invites;
  const [draft, setDraft] = useState("");
  const draftRevisionRef = useRef(0);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState(t("connecting"));
  const [canRetryConnection, setCanRetryConnection] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const retryConnectionRef = useRef<(() => void) | null>(null);
  const retryFocusTargetRef = useRef<HTMLElement | null>(null);
  const preserveRetryFocusRef = useRef(false);
  const setRetryFocusTarget = useCallback((element: HTMLElement | null) => {
    if (!element) {
      // Follow a replacement view only while the manually focused status owns focus.
      preserveRetryFocusRef.current = preserveRetryFocusRef.current &&
        document.activeElement === retryFocusTargetRef.current;
    }
    retryFocusTargetRef.current = element;
    if (element && preserveRetryFocusRef.current) element.focus();
  }, []);
  const [keyReady, setKeyReady] = useState(false);
  const [presence, setPresence] = useState<PresenceSnapshot>({ count: 0, connectedSessionIds: [] });
  const [now, setNow] = useState(Date.now());
  const conversationFind = useConversationFind(messages, now, (id) => {
    const log = chatLogRef.current;
    const article = log?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!log || !article) return;
    log.scrollTop += article.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
    handleConversationScroll();
  });
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const concealment = useConversationConcealment(() => conversationFind.close());
  const [notFound, setNotFound] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<ActionFeedback>("idle");
  const [destroyFeedback, setDestroyFeedback] = useState<ActionFeedback>("idle");
  const [inviteFeedback, setInviteFeedback] = useState<InviteFeedback>("idle");
  const [destroying, setDestroying] = useState(false);
  const [inviteAccess, setInviteAccess] = useState<InviteAccess>(isInviteGuest ? "checking" : "granted");
  const [removedFromRoom, setRemovedFromRoom] = useState(false);
  const [inviteDuration, setInviteDuration] = useState<InviteDurationDraft>({
    amount: "10",
    unit: "minutes"
  });
  const [sessionId] = useState(() => {
    const stored = safeStorageGet("session", sessionKey(roomId));
    if (stored) {
      return stored;
    }
    const next = generateSessionId();
    safeStorageSet("session", sessionKey(roomId), next);
    return next;
  });
  const creatorToken = storedCreatorToken;
  const socketRef = useRef<WebSocket | null>(null);
  const roomKeyRef = useRef<CryptoKey | null>(null);
  const roomKeysRef = useRef(new Map<number, CryptoKey>());
  const keyEpochRef = useRef(1);
  const keyReadyRef = useRef(false);
  const membershipVersionRef = useRef(0);
  const keyWorkGenerationRef = useRef(0);
  const identityKeyRef = useRef<string>("");
  const identityPrivateKeyRef = useRef<CryptoKey | null>(null);
  const agreementPrivateKeyRef = useRef<CryptoKey | null>(null);
  const agreementPublicKeyRef = useRef<string>("");
  const peerIdentityKeysRef = useRef(new Map<string, string>());
  const peersRef = useRef(new Map<string, PeerDescriptor>());
  const joinedRef = useRef(false);
  // Mirror of the latest room status so the socket close handler (captured once
  // by the connection effect) can distinguish a live-room drop from an
  // already-closed room without reading a stale `room` value.
  const roomStatusRef = useRef<RoomMetadata["status"] | null>(null);
  const { chatLogRef, awayFromLatest, newMessageCount, jumpToLatest, handleConversationScroll } =
    useConversationScroll(messages, ready, conversationFind.open || concealment.hidden);
  const messageRef = useRef(new Map<string, AuthenticatedPeerEvent>());
  const replayGuardRef = useRef<ReplayGuard | null>(null);
  const eventReplayGuardRef = useRef<ReplayGuard | null>(null);
  if (!replayGuardRef.current) {
    replayGuardRef.current = new ReplayGuard(
      10000,
      window.sessionStorage,
      replayStateKey(roomId, sessionId, "message")
    );
  }
  if (!eventReplayGuardRef.current) {
    eventReplayGuardRef.current = new ReplayGuard(
      10000,
      window.sessionStorage,
      replayStateKey(roomId, sessionId, "event")
    );
  }
  const measuredInviteHandoffsRef = useRef(new Set<string>());
  const shouldRequestSyncRef = useRef(false);
  // Files being served by this client (we are the sender), kept in memory so we
  // can stream chunks on demand when a peer requests them.
  const outgoingFilesRef = useRef(new Map<string, File>());
  const outgoingFileHashesRef = useRef(new Map<string, string>());
  const outgoingFileEpochsRef = useRef(new Map<string, number>());
  // Files being received by this client, accumulating decrypted chunks.
  const incomingFilesRef = useRef(new Map<string, IncomingFile>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Object URLs created for received files, revoked on expiry/unmount.
  const objectUrlsRef = useRef(new Set<string>());

  async function sendPeerData(payload: PeerDataEvent, toSessionId?: string, isCurrent?: () => boolean) {
    const socket = socketRef.current;
    const privateKey = identityPrivateKeyRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !joinedRef.current || !privateKey || (isCurrent && !isCurrent())) return null;
    const data = await createAuthenticatedPeerEvent(
      privateKey,
      roomId,
      sessionId,
      toSessionId ?? null,
      payload
    );
    // Signing yields to the browser; the connection may close before it finishes.
    if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || !joinedRef.current || (isCurrent && !isCurrent())) return null;
    socket.send(JSON.stringify({ type: "peer_data", toSessionId, data }));
    eventReplayGuardRef.current?.markLocal(data.eventId);
    return data;
  }

  function currentKeyLeader(): PeerDescriptor | undefined {
    return [...peersRef.current.values()].sort((left, right) =>
      Number(right.creator) - Number(left.creator) ||
      left.connectedAt - right.connectedAt ||
      left.sessionId.localeCompare(right.sessionId)
    )[0];
  }

  // Crypto can finish after a disconnect, a new membership, or effect cleanup.
  function captureKeyWork(keyEpoch: number, leader: PeerDescriptor): () => boolean {
    const socket = socketRef.current;
    const generation = keyWorkGenerationRef.current;
    return () => {
      const currentLeader = currentKeyLeader();
      return generation === keyWorkGenerationRef.current &&
        socket !== null && socketRef.current === socket && socket.readyState === WebSocket.OPEN &&
        joinedRef.current && roomStatusRef.current === "open" &&
        membershipVersionRef.current === keyEpoch &&
        currentLeader?.sessionId === leader.sessionId &&
        currentLeader.identityKey === leader.identityKey &&
        currentLeader.agreementKey === leader.agreementKey;
    };
  }

  async function rotateRoomKey(keyEpoch: number) {
    const leader = currentKeyLeader();
    const agreementPrivateKey = agreementPrivateKeyRef.current;
    if (!leader || leader.sessionId !== sessionId || !agreementPrivateKey) return;
    const isCurrent = captureKeyWork(keyEpoch, leader);
    if (!isCurrent()) return;
    const roomSecretForEpoch = generateRoomSecret();
    const nextKey = await deriveRoomKey(roomSecretForEpoch);
    if (!isCurrent()) return;
    roomKeysRef.current.set(keyEpoch, nextKey);
    roomKeyRef.current = nextKey;
    keyEpochRef.current = keyEpoch;
    keyReadyRef.current = true;
    setKeyReady(true);
    setConnection(t("connected"));
    await Promise.all([...peersRef.current.values()]
      .filter((peer) => peer.sessionId !== sessionId)
      .map(async (peer) => {
        const wrapped = await wrapRoomSecret(
          agreementPrivateKey,
          peer.agreementKey,
          roomId,
          keyEpoch,
          sessionId,
          peer.sessionId,
          roomSecretForEpoch
        );
        if (!isCurrent()) return;
        await sendPeerData({
          type: "key_rotation",
          keyEpoch,
          senderAgreementKey: agreementPublicKeyRef.current,
          ...wrapped
        }, peer.sessionId, isCurrent);
      }));
  }

  function beginMembershipChange(keyEpoch: number) {
    if (keyEpoch <= membershipVersionRef.current) return;
    membershipVersionRef.current = keyEpoch;
    keyReadyRef.current = false;
    setKeyReady(false);
    setConnection(t("securing"));
    void rotateRoomKey(keyEpoch);
  }

  function clearRoomSecurityState() {
    conversationFind.close();
    for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
    replayGuardRef.current?.clear();
    eventReplayGuardRef.current?.clear();
    roomKeysRef.current.clear();
    keyReadyRef.current = false;
    setKeyReady(false);
    safeStorageRemove("session", identityKeyPairKey(roomId, sessionId));
    safeStorageRemove("session", sessionKey(roomId));
  }

  async function refreshInvites() {
    if (!creatorToken) {
      return;
    }
    try {
      const nextInvites = await listInvites(roomId, creatorToken);
      currentInvitesRef.current = nextInvites;
      setInvites(nextInvites);
    } catch {
      // Keep the last known invite state if the refresh fails.
    }
  }

  function updateFileMessage(fileId: string, patch: Partial<UiFile>) {
    startTransition(() => {
      setMessages((current) =>
        current.map((message) =>
          message.kind === "file" && message.file?.fileId === fileId
            ? { ...message, file: { ...message.file, ...patch } }
            : message
        )
      );
    });
  }

  function removeIncomingFile(fileId: string, entry = incomingFilesRef.current.get(fileId)) {
    if (!entry) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    if (incomingFilesRef.current.get(fileId) === entry) incomingFilesRef.current.delete(fileId);
  }

  function armFileTimeout(fileId: string, entry: IncomingFile) {
    if (!entry.requested || incomingFilesRef.current.get(fileId) !== entry) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    const timeoutId = window.setTimeout(() => {
      // A cleared/queued callback must not remove a replacement or refreshed transfer.
      if (incomingFilesRef.current.get(fileId) !== entry || entry.timeoutId !== timeoutId) return;
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      void sendPeerData({ type: "file_cancel", fileId, reason: "timeout" }, entry.senderSessionId);
    }, 30_000);
    entry.timeoutId = timeoutId;
  }

  async function waitForSocketDrain() {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    const maxBuffer = 4 * 1024 * 1024;
    while (socket.bufferedAmount > maxBuffer && socket.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }

  // Sender side: stream an outgoing file to the requesting peer as encrypted chunks.
  async function serveFile(fileId: string, requesterSessionId: string) {
    const file = outgoingFilesRef.current.get(fileId);
    const keyEpoch = outgoingFileEpochsRef.current.get(fileId);
    const key = typeof keyEpoch === "number" ? roomKeysRef.current.get(keyEpoch) : undefined;
    if (!file || !key) {
      return;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    const totalChunks = Math.max(1, Math.ceil(buffer.byteLength / FILE_CHUNK_BYTES));
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * FILE_CHUNK_BYTES;
      const slice = buffer.subarray(start, Math.min(start + FILE_CHUNK_BYTES, buffer.byteLength));
      const { ciphertext, nonce } = await encryptBytes(key, slice);
      await waitForSocketDrain();
      const delivered = await sendPeerData(
        { type: "file_chunk", fileId, chunkIndex: index, totalChunks, ciphertext, nonce, keyEpoch: keyEpoch! },
        requesterSessionId
      );
      if (!delivered) {
        return;
      }
    }
    const sha256 = outgoingFileHashesRef.current.get(fileId);
    if (sha256) await sendPeerData({ type: "file_complete", fileId, sha256 }, requesterSessionId);
  }

  // Receiver side: decrypt and store an incoming chunk, updating transfer progress.
  async function receiveChunk(payload: PeerFileChunk) {
    const key = roomKeysRef.current.get(payload.keyEpoch);
    if (!key) {
      return;
    }
    const entry = incomingFilesRef.current.get(payload.fileId);
    if (!entry?.requested) return;
    if (entry.keyEpoch !== payload.keyEpoch) return;
    if (entry.chunks.length !== payload.totalChunks) {
      entry.chunks = new Array<Uint8Array | undefined>(payload.totalChunks);
      entry.received = 0;
      entry.receivedBytes = 0;
      entry.totalChunks = payload.totalChunks;
    }
    if (!entry.chunks[payload.chunkIndex]) {
      try {
        const chunk = await decryptBytes(key, payload.ciphertext, payload.nonce);
        if (incomingFilesRef.current.get(payload.fileId) !== entry) return;
        if (entry.receivedBytes + chunk.byteLength > entry.size || chunk.byteLength > FILE_CHUNK_BYTES) {
          throw new Error("File chunk exceeds declared bounds.");
        }
        entry.chunks[payload.chunkIndex] = chunk;
        entry.received += 1;
        entry.receivedBytes += chunk.byteLength;
      } catch {
        if (incomingFilesRef.current.get(payload.fileId) !== entry) return;
        removeIncomingFile(payload.fileId, entry);
        updateFileMessage(payload.fileId, { state: "error" });
        return;
      }
    }
    updateFileMessage(payload.fileId, {
      state: "transferring",
      progress: entry.totalChunks ? entry.received / entry.totalChunks : 0
    });
    armFileTimeout(payload.fileId, entry);
  }

  // Receiver side: reassemble a completed file into a downloadable blob URL.
  async function finalizeIncoming(fileId: string, announcedSha256: string) {
    const entry = incomingFilesRef.current.get(fileId);
    if (!entry?.requested) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    if (entry.totalChunks === 0 || entry.received < entry.totalChunks) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      return;
    }
    const parts = entry.chunks.filter((chunk): chunk is Uint8Array => Boolean(chunk));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const digest = await sha256Base64Url(bytes);
    if (incomingFilesRef.current.get(fileId) !== entry) return;
    if (bytes.byteLength !== entry.size || digest !== entry.sha256 || digest !== announcedSha256) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      await sendPeerData({ type: "file_cancel", fileId, reason: "integrity" }, entry.senderSessionId);
      return;
    }
    const blob = new Blob(parts as BlobPart[], { type: entry.mimeType });
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    removeIncomingFile(fileId, entry);
    updateFileMessage(fileId, { state: "ready", progress: 1, url });
  }

  async function handleAttachFiles(fileList: FileList | null) {
    if (!fileList || !room || room.status !== "open" || !keyReadyRef.current) {
      return;
    }
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(t("fileTooLarge", { name: file.name, limit: formatBytes(MAX_FILE_BYTES) }));
        continue;
      }
      const fileId = generateMessageId();
      const sentAt = Date.now();
      const mimeType = file.type || "application/octet-stream";
      const expiresAfterReadSeconds = room.disappearAfterReadSeconds ?? null;
      const expiresAt =
        typeof expiresAfterReadSeconds === "number"
          ? sentAt + expiresAfterReadSeconds * 1000
          : undefined;
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = await sha256Base64Url(fileBytes);
      outgoingFilesRef.current.set(fileId, file);
      outgoingFileHashesRef.current.set(fileId, sha256);
      outgoingFileEpochsRef.current.set(fileId, keyEpochRef.current);
      setError(null);
      jumpToLatest();
      startTransition(() => {
        setMessages((current) =>
          upsertMessage(current, {
            id: fileId,
            senderSessionId: sessionId,
            sentAt,
            expiresAt,
            kind: "file",
            file: {
              fileId,
              name: file.name,
              mimeType,
              size: file.size,
              state: "sent",
              progress: 1,
              outgoing: true
            }
          })
        );
      });
      const delivered = await sendPeerData({
        type: "file_offer",
        fileId,
        senderSessionId: sessionId,
        name: file.name,
        mimeType,
        size: file.size,
        sentAt,
        expiresAfterReadSeconds,
        sha256,
        keyEpoch: keyEpochRef.current
      });
      if (!delivered) {
        setError(t("fileDeliveryPending"));
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleRequestFile(fileId: string, senderSessionId: string) {
    const entry = incomingFilesRef.current.get(fileId);
    if (!entry || entry.senderSessionId !== senderSessionId || entry.requested) return;
    entry.requested = true;
    armFileTimeout(fileId, entry);
    updateFileMessage(fileId, { state: "transferring", progress: 0 });
    const requested = await sendPeerData({ type: "file_request", fileId }, senderSessionId);
    if (!requested && incomingFilesRef.current.get(fileId) === entry) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      setError(t("fileRequestFailed"));
    }
  }

  useEffect(() => {
    if (!roomSecret) {
      setError(t("missingSecret"));
      return;
    }

    let active = true;
    let reconnectAllowed = true;
    const connectionAllowed = () => active && reconnectAllowed &&
      (roomStatusRef.current === null || roomStatusRef.current === "open");
    const reconnect = new ReconnectScheduler(
      connectionAllowed,
      () => { void bootstrap(); },
      (delay) => {
        setCanRetryConnection(false);
        setConnection(t("reconnecting", { seconds: Math.ceil(delay / 1000) }));
      }
    );
    function stopReconnecting() {
      for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
      keyWorkGenerationRef.current += 1;
      reconnectAllowed = false;
      reconnect.cancel();
      if (active) setCanRetryConnection(false);
    }
    retryConnectionRef.current = () => {
      if (!reconnect.canRetry) return;
      const focusTarget = retryFocusTargetRef.current;
      focusTarget?.focus({ preventScroll: true });
      preserveRetryFocusRef.current = Boolean(focusTarget && document.activeElement === focusTarget);
      setCanRetryConnection(false);
      setConnectionError(null);
      setConnection(t("connecting"));
      reconnect.retryNow();
    };
    const tick = window.setInterval(() => setNow(Date.now()), 1000);

    async function bootstrap() {
      try {
        const [metadata, key, identity] = await Promise.all([
          loadRoomMetadata(roomId),
          deriveRoomKey(roomSecret),
          loadIdentityKeyPair(roomId, sessionId)
        ]);
        if (!connectionAllowed()) {
          return;
        }
        roomKeyRef.current = key;
        roomKeysRef.current.set(0, key);
        identityPrivateKeyRef.current = identity.privateKey;
        identityKeyRef.current = identity.publicKey;
        agreementPrivateKeyRef.current = identity.agreementPrivateKey;
        agreementPublicKeyRef.current = identity.agreementPublicKey;
        peerIdentityKeysRef.current.set(sessionId, identity.publicKey);
        roomStatusRef.current = metadata.status;
        setRoom(metadata);
        if (metadata.status !== "open") {
          stopReconnecting();
          setReady(true);
          setConnection(t("closed"));
          setRoomNotice(roomStateMessage(metadata.status));
          return;
        }

        const socket = new WebSocket(wsUrl(`/api/rooms/${roomId}/ws`));
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          setConnection(t("connected"));
          joinedRef.current = false;
          socket.send(
            JSON.stringify({
              type: "join",
              sessionId,
              identityKey: identityKeyRef.current,
              agreementKey: agreementPublicKeyRef.current,
              creatorToken: creatorToken || undefined,
              inviteToken: inviteToken || undefined
            })
          );
        });

        socket.addEventListener("close", (closeEvent) => {
          if (!active || socketRef.current !== socket) return;
          keyWorkGenerationRef.current += 1;
          joinedRef.current = false;
          keyReadyRef.current = false;
          setKeyReady(false);
          if (isInviteGuest && closeEvent.code === 4403) {
            stopReconnecting();
            setInviteAccess((current) => {
              if (current === "claimed" || current === "used") {
                return current;
              }
              if (closeEvent.reason === "invite claimed") {
                return "claimed";
              }
              if (closeEvent.reason === "invite used") {
                return "used";
              }
              return "invalid";
            });
            setError(null);
            setRoom(null);
            setRoomNotice(null);
            setReady(true);
            return;
          }
          if (reconnect.schedule()) return;
          setCanRetryConnection(reconnect.canRetry);
          setConnection(roomStatusRef.current === "open" ? t("disconnected") : t("closed"));
        });

        socket.addEventListener("error", () => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          setConnection(t("connectionError"));
        });

        socket.addEventListener("message", async (event) => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          const payload = JSON.parse(String(event.data)) as ServerEvent;
          if (payload.type === "joined") {
            joinedRef.current = true;
            reconnect.reset();
            setCanRetryConnection(false);
            setConnectionError(null);
            startTransition(() => {
              setInviteAccess("granted");
              setRoom(payload.room);
              setPresence(payload.presence);
              setReady(true);
            });
            if (creatorToken) {
              void refreshInvites();
            }
            peersRef.current.clear();
            peersRef.current.set(sessionId, payload.self);
            for (const peer of payload.peers) {
              peersRef.current.set(peer.sessionId, peer);
              peerIdentityKeysRef.current.set(peer.sessionId, peer.identityKey);
            }
            beginMembershipChange(payload.room.membershipVersion);
            shouldRequestSyncRef.current = payload.peers.length > 0;
            if (payload.peers.length > 0 && keyReadyRef.current) {
              await sendPeerData({ type: "sync_request" });
            }
            return;
          }

          if (payload.type === "presence") {
            startTransition(() => setPresence(payload.presence));
            if (creatorToken) {
              void refreshInvites();
            }
            return;
          }

          if (payload.type === "peer_joined") {
            peerIdentityKeysRef.current.set(payload.peer.sessionId, payload.peer.identityKey);
            peersRef.current.set(payload.peer.sessionId, payload.peer);
            beginMembershipChange(payload.membershipVersion);
            startTransition(() =>
              setPresence((current) => ({
                count: current.connectedSessionIds.includes(payload.peer.sessionId)
                  ? current.count
                  : current.count + 1,
                connectedSessionIds: current.connectedSessionIds.includes(payload.peer.sessionId)
                  ? current.connectedSessionIds
                  : [...current.connectedSessionIds, payload.peer.sessionId]
              }))
            );
            if (creatorToken) {
              void refreshInvites();
            }
            if (messageRef.current.size > 0) {
              await sendPeerData({
                type: "sync_response",
                messages: [...messageRef.current.values()]
                  .sort((left, right) => left.sentAt - right.sentAt)
                  .slice(-MAX_TRANSCRIPT_SYNC_MESSAGES),
                completeness: "peer-partial",
                truncated: messageRef.current.size > MAX_TRANSCRIPT_SYNC_MESSAGES
              }, payload.peer.sessionId);
            }
            return;
          }

          if (payload.type === "peer_left") {
            peersRef.current.delete(payload.sessionId);
            beginMembershipChange(payload.membershipVersion);
            startTransition(() =>
              setPresence((current) => {
                const nextIds = current.connectedSessionIds.filter((id) => id !== payload.sessionId);
                return {
                  count: nextIds.length,
                  connectedSessionIds: nextIds
                };
              })
            );
            if (creatorToken) {
              void refreshInvites();
            }
            for (const [fileId, transfer] of incomingFilesRef.current) {
              if (transfer.senderSessionId === payload.sessionId) {
                removeIncomingFile(fileId, transfer);
                updateFileMessage(fileId, { state: "error" });
              }
            }
            return;
          }

          if (payload.type === "peer_data") {
            await handlePeerData(payload.fromSessionId, payload.data, socket);
            return;
          }

          if (payload.type === "room_state") {
            stopReconnecting();
            roomStatusRef.current = payload.status;
            startTransition(() => {
              setRoom((current) =>
                current
                  ? {
                      ...current,
                      status: payload.status
                    }
                  : current
              );
              setRoomNotice(roomStateMessage(payload.status, payload.reason));
              setDestroying(false);
              setDestroyFeedback(payload.status === "destroyed" ? "success" : "idle");
              setConnection(t("closed"));
            });
            clearRoomSecurityState();
            await sendPeerData({ type: "peer_destroy" });
            return;
          }

          if (payload.type === "participant_kicked") {
            if (payload.sessionId === sessionId) {
              stopReconnecting();
              setRemovedFromRoom(true);
              setRoomNotice(null);
              setError(null);
              setConnection(t("closed"));
              joinedRef.current = false;
              clearRoomSecurityState();
              socket.close();
            }
            if (creatorToken) {
              void refreshInvites();
            }
            return;
          }

          if (payload.type === "error") {
            if (
              payload.code === "invite_required" ||
              payload.code === "invite_claimed" ||
              payload.code === "invite_used"
            ) {
              stopReconnecting();
              setInviteAccess(
                payload.code === "invite_claimed"
                  ? "claimed"
                  : payload.code === "invite_used"
                    ? "used"
                    : "invalid"
              );
              setError(null);
              setRoom(null);
              setRoomNotice(null);
              setReady(true);
              socket.close(4403, "invalid-invite");
              return;
            }
            if (payload.code === "peer_missing") {
              return;
            }
            setError(payload.message);
          }
        });
      } catch (cause) {
        if (!connectionAllowed()) return;
        if (cause instanceof RoomMetadataError && cause.kind === "missing") {
          stopReconnecting();
          setNotFound(true);
          setReady(true);
          return;
        }
        if (cause instanceof RoomMetadataError && cause.kind === "temporary") {
          if (reconnect.schedule()) return;
          setCanRetryConnection(reconnect.canRetry);
          setConnection(t("disconnected"));
          setConnectionError(t("failedJoinRoom"));
          return;
        }
        setCanRetryConnection(false);
        setConnection(t("disconnected"));
        setError(cause instanceof RoomMetadataError ? t("failedJoinRoom") :
          cause instanceof Error ? cause.message : t("failedJoinRoom"));
      }
    }

    async function verifyPeerEvent(
      event: AuthenticatedPeerEvent,
      relaySenderId?: string
    ): Promise<boolean> {
      if (
        event.roomId !== roomId ||
        (relaySenderId && event.senderSessionId !== relaySenderId) ||
        (event.targetSessionId !== null && event.targetSessionId !== sessionId) ||
        event.sentAt > Date.now() + 5 * 60 * 1000
      ) return false;
      const encodedKey = peerIdentityKeysRef.current.get(event.senderSessionId);
      if (!encodedKey) return false;
      try {
        return await eventReplayGuardRef.current!.accept(event.eventId, null, async () => {
          const key = await importIdentityPublicKey(encodedKey);
          if (!(await verifyAuthenticatedPeerEvent(key, event))) {
            throw new Error("Peer signature verification failed.");
          }
        });
      } catch {
        return false;
      }
    }

    async function addEnvelope(event: AuthenticatedPeerEvent) {
      if (event.payload.type !== "chat_message") return;
      const envelope = event.payload.envelope;
      const messageKey = roomKeysRef.current.get(envelope.keyEpoch);
      if (!messageKey) return;

      try {
        const received = await receiveTextMessage(
          messageKey, roomId, envelope, replayGuardRef.current!, event.senderSessionId
        );
        if (!received) return;
        const { plaintext, expiresAt } = received;
        messageRef.current.set(envelope.messageId, event);

        startTransition(() => {
          setMessages((current) =>
            upsertMessage(current, {
              id: envelope.messageId,
              senderSessionId: envelope.senderSessionId,
              plaintext,
              sentAt: envelope.sentAt,
              expiresAt,
              kind: "text"
            })
          );
        });
      } catch (cause) {
        setError(
          cause instanceof InvalidMessageEnvelopeError
            ? t("alteredMessage")
            : cause instanceof Error && cause.message === "Message replay limit reached."
            ? t("replayLimit")
            : t("authFailed")
        );
      }
    }

    async function handlePeerData(peerId: string, event: AuthenticatedPeerEvent, sourceSocket: WebSocket) {
      const verified = await verifyPeerEvent(event, peerId);
      if (!connectionAllowed() || socketRef.current !== sourceSocket || !joinedRef.current) return;
      if (!verified) {
        setError(t("authFailed"));
        return;
      }
      const payload = event.payload;
      if (payload.type === "key_rotation") {
        const leader = currentKeyLeader();
        const agreementPrivateKey = agreementPrivateKeyRef.current;
        if (
          !leader ||
          event.senderSessionId !== leader.sessionId ||
          payload.senderAgreementKey !== leader.agreementKey ||
          payload.keyEpoch !== membershipVersionRef.current ||
          payload.keyEpoch <= keyEpochRef.current ||
          !agreementPrivateKey
        ) return;
        const isCurrent = captureKeyWork(payload.keyEpoch, leader);
        if (!isCurrent()) return;
        try {
          const nextSecret = await unwrapRoomSecret(
            agreementPrivateKey,
            payload.senderAgreementKey,
            roomId,
            payload.keyEpoch,
            event.senderSessionId,
            sessionId,
            payload.ciphertext,
            payload.nonce
          );
          if (!isCurrent()) return;
          const nextKey = await deriveRoomKey(nextSecret);
          if (!isCurrent() || payload.keyEpoch <= keyEpochRef.current) return;
          roomKeysRef.current.set(payload.keyEpoch, nextKey);
          roomKeyRef.current = nextKey;
          keyEpochRef.current = payload.keyEpoch;
          keyReadyRef.current = true;
          setKeyReady(true);
          setConnection(t("connected"));
          if (shouldRequestSyncRef.current) await sendPeerData({ type: "sync_request" });
        } catch {
          if (isCurrent()) setError(t("authFailed"));
        }
        return;
      }
      if (payload.type === "chat_message") {
        await addEnvelope(event);
        return;
      }

      if (payload.type === "sync_request") {
        const transcript = [...messageRef.current.values()]
          .sort((left, right) => left.sentAt - right.sentAt)
          .slice(-MAX_TRANSCRIPT_SYNC_MESSAGES);
        await sendPeerData({
          type: "sync_response",
          messages: transcript,
          completeness: "peer-partial",
          truncated: messageRef.current.size > MAX_TRANSCRIPT_SYNC_MESSAGES
        }, peerId);
        return;
      }

      if (payload.type === "sync_response") {
        if (
          payload.completeness !== "peer-partial" ||
          payload.messages.length > MAX_TRANSCRIPT_SYNC_MESSAGES
        ) return;
        shouldRequestSyncRef.current = false;
        setRoomNotice(
          payload.messages.length === 0
            ? t("syncEmpty")
            : payload.truncated
              ? t("syncTruncated")
              : t("syncPartial")
        );
        for (const syncedEvent of payload.messages.slice(-MAX_TRANSCRIPT_SYNC_MESSAGES)) {
          if (await verifyPeerEvent(syncedEvent)) await addEnvelope(syncedEvent);
        }
        return;
      }

      if (payload.type === "file_offer") {
        if (
          payload.senderSessionId !== event.senderSessionId ||
          payload.size < 0 ||
          payload.size > MAX_FILE_BYTES ||
          !/^[A-Za-z0-9_-]{43}$/.test(payload.sha256)
        ) {
          setError(t("authFailed"));
          return;
        }
        const expiresAt =
          typeof payload.expiresAfterReadSeconds === "number"
            ? payload.sentAt + payload.expiresAfterReadSeconds * 1000
            : undefined;
        if (typeof expiresAt === "number" && expiresAt <= Date.now()) {
          return;
        }
        removeIncomingFile(payload.fileId);
        incomingFilesRef.current.set(payload.fileId, {
          requested: false,
          name: payload.name,
          mimeType: payload.mimeType || "application/octet-stream",
          size: payload.size,
          totalChunks: 0,
          received: 0,
          receivedBytes: 0,
          chunks: [],
          senderSessionId: payload.senderSessionId,
          sha256: payload.sha256,
          keyEpoch: payload.keyEpoch
        });
        startTransition(() => {
          setMessages((current) =>
            upsertMessage(current, {
              id: payload.fileId,
              senderSessionId: payload.senderSessionId,
              sentAt: payload.sentAt,
              expiresAt,
              kind: "file",
              file: {
                fileId: payload.fileId,
                name: payload.name,
                mimeType: payload.mimeType || "application/octet-stream",
                size: payload.size,
                state: "offered",
                progress: 0,
                outgoing: false
              }
            })
          );
        });
        return;
      }

      if (payload.type === "file_request") {
        void serveFile(payload.fileId, peerId);
        return;
      }

      if (payload.type === "file_chunk") {
        const incoming = incomingFilesRef.current.get(payload.fileId);
        if (
          !incoming ||
          incoming.senderSessionId !== event.senderSessionId ||
          !Number.isSafeInteger(payload.chunkIndex) ||
          !Number.isSafeInteger(payload.totalChunks) ||
          payload.chunkIndex < 0 ||
          payload.totalChunks < 1 ||
          payload.chunkIndex >= payload.totalChunks ||
          payload.totalChunks > Math.ceil(MAX_FILE_BYTES / FILE_CHUNK_BYTES) ||
          payload.totalChunks !== Math.max(1, Math.ceil(incoming.size / FILE_CHUNK_BYTES)) ||
          payload.keyEpoch !== incoming.keyEpoch
        ) {
          return;
        }
        await receiveChunk(payload);
        return;
      }

      if (payload.type === "file_complete") {
        const incoming = incomingFilesRef.current.get(payload.fileId);
        if (!incoming || incoming.senderSessionId !== event.senderSessionId) return;
        await finalizeIncoming(payload.fileId, payload.sha256);
        return;
      }

      if (payload.type === "file_cancel") {
        removeIncomingFile(payload.fileId);
        updateFileMessage(payload.fileId, { state: "error" });
        return;
      }

      if (payload.type === "peer_destroy") {
        stopReconnecting();
        setRoomNotice(t("peerDestroyed"));
        setConnection(t("closed"));
        clearRoomSecurityState();
      }
    }

    void bootstrap();

    return () => {
      active = false;
      stopReconnecting();
      retryConnectionRef.current = null;
      window.clearInterval(tick);
      socketRef.current?.close();
      for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
    };
  }, [creatorToken, inviteToken, roomId, roomSecret, sessionId]);

  useEffect(() => {
    if (copyFeedback !== "success") {
      return;
    }
    const timeout = window.setTimeout(() => setCopyFeedback("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  useEffect(() => {
    if (inviteFeedback === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setInviteFeedback("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [inviteFeedback]);

  useEffect(() => {
    if (destroyFeedback !== "success") {
      return;
    }
    const timeout = window.setTimeout(() => setDestroyFeedback("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [destroyFeedback]);

  useEffect(() => {
    if (!ready || room?.status !== "open") {
      return;
    }
    const interval = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && joinedRef.current) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 15000);
    return () => window.clearInterval(interval);
  }, [ready, room?.status]);

  useEffect(() => {
    startTransition(() => {
      setMessages((current) =>
        current.filter((message) => {
          const keep = !message.expiresAt || message.expiresAt > now;
          if (!keep && message.kind === "file") {
            if (message.file?.url) {
              URL.revokeObjectURL(message.file.url);
              objectUrlsRef.current.delete(message.file.url);
            }
            outgoingFilesRef.current.delete(message.id);
            outgoingFileHashesRef.current.delete(message.id);
            removeIncomingFile(message.id);
          }
          return keep;
        })
      );
    });
    for (const [messageId, envelope] of messageRef.current.entries()) {
      const message = envelope.payload.type === "chat_message" ? envelope.payload.envelope : null;
      const expiresAt =
        typeof message?.expiresAfterReadSeconds === "number"
          ? message.sentAt + message.expiresAfterReadSeconds * 1000
          : undefined;
      if (typeof expiresAt === "number" && expiresAt <= now) {
        messageRef.current.delete(messageId);
      }
    }
  }, [now]);

  useEffect(() => {
    void refreshInvites();
  }, [creatorToken, roomId]);

  useEffect(() => {
    roomStatusRef.current = room?.status ?? null;
  }, [room?.status]);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  async function handleSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendingRef.current) return;
    const trimmed = draft.trim();
    const key = roomKeyRef.current;
    const leader = currentKeyLeader();
    if (!trimmed || !key || !leader || !room || room.status !== "open") return;
    if (!keyReadyRef.current) {
      setError(t("securing"));
      return;
    }
    const keyEpoch = keyEpochRef.current;
    const keyWorkIsCurrent = captureKeyWork(keyEpoch, leader);
    const isCurrent = () => keyWorkIsCurrent() && roomKeyRef.current === key;
    if (!isCurrent()) return;
    const draftRevision = draftRevisionRef.current;
    // A ref blocks same-tick Enter/click submissions before React renders.
    sendingRef.current = true;
    setSending(true);
    try {
      const sentAt = Date.now();
      const expiresAt = typeof room.disappearAfterReadSeconds === "number"
        ? sentAt + room.disappearAfterReadSeconds * 1000 : undefined;
      const envelope: EncryptedMessageEnvelope = {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        messageId: generateMessageId(),
        senderSessionId: sessionId,
        ciphertext: "",
        nonce: "",
        sentAt,
        expiresAfterReadSeconds: room.disappearAfterReadSeconds ?? null,
        keyEpoch
      };
      const encrypted = await encryptMessage(key, roomId, envelope, trimmed);
      if (!isCurrent()) return;
      envelope.ciphertext = encrypted.ciphertext;
      envelope.nonce = encrypted.nonce;
      try {
        replayGuardRef.current!.markLocal(envelope.messageId, expiresAt ?? null);
      } catch {
        setError(t("replayLimit"));
        return;
      }
      const sentEvent = await sendPeerData({ type: "chat_message", envelope }, undefined, isCurrent);
      if (!sentEvent) {
        if (isCurrent()) setError(t("messageSendFailed"));
        return;
      }
      messageRef.current.set(envelope.messageId, sentEvent);
      // Keep edits made while encryption/signing was pending, even if the user
      // edited back to the same text. Failed attempts also retain the draft.
      if (draftRevisionRef.current === draftRevision) setDraft("");
      jumpToLatest();
      setError(null);
      startTransition(() => {
        setMessages((current) => upsertMessage(current, {
          id: envelope.messageId,
          senderSessionId: sessionId,
          plaintext: trimmed,
          sentAt,
          expiresAt,
          kind: "text"
        }));
      });
    } catch {
      if (isCurrent()) setError(t("messageSendFailed"));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function handleCopyLink() {
    if (await copyText(window.location.href)) {
      setCopyFeedback("success");
      setError(null);
      return;
    }
    setError(t("clipboardLinkFailed"));
  }

  function recordInviteHandoff(token: string) {
    if (measuredInviteHandoffsRef.current.has(token)) {
      return;
    }
    measuredInviteHandoffsRef.current.add(token);
    recordGrowthEvent("invite_share_handoff");
  }

  function inviteActionIsCurrent(action: number, token: string) {
    return action === inviteActionRef.current && roomStatusRef.current === "open" &&
      canShareInvite(currentInvitesRef.current.find((invite) => invite.token === token), Date.now());
  }

  async function handleShareInvite(event: React.MouseEvent<HTMLButtonElement>) {
    const trigger = event.currentTarget;
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (!creatorToken) {
      return;
    }
    try {
      const inviteTtlMs = parseInviteDurationDraft(inviteDuration);
      const invite = await createInvite(roomId, creatorToken, inviteTtlMs);
      if (action !== inviteActionRef.current || roomStatusRef.current !== "open") return;
      currentInvitesRef.current = [invite, ...currentInvitesRef.current];
      setInvites(currentInvitesRef.current);
      if (!inviteActionIsCurrent(action, invite.token)) return;
      const inviteUrl = buildInviteUrl(roomId, invite.token, roomSecret);
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({
            title: "Babili invite",
            text: t("inviteShareText"),
            url: inviteUrl
          });
          recordInviteHandoff(invite.token);
          if (!inviteActionIsCurrent(action, invite.token)) return;
          setInviteFeedback("shared");
          setRoomNotice(t("sharedInviteNotice"));
          setError(null);
          return;
        } catch (cause) {
          if (!inviteActionIsCurrent(action, invite.token)) return;
          if (cause instanceof DOMException && cause.name === "AbortError") {
            setInviteFeedback("idle");
            setRoomNotice(t("createdInviteNotice"));
            setError(null);
            return;
          }
        }
      }
      if (await copyText(inviteUrl)) {
        recordInviteHandoff(invite.token);
        if (!inviteActionIsCurrent(action, invite.token)) return;
        setInviteFeedback("copied");
        setRoomNotice(t("copiedInviteNotice"));
        setError(null);
        return;
      }
      if (!inviteActionIsCurrent(action, invite.token)) return;
      setManualInvite({ token: invite.token, trigger, focusOwner });
      setInviteFeedback("idle");
    } catch (cause) {
      if (action !== inviteActionRef.current || roomStatusRef.current !== "open") return;
      setError(cause instanceof Error ? cause.message : t("createInviteFailed"));
    }
  }

  async function handleCopyInvite(token: string, trigger: HTMLButtonElement) {
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (await copyText(buildInviteUrl(roomId, token, roomSecret))) {
      recordInviteHandoff(token);
      if (!inviteActionIsCurrent(action, token)) return;
      setInviteFeedback("copied");
      setRoomNotice(t("copiedInviteNotice"));
      setError(null);
      return;
    }
    if (!inviteActionIsCurrent(action, token)) return;
    setManualInvite({ token, trigger, focusOwner });
  }

  async function handleNativeShareInvite(token: string, trigger: HTMLButtonElement) {
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (typeof navigator.share !== "function") {
      return;
    }
    try {
      await navigator.share({
        title: "Babili invite",
        text: t("inviteShareText"),
        url: buildInviteUrl(roomId, token, roomSecret)
      });
      recordInviteHandoff(token);
      if (!inviteActionIsCurrent(action, token)) return;
      setInviteFeedback("shared");
      setRoomNotice(t("sharedInviteNotice"));
      setError(null);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        if (!inviteActionIsCurrent(action, token)) return;
        setManualInvite({ token, trigger, focusOwner });
      }
    }
  }

  async function handleRevokeInvite(token: string) {
    // Removing an invite supersedes any copy/share still awaiting browser APIs.
    inviteActionRef.current += 1;
    if (!creatorToken) {
      return;
    }
    try {
      await revokeInvite(roomId, creatorToken, token);
      setInvites((current) =>
        current.map((invite) =>
          invite.token === token ? { ...invite, revokedAt: Date.now() } : invite
        )
      );
      setRoomNotice(t("removedInviteNotice"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("revokeInviteFailed"));
    }
  }

  function handleKickParticipant(targetSessionId: string) {
    if (!creatorToken || targetSessionId === sessionId) {
      return;
    }
    socketRef.current?.send(
      JSON.stringify({
        type: "kick_participant",
        creatorToken,
        targetSessionId
      })
    );
  }

  async function handleDestroy() {
    if (!creatorToken) {
      return;
    }
    try {
      setDestroying(true);
      setDestroyFeedback("idle");
      const next = await destroyRoom(roomId, creatorToken);
      await sendPeerData({ type: "peer_destroy" });
      setRoomNotice(null);
      setRoom(next);
    } catch (cause) {
      setDestroying(false);
      setError(cause instanceof Error ? cause.message : t("destroyRoomFailed"));
    }
  }

  const presentCount = presence.count;
  const sortedPresenceIds = [...presence.connectedSessionIds].sort((left, right) =>
    left === sessionId ? -1 : right === sessionId ? 1 : left.localeCompare(right)
  );
  const messagePolicyLabel =
    typeof room?.disappearAfterReadSeconds === "number"
      ? t("messagesVanish", { duration: formatStaticDuration(room.disappearAfterReadSeconds) })
      : t("messagesStay");
  const idleDeadline =
    typeof room?.inactivityTimeoutMs === "number"
      ? room.lastActivityAt + room.inactivityTimeoutMs
      : null;
  const roomDeadline =
    typeof room?.expiresAt === "number" && typeof idleDeadline === "number"
      ? Math.min(room.expiresAt, idleDeadline)
      : typeof room?.expiresAt === "number"
        ? room.expiresAt
        : idleDeadline;
  const roomPolicyLabel =
    typeof roomDeadline === "number"
      ? t("roomExpires", { duration: formatRelativeDuration(roomDeadline) })
      : t("roomStays");
  const isCreator = Boolean(creatorToken);
  const manualInviteRecord = invites.find((invite) => invite.token === manualInvite?.token);
  const showManualInvite = isCreator && room?.status === "open" &&
    canShareInvite(manualInviteRecord, Math.max(now, Date.now()));
  function dismissManualInvite() {
    inviteActionRef.current += 1;
    setManualInvite(null);
  }

  useEffect(() => {
    if (removedFromRoom || notFound || (room && room.status !== "open") ||
      ["invalid", "claimed", "used"].includes(inviteAccess)) {
      conversationFind.close();
      concealment.reset();
    }
  }, [removedFromRoom, notFound, room?.status, inviteAccess]);

  if (removedFromRoom) {
    return <RemovedFromRoomScreen focusRef={setRetryFocusTarget} />;
  }

  if (inviteAccess === "invalid" || inviteAccess === "claimed" || inviteAccess === "used") {
    return <InvalidInviteScreen reason={inviteAccess} focusRef={setRetryFocusTarget} />;
  }

  if (notFound) {
    return (
      <RoomGoneScreen
        fromInvite={isInviteGuest}
        reason={t("roomNotFound")}
        focusRef={setRetryFocusTarget}
      />
    );
  }

  if (ready && room && room.status !== "open") {
    return (
      <RoomGoneScreen
        fromInvite={isInviteGuest}
        reason={roomNotice ?? roomStateMessage(room.status)}
        focusRef={setRetryFocusTarget}
      />
    );
  }

  if (!concealment.hidden && isInviteGuest && (inviteAccess !== "granted" || !room || !ready)) {
    return <InviteCheckingScreen connection={connection} error={connectionError ?? error}
      focusRef={setRetryFocusTarget}
      onRetry={canRetryConnection ? () => retryConnectionRef.current?.() : undefined} />;
  }

  return (
    <>
    {concealment.screen}
    <main className="room-shell room-content" hidden={concealment.hidden} style={concealment.hidden ? { display: "none" } : undefined}>
      <header className="room-header">
        <div className="room-title">
          <p className="eyebrow">Babili</p>
          <h1>{roomId.slice(0, 8)}</h1>
          <p className="room-subtitle">
            {messagePolicyLabel} {roomPolicyLabel}
          </p>
        </div>
        <div className="room-toolbar">
          <div className="room-meta" aria-live="polite" ref={setRetryFocusTarget} tabIndex={-1}>
            <span>{connection}</span>
            <span>{t("present", { count: presentCount })}</span>
          </div>
          <div className="room-actions">
            {canRetryConnection ? (
              <button className="secondary-button" onClick={() => retryConnectionRef.current?.()} type="button">
                {t("retryConnection")}
              </button>
            ) : null}
            {isCreator ? (
              <button
                className={`secondary-button ${inviteFeedback !== "idle" ? "button-success" : ""}`}
                onClick={handleShareInvite}
                ref={inviteTriggerRef}
                type="button"
              >
                {inviteFeedback === "shared"
                  ? t("inviteShared")
                  : inviteFeedback === "copied"
                    ? t("inviteCopiedSend")
                    : typeof navigator.share === "function"
                      ? t("sendInvite")
                      : t("inviteOne")}
              </button>
            ) : (
              <button
                className={`secondary-button ${copyFeedback === "success" ? "button-success" : ""}`}
                onClick={handleCopyLink}
                type="button"
              >
                {copyFeedback === "success" ? t("copied") : t("copyMyLink")}
              </button>
            )}
            <button
              className={`secondary-button ${destroyFeedback === "success" ? "button-success" : ""}`}
              disabled={!creatorToken || destroying || room?.status !== "open"}
              onClick={handleDestroy}
              type="button"
            >
              {destroying ? t("destroying") : t("destroy")}
            </button>
            {concealment.control}
          </div>
          <span className="sr-only" role="status" aria-live="polite">
            {inviteFeedback === "shared"
              ? t("inviteSharedStatus")
              : inviteFeedback === "copied"
                ? t("inviteCopiedStatus")
                : copyFeedback === "success"
                  ? t("roomLinkCopiedStatus")
                  : ""}
          </span>
        </div>
      </header>

      <section className="room-strip">
        <div className="participant-strip" aria-label={t("participants")}>
          {sortedPresenceIds.length === 0 ? (
            <span className="participant-empty">{t("waiting")}</span>
          ) : (
            sortedPresenceIds.map((id) => (
              <span
                className={`participant-chip ${id === sessionId ? "participant-chip-self" : ""}`}
                key={id}
                style={{ "--participant-color": colorFromSessionId(id) } as CSSProperties}
              >
                <span className="participant-dot" />
                {id === sessionId ? t("you") : t("guest")}
                {isCreator && id !== sessionId ? (
                  <button
                    className="participant-kick"
                    onClick={() => handleKickParticipant(id)}
                    type="button"
                  >
                    {t("remove")}
                  </button>
                ) : null}
              </span>
            ))
          )}
        </div>
        <div className="banner-stats">
          <span>{room?.status ?? "loading"}</span>
        </div>
      </section>

      {isCreator ? (
        <section className="invite-settings" aria-label={t("inviteExpiration")}>
          <div>
            <span className="setting-label">{t("newInviteExpires")}</span>
            <p className="setting-note">
              {t("inviteNextOnly")}
            </p>
          </div>
          <div className="setting-controls">
            <input
              aria-label={t("inviteLifetimeAmount")}
              className="setting-input"
              inputMode="numeric"
              min="1"
              onChange={(event) =>
                setInviteDuration((current) => ({ ...current, amount: event.target.value }))
              }
              type="number"
              value={inviteDuration.amount}
            />
            <DurationUnitButtons
              label={t("inviteLifetimeUnit")}
              onChange={(unit) =>
                setInviteDuration((current) => ({ ...current, unit }))
              }
              value={inviteDuration.unit}
            />
          </div>
        </section>
      ) : null}

      {isInviteGuest ? <MakeYourOwnCallout compact /> : null}
      {roomNotice ? (
        <p className="room-notice" role="status" aria-live="polite">
          {roomNotice}
        </p>
      ) : null}
      {error ? <p className="error-text room-error" role="alert">{error}</p> : null}
      {connectionError ? <p className="error-text room-error" role="alert">{connectionError}</p> : null}
      {isCreator && invites.length > 0 ? (
        <section className="invite-panel">
          <span className="eyebrow">{t("invites")}</span>
          <p className="invite-guidance">
            {t("inviteGuidance")}
          </p>
          {showManualInvite && manualInvite ? (
            <ManualInviteLink key={manualInvite.token} url={buildInviteUrl(roomId, manualInvite.token, roomSecret)}
              trigger={manualInvite.trigger} focusOwner={manualInvite.focusOwner} fallbackTrigger={inviteTriggerRef.current} onDismiss={dismissManualInvite} />
          ) : null}
          {invites.slice(0, 4).map((invite) => (
            <div className="invite-row" key={invite.token} style={inviteAccentStyle(invite)}>
              <span>{inviteStatusLabel(invite)}</span>
              <div className="invite-actions">
                {canShareInvite(invite, now) ? (
                  <>
                    {typeof navigator.share === "function" ? (
                      <button
                        className="secondary-button invite-copy"
                        onClick={(event) => handleNativeShareInvite(invite.token, event.currentTarget)}
                        type="button"
                      >
                        {t("share")}
                      </button>
                    ) : null}
                    <button className="secondary-button invite-copy" onClick={(event) => handleCopyInvite(invite.token, event.currentTarget)} type="button">
                      {t("copyInvite")}
                    </button>
                  </>
                ) : null}
                {!invite.revokedAt ? (
                  <button className="secondary-button invite-revoke" onClick={() => handleRevokeInvite(invite.token)} type="button">
                    {t("remove")}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {conversationFind.controls}
      <section className="chat-stage">
        <section aria-label={t("conversationLog")} aria-live="polite" aria-relevant="additions" className="chat-log" ref={chatLogRef} role="log" tabIndex={0} onScroll={handleConversationScroll}>
        <div className="chat-thread">
          {!ready ? <p className="system-line">{t("deriving")}</p> : null}
          {messages.length === 0 && ready ? (
            <p className="system-line">{messagePolicyLabel}</p>
          ) : null}
          {messages.map((message) => {
            const mine = message.senderSessionId === sessionId;
            return (
              <article
                className={`bubble ${mine ? "bubble-mine" : "bubble-theirs"}${conversationFind.selectedId === message.id ? " bubble-find-selected" : ""}`}
                data-message-id={message.id}
                key={message.id}
                style={bubbleStyle(message.senderSessionId, mine)}
              >
                <span className="bubble-author">{mine ? t("you") : t("guest")}</span>
                {message.kind === "file" && message.file ? (
                  <FileCard
                    file={message.file}
                    onDownload={() =>
                      handleRequestFile(message.file!.fileId, message.senderSessionId)
                    }
                  />
                ) : (
                  <p>{message.plaintext}</p>
                )}
                <footer>
                  <span>{formatClock(message.sentAt)}</span>
                  <span>{messageStatus(message)}</span>
                </footer>
              </article>
            );
          })}
        </div>
        </section>
        {awayFromLatest ? (
          <button
            className="secondary-button jump-to-latest"
            type="button"
            onClick={() => {
              jumpToLatest();
              chatLogRef.current?.focus({ preventScroll: true });
            }}
          >
            {newMessageCount > 0 ? t("newMessagesJump", { count: newMessageCount }) : t("jumpToLatest")}
          </button>
        ) : null}
      </section>

      <form className="composer" onSubmit={handleSend}>
        <button
          aria-label={t("attachFileLabel")}
          className="secondary-button composer-attach"
          disabled={room?.status !== "open" || !keyReady}
          onClick={() => fileInputRef.current?.click()}
          title={t("attachFile")}
          type="button"
        >
          &#128206;
        </button>
        <input
          hidden
          multiple
          onChange={(event) => void handleAttachFiles(event.target.files)}
          ref={fileInputRef}
          type="file"
        />
        <textarea
          aria-label={t("writeMessageLabel")}
          value={draft}
          onChange={(event) => {
            draftRevisionRef.current += 1;
            setDraft(event.target.value);
          }}
          onKeyDown={handleComposerKeyDown}
          disabled={room?.status !== "open" || !keyReady}
          placeholder={room?.status === "open" ? (keyReady ? t("writeMessage") : t("securing")) : roomNotice ?? t("roomClosed")}
          rows={3}
        />
        <button className="primary-button" type="submit" disabled={sending || !draft.trim() || room?.status !== "open" || !keyReady}>
          {t("sendEncrypted")}
        </button>
      </form>
    </main>
    </>
  );
}

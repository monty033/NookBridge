/**
 * Deterministic Stage 2A authentication provider.
 *
 * This provider is intentionally test-only/offline. It validates that
 * credentials are non-empty, derives a stable fake user identifier, and
 * issues deterministic opaque session values in memory. It has no transport,
 * account, credential store, or persistence integration.
 */

import { createHash } from "node:crypto";

import type { AuthCredentials, AuthProvider, AuthSession } from "./types.js";

export type MockAuthProviderOptions = Readonly<{
  /** Injectable clock makes expiry behavior deterministic in tests. */
  clock?: () => number;
  sessionTtlMs?: number;
}>;

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const MOCK_TOKEN_PREFIX = "offline-mock-token-";

export class MockAuthProvider implements AuthProvider {
  private readonly clock: () => number;
  private readonly sessionTtlMs: number;
  private sequence = 0;

  constructor(options: MockAuthProviderOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isInteger(this.sessionTtlMs) || this.sessionTtlMs <= 0) {
      throw new Error("offline mock sessionTtlMs must be a positive integer");
    }
  }

  async login(credentials: AuthCredentials): Promise<AuthSession> {
    if (
      typeof credentials.username !== "string" ||
      credentials.username.trim().length === 0 ||
      typeof credentials.password !== "string" ||
      credentials.password.length === 0
    ) {
      throw new Error("offline mock login requires a non-empty username and password");
    }

    // Do not retain either credential. The password is intentionally not used
    // to derive the fake identity or token.
    const userId = `offline-mock-user-${stableUserId(credentials.username)}`;
    return this.issueSession(userId);
  }

  async refresh(session: AuthSession): Promise<AuthSession> {
    if (!session.accessToken.startsWith(MOCK_TOKEN_PREFIX)) {
      throw new Error("offline mock cannot refresh a session from another provider");
    }
    return this.issueSession(session.userId);
  }

  async logout(_session: AuthSession): Promise<void> {
    // There is no remote account and no local session registry to clear. The
    // coordinator clears its in-memory reference independently.
  }

  private issueSession(userId: string): AuthSession {
    const issuedAt = this.clock();
    if (!Number.isFinite(issuedAt))
      throw new Error("offline mock clock must return a finite number");
    this.sequence += 1;
    return {
      userId,
      accessToken: `${MOCK_TOKEN_PREFIX}${this.sequence}`,
      issuedAt,
      expiresAt: issuedAt + this.sessionTtlMs,
    };
  }
}

function stableUserId(username: string): string {
  return createHash("sha256").update(username.trim(), "utf8").digest("hex").slice(0, 16);
}

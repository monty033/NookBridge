/**
 * Stage 2A authentication boundary.
 *
 * These types intentionally describe only an in-memory session boundary. They
 * are not a Notesnook account or network-authentication API.
 */

export type AuthCredentials = Readonly<{
  username: string;
  password: string;
}>;

/** An opaque, in-memory session returned by an auth provider. */
export type AuthSession = Readonly<{
  userId: string;
  accessToken: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type SignedOutAuthState = Readonly<{
  status: "signed-out";
}>;

export type AuthenticatedAuthState = Readonly<{
  status: "authenticated";
  session: AuthSession;
}>;

export type ExpiredAuthState = Readonly<{
  status: "expired";
  session: AuthSession;
}>;

export type AuthState = SignedOutAuthState | AuthenticatedAuthState | ExpiredAuthState;

/**
 * The only provider operations the coordinator needs. A real provider is
 * deliberately deferred to Stage 2B; Stage 2A supplies only the offline mock.
 */
export interface AuthProvider {
  login(credentials: AuthCredentials): Promise<AuthSession>;
  refresh(session: AuthSession): Promise<AuthSession>;
  logout(session: AuthSession): Promise<void>;
}

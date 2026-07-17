import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";

// --- Config ---------------------------------------------------------------

const SESSION_TTL_DAYS = 30;
const CODE_TTL_MINUTES = 5;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_GATE_SECONDS = 60;

function isProd(): boolean {
  return (Bun.env.DASHBOARD_URL ?? "").startsWith("https://");
}

function otpPepper(): string {
  const pepper = Bun.env.OTP_PEPPER;
  if (pepper) return pepper;
  if (isProd()) throw new Error("OTP_PEPPER is required in production — set it in the env");
  return "dev-pepper-insecure";
}

// --- Crypto helpers ---------------------------------------------------------

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hmacCode(code: string): string {
  return createHmac("sha256", otpPepper()).update(code).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

// --- Session cookie ---------------------------------------------------------

export function sessionCookieName(): string {
  return isProd() ? "__Host-session" : "session";
}

function cookieAttrs(maxAge: number): string {
  const base = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
  return isProd() ? `${base}; Secure` : base;
}

export function sessionSetCookie(token: string): string {
  return `${sessionCookieName()}=${token}; ${cookieAttrs(SESSION_TTL_DAYS * 86400)}`;
}

export function sessionClearCookie(): string {
  return `${sessionCookieName()}=; ${cookieAttrs(0)}`;
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const name = sessionCookieName();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

// --- Sessions ---------------------------------------------------------------

export type AuthUser = {
  id: number;
  email: string;
  name: string | null;
  isAdmin: boolean;
  receiveDigest: boolean;
};

export type SessionCheck = {
  user: AuthUser;
  // Set when the rolling expiry was extended — attach to the response.
  refreshCookie: string | null;
};

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(48).toString("base64url");
  await db()`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${sha256hex(token)}, ${userId}, now() + make_interval(days => ${SESSION_TTL_DAYS}))`;
  await db()`UPDATE users SET last_login_at = now() WHERE id = ${userId}`;
  return token;
}

export async function getSession(req: Request): Promise<SessionCheck | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const hash = sha256hex(token);
  const rows = await db()`
    SELECT u.id, u.email, u.name, u.is_admin, u.receive_digest, s.last_used_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND s.expires_at > now()`;
  const row = rows[0];
  if (!row) return null;

  let refreshCookie: string | null = null;
  const lastUsed = new Date(row.last_used_at).getTime();
  if (Date.now() - lastUsed > 3600_000) {
    await db()`
      UPDATE sessions SET last_used_at = now(),
        expires_at = now() + make_interval(days => ${SESSION_TTL_DAYS})
      WHERE token_hash = ${hash}`;
    refreshCookie = sessionSetCookie(token);
  }

  return {
    user: {
      id: Number(row.id),
      email: row.email,
      name: row.name,
      isAdmin: row.is_admin === true,
      receiveDigest: row.receive_digest === true,
    },
    refreshCookie,
  };
}

export async function deleteSession(req: Request): Promise<void> {
  const token = readSessionToken(req);
  if (!token) return;
  await db()`DELETE FROM sessions WHERE token_hash = ${sha256hex(token)}`;
}

// --- Access rules -----------------------------------------------------------

// Emails on these domains may log in without a pre-created account; the user
// row is created at first successful code verification (non-admin).
export function allowedDomains(): string[] {
  return (Bun.env.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export function isEmailDomainAllowed(email: string): boolean {
  const domain = normalizeEmail(email).split("@")[1] ?? "";
  return domain.length > 0 && allowedDomains().includes(domain);
}

// Local part of an email address (the admin form only collects this;
// the domain is fixed by ALLOWED_EMAIL_DOMAINS).
export function isValidLocalPart(s: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?$/i.test(s);
}

export function isEmailish(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export type NewUserInput = { email?: string; local?: string; domain?: string };

// Resolves the admin "add user" form into a full normalized email, or null
// when invalid. Domain-locked when allowed domains are configured (the form
// sends only the local part); otherwise falls back to a free email field.
export function resolveNewUserEmail(
  input: NewUserInput,
  domains: string[] = allowedDomains(),
): string | null {
  if (domains.length > 0) {
    const local = (input.local ?? "").trim();
    const chosen = domains.length === 1 ? domains[0]! : (input.domain ?? "");
    if (!isValidLocalPart(local)) return null;
    if (!domains.includes(chosen)) return null;
    return normalizeEmail(`${local}@${chosen}`);
  }
  const email = normalizeEmail(input.email ?? "");
  return isEmailish(email) ? email : null;
}

// JIT provisioning for allowed-domain logins. Never grants admin; never
// demotes an existing user.
export async function ensureUser(email: string): Promise<AuthUser | null> {
  await db()`
    INSERT INTO users (email) VALUES (${normalizeEmail(email)})
    ON CONFLICT (email) DO NOTHING`;
  return findUserByEmail(email);
}

// --- Login codes (OTP) --------------------------------------------------------

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const rows = await db()`
    SELECT id, email, name, is_admin, receive_digest
    FROM users WHERE email = ${normalizeEmail(email)}`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    name: row.name,
    isAdmin: row.is_admin === true,
    receiveDigest: row.receive_digest === true,
  };
}

// Returns the 6-digit code to send, or null when the resend gate is active.
export async function createLoginCode(email: string): Promise<string | null> {
  const norm = normalizeEmail(email);
  const recent = await db()`
    SELECT 1 FROM email_verification_codes
    WHERE email = ${norm}
      AND created_at > now() - make_interval(secs => ${RESEND_GATE_SECONDS})`;
  if (recent.length > 0) return null;

  await db()`
    UPDATE email_verification_codes SET used_at = now()
    WHERE email = ${norm} AND used_at IS NULL`;

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db()`
    INSERT INTO email_verification_codes (email, code_hash, expires_at)
    VALUES (${norm}, ${hmacCode(code)}, now() + make_interval(mins => ${CODE_TTL_MINUTES}))`;
  return code;
}

export async function verifyLoginCode(email: string, code: string): Promise<boolean> {
  const norm = normalizeEmail(email);
  const rows = await db()`
    SELECT id, code_hash, attempts, expires_at
    FROM email_verification_codes
    WHERE email = ${norm} AND used_at IS NULL AND purpose = 'login'
    ORDER BY created_at DESC LIMIT 1`;
  const row = rows[0];
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  if (row.attempts >= CODE_MAX_ATTEMPTS) return false;

  await db()`UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ${row.id}`;

  if (!safeEqual(hmacCode(code.trim()), row.code_hash)) return false;

  const claimed = await db()`
    UPDATE email_verification_codes SET used_at = now()
    WHERE id = ${row.id} AND used_at IS NULL
    RETURNING id`;
  return claimed.length > 0;
}

// --- In-memory rate limiting (single instance) ---------------------------------

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count++;
  return bucket.count <= max;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? (fwd.split(",")[0]?.trim() ?? "?") : "?";
}

// --- User management -------------------------------------------------------------

export type UserRow = {
  id: number;
  email: string;
  name: string | null;
  is_admin: boolean;
  created_at: Date;
  last_login_at: Date | null;
};

export async function listUsers(): Promise<UserRow[]> {
  const rows = await db()`
    SELECT id, email, name, is_admin, created_at, last_login_at
    FROM users ORDER BY email`;
  return rows as UserRow[];
}

// Returns false when the email already exists.
export async function addUser(email: string, name: string, isAdmin: boolean): Promise<boolean> {
  const rows = await db()`
    INSERT INTO users (email, name, is_admin)
    VALUES (${normalizeEmail(email)}, ${name.trim() || null}, ${isAdmin})
    ON CONFLICT (email) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

export async function deleteUser(id: number): Promise<void> {
  await db()`DELETE FROM users WHERE id = ${id}`;
}

export async function updateProfile(
  userId: number,
  name: string,
  receiveDigest: boolean,
): Promise<void> {
  await db()`
    UPDATE users SET name = ${name.trim().slice(0, 80) || null}, receive_digest = ${receiveDigest}
    WHERE id = ${userId}`;
}

// « Se déconnecter de tous les appareils »
export async function deleteAllSessions(userId: number): Promise<void> {
  await db()`DELETE FROM sessions WHERE user_id = ${userId}`;
}

// Daily digest goes to users who kept the opt-in (plus DIGEST_RECIPIENTS env).
export async function getDigestUserEmails(): Promise<string[]> {
  const rows = await db()`SELECT email FROM users WHERE receive_digest = true`;
  return rows.map((r: { email: string }) => r.email);
}

// Grant-only: emails listed in ADMIN_EMAILS become admins; removal never demotes.
export async function seedAdmins(): Promise<void> {
  const emails = (Bun.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
  for (const email of emails) {
    await db()`
      INSERT INTO users (email, is_admin) VALUES (${email}, true)
      ON CONFLICT (email) DO UPDATE SET is_admin = true`;
  }
}

// --- Cleanup (called after successful daily runs and after logins) ----------------

export async function cleanupAuth(): Promise<void> {
  await db()`DELETE FROM sessions WHERE expires_at < now()`;
  await db()`DELETE FROM email_verification_codes WHERE expires_at < now() - interval '1 day'`;
}

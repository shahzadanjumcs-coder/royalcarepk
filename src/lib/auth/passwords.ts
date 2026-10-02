import { createHash, randomBytes } from "crypto";

/**
 * Password hashing for demo mode sessions.
 * In Supabase (live) mode, authentication is delegated to Supabase Auth (bcrypt inside GoTrue)
 * and these helpers are only used for the embedded demo store.
 */
export function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(8).toString("hex");
  const hash = createHash("sha256").update(`${s}:${password}`).digest("hex");
  return `${s}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [salt] = stored.split("$");
  if (!salt) return false;
  return hashPassword(password, salt) === stored;
}

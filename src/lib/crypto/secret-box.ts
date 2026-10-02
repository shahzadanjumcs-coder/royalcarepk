import "server-only";
import crypto from "crypto";

/**
 * Server-side secret box: encrypts values that must be stored at rest
 * (e.g. the Flaship API key) but never returned to the browser.
 *
 * The encryption key is derived from a server-only secret. It is NEVER
 * sent to the client and never written to logs or the database.
 */
const MATERIAL =
  process.env.FLASHIP_ENC_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.DEMO_AUTH_SECRET ||
  "royalcarepk-local-development-secret";

const KEY = crypto.createHash("sha256").update(`royalcarepk:secret-box:v1:${MATERIAL}`).digest();

/** Encrypt to `v1.<iv>.<tag>.<ciphertext>` (all base64url). Returns null on empty input. */
export function encryptSecret(plain: string | null | undefined): string | null {
  const value = (plain ?? "").trim();
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

/** Decrypt a value produced by encryptSecret. Returns null when missing/corrupt. */
export function decryptSecret(payload: string | null | undefined): string | null {
  const raw = (payload ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const data = Buffer.from(parts[3], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Mask a secret for display: keeps only the last 4 characters. */
export function maskSecret(plain: string | null | undefined): string | null {
  const value = (plain ?? "").trim();
  if (!value) return null;
  const tail = value.slice(-4);
  return `••••••••${tail.length === 4 ? tail : "••••"}`;
}

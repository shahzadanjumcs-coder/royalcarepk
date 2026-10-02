import { store, IS_DEMO_MODE } from "@/lib/store";
import { verifyPassword, hashPassword } from "./passwords";
import { signToken, SESSION_COOKIE } from "./session";
import type { Role } from "@/lib/types";
import { cookies } from "next/headers";

export class AuthError extends Error {}

async function issueSessionCookie(payload: { userId: string; email: string; name: string; role: Role }) {
  const token = await signToken({ ...payload, mode: "demo" });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function login(email: string, password: string): Promise<{ role: Role; name: string }> {
  email = email.trim().toLowerCase();
  if (IS_DEMO_MODE) {
    const user = await store.first<{
      id: string; email: string; name: string; role: Role; status: string; password_hash: string | null;
    }>("profiles", { email });
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new AuthError("Invalid email or password.");
    }
    if (user.status !== "active") throw new AuthError("This account has been disabled. Contact your administrator.");
    await issueSessionCookie({ userId: user.id, email: user.email, name: user.name, role: user.role });
    return { role: user.role, name: user.name };
  }

  // Supabase mode
  const { getServerClient } = await import("@/lib/supabase/server");
  const supabase = await getServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new AuthError("Invalid email or password.");
  const { data: profile } = await supabase
    .from("profiles")
    .select("name, role, status")
    .eq("id", data.user.id)
    .single();
  if (!profile) throw new AuthError("Profile not found. Contact your administrator.");
  if (profile.status !== "active") throw new AuthError("This account has been disabled. Contact your administrator.");
  return { role: profile.role as Role, name: profile.name };
}

export async function signup(input: { name: string; email: string; phone?: string; password: string }): Promise<{ role: Role }> {
  const email = input.email.trim().toLowerCase();
  if (IS_DEMO_MODE) {
    const existing = await store.first("profiles", { email });
    if (existing) throw new AuthError("An account with this email already exists.");
    const user = await store.insert<{ email: string; name: string; id?: string }>("profiles", {
      email,
      name: input.name.trim(),
      phone: input.phone ?? "",
      role: "worker" as Role,
      worker_code: null,
      commission_rate: 0,
      status: "active",
      password_hash: hashPassword(input.password),
    });
    await issueSessionCookie({ userId: user.id, email: user.email, name: user.name, role: "worker" });
    return { role: "worker" };
  }

  const { getServerClient } = await import("@/lib/supabase/server");
  const supabase = await getServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: { data: { name: input.name.trim(), phone: input.phone ?? "" } },
  });
  if (error) throw new AuthError(error.message);
  if (!data.session) throw new AuthError("Account created. Please verify your email before signing in.");
  await issueSessionCookie({ userId: data.user!.id, email, name: input.name.trim(), role: "worker" });
  return { role: "worker" };
}

export async function logout(): Promise<void> {
  if (!IS_DEMO_MODE) {
    try {
      const { getServerClient } = await import("@/lib/supabase/server");
      const supabase = await getServerClient();
      await supabase.auth.signOut();
    } catch {
      /* ignore */
    }
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** Demo-mode password reset (live mode uses Supabase reset emails). */
export async function resetPassword(email: string, newPassword: string): Promise<void> {
  email = email.trim().toLowerCase();
  if (IS_DEMO_MODE) {
    const user = await store.first<{ id: string }>("profiles", { email });
    if (!user) throw new AuthError("No account found with this email.");
    await store.update("profiles", user.id, { password_hash: hashPassword(newPassword) });
    return;
  }
  const { getServerClient } = await import("@/lib/supabase/server");
  const supabase = await getServerClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new AuthError(error.message);
}

export async function requestPasswordReset(email: string): Promise<string> {
  email = email.trim().toLowerCase();
  if (IS_DEMO_MODE) {
    const user = await store.first("profiles", { email });
    if (!user) throw new AuthError("No account found with this email.");
    return "Demo mode: continue to set a new password.";
  }
  const { getServerClient } = await import("@/lib/supabase/server");
  const supabase = await getServerClient();
  const redirectTo = `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/reset-password`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw new AuthError(error.message);
  return "Password reset email sent. Check your inbox.";
}

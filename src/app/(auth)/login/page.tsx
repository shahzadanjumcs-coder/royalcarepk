"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/client";
import { Loader2, LogIn } from "lucide-react";

const DEMO_ACCOUNTS = [
  { label: "Super Admin", email: "admin@demo.com", password: "admin123" },
  { label: "Manager", email: "manager@demo.com", password: "admin123" },
  { label: "Worker (Ali)", email: "ali@demo.com", password: "worker123" },
];

// Same definition as the server's IS_DEMO_MODE. NEXT_PUBLIC_* vars are inlined
// at build time, so this is safe in a client component. Demo one-tap logins are
// hidden in live mode — real credentials only.
const IS_DEMO_MODE_CLIENT =
  !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isDemo, setIsDemo] = useState(false);

  const submit = async (e: React.FormEvent, creds?: { email: string; password: string }) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api<{ role: string; mode: string }>("/api/auth/login", {
        method: "POST",
        json: creds ?? { email, password },
      });
      setIsDemo(res.mode === "demo");
      const next = params.get("next");
      router.replace(next && next.startsWith("/") ? next : res.role === "worker" ? "/worker" : "/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to sign in right now.");
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">Welcome back. Enter your credentials to continue.</p>

      <form onSubmit={(e) => submit(e)} className="mt-6 space-y-4" noValidate>
        <div>
          <Label htmlFor="email" className="mb-1.5 block">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            /* casing-only SSR/DOM diff on autocomplete is benign — suppress the dev warning */
            suppressHydrationWarning
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link href="/forgot-password" className="text-xs font-medium text-emerald-700 hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            suppressHydrationWarning
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
            {error}
          </div>
        ) : null}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogIn className="mr-2 h-4 w-4" />}
          Sign in
        </Button>
      </form>

      {IS_DEMO_MODE_CLIENT ? (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
          <p className="text-xs font-semibold text-amber-800">Demo accounts (demo mode)</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {DEMO_ACCOUNTS.map((a) => (
              <Button
                key={a.email}
                type="button"
                size="sm"
                variant="outline"
                className="h-8 border-amber-300 bg-white text-xs text-amber-900 hover:bg-amber-100"
                disabled={loading}
                onClick={(e) => void submit(e, a)}
              >
                {a.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-amber-700">
            One-tap sign-in for evaluation. When you connect Supabase (see README), these buttons
            disappear and real credentials apply.
          </p>
        </div>
      ) : null}

      <p className="mt-6 text-center text-sm text-muted-foreground">
        New here?{" "}
        <Link href="/signup" className="font-medium text-emerald-700 hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

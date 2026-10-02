import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ADMIN_ROLES } from "@/lib/types";
import { IS_DEMO_MODE } from "@/lib/store";
import { AdminShell } from "@/components/app/admin-shell";
import { getBranding } from "@/lib/services/branding";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!ADMIN_ROLES.includes(session.role)) redirect("/worker");

  const branding = await getBranding();

  return (
    <AdminShell session={session} demoMode={IS_DEMO_MODE} branding={branding}>
      {children}
    </AdminShell>
  );
}

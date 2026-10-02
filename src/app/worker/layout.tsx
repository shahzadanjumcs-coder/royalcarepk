import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { IS_DEMO_MODE } from "@/lib/store";
import { WorkerShell } from "@/components/app/worker-shell";
import { getBranding } from "@/lib/services/branding";

export default async function WorkerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "worker") redirect("/admin");

  const branding = await getBranding();

  return (
    <WorkerShell session={session} demoMode={IS_DEMO_MODE} branding={branding}>
      {children}
    </WorkerShell>
  );
}

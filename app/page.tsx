import { authOpen } from "@/lib/session";
import { Dashboard } from "@/components/Dashboard";

// APP_PASSWORD is a runtime value, so the dashboard remains dynamic when a prebuilt image receives
// its password only at startup.
export const dynamic = "force-dynamic";

export default function Home() {
  return <Dashboard showSignOut={!authOpen()} />;
}

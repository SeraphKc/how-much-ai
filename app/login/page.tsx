import { redirect } from "next/navigation";
import { authOpen } from "@/lib/session";
import { PasswordLogin } from "@/components/PasswordLogin";

// Rendered on the Node runtime at request time so the open/password decision uses this process's
// current environment rather than being frozen into a static build.
export const dynamic = "force-dynamic";

// Open mode never reaches this form: both middleware and this component redirect it to `/`.
export default function LoginPage() {
  if (authOpen()) redirect("/");
  return <PasswordLogin />;
}

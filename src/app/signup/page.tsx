import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getAuth } from "@/lib/auth";

export const metadata = { title: "Create workspace" };

export default async function SignupPage() {
  if (await getAuth()) redirect("/");
  return <AuthForm mode="signup" />;
}

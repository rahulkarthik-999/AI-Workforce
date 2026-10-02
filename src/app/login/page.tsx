import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getAuth } from "@/lib/auth";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getAuth()) redirect("/");
  return <AuthForm mode="login" />;
}

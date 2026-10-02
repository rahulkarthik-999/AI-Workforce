import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, endSession, registerUser, signupsOpen, startSession } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { clientIp, parseBody, rateLimit, route } from "@/lib/http";

const signupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().email("Enter a valid email").max(200),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});
const loginSchema = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });

export const POST = route(async (req: Request, ctx: { params: Promise<{ action: string }> }) => {
  const { action } = await ctx.params;
  const ip = clientIp(req);

  if (action === "signup") {
    await rateLimit(`signup:${ip}`, 5, 3600);
    if (!(await signupsOpen())) throw new AppError("Signups are closed for this deployment.", 403, "forbidden");
    const input = await parseBody(req, signupSchema);
    const user = await registerUser(input);
    await startSession(user.id);
    return NextResponse.json({ ok: true });
  }

  if (action === "login") {
    const input = await parseBody(req, loginSchema);
    await rateLimit(`login:${ip}`, 20, 600);
    await rateLimit(`login:${input.email.toLowerCase()}`, 8, 600);
    const user = await authenticate(input.email, input.password);
    if (!user) throw new AppError("Incorrect email or password.", 401, "unauthorized");
    await startSession(user.id);
    return NextResponse.json({ ok: true });
  }

  if (action === "logout") {
    await endSession();
    return NextResponse.json({ ok: true });
  }

  throw new AppError("Not found.", 404, "not_found");
});

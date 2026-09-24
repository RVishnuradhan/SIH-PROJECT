"use server";

import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { defineAction, formInput, type ActionResult } from "@/lib/action";
import { AUTH_COOKIE_PREFIX, DEACTIVATED_ACCOUNT_MESSAGE, getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getServerEnv } from "@/lib/env";
import { LOGIN_PATH, safeRedirectPath } from "@/lib/routes";
import { changeOwnPassword } from "@/modules/users/service";
import { changeOwnPasswordSchema, signInSchema } from "@/modules/users/schemas";

import { applyAuthCookies, getCurrentUser } from "./session";
import { signInWithPassword, signOutSession } from "./sign-in";
import { KeyedLock } from "./throttle";

const signInLock = new KeyedLock();

export type SignInState = {
  error?: string;
  fieldErrors?: { username?: string; password?: string };
  /** Refills the username after a failed attempt (never the password). */
  username?: string;
};

function waitMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many sign-in attempts. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
}

export async function signInAction(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const raw = formInput(formData);
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: SignInState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === "username" || field === "password") && !fieldErrors[field]) {
        fieldErrors[field] = issue.message;
      }
    }
    return { fieldErrors, username: raw.username?.slice(0, 64) };
  }

  const { username, password, next } = parsed.data;
  let outcome;
  try {
    outcome = await signInWithPassword(
      {
        auth: getAuth(),
        db: getDb(),
        secret: getServerEnv().BETTER_AUTH_SECRET,
        lock: signInLock,
      },
      { username, password, headers: await headers() },
    );
  } catch (error) {
    const reference = crypto.randomUUID().slice(0, 8);
    console.error(`Sign-in failed unexpectedly [ref ${reference}]`, error);
    return {
      error: `Signing in isn't working right now. Please try again in a moment. (Reference ${reference})`,
      username,
    };
  }

  switch (outcome.status) {
    case "signed-in":
      await applyAuthCookies(outcome.responseHeaders);
      redirect(safeRedirectPath(next) as Route);
    case "invalid-credentials":
      return { error: "Incorrect username or password.", username };
    case "deactivated":
      return { error: DEACTIVATED_ACCOUNT_MESSAGE, username };
    case "throttled":
      return { error: waitMessage(outcome.retryAfterSeconds), username };
  }
}

export async function signOutAction(): Promise<void> {
  const requestHeaders = await headers();
  const user = await getCurrentUser();
  try {
    const responseHeaders = await signOutSession(
      { auth: getAuth(), db: getDb() },
      { userId: user?.id ?? null, headers: requestHeaders },
    );
    await applyAuthCookies(responseHeaders);
  } catch (error) {
    // Already signed out, or the database is unreachable: still clear the
    // cookie in this browser so the person ends up signed out.
    if (user) console.error("Sign-out could not end the session in the database", error);
    const jar = await cookies();
    for (const name of [
      `${AUTH_COOKIE_PREFIX}.session_token`,
      `__Secure-${AUTH_COOKIE_PREFIX}.session_token`,
    ]) {
      if (!jar.has(name)) continue;
      // Browsers only accept the removal of a __Secure- cookie marked Secure.
      jar.set(name, "", {
        maxAge: 0,
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: name.startsWith("__Secure-"),
      });
    }
  }
  redirect(LOGIN_PATH as Route);
}

const changePassword = defineAction({
  name: "account.changePassword",
  permission: "signed-in",
  schema: changeOwnPasswordSchema,
  handler: async (input, { user, request }) => {
    await changeOwnPassword(getDb(), {
      user,
      currentPassword: input.currentPassword,
      newPassword: input.password,
      request,
    });
    return null;
  },
});

export async function changePasswordAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return changePassword(formInput(formData));
}

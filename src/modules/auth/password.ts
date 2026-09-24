import { hashPassword as scryptHash, verifyPassword as scryptVerify } from "better-auth/crypto";

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password-rules";

/**
 * The single password hasher for the app (scrypt, salted). Better Auth is
 * configured with these same functions, so passwords set by an admin, by the
 * first-admin script and at sign-in are always hashed and checked one way.
 */
export function hashPassword(password: string): Promise<string> {
  return scryptHash(password);
}

export function verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
  return scryptVerify(input);
}

/**
 * An expected failure with a message the person can act on ("That username is
 * already taken."). Services throw it; the action guard turns it into a
 * friendly result. Anything else is unexpected and is shown only as a
 * reference number (PRD §62).
 */
export type ServiceErrorCode = "INVALID_INPUT" | "CONFLICT" | "NOT_FOUND" | "RATE_LIMITED";

export type FieldErrors = Partial<Record<string, string>>;

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly fieldErrors?: FieldErrors,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * Password rules (ARCHITECTURE.md §13): a length range only, no forced mixes of
 * symbols — long passphrases are the safest choice people actually remember.
 * Kept apart from the hashing code so forms in the browser can show them.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

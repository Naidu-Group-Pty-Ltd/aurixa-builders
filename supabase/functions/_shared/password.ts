// @ts-ignore esm.sh serves bcryptjs with a CommonJS default export, which the
// bundled @types/bcryptjs declaration does not describe. The import works at
// runtime; only the type declaration is wrong. Suppressed rather than rewritten
// so the runtime behaviour of every function importing this module is unchanged.
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";

/**
 * Hash a password using bcrypt
 * @param password - The plaintext password to hash
 * @returns The hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, 10, (err: Error | null, hash: string) => {
      if (err) reject(err);
      else resolve(hash);
    });
  });
}

/**
 * Verify a password against a bcrypt hash.
 *
 * ONLY a bcrypt hash can ever match. This function used to fall back to
 * `password === storedHash` for anything that did not look like bcrypt — a
 * "legacy plaintext migration" path with no migration wired up behind it
 * (`isLegacyPassword` below has no callers) and no database constraint
 * stopping such a value from existing. The security audit of 16 Sep 2026
 * recorded it as a live footgun: any row whose `password_hash` was not bcrypt
 * — an import artefact, an operator-set value, a placeholder — became a
 * plaintext credential compared with a short-circuiting `===`.
 *
 * It now fails closed. Every stored hash in production is bcrypt (verified
 * before this change), every writer in this repo goes through `hashPassword`,
 * and a CHECK constraint on the column now refuses anything else, so nothing
 * legitimate relied on the fallback.
 *
 * @param password - The plaintext password to verify
 * @param storedHash - The stored bcrypt hash
 * @returns True if password matches
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // Check if it's a bcrypt hash (starts with $2a$, $2b$, or $2y$)
  const isBcryptHash = /^\$2[aby]\$\d+\$/.test(storedHash);

  if (!isBcryptHash) return false;

  return new Promise((resolve, reject) => {
    bcrypt.compare(password, storedHash, (err: Error | null, result: boolean) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * Check if a hash is a legacy plaintext password
 * @param hash - The stored hash
 * @returns True if this is a legacy plaintext (not bcrypt)
 */
export function isLegacyPassword(hash: string): boolean {
  return !/^\$2[aby]\$\d+\$/.test(hash);
}

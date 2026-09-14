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
 * Verify a password against a hash
 * Handles both bcrypt hashes and legacy plaintext passwords for migration
 * @param password - The plaintext password to verify
 * @param storedHash - The stored hash (or plaintext for legacy)
 * @returns True if password matches
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // Check if it's a bcrypt hash (starts with $2a$, $2b$, or $2y$)
  const isBcryptHash = /^\$2[aby]\$\d+\$/.test(storedHash);
  
  if (isBcryptHash) {
    return new Promise((resolve, reject) => {
      bcrypt.compare(password, storedHash, (err: Error | null, result: boolean) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }
  
  // Legacy plaintext comparison for migration period
  // This allows existing users to login with their old passwords
  // On successful login, the password should be re-hashed
  return password === storedHash;
}

/**
 * Check if a hash is a legacy plaintext password
 * @param hash - The stored hash
 * @returns True if this is a legacy plaintext (not bcrypt)
 */
export function isLegacyPassword(hash: string): boolean {
  return !/^\$2[aby]\$\d+\$/.test(hash);
}

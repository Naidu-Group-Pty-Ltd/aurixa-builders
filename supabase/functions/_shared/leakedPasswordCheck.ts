/**
 * THE BREACHED-PASSWORD CHECK THAT `passwordValidation.ts` HAS ALWAYS IMPORTED.
 *
 * The security audit of 16 Sep 2026 found this module did not exist. Its
 * importer does a dynamic `import('./leakedPasswordCheck.ts')` inside a
 * try/catch that fails open, so every call threw "module not found", the
 * failure was swallowed, and validation returned valid. That mattered more
 * than a missing feature: `passwordValidation.ts` records that its
 * character-class rule was deliberately kept at 2-of-4 *because* "the breach
 * check below does the work those rules were pretending to do". It did no
 * work, so the whole policy was length plus a thirty-entry deny list.
 *
 * This is the module it expected, implemented the standard way.
 *
 * ## k-anonymity — the password never leaves this process
 *
 * We SHA-1 the password, send only the FIRST FIVE hex characters of that
 * digest to the range API, and match the remaining 35 locally against the
 * few hundred suffixes it returns. The service learns a prefix shared by
 * thousands of distinct passwords and never sees the password, its full
 * hash, the user, or which suffix matched. `Add-Padding` asks the service to
 * pad every response to a uniform size so the response LENGTH does not leak
 * how many suffixes share the prefix either.
 *
 * SHA-1 is not a security choice here — it is the digest that range API is
 * keyed on. It is used as a lookup key against a public corpus, never to
 * store or protect anything.
 *
 * ## Failure posture
 *
 * This module THROWS on timeout, transport failure or a malformed response,
 * and never returns a false negative dressed up as a pass. The decision to
 * fail open lives with the caller, which already catches and continues — so
 * an outage at the range API leaves people able to set passwords, exactly as
 * before. What changes is that a working service is now actually consulted.
 */

/** What the caller reads back. `count` is 0 when the password is unknown. */
export interface LeakedPasswordResult {
  isLeaked: boolean;
  count: number;
}

const RANGE_API = 'https://api.pwnedpasswords.com/range';

/** Uppercase hex of a digest, which is the casing the range API answers in. */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out.toUpperCase();
}

/**
 * Ask the public breach corpus whether this password appears in it.
 *
 * Throws on any failure. Callers that prefer availability over the check
 * catch and continue.
 */
export async function checkLeakedPassword(password: string): Promise<LeakedPasswordResult> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
  const hash = toHex(digest);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const response = await fetch(`${RANGE_API}/${prefix}`, {
    headers: {
      // Uniform response size, so the length of the reply says nothing.
      'Add-Padding': 'true',
      'User-Agent': 'aurixa-builder-portal',
    },
  });
  if (!response.ok) {
    throw new Error(`leaked password range lookup answered ${response.status}`);
  }

  const body = await response.text();
  for (const line of body.split('\n')) {
    // Each line is `SUFFIX:COUNT`. Padding entries carry a count of 0 and are
    // indistinguishable here, which is the point — a padded row that happened
    // to match would report 0 occurrences and is treated as not leaked.
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    if (line.slice(0, separator).trim().toUpperCase() !== suffix) continue;
    const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
    if (!Number.isFinite(count) || count <= 0) return { isLeaked: false, count: 0 };
    return { isLeaked: true, count };
  }
  return { isLeaked: false, count: 0 };
}

/**
 * The same check, abandoned after `timeoutMs`.
 *
 * Setting a password must not wait on somebody else's service. The abort
 * surfaces as a thrown error, which the caller treats as "not checked".
 */
export async function checkLeakedPasswordWithTimeout(
  password: string,
  timeoutMs = 3000,
): Promise<LeakedPasswordResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await Promise.race([
      checkLeakedPassword(password),
      new Promise<LeakedPasswordResult>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`leaked password check timed out after ${timeoutMs}ms`));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

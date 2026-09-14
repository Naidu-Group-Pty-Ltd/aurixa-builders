/**
 * JWT utilities for custom authentication
 * Generates Supabase-compatible JWTs signed with the project secret
 */

// @ts-ignore Deno-only module; not resolvable under Node type-checking.
import { create, getNumericDate, verify, Header, Payload } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

interface JWTPayload {
  sub: string;           // User ID (custom_users.id)
  role: string;          // Supabase role ('authenticated')
  aud: string;           // Audience ('authenticated')
  iss: string;           // Issuer (Supabase URL)
  exp: number;           // Expiration timestamp
  iat: number;           // Issued at timestamp
  email?: string;        // Optional email
  user_metadata?: Record<string, any>;  // Optional metadata
  app_metadata?: Record<string, any>;   // Optional app metadata
}

/**
 * Convert a secret string to a CryptoKey for HMAC-SHA256 signing
 */
async function getSigningKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  
  return await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Generate a Supabase-compatible JWT for a custom user
 * @param userId - The user's ID from custom_users table
 * @param expiresIn - Token lifetime in seconds (default: 24 hours)
 * @param options - Additional claims to include
 * @returns Signed JWT string
 */
export async function generateSupabaseJWT(
  userId: string,
  expiresIn: number = 86400,
  options?: {
    email?: string;
    roles?: string[];
    userMetadata?: Record<string, any>;
    appMetadata?: Record<string, any>;
  }
): Promise<string> {
  // Supabase Edge Runtime typically exposes the project JWT secret as JWT_SECRET.
  // Some environments may expose it as SUPABASE_JWT_SECRET.
  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET') ?? Deno.env.get('JWT_SECRET');
  if (!jwtSecret) {
    throw new Error('JWT secret is not configured (expected JWT_SECRET or SUPABASE_JWT_SECRET)');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL is not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  
  const payload: JWTPayload = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    iss: supabaseUrl,
    iat: now,
    exp: now + expiresIn,
  };

  // Add optional claims
  if (options?.email) {
    payload.email = options.email;
  }

  if (options?.roles && options.roles.length > 0) {
    payload.app_metadata = {
      ...payload.app_metadata,
      custom_roles: options.roles,
    };
  }

  if (options?.userMetadata) {
    payload.user_metadata = options.userMetadata;
  }

  if (options?.appMetadata) {
    payload.app_metadata = {
      ...payload.app_metadata,
      ...options.appMetadata,
    };
  }

  const header: Header = { alg: "HS256", typ: "JWT" };
  const key = await getSigningKey(jwtSecret);

  return await create(header, payload as unknown as Payload, key);
}

/**
 * Verify a JWT and extract claims
 * @param token - The JWT to verify
 * @returns Decoded payload or null if invalid
 */
export async function verifySupabaseJWT(token: string): Promise<JWTPayload | null> {
  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET') ?? Deno.env.get('JWT_SECRET');
  if (!jwtSecret) {
    console.error('JWT secret is not configured (expected JWT_SECRET or SUPABASE_JWT_SECRET)');
    return null;
  }

  try {
    const key = await getSigningKey(jwtSecret);
    const payload = await verify(token, key) as unknown as JWTPayload;
    return payload;
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

/**
 * Extract user ID from JWT without full verification
 * Useful for logging before verification
 */
export function extractUserIdFromJWT(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const payload = JSON.parse(atob(parts[1]));
    return payload.sub || null;
  } catch {
    return null;
  }
}

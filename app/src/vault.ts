// Password-protected storage for the in-browser private key.
//
// The key is encrypted with AES-256-GCM under a key derived from the password with
// PBKDF2-SHA256 (600,000 iterations, random 16-byte salt). Only the ciphertext is kept in
// localStorage. While the wallet is unlocked, the plain key sits in sessionStorage, which
// the browser clears when the tab closes.

const ITERATIONS = 600_000;
const enc = new TextEncoder();
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** What seal() returns and open() takes; stored as JSON in localStorage. */
export interface Sealed {
  salt: string;
  iv: string;
  ct: string;
  iterations: number;
}

/** Encrypts a hex private key. Returns a JSON-safe record. */
export async function seal(hexKey: string, password: string): Promise<Sealed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await derive(password, salt), enc.encode(hexKey)));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct), iterations: ITERATIONS };
}

/** Decrypts a record from seal(). Returns the hex key, or null if the password is wrong. */
export async function open(record: Sealed, password: string): Promise<string | null> {
  try {
    const key = await derive(password, unb64(record.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, key, unb64(record.ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

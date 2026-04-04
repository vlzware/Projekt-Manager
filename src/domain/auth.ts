/**
 * Hash a plaintext password.
 *
 * Returns the hashed representation suitable for storage.
 */
export async function hashPassword(_plain: string): Promise<string> {
  throw new Error('not implemented');
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Returns `true` when the plaintext matches the hash, `false` otherwise.
 */
export async function verifyPassword(
  _plain: string,
  _hash: string,
): Promise<boolean> {
  throw new Error('not implemented');
}

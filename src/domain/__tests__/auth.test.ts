import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../auth';

describe('password hashing', () => {
  // UT-10: a hashed password does not match a different plaintext
  it('UT-10: hashed password does not match a different plaintext', async () => {
    const hash = await hashPassword('correct-password');
    const result = await verifyPassword('wrong-password', hash);
    expect(result).toBe(false);
  });

  // UT-11: a hashed password matches the original plaintext
  it('UT-11: hashed password matches the original plaintext', async () => {
    const plain = 'my-secret-password';
    const hash = await hashPassword(plain);
    expect(hash).not.toBe(plain);
    const result = await verifyPassword(plain, hash);
    expect(result).toBe(true);
  });
});

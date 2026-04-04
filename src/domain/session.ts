/**
 * Determine whether a session has expired.
 *
 * A session is expired when the current time is past `expiresAt`.
 *
 * @param session - object with an ISO 8601 `expiresAt` datetime string
 * @returns `true` if the session is expired, `false` if still valid
 */
export function isSessionExpired(
  _session: { expiresAt: string },
): boolean {
  throw new Error('not implemented');
}

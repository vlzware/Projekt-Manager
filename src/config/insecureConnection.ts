/**
 * Detect whether the page was loaded over plain HTTP on a non-localhost host.
 *
 * http://localhost and http://127.0.0.1 are W3C secure contexts —
 * cookies with Secure flag work, so no warning is needed.
 * Any other http:// origin means credentials travel in cleartext.
 *
 * Parameters accept explicit values for testability; at runtime they
 * default to window.location.
 */
export function isInsecureConnection(
  protocol = window.location.protocol,
  hostname = window.location.hostname,
): boolean {
  return protocol === 'http:' && hostname !== 'localhost' && hostname !== '127.0.0.1';
}

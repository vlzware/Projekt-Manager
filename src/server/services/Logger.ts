/**
 * Service-layer logger interface.
 *
 * Services must not depend on Fastify (or any HTTP framework) directly,
 * so they accept this minimal logger shape instead of `FastifyBaseLogger`.
 * Routes pass `request.log` which already satisfies the interface
 * structurally — no adapter needed.
 *
 * The shape mirrors the subset of `pino.Logger` we actually use:
 * structured-logging methods that take a context object and an event name.
 *
 * Use `info` for routine business events (login_success, password_change, ...).
 * Use `error` for failures that should trigger alerting (audit subscriber crash,
 * background-job exception, ...). Audit-trail loss must not hide in info noise.
 */
export interface ServiceLogger {
  info(context: Record<string, unknown>, event: string): void;
  error(context: Record<string, unknown>, event: string): void;
}

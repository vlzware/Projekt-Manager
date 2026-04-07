/**
 * Service-layer logger interface.
 *
 * Services must not depend on Fastify (or any HTTP framework) directly,
 * so they accept this minimal logger shape instead of `FastifyBaseLogger`.
 * Routes pass `request.log` which already satisfies the interface
 * structurally — no adapter needed.
 *
 * The shape mirrors the subset of `pino.Logger` we actually use:
 * one structured-logging method that takes a context object and an event name.
 */
export interface ServiceLogger {
  info(context: Record<string, unknown>, event: string): void;
}

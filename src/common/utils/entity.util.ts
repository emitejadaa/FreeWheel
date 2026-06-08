import { NotFoundException } from "@nestjs/common";

/**
 * Throws a 404 when a lookup returned nothing, and narrows the type to
 * non-null for the rest of the caller. Replaces the repeated
 * `if (!entity) throw new NotFoundException(...)` guard across services.
 */
export function assertFound<T>(
  entity: T | null | undefined,
  message = "Resource not found",
): asserts entity is NonNullable<T> {
  if (entity === null || entity === undefined) {
    throw new NotFoundException(message);
  }
}

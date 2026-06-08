import { ForbiddenException } from "@nestjs/common";

/**
 * Throws a 403 unless `userId` owns the resource. Callers pass a resource-
 * specific message (e.g. "You cannot update this vehicle").
 */
export function assertOwner(
  ownerId: string,
  userId: string,
  message = "You are not the owner of this resource",
): void {
  if (ownerId !== userId) {
    throw new ForbiddenException(message);
  }
}

/**
 * Throws a 403 unless `userId` is the owner or the renter of the resource
 * (the two parties to a booking/conversation).
 */
export function assertParticipant(
  ownerId: string,
  renterId: string,
  userId: string,
  message = "You are not a participant in this resource",
): void {
  if (userId !== ownerId && userId !== renterId) {
    throw new ForbiddenException(message);
  }
}

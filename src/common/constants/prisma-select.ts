import { Prisma } from "@prisma/client";

// Shared Prisma `select`/`include` shapes. `satisfies` keeps each object literal
// narrow so Prisma still infers exact return types at every call site, while
// validating the fields against the generated schema types.

/** Minimal public user fields — no contact info. Used for listing owners and chat senders. */
export const USER_PUBLIC_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  displayName: true,
} satisfies Prisma.UserSelect;

/** Public fields plus email — used for the counterparties shown on a booking. */
export const USER_CONTACT_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  displayName: true,
} satisfies Prisma.UserSelect;

/** Full admin-facing user projection: everything except the password hash. */
export const USER_SAFE_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  displayName: true,
  phone: true,
  dateOfBirth: true,
  profilePhotoUrl: true,
  role: true,
  status: true,
  verificationStatus: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

/** Booking with its listing, vehicle, and both parties (contact-level user fields). */
export const BOOKING_PARTICIPANT_INCLUDE = {
  listing: true,
  vehicle: true,
  owner: { select: USER_CONTACT_SELECT },
  renter: { select: USER_CONTACT_SELECT },
} satisfies Prisma.BookingInclude;

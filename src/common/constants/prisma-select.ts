import { Prisma } from "@prisma/client";

// Shared Prisma `select`/`include` shapes. `satisfies` keeps each object literal
// narrow so Prisma still infers exact return types at every call site, while
// validating the fields against the generated schema types.

/**
 * Minimal public user fields — no contact info. Used for listing owners and chat
 * senders.
 *
 * `profilePhotoUrl` va acá a propósito: es la foto que la persona eligió para
 * mostrar, o sea información pública por definición. Sin ella el front no tenía
 * con qué dibujar el avatar en el chat, en la publicación de un auto ni al lado
 * de una reseña, y en todos esos lugares mostraba un círculo con la inicial
 * aunque la persona hubiera subido una foto.
 *
 * `profilePhotoVisibility` viaja al lado porque es lo que decide si esa foto se
 * puede mostrar o no. No llega al front: PhotoVisibilityInterceptor lo lee, tapa
 * la foto cuando corresponde y saca el campo de la respuesta.
 */
export const USER_PUBLIC_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  displayName: true,
  profilePhotoUrl: true,
  profilePhotoVisibility: true,
} satisfies Prisma.UserSelect;

/** Public fields plus email — used for the counterparties shown on a booking. */
export const USER_CONTACT_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  displayName: true,
  profilePhotoUrl: true,
  profilePhotoVisibility: true,
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
  /*
    La foto sin recortar viaja SOLO acá, que es la proyección de la propia
    cuenta y la del panel de administración. NO va en USER_PUBLIC_SELECT ni en
    USER_CONTACT_SELECT a propósito: lo que la persona eligió mostrarle a los
    demás es el recorte, y la original es justamente lo que quedó afuera de esa
    decisión. La necesita el editor de encuadre, y el editor solo lo abre el
    dueño de la foto.
  */
  profilePhotoOriginalUrl: true,
  profilePhotoVisibility: true,
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

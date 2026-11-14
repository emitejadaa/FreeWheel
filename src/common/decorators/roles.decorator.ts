import { SetMetadata } from "@nestjs/common";
import { UserRole } from "@prisma/client";

export const ROLES_KEY = "roles";

// - [Sesiones] @Roles le dice a una ruta qué roles pueden usarla
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

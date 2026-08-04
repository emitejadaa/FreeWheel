import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * Autenticación opcional: si viene un Bearer válido deja `req.user` cargado, y
 * si no viene (o es inválido) sigue adelante como visitante anónimo en lugar de
 * responder 401. Se usa en rutas públicas que muestran algo extra al dueño,
 * como el detalle de una publicación pausada.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard("jwt") {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // Token ausente o inválido: la ruta es pública, se continúa sin usuario.
    }
    return true;
  }

  // Passport lanza si no hay usuario; acá null es un resultado válido.
  handleRequest<TUser>(_err: unknown, user: TUser): TUser {
    return user || (null as TUser);
  }
}

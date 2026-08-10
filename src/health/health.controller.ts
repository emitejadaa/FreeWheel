import { Controller, Get } from "@nestjs/common";
import { HealthService } from "./health.service";
import { buildEnvReport } from "./env-report";

/**
 * Estado de la API. Público a propósito: es lo que se abre en el navegador para
 * saber si el deploy quedó bien sin tener acceso al panel del proveedor.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getStatus() {
    return {
      status: "ok",
      environment: process.env.NODE_ENV ?? "development",
      timestamp: new Date().toISOString(),
    };
  }

  /** ¿La base responde y tiene lo que el código necesita? */
  @Get("db")
  getDatabaseStatus() {
    return this.healthService.checkDatabase();
  }

  /**
   * ¿Qué variables de entorno están cargadas en este deploy?
   *
   * Público como el resto de /health, y a propósito: el deploy lo administra otra
   * persona, así que ésta es la única forma de saber qué falta sin pedirle una
   * captura del panel. Devuelve solo NOMBRES y true/false: nunca un valor, ni una
   * parte, ni su largo.
   */
  @Get("env")
  getEnvStatus() {
    return buildEnvReport();
  }
}

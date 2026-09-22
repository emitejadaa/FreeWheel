import {
  Controller,
  Get,
  Headers,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SkipThrottle } from "@nestjs/throttler";
import { timingSafeEqual } from "crypto";
import { JobsService } from "./jobs.service";

/**
 * EL DISPARADOR DEL TRABAJO PROGRAMADO.
 *
 * Lo llama el cron de Vercel (ver vercel.json), que manda un GET con
 * `Authorization: Bearer $CRON_SECRET`. No hay sesión de por medio: lo único
 * que lo autentica es ese secreto, comparado en tiempo constante para que no se
 * pueda adivinar midiendo cuánto tarda la respuesta.
 *
 * Sin CRON_SECRET configurado el endpoint NO corre nada y contesta 401: un
 * disparador abierto es un botón para que cualquiera fuerce liquidaciones y
 * borrados cuando quiera.
 */
@Controller("internal/cron")
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly config: ConfigService,
  ) {}

  @SkipThrottle()
  @Get("daily")
  async daily(@Headers("authorization") authorization?: string) {
    this.assertCronSecret(authorization);
    return this.jobs.runDaily();
  }

  private assertCronSecret(authorization?: string): void {
    const esperado = (this.config.get<string>("CRON_SECRET") ?? "").trim();
    const recibido =
      /^Bearer (.+)$/.exec(authorization?.trim() ?? "")?.[1] ?? "";

    if (!esperado) {
      this.logger.error(
        "CRON_SECRET no está configurado: el trabajo programado no corre.",
      );
      throw new UnauthorizedException({
        statusCode: 401,
        code: "CRON_NOT_CONFIGURED",
        message: "El trabajo programado no está habilitado en este servidor.",
      });
    }

    const a = Buffer.from(esperado);
    const b = Buffer.from(recibido);
    // timingSafeEqual exige el mismo largo; comparar los largos aparte no
    // filtra nada útil (el largo del secreto no es el secreto).
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: "CRON_UNAUTHORIZED",
        message: "Credencial del trabajo programado inválida.",
      });
    }
  }
}

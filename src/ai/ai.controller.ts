import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { OptionalJwtAuthGuard } from "../auth/guards/optional-jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { AiChatDto } from "./dto/ai-chat.dto";
import { AiQuestionAskedDto } from "./dto/ai-question-asked.dto";
import { AiTranscribeDto } from "./dto/ai-transcribe.dto";
import { AiVisionDto } from "./dto/ai-vision.dto";
import { SensitiveRateLimit } from "../common/rate-limit/sensitive-rate-limit.decorator";
import { AiService } from "./ai.service";
import { QuestionsService } from "./questions.service";

/**
 * Proxy de IA. Todas las llamadas a Groq salen desde acá y nunca desde el
 * navegador: así la GROQ_API_KEY queda del lado del servidor en vez de quedar
 * incluida en el JavaScript que se descarga el visitante.
 *
 * Las rutas abiertas llevan un límite por IP más bajo que el global (120/min):
 * cada request consume cuota de una API key nuestra, así que sin tope una ruta
 * pública es una factura ajena.
 */
@Controller("ai")
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly questions: QuestionsService,
  ) {}

  /**
   * ¿Está funcionando la revisión por IA? Dice si falta la clave, qué contestó
   * Groq la última vez que falló, y qué modelos de visión ofrece hoy.
   *
   * La consulta simple queda PÚBLICA: es de lectura, no expone la clave ni datos
   * de nadie, y cuando la verificación de documentos se rompe hay que poder
   * mirarlo desde el navegador sin depender de los logs del deploy.
   *
   * `?probe=1` es otra cosa: PRUEBA cada modelo mandándole una imagen, o sea que
   * cada consulta gasta tantas llamadas a Groq como modelos haya en la lista.
   * Pública, alcanzaba para que cualquiera con la URL agotara la cuota del
   * proyecto y dejara la verificación de documentos sin IA para todos. Así que la
   * prueba pide sesión de administrador —es la única pantalla que la usa— y
   * además tiene su propio tope por minuto.
   */
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @UseGuards(OptionalJwtAuthGuard)
  @Get("health")
  health(
    @CurrentUser() user?: CurrentUserPayload,
    @Query("probe") probe?: string,
  ) {
    const probar = probe === "1" || probe === "true";
    if (probar && user?.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        "Probar los modelos gasta cuota de la API: hace falta ser administrador",
      );
    }
    // La muestra de la última respuesta ilegible puede traer texto del
    // documento de alguien: solo para administradores.
    return this.ai.health(probar, user?.role === UserRole.ADMIN);
  }

  /*
    EL CUPO DIARIO DE WILI.

    El tope por minuto de arriba frena una ráfaga, pero no frena a alguien que
    deja un guion preguntando toda la noche a un ritmo tranquilo: veinte por
    minuto son veintiocho mil por día, y cada una gasta cuota de NUESTRA clave.
    El cupo diario es el que pone el techo de la factura.

    ── POR QUÉ ESTE TOPE Y NO UNO DEL LADO DEL NAVEGADOR ────────────────────
    Porque un tope en el navegador es una sugerencia. Cualquiera abre las
    herramientas de desarrollo (F12) y llama al endpoint directamente, o lo
    llama con curl sin abrir la página. Lo único que de verdad limita es lo que
    cuenta EL SERVIDOR, y acá el contador vive en la base: lo ven todas las
    instancias a la vez y no se reinicia cuando Vercel levanta una nueva.

    ── POR QUÉ `ip+user` ────────────────────────────────────────────────────
    El asistente contesta también a visitantes sin cuenta, así que la IP es la
    única identidad que hay en la mitad de los casos. Y contra alguien que SÍ
    tiene cuenta, la IP sola no alcanza: cambiar de red es gratis. Contando las
    dos, hay que pasar los dos cupos.

    Ochenta preguntas por día es mucho más de lo que pregunta una persona —son
    cuatro o cinco en una visita— y a la vez es un techo.
  */
  @SensitiveRateLimit({
    name: "ai.chat",
    limit: 80,
    windowSec: 24 * 60 * 60,
    by: "ip+user",
  })
  // Pública: el chatbot de ayuda funciona también para visitantes sin cuenta.
  // El guard opcional está para que, cuando HAY sesión, el cupo se cuente
  // además contra la cuenta y no solo contra la IP.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(OptionalJwtAuthGuard)
  @Post("chat")
  chat(@Body() dto: AiChatDto) {
    return this.ai.chat(dto.messages, dto.temperature);
  }

  /**
   * Revisa si una foto muestra un vehículo real. Pide sesión: las dos pantallas
   * que la usan (publicar un auto y la verificación) ya exigen estar logueado, así
   * que cerrarla no le saca nada a nadie y saca de encima que un anónimo gaste
   * llamadas de visión, que son las más caras de todas.
   */
  /*
    El cupo diario de revisiones. Es la llamada MÁS CARA de las tres —una foto
    pesa mucho más que una pregunta— así que es la que más conviene acotar.

    Ciento veinte por día contra lo que hace una persona: un aviso lleva hasta
    seis fotos y se pueden publicar seis autos por día (ver
    antifraude/limites.ts), o sea treinta y seis revisiones, más las que se
    repitan porque una foto salió mal. Entra holgado y aun así pone un techo.
  */
  @SensitiveRateLimit({
    name: "ai.vision",
    limit: 120,
    windowSec: 24 * 60 * 60,
    by: "user",
  })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post("vision")
  vision(@Body() dto: AiVisionDto) {
    return this.ai.vision(dto.imageDataUrl, dto.lang ?? "es");
  }

  /**
   * LAS PREGUNTAS MÁS HECHAS AL ASISTENTE, PARA ORDENAR LOS BOTONES.
   *
   * Las dos rutas son PÚBLICAS, como el chat: el asistente contesta también a
   * visitantes sin cuenta, y si solo contaran las preguntas de los logueados el
   * ranking diría qué pregunta la mitad de la gente.
   *
   * Lo que se guarda es el id de la pregunta y un número, nada más. Ver
   * questions.service.ts.
   */

  /**
   * Suma uno. El front la llama DESPUÉS de haber contestado, así que no hay
   * nadie esperando esta respuesta: por eso el servicio no lanza nunca y esto
   * devuelve `{ contada }` en vez de un error.
   *
   * El tope es bajo a propósito. No alcanza para impedir que alguien infle una
   * pregunta —con paciencia se puede, y hay que decirlo—, pero el daño máximo
   * es que cuatro botones queden en otro orden, y a cambio una sola IP no puede
   * mover el ranking en un rato.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("questions/asked")
  questionAsked(@Body() dto: AiQuestionAskedDto) {
    return this.questions.contar(dto.questionId);
  }

  /**
   * El ranking. De lectura, sin datos de nadie adentro: son ocho ids y ocho
   * números. Si la migración todavía no está aplicada vuelve vacío, y el front
   * se queda con la cuenta de su propio navegador.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("questions/top")
  questionsTop() {
    return this.questions.ranking();
  }

  // Transcribir consume más que una respuesta de texto: solo usuarios logueados
  // (se usa en las notas de voz del chat, que ya requieren sesión).
  //
  // Cuarenta por día: transcribir es una comodidad de una conversación, no algo
  // que se haga en serie. Quien mande cuarenta notas de voz en un día ya tuvo
  // una conversación muy larga.
  @SensitiveRateLimit({
    name: "ai.transcribe",
    limit: 40,
    windowSec: 24 * 60 * 60,
    by: "user",
  })
  @Post("transcribe")
  @UseGuards(JwtAuthGuard)
  transcribe(@Body() dto: AiTranscribeDto) {
    return this.ai.transcribe(dto.audioUrl);
  }
}

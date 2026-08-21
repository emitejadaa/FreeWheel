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
import { AiDocumentDto } from "./dto/ai-document.dto";
import { AiTranscribeDto } from "./dto/ai-transcribe.dto";
import { AiVisionDto } from "./dto/ai-vision.dto";
import { DocumentPrecheckService } from "../verification/extraction/document-precheck.service";
import { AiService } from "./ai.service";

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
    private readonly precheck: DocumentPrecheckService,
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

  // Pública: el chatbot de ayuda funciona también para visitantes sin cuenta.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post("vision")
  vision(@Body() dto: AiVisionDto) {
    return this.ai.vision(dto.imageDataUrl, dto.lang ?? "es");
  }

  // Transcribir consume más que una respuesta de texto: solo usuarios logueados
  // (se usa en las notas de voz del chat, que ya requieren sesión).
  @Post("transcribe")
  @UseGuards(JwtAuthGuard)
  transcribe(@Body() dto: AiTranscribeDto) {
    return this.ai.transcribe(dto.audioUrl);
  }

  /**
   * Revisa si una foto es realmente el documento pedido (DNI o licencia). El
   * front lo llama al elegir cada foto, para avisar en el momento que no sirve en
   * vez de dejar subir cualquier imagen.
   *
   * PRIMERO SIN IA: si la foto trae el PDF417 del DNI (o el código de la
   * licencia), eso ya contesta la pregunta —lo imprime el organismo que emite
   * el documento y lo lee un decodificador, no un modelo—, así que se responde
   * con eso y no se gasta ninguna llamada de visión. Al modelo se le pregunta
   * solo por lo que no tiene código legible.
   */
  @Post("document")
  @UseGuards(JwtAuthGuard)
  async document(@Body() dto: AiDocumentDto) {
    const lang = dto.lang ?? "es";
    const fromCode = await this.precheck.check(dto.image, dto.kind, lang);
    return (
      fromCode ?? (await this.ai.inspectDocument(dto.image, dto.kind, lang))
    );
  }
}

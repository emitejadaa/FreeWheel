import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AiChatDto } from "./dto/ai-chat.dto";
import { AiDocumentDto } from "./dto/ai-document.dto";
import { AiTranscribeDto } from "./dto/ai-transcribe.dto";
import { AiVisionDto } from "./dto/ai-vision.dto";
import { AiService } from "./ai.service";

/**
 * Proxy de IA. Todas las llamadas a Groq salen desde acá y nunca desde el
 * navegador: así la GROQ_API_KEY queda del lado del servidor en vez de quedar
 * incluida en el JavaScript que se descarga el visitante.
 */
@Controller("ai")
export class AiController {
  constructor(private readonly ai: AiService) {}

  /**
   * ¿Está funcionando la revisión por IA? Dice si falta la clave, qué contestó
   * Groq la última vez que falló, y qué modelos de visión ofrece hoy.
   *
   * Es de lectura y no expone la clave ni datos de nadie, así que queda pública:
   * cuando la verificación de documentos se rompe hay que poder mirarlo desde el
   * navegador sin depender de los logs del deploy.
   */
  @Get("health")
  health(@Query("probe") probe?: string) {
    // Con ?probe=1 además PRUEBA cada modelo con una imagen mínima y dice cuál
    // contesta. Sin eso solo compara nombres contra la lista de Groq, y estar en
    // la lista no garantiza que el modelo funcione.
    return this.ai.health(probe === "1" || probe === "true");
  }

  // Pública: el chatbot de ayuda funciona también para visitantes sin cuenta.
  @Post("chat")
  chat(@Body() dto: AiChatDto) {
    return this.ai.chat(dto.messages, dto.temperature);
  }

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
   */
  @Post("document")
  @UseGuards(JwtAuthGuard)
  document(@Body() dto: AiDocumentDto) {
    return this.ai.inspectDocument(dto.image, dto.kind, dto.lang ?? "es");
  }
}

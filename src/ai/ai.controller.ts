import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AiChatDto } from "./dto/ai-chat.dto";
import { AiVisionDto } from "./dto/ai-vision.dto";
import { AiService } from "./ai.service";

/**
 * Proxy del proveedor de IA. Requiere sesión: cada request consume cuota de
 * una API key nuestra, así que un endpoint abierto es una factura ajena.
 * Los límites por ruta son más bajos que el global (120/min) por el mismo
 * motivo.
 */
@Controller("ai")
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("chat")
  chat(@Body() dto: AiChatDto) {
    return this.ai.chat(dto.messages, dto.temperature);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("vision")
  vision(@Body() dto: AiVisionDto) {
    return this.ai.vision(dto.imageDataUrl);
  }
}

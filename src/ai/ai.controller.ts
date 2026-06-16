import { Body, Controller, Post } from "@nestjs/common";
import { AiChatDto } from "./dto/ai-chat.dto";
import { AiVisionDto } from "./dto/ai-vision.dto";
import { AiService } from "./ai.service";

@Controller("ai")
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post("chat")
  chat(@Body() dto: AiChatDto) {
    return this.ai.chat(dto.messages, dto.temperature);
  }

  @Post("vision")
  vision(@Body() dto: AiVisionDto) {
    return this.ai.vision(dto.imageDataUrl);
  }
}

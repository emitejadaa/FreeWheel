import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";

// EmailModule entra por el aviso de "tenés mensajes sin leer".
@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}

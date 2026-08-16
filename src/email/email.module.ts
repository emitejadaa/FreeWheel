import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EmailService } from "./email.service";

// PrismaModule entra porque antes de mandar un AVISO hay que mirar si esa
// persona los quiere recibir (User.emailNotifications). Los mails de seguridad
// —códigos, recuperar contraseña— no consultan nada y salen siempre.
@Module({
  imports: [PrismaModule],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}

import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { RateLimitService } from "./rate-limit.service";
import { SensitiveRateLimitGuard } from "./sensitive-rate-limit.guard";

/**
 * Global: el guard se usa desde controllers de muchos módulos distintos, y
 * cada uno tiene que poder resolver RateLimitService sin importarlo a mano.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [RateLimitService, SensitiveRateLimitGuard],
  exports: [RateLimitService, SensitiveRateLimitGuard],
})
export class RateLimitModule {}

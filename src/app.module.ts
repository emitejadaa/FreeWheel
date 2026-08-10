import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PhotoVisibilityInterceptor } from "./common/interceptors/photo-visibility.interceptor";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { PrismaModule } from "./prisma/prisma.module";
import { VehiclesModule } from "./vehicles/vehicles.module";
import { ListingsModule } from "./listings/listings.module";
import { FavoritesModule } from "./favorites/favorites.module";
import { VerificationModule } from "./verification/verification.module";
import { AdminModule } from "./admin/admin.module";
import { BookingsModule } from "./bookings/bookings.module";
import { PaymentsModule } from "./payments/payments.module";
import { ContractsModule } from "./contracts/contracts.module";
import { MediaModule } from "./media/media.module";
import { ConversationsModule } from "./conversations/conversations.module";
import { HealthModule } from "./health/health.module";
import { ReviewsModule } from "./reviews/reviews.module";
import { ReportsModule } from "./reports/reports.module";

@Module({
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // El ajuste "quién ve mi foto" se hace valer acá, sobre TODAS las respuestas,
    // en vez de en cada consulta que devuelve una persona. Ver el comentario del
    // interceptor: un control de privacidad repartido en seis lugares se olvida
    // en el séptimo.
    { provide: APP_INTERCEPTOR, useClass: PhotoVisibilityInterceptor },
  ],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    VehiclesModule,
    ListingsModule,
    FavoritesModule,
    VerificationModule,
    AdminModule,
    BookingsModule,
    PaymentsModule,
    ContractsModule,
    MediaModule,
    ConversationsModule,
    AiModule,
    ReviewsModule,
    ReportsModule,
  ],
})
export class AppModule {}

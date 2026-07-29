import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiModule } from "../ai/ai.module";
import { AiService } from "../ai/ai.service";
import { PrismaModule } from "../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import { SmsModule } from "../sms/sms.module";
import { VerificationController } from "./verification.controller";
import { VerificationService } from "./verification.service";
import { IdentityReviewService } from "./review/identity-review.service";
import { IDENTITY_REVIEWER } from "./review/identity-reviewer.interface";
import { AiIdentityReviewer } from "./review/ai.reviewer";
import { AutoApproveReviewer } from "./review/auto-approve.reviewer";
import { ManualReviewer } from "./review/manual.reviewer";

const identityReviewer: Provider = {
  provide: IDENTITY_REVIEWER,
  inject: [ConfigService, AiService],
  useFactory: (config: ConfigService, ai: AiService) => {
    const mode = (
      config.get<string>("IDENTITY_REVIEW_MODE") ?? "ai"
    ).toLowerCase();
    if (mode === "manual") return new ManualReviewer();
    // "ai" revisa las fotos de verdad (no se puede subir cualquier imagen) y es
    // el modo por defecto; "auto_approve" queda para desarrollo sin IA.
    if (mode === "ai") return new AiIdentityReviewer(ai);
    if (mode !== "auto_approve") {
      throw new Error(
        `Unknown IDENTITY_REVIEW_MODE "${mode}" (use "ai", "auto_approve" or "manual")`,
      );
    }
    return new AutoApproveReviewer();
  },
};

@Module({
  imports: [PrismaModule, EmailModule, SmsModule, AiModule],
  controllers: [VerificationController],
  providers: [VerificationService, IdentityReviewService, identityReviewer],
  exports: [VerificationService, IdentityReviewService],
})
export class VerificationModule {}

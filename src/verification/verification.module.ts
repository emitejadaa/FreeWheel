import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import { SmsModule } from "../sms/sms.module";
import { VerificationController } from "./verification.controller";
import { VerificationService } from "./verification.service";
import { IdentityReviewService } from "./review/identity-review.service";
import { IDENTITY_REVIEWER } from "./review/identity-reviewer.interface";
import { AutoApproveReviewer } from "./review/auto-approve.reviewer";
import { ManualReviewer } from "./review/manual.reviewer";

const identityReviewer: Provider = {
  provide: IDENTITY_REVIEWER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const mode = (
      config.get<string>("IDENTITY_REVIEW_MODE") ?? "auto_approve"
    ).toLowerCase();
    if (mode === "manual") return new ManualReviewer();
    if (mode !== "auto_approve") {
      throw new Error(
        `Unknown IDENTITY_REVIEW_MODE "${mode}" (use "auto_approve" or "manual")`,
      );
    }
    return new AutoApproveReviewer();
  },
};

@Module({
  imports: [PrismaModule, EmailModule, SmsModule],
  controllers: [VerificationController],
  providers: [VerificationService, IdentityReviewService, identityReviewer],
  exports: [VerificationService, IdentityReviewService],
})
export class VerificationModule {}

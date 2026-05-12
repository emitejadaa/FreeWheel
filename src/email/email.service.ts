import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { getFrontendUrl } from "../config/public-urls";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {}

  private createTransporter() {
    const user = this.configService.get<string>("GMAIL_USER");
    const pass = this.configService.get<string>("GMAIL_APP_PASSWORD");

    if (!user || !pass) {
      this.logger.warn(
        "Email no configurado (faltan GMAIL_USER o GMAIL_APP_PASSWORD)",
      );
      return null;
    }

    return nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }

  private async send(to: string, subject: string, html: string) {
    const transporter = this.createTransporter();
    if (!transporter) return;

    const from = this.configService.get<string>("GMAIL_USER");
    try {
      await transporter.sendMail({
        from: `Freewheel <${from}>`,
        to,
        subject,
        html,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error enviando email: ${message}`);
    }
  }

  async sendVerificationCode(email: string, code: string) {
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a4d2e;margin-bottom:8px">Verifica tu email</h2>
        <p style="color:#374151">Tu codigo de verificacion es:</p>
        <div style="font-size:40px;font-weight:bold;letter-spacing:10px;color:#1a4d2e;padding:20px 0">
          ${code}
        </div>
        <p style="color:#6b7280;font-size:13px">Expira en 15 minutos. No lo compartas con nadie.</p>
      </div>`;
    await this.send(email, "Tu codigo de verificacion - Freewheel", html);
  }

  async sendPasswordReset(
    email: string,
    firstName: string,
    token: string,
    userId: string,
  ) {
    const resetUrl = `${getFrontendUrl(
      this.configService,
    )}/reset-password?token=${token}&uid=${userId}`;

    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a4d2e;margin-bottom:8px">Restablecer contrasena</h2>
        <p style="color:#374151">Hola ${firstName}, recibimos una solicitud para cambiar tu contrasena.</p>
        <a href="${resetUrl}"
           style="display:inline-block;background:#1a4d2e;color:#fff;padding:12px 28px;
                  border-radius:8px;text-decoration:none;font-weight:bold;margin:20px 0">
          Cambiar contrasena
        </a>
        <p style="color:#6b7280;font-size:13px">
          Este enlace expira en 1 hora.<br>
          Si no lo pediste, ignora este email.
        </p>
      </div>`;
    await this.send(email, "Restablecer tu contrasena - Freewheel", html);
  }
}

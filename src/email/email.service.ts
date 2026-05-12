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
      this.logger.warn("Email no configurado (faltan GMAIL_USER o GMAIL_APP_PASSWORD)");
      return null;
    }
    return nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  }

  private async send(to: string, subject: string, html: string) {
    const transporter = this.createTransporter();
    if (!transporter) return;
    const from = this.configService.get<string>("GMAIL_USER");
    try {
      await transporter.sendMail({ from: `Freewheel <${from}>`, to, subject, html });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error enviando email: ${message}`);
    }
  }

  async sendVerificationCode(email: string, code: string) {
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:#111827;padding:24px 32px;display:flex;align-items:center;gap:10">
          <span style="font-size:20px;font-weight:800;color:#fff">Free</span><span style="font-size:20px;font-weight:800;color:#2563eb">wheel</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#111827;margin:0 0 8px">Verificá tu email</h2>
          <p style="color:#374151;margin:0 0 24px">Tu código de verificación es:</p>
          <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#2563eb;background:#eff6ff;padding:20px;border-radius:10px;text-align:center">
            ${code}
          </div>
          <p style="color:#6b7280;font-size:13px;margin-top:20px">Expira en 15 minutos. No lo compartas con nadie.</p>
        </div>
      </div>`;
    await this.send(email, "Tu código de verificación - Freewheel", html);
  }

  async sendPasswordReset(email: string, firstName: string, token: string, userId: string) {
    const resetUrl = `${getFrontendUrl(this.configService)}/reset-password?token=${token}&uid=${userId}`;
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:#111827;padding:24px 32px;display:flex;align-items:center;gap:10">
          <span style="font-size:20px;font-weight:800;color:#fff">Free</span><span style="font-size:20px;font-weight:800;color:#2563eb">wheel</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#111827;margin:0 0 8px">Restablecer contraseña</h2>
          <p style="color:#374151">Hola ${firstName}, recibimos una solicitud para cambiar tu contraseña.</p>
          <a href="${resetUrl}"
             style="display:inline-block;background:#2563eb;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;margin:20px 0">
            Cambiar contraseña
          </a>
          <p style="color:#6b7280;font-size:13px">
            Este enlace expira en 1 hora.<br>
            Si no lo pediste, ignorá este email.
          </p>
        </div>
      </div>`;
    await this.send(email, "Restablecer tu contraseña - Freewheel", html);
  }
}
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
        "Email not configured (missing GMAIL_USER or GMAIL_APP_PASSWORD)",
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
      this.logger.log(`Email sent to ${to}: ${subject}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send email to ${to}: ${message}`);
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
          <p style="color:#6b7280;font-size:13px;margin-top:20px">Expira en 10 minutos. No lo compartas con nadie.</p>
        </div>
      </div>`;
    await this.send(email, "Tu código de verificación - Freewheel", html);
  }

  /**
   * Código para verificar el TELÉFONO, enviado por email.
   *
   * Se usa cuando no hay una pasarela de SMS contratada (mandar un SMS a un
   * número real es siempre un servicio pago). El código sigue siendo el mismo y
   * queda igual de registrado en la base: lo único distinto es el canal por el
   * que viaja, así la verificación del teléfono funciona sin costo.
   */
  async sendPhoneVerificationCode(email: string, phone: string, code: string) {
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:#111827;padding:24px 32px">
          <span style="font-size:20px;font-weight:800;color:#fff">Free</span><span style="font-size:20px;font-weight:800;color:#2563eb">wheel</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#111827;margin:0 0 8px">Verificá tu teléfono</h2>
          <p style="color:#374151;margin:0 0 24px">
            Código para confirmar el número <strong>${phone}</strong>:
          </p>
          <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#2563eb;background:#eff6ff;padding:20px;border-radius:10px;text-align:center">
            ${code}
          </div>
          <p style="color:#6b7280;font-size:13px;margin-top:20px">
            Te lo enviamos por email porque el envío por SMS todavía no está
            habilitado. Expira en 10 minutos y no se comparte con nadie.
          </p>
        </div>
      </div>`;
    await this.send(
      email,
      "Código para verificar tu teléfono - Freewheel",
      html,
    );
  }

  async sendPasswordReset(
    email: string,
    firstName: string,
    token: string,
    userId: string,
  ) {
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
  async sendBookingRequestedToOwner(
    email: string,
    params: {
      ownerName?: string;
      renterName: string;
      vehicleLabel: string;
      startDate: Date;
      endDate: Date;
      totalPrice: number;
      currency: string;
    },
  ) {
    const url = `${getFrontendUrl(this.configService)}/my-bookings`;
    const greeting = params.ownerName ? `Hola ${params.ownerName},` : "Hola,";
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:#111827;padding:24px 32px">
          <span style="font-size:20px;font-weight:800;color:#fff">Free</span><span style="font-size:20px;font-weight:800;color:#2563eb">wheel</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#111827;margin:0 0 8px">Nueva solicitud de reserva</h2>
          <p style="color:#374151;margin:0 0 16px">${greeting} <strong>${params.renterName}</strong> quiere reservar tu <strong>${params.vehicleLabel}</strong>.</p>
          <div style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:10px;padding:16px;margin-bottom:20px">
            <div style="display:flex;justify-content:space-between;font-size:14px;color:#374151;margin-bottom:8px"><span style="color:#6b7280">Desde</span><strong>${this.formatDate(params.startDate)}</strong></div>
            <div style="display:flex;justify-content:space-between;font-size:14px;color:#374151;margin-bottom:8px"><span style="color:#6b7280">Hasta</span><strong>${this.formatDate(params.endDate)}</strong></div>
            <div style="display:flex;justify-content:space-between;font-size:14px;color:#111827"><span style="color:#6b7280">Total estimado</span><strong style="color:#2563eb">${this.formatMoney(params.totalPrice, params.currency)}</strong></div>
          </div>
          <p style="color:#374151;margin:0 0 20px">Revisá la disponibilidad y confirmá o rechazá la solicitud desde tu panel.</p>
          <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
            Ver la solicitud
          </a>
          <p style="color:#6b7280;font-size:13px;margin-top:20px">Si no reconocés esta solicitud, podés ignorar este email.</p>
        </div>
      </div>`;
    await this.send(email, "Nueva solicitud de reserva - Freewheel", html);
  }

  async sendBookingAcceptedToRenter(
    email: string,
    params: {
      renterName?: string;
      vehicleLabel: string;
      startDate: Date;
      endDate: Date;
    },
  ) {
    const url = `${getFrontendUrl(this.configService)}/my-bookings`;
    const greeting = params.renterName ? `Hola ${params.renterName},` : "Hola,";
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:#111827;padding:24px 32px">
          <span style="font-size:20px;font-weight:800;color:#fff">Free</span><span style="font-size:20px;font-weight:800;color:#2563eb">wheel</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#111827;margin:0 0 8px">¡Tu reserva fue aceptada! 🎉</h2>
          <p style="color:#374151;margin:0 0 16px">${greeting} el dueño confirmó la disponibilidad de <strong>${params.vehicleLabel}</strong> para las fechas solicitadas.</p>
          <div style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:10px;padding:16px;margin-bottom:20px">
            <div style="display:flex;justify-content:space-between;font-size:14px;color:#374151;margin-bottom:8px"><span style="color:#6b7280">Desde</span><strong>${this.formatDate(params.startDate)}</strong></div>
            <div style="display:flex;justify-content:space-between;font-size:14px;color:#374151"><span style="color:#6b7280">Hasta</span><strong>${this.formatDate(params.endDate)}</strong></div>
          </div>
          <p style="color:#374151;margin:0 0 20px">Ingresá para completar el pago y coordinar el retiro del vehículo.</p>
          <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
            Completar mi reserva
          </a>
        </div>
      </div>`;
    await this.send(email, "Tu reserva fue aceptada - Freewheel", html);
  }

  async sendBookingRejectedToRenter(
    email: string,
    params: {
      renterName?: string;
      vehicleLabel: string;
      startDate: Date;
      endDate: Date;
    },
  ) {
    const url = `${getFrontendUrl(this.configService)}`;
    const greeting = params.renterName ? `Hola ${params.renterName},` : "Hola,";
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:#111827;padding:24px 32px">
          <span style="font-size:20px;font-weight:800;color:#fff">Free</span><span style="font-size:20px;font-weight:800;color:#2563eb">wheel</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#111827;margin:0 0 8px">Tu solicitud no fue aceptada</h2>
          <p style="color:#374151;margin:0 0 16px">${greeting} lamentablemente el dueño no pudo confirmar <strong>${params.vehicleLabel}</strong> para las fechas del ${this.formatDate(params.startDate)} al ${this.formatDate(params.endDate)}.</p>
          <p style="color:#374151;margin:0 0 20px">No te preocupes, hay muchos otros vehículos disponibles en Freewheel.</p>
          <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
            Buscar otros autos
          </a>
        </div>
      </div>`;
    await this.send(email, "Actualización de tu solicitud - Freewheel", html);
  }

  private formatDate(date: Date): string {
    const d = new Date(date);
    const day = String(d.getUTCDate()).padStart(2, "0");
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${day}/${month}/${d.getUTCFullYear()}`;
  }

  private formatMoney(amount: number, currency = "ARS"): string {
    return `$${Number(amount || 0).toLocaleString("es-AR")} ${currency}`;
  }
}

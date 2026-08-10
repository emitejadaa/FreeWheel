import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
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

  /**
   * ¿Está configurado el envío de mails? Sin GMAIL_USER y GMAIL_APP_PASSWORD no
   * sale ningún mail.
   */
  get configured(): boolean {
    return Boolean(
      this.configService.get<string>("GMAIL_USER") &&
      this.configService.get<string>("GMAIL_APP_PASSWORD"),
    );
  }

  /**
   * Manda un mail que la persona ESTÁ ESPERANDO para poder seguir (un código de
   * verificación, un link para recuperar la contraseña) y falla si no se puede
   * mandar.
   *
   * Existe por un problema concreto: send() se va sin hacer nada cuando el mail no
   * está configurado, así que /auth/register/start contestaba "código enviado" con
   * un 201 y el mail no salía nunca. La persona se quedaba esperando un código que
   * no existía, escribía cualquier cosa y recibía un "Incorrect code" 400 que no
   * tenía nada que ver con el problema real. Los avisos que no bloquean a nadie
   * (una reserva pedida, una aceptada) siguen usando send() y se pierden en
   * silencio, que para eso está bien.
   */
  private async sendOrThrow(to: string, subject: string, html: string) {
    if (!this.configured) {
      this.logger.error(
        `No se pudo mandar "${subject}" a ${to}: falta configurar el envío de ` +
          "mails (GMAIL_USER y GMAIL_APP_PASSWORD en las variables de entorno).",
      );
      throw new ServiceUnavailableException(
        "No podemos enviar mails en este momento, así que no te llegaría el " +
          "código. Avisale a quien administra el servidor que falta configurar " +
          "el envío de mails.",
      );
    }
    await this.send(to, subject, html);
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

  /**
   * El sobre de todos los mails: encabezado con la marca, tarjeta blanca y el
   * contenido adentro.
   *
   * Existe porque el mismo bloque de HTML estaba copiado en cada mail. Con nueve
   * avisos distintos eso son nueve lugares donde cambiar un color, y el noveno
   * siempre queda distinto.
   */
  private layout(titulo: string, cuerpo: string): string {
    return `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:#111827;padding:24px 32px">
          <span style="font-size:20px;font-weight:800;color:#fff">Free</span><span style="font-size:20px;font-weight:800;color:#2563eb">wheel</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#111827;margin:0 0 12px;font-size:20px">${titulo}</h2>
          ${cuerpo}
        </div>
      </div>`;
  }

  /**
   * El cuadro de datos (fechas, montos, quién es la otra persona).
   *
   * Va con <table> y no con flex a propósito: los clientes de correo no soportan
   * flexbox parejo —en Outlook la etiqueta y el valor se apilaban en vez de
   * quedar uno a cada lado—, y una tabla se ve igual en todos.
   * `destacar` pinta el valor de azul y en negrita, para el importe principal.
   */
  private cuadro(
    filas: { etiqueta: string; valor: string; destacar?: boolean }[],
  ): string {
    const celdas = filas
      .map(
        (fila) => `
          <tr>
            <td style="padding:5px 0;font-size:14px;color:#6b7280">${fila.etiqueta}</td>
            <td style="padding:5px 0;font-size:14px;text-align:right;font-weight:700;color:${fila.destacar ? "#2563eb" : "#111827"}">${fila.valor}</td>
          </tr>`,
      )
      .join("");
    return `
      <table role="presentation" width="100%" style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:10px;padding:14px 16px;margin:0 0 20px;border-collapse:separate">
        ${celdas}
      </table>`;
  }

  /** El botón principal del mail. */
  private boton(url: string, texto: string): string {
    return `<a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">${texto}</a>`;
  }

  /** Un párrafo, con el mismo color y espaciado en todos los mails. */
  private p(texto: string): string {
    return `<p style="color:#374151;margin:0 0 16px;line-height:1.6">${texto}</p>`;
  }

  /** El renglón chico del final, para aclaraciones. */
  private nota(texto: string): string {
    return `<p style="color:#6b7280;font-size:13px;margin:20px 0 0;line-height:1.6">${texto}</p>`;
  }

  /** A dónde van los links de los mails de reserva. */
  private get misReservas(): string {
    return `${getFrontendUrl(this.configService)}/my-bookings`;
  }

  private saludo(nombre?: string): string {
    return nombre ? `Hola ${nombre},` : "Hola,";
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
    await this.sendOrThrow(
      email,
      "Tu código de verificación - Freewheel",
      html,
    );
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
    await this.sendOrThrow(
      email,
      "Código para verificar tu teléfono - Freewheel",
      html,
    );
  }

  /**
   * Código para confirmar un CAMBIO DE PRECIO de una publicación.
   *
   * El precio es lo único que mueve plata sin intervención de nadie más, así que
   * cambiarlo pide una confirmación por un segundo canal: la persona tiene que
   * tener acceso al mail, no solo a la sesión abierta. El mail muestra el precio
   * viejo y el nuevo para que se pueda frenar un cambio que no se pidió.
   */
  async sendPriceChangeCode(
    email: string,
    listingTitle: string,
    currentPrice: number,
    newPrice: number,
    code: string,
  ) {
    const money = (value: number) =>
      `$${Math.round(value).toLocaleString("es-AR")}`;
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:#111827;padding:24px 32px">
          <span style="font-size:20px;font-weight:800;color:#fff">Free</span><span style="font-size:20px;font-weight:800;color:#2563eb">wheel</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#111827;margin:0 0 8px">Confirmá el cambio de precio</h2>
          <p style="color:#374151;margin:0 0 16px">
            Se pidió cambiar el precio por día de <strong>${listingTitle}</strong>:
          </p>
          <p style="color:#111827;margin:0 0 24px;font-size:18px">
            <span style="color:#6b7280;text-decoration:line-through">${money(currentPrice)}</span>
            &nbsp;→&nbsp;
            <strong style="color:#2563eb">${money(newPrice)}</strong>
          </p>
          <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#2563eb;background:#eff6ff;padding:20px;border-radius:10px;text-align:center">
            ${code}
          </div>
          <p style="color:#6b7280;font-size:13px;margin-top:20px">
            Expira en 10 minutos. Hasta que ingreses el código, el precio sigue
            siendo el anterior. <strong>Si no pediste este cambio, no ingreses el
            código y cambiá tu contraseña.</strong>
          </p>
        </div>
      </div>`;
    await this.sendOrThrow(
      email,
      "Confirmá el cambio de precio - Freewheel",
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
    await this.sendOrThrow(
      email,
      "Restablecer tu contraseña - Freewheel",
      html,
    );
  }
  // ── AVISOS DE UNA RESERVA ───────────────────────────────────────────────────
  //
  // Un alquiler entre dos personas que no se conocen se sostiene con que las dos
  // sepan, por escrito, qué pasó y cuándo. Antes solo salían tres avisos: el
  // pedido al dueño, y la aceptación o el rechazo al inquilino. Quien reservaba
  // no recibía NADA al pedir —ni las fechas, ni el monto—, un pago no dejaba
  // comprobante, y una cancelación no le llegaba a la otra parte. O sea que la
  // parte del trámite donde hay plata de por medio era la que menos rastro
  // dejaba.
  //
  // Todos estos usan send() y no sendOrThrow(): si el mail falla, la reserva
  // sigue su curso igual. Un aviso que no salió es un problema; una reserva que
  // se cae porque el aviso no salió es un problema peor.

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
    const html = this.layout(
      "Nueva solicitud de reserva",
      this.p(
        `${this.saludo(params.ownerName)} <strong>${params.renterName}</strong> quiere reservar tu <strong>${params.vehicleLabel}</strong>.`,
      ) +
        this.cuadro([
          { etiqueta: "Desde", valor: this.formatDate(params.startDate) },
          { etiqueta: "Hasta", valor: this.formatDate(params.endDate) },
          {
            etiqueta: "Total estimado",
            valor: this.formatMoney(params.totalPrice, params.currency),
            destacar: true,
          },
        ]) +
        this.p(
          "Revisá la disponibilidad y confirmá o rechazá la solicitud desde tu panel.",
        ) +
        this.boton(this.misReservas, "Ver la solicitud") +
        this.nota("Si no reconocés esta solicitud, podés ignorar este email."),
    );
    await this.send(email, "Nueva solicitud de reserva - Freewheel", html);
  }

  /**
   * Al INQUILINO, cuando acaba de pedir la reserva.
   *
   * Es el aviso que faltaba y el más importante de los nuevos: quien reservaba
   * mandaba el pedido y no le llegaba nada. No tenía por escrito ni qué auto pidió,
   * ni para qué fechas, ni cuánto va a pagar, ni qué tiene que pasar después.
   */
  async sendBookingRequestedToRenter(
    email: string,
    params: {
      renterName?: string;
      ownerName: string;
      vehicleLabel: string;
      startDate: Date;
      endDate: Date;
      totalPrice: number;
      currency: string;
    },
  ) {
    const html = this.layout(
      "Recibimos tu solicitud",
      this.p(
        `${this.saludo(params.renterName)} le pedimos a <strong>${params.ownerName}</strong> que confirme la reserva de <strong>${params.vehicleLabel}</strong>.`,
      ) +
        this.cuadro([
          { etiqueta: "Desde", valor: this.formatDate(params.startDate) },
          { etiqueta: "Hasta", valor: this.formatDate(params.endDate) },
          {
            etiqueta: "Total estimado",
            valor: this.formatMoney(params.totalPrice, params.currency),
            destacar: true,
          },
        ]) +
        this.p(
          "<strong>Todavía no te cobramos nada.</strong> Cuando el dueño acepte, " +
            "te avisamos por mail y ahí vas a poder pagar la seña.",
        ) +
        this.boton(this.misReservas, "Ver mi solicitud") +
        this.nota(
          "Si el dueño no responde o rechaza el pedido, también te lo avisamos.",
        ),
    );
    await this.send(
      email,
      "Recibimos tu solicitud de reserva - Freewheel",
      html,
    );
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
    const html = this.layout(
      "Tu reserva fue aceptada",
      this.p(
        `${this.saludo(params.renterName)} el dueño confirmó la disponibilidad de <strong>${params.vehicleLabel}</strong> para las fechas solicitadas.`,
      ) +
        this.cuadro([
          { etiqueta: "Desde", valor: this.formatDate(params.startDate) },
          { etiqueta: "Hasta", valor: this.formatDate(params.endDate) },
        ]) +
        this.p(
          "Ingresá para completar el pago y coordinar el retiro del vehículo.",
        ) +
        this.boton(this.misReservas, "Completar mi reserva"),
    );
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
    const html = this.layout(
      "Tu solicitud no fue aceptada",
      this.p(
        `${this.saludo(params.renterName)} el dueño no pudo confirmar <strong>${params.vehicleLabel}</strong> para las fechas del ${this.formatDate(params.startDate)} al ${this.formatDate(params.endDate)}.`,
      ) +
        this.p(
          "No te cobramos nada. Hay otros autos disponibles para esas fechas.",
        ) +
        this.boton(getFrontendUrl(this.configService), "Buscar otros autos"),
    );
    await this.send(email, "Actualización de tu solicitud - Freewheel", html);
  }

  /**
   * Cancelación. Le llega a las DOS partes: a quien canceló como constancia de
   * que quedó registrado, y a la otra porque le cambia el plan.
   *
   * `cancelaste` distingue los dos textos con un solo mail: decirle "tu reserva
   * fue cancelada" a quien acaba de cancelarla suena a error del sistema.
   * El motivo va entero: es lo único que explica por qué se cayó el alquiler, y
   * esconderlo obliga a preguntar por chat algo que ya está escrito.
   */
  async sendBookingCancelled(
    email: string,
    params: {
      recipientName?: string;
      otherPartyName: string;
      vehicleLabel: string;
      startDate: Date;
      endDate: Date;
      reason?: string | null;
      cancelaste: boolean;
      refunded?: boolean;
    },
  ) {
    const titulo = params.cancelaste
      ? "Cancelaste la reserva"
      : "La reserva fue cancelada";
    const apertura = params.cancelaste
      ? `${this.saludo(params.recipientName)} registramos la cancelación de <strong>${params.vehicleLabel}</strong>. Ya le avisamos a ${params.otherPartyName}.`
      : `${this.saludo(params.recipientName)} <strong>${params.otherPartyName}</strong> canceló la reserva de <strong>${params.vehicleLabel}</strong>.`;

    const filas = [
      { etiqueta: "Desde", valor: this.formatDate(params.startDate) },
      { etiqueta: "Hasta", valor: this.formatDate(params.endDate) },
    ];
    if (params.reason?.trim()) {
      filas.push({ etiqueta: "Motivo", valor: params.reason.trim() });
    }

    const sobreElDinero = params.refunded
      ? this.p(
          "Lo que estaba pagado se devuelve al mismo medio de pago. Puede tardar " +
            "unos días hábiles en aparecer en el resumen.",
        )
      : this.p("No hay cobros pendientes por esta reserva.");

    const html = this.layout(
      titulo,
      this.p(apertura) +
        this.cuadro(filas) +
        sobreElDinero +
        this.boton(this.misReservas, "Ver mis reservas"),
    );
    await this.send(email, `${titulo} - Freewheel`, html);
  }

  /**
   * Comprobante de un pago, al INQUILINO.
   *
   * `concepto` es lo que se pagó escrito en castellano ("Seña", "Saldo",
   * "Depósito en garantía"), no el código interno: el mail lo lee una persona.
   */
  async sendPaymentReceipt(
    email: string,
    params: {
      renterName?: string;
      concepto: string;
      amount: number;
      currency: string;
      vehicleLabel: string;
      startDate: Date;
      endDate: Date;
      totalPaid?: number;
      bookingId: string;
    },
  ) {
    const filas = [
      { etiqueta: "Concepto", valor: params.concepto },
      {
        etiqueta: "Importe",
        valor: this.formatMoney(params.amount, params.currency),
        destacar: true,
      },
      { etiqueta: "Auto", valor: params.vehicleLabel },
      {
        etiqueta: "Fechas",
        valor: `${this.formatDate(params.startDate)} al ${this.formatDate(params.endDate)}`,
      },
      {
        etiqueta: "Reserva",
        valor: params.bookingId.slice(0, 8).toUpperCase(),
      },
    ];
    if (params.totalPaid != null) {
      filas.push({
        etiqueta: "Pagado en total",
        valor: this.formatMoney(params.totalPaid, params.currency),
      });
    }

    const html = this.layout(
      "Comprobante de pago",
      this.p(
        `${this.saludo(params.renterName)} recibimos tu pago. Este mail te sirve como comprobante.`,
      ) +
        this.cuadro(filas) +
        this.boton(this.misReservas, "Ver la reserva") +
        this.nota(
          "Guardá este mail. Si algo no coincide con lo que esperabas, respondelo " +
            "y lo revisamos.",
        ),
    );
    await this.send(
      email,
      `Comprobante de pago - ${params.concepto} - Freewheel`,
      html,
    );
  }

  /** Aviso al DUEÑO de que el inquilino pagó. */
  async sendPaymentReceivedToOwner(
    email: string,
    params: {
      ownerName?: string;
      renterName: string;
      concepto: string;
      amount: number;
      currency: string;
      vehicleLabel: string;
      startDate: Date;
      endDate: Date;
    },
  ) {
    const html = this.layout(
      "Recibiste un pago",
      this.p(
        `${this.saludo(params.ownerName)} <strong>${params.renterName}</strong> pagó la ${params.concepto.toLowerCase()} de <strong>${params.vehicleLabel}</strong>.`,
      ) +
        this.cuadro([
          {
            etiqueta: params.concepto,
            valor: this.formatMoney(params.amount, params.currency),
            destacar: true,
          },
          { etiqueta: "Desde", valor: this.formatDate(params.startDate) },
          { etiqueta: "Hasta", valor: this.formatDate(params.endDate) },
        ]) +
        this.boton(this.misReservas, "Ver la reserva") +
        this.nota(
          "El dinero se transfiere a tu cuenta según lo acordado, una vez que el " +
            "alquiler termine.",
        ),
    );
    await this.send(email, "Recibiste un pago - Freewheel", html);
  }

  /**
   * Entrega del auto confirmada. Le llega a las dos partes con el mismo cuerpo:
   * es el momento en que empieza a correr el alquiler y las dos necesitan la
   * misma constancia, con la misma hora.
   */
  async sendPickupConfirmed(
    email: string,
    params: {
      recipientName?: string;
      vehicleLabel: string;
      startDate: Date;
      endDate: Date;
      confirmedAt: Date;
      esDueño: boolean;
    },
  ) {
    const apertura = params.esDueño
      ? `${this.saludo(params.recipientName)} confirmaste la entrega de <strong>${params.vehicleLabel}</strong>. El alquiler ya está en curso.`
      : `${this.saludo(params.recipientName)} quedó confirmado el retiro de <strong>${params.vehicleLabel}</strong>. El alquiler ya está en curso.`;

    const html = this.layout(
      "Entrega confirmada",
      this.p(apertura) +
        this.cuadro([
          {
            etiqueta: "Entregado el",
            valor: this.formatDate(params.confirmedAt),
          },
          {
            etiqueta: "Devolución prevista",
            valor: this.formatDate(params.endDate),
            destacar: true,
          },
        ]) +
        this.p(
          params.esDueño
            ? "Cuando te devuelvan el auto, confirmá la devolución para cerrar la reserva."
            : "Al devolverlo, el dueño confirma la devolución y con eso se cierra la reserva.",
        ) +
        this.boton(this.misReservas, "Ver la reserva"),
    );
    await this.send(email, "Entrega confirmada - Freewheel", html);
  }

  /** Devolución confirmada: la reserva se cerró. También a las dos partes. */
  async sendReturnConfirmed(
    email: string,
    params: {
      recipientName?: string;
      otherPartyName: string;
      vehicleLabel: string;
      confirmedAt: Date;
      esDueño: boolean;
    },
  ) {
    const html = this.layout(
      "Reserva cerrada",
      this.p(
        `${this.saludo(params.recipientName)} quedó confirmada la devolución de <strong>${params.vehicleLabel}</strong>. La reserva está cerrada.`,
      ) +
        this.cuadro([
          {
            etiqueta: "Devuelto el",
            valor: this.formatDate(params.confirmedAt),
          },
          {
            etiqueta: params.esDueño ? "Inquilino" : "Dueño",
            valor: params.otherPartyName,
          },
        ]) +
        this.p(
          `Ahora podés dejarle una reseña a ${params.otherPartyName}. Las reseñas son ` +
            "lo que le permite a la siguiente persona saber con quién está tratando.",
        ) +
        this.boton(this.misReservas, "Dejar una reseña"),
    );
    await this.send(email, "Reserva cerrada - Freewheel", html);
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

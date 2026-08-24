import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { SmsProvider } from "./sms-provider.interface";

/**
 * Manda el SMS de verificación por Twilio.
 *
 * ── POR QUÉ TWILIO Y NO "TWILIO VERIFY" ─────────────────────────────────────
 * Twilio tiene dos productos. Verify genera el código, lo guarda y lo comprueba
 * él; Programmable SMS solo manda el texto que uno le da. Acá se usa el segundo,
 * porque el código YA lo genera y lo guarda este backend (VerificationCode, con
 * su vencimiento, su propósito y su límite de intentos). Con Verify habría que
 * tirar todo eso y dejar el estado de la verificación en un servicio de afuera,
 * que además cobra por intento. Programmable SMS entra en la interfaz que ya
 * existe sin tocar una línea del circuito.
 *
 * ── POR QUÉ SIN LA LIBRERÍA DE TWILIO ───────────────────────────────────────
 * Mandar un SMS es un POST con usuario y contraseña. El paquete `twilio` son
 * varios megas de SDK para eso, y este backend corre en funciones sin servidor,
 * donde cada mega es tiempo de arranque en frío. Node ya trae `fetch`.
 *
 * ── QUÉ HAY QUE CARGAR EN EL SERVIDOR ───────────────────────────────────────
 *   SMS_PROVIDER=twilio
 *   TWILIO_ACCOUNT_SID=AC...        (Console de Twilio, arriba de todo)
 *   TWILIO_AUTH_TOKEN=...           (al lado del anterior)
 * y UNO de estos dos, que es de dónde sale el mensaje:
 *   TWILIO_FROM_NUMBER=+1...        (el número que te dio Twilio)
 *   TWILIO_MESSAGING_SERVICE_SID=MG...
 *
 * Con la cuenta de prueba de Twilio los SMS SOLO llegan a números verificados en
 * la consola, y el texto llega con un prefijo suyo. Alcanza para probar el
 * circuito completo con el teléfono propio.
 *
 * ── SI FALLA, FALLA FUERTE ──────────────────────────────────────────────────
 * Cuando Twilio rechaza el envío, esto lanza. No devuelve como si hubiera
 * mandado: quien llama guarda el código en la base y le dice a la persona "te
 * mandamos un SMS", y esa persona se quedaría esperando un mensaje que nunca
 * salió, sin nada que hacer más que reintentar y esperar de nuevo.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";

  private readonly logger = new Logger(TwilioSmsProvider.name);

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
    private readonly isMessagingService: boolean,
  ) {}

  async sendVerificationCode(phone: string, code: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      this.accountSid,
    )}/Messages.json`;

    const body = new URLSearchParams({
      To: phone,
      [this.isMessagingService ? "MessagingServiceSid" : "From"]: this.from,
      Body: `Freewheel: tu codigo de verificacion es ${code}. Vence en 10 minutos. No se lo pases a nadie.`,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          // Twilio usa autenticación básica: usuario = SID, contraseña = token.
          Authorization: `Basic ${Buffer.from(
            `${this.accountSid}:${this.authToken}`,
          ).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch (err) {
      // Se cortó la red antes de llegar. El mensaje del error de red no le dice
      // nada a quien está esperando el SMS, así que se registra y se contesta
      // algo que sí se entiende.
      this.logger.error(`Twilio unreachable: ${String(err)}`);
      throw new ServiceUnavailableException(
        "No se pudo mandar el SMS. Probá de nuevo en un minuto.",
      );
    }

    if (!res.ok) {
      // El cuerpo del error de Twilio trae el código y el motivo (número
      // inválido, sin saldo, país bloqueado). Va al log, no a la respuesta: son
      // detalles de nuestra cuenta, no del problema de la persona.
      const detalle = await res.text().catch(() => "");
      this.logger.error(
        `Twilio rejected the message (${res.status}): ${detalle.slice(0, 300)}`,
      );
      throw new ServiceUnavailableException(
        "No se pudo mandar el SMS a ese número. Revisá que esté bien escrito.",
      );
    }
  }
}

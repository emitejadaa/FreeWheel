import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SMS_PROVIDER } from "./providers/sms-provider.interface";
import { MockSmsProvider } from "./providers/mock-sms.provider";
import { TwilioSmsProvider } from "./providers/twilio-sms.provider";
import { SmsService } from "./sms.service";

const smsProvider: Provider = {
  provide: SMS_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const which = (config.get<string>("SMS_PROVIDER") ?? "mock").toLowerCase();
    if (which === "mock") return new MockSmsProvider();

    if (which === "twilio") {
      const accountSid = config.get<string>("TWILIO_ACCOUNT_SID");
      const authToken = config.get<string>("TWILIO_AUTH_TOKEN");
      // De dónde sale el mensaje: un número comprado, o un Messaging Service
      // (que agrupa varios). Twilio acepta uno u otro, no los dos.
      const servicio = config.get<string>("TWILIO_MESSAGING_SERVICE_SID");
      const numero = config.get<string>("TWILIO_FROM_NUMBER");
      const desde = servicio || numero;

      // Se revienta al arrancar, no en el primer SMS. Con la mitad de las
      // variables cargadas, la app levantaría igual y la falla aparecería recién
      // cuando alguien intente verificar su teléfono: quien hizo el deploy ya no
      // está mirando, y el que se come el error es un usuario.
      if (!accountSid || !authToken || !desde) {
        throw new Error(
          'SMS_PROVIDER="twilio" necesita TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y ' +
            "TWILIO_FROM_NUMBER (o TWILIO_MESSAGING_SERVICE_SID).",
        );
      }
      return new TwilioSmsProvider(
        accountSid,
        authToken,
        desde,
        Boolean(servicio),
      );
    }

    throw new Error(
      `Unknown SMS_PROVIDER "${which}" (available: "mock", "twilio")`,
    );
  },
};

@Module({
  providers: [SmsService, smsProvider],
  exports: [SmsService],
})
export class SmsModule {}

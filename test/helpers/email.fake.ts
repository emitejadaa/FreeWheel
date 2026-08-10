/**
 * Stand-in for EmailService used in tests. The real service emails verification
 * codes and password-reset tokens (never returning them over HTTP), so tests
 * capture them here to drive the verify-email / reset-password flows.
 */
export class FakeEmailService {
  /**
   * En los tests el envío "funciona" siempre. El servicio real expone esto para
   * poder cortar antes los flujos que dependen de que el mail llegue (registro,
   * recuperar contraseña): sin GMAIL_USER/GMAIL_APP_PASSWORD el mail se perdía en
   * silencio y la persona quedaba esperando un código que nunca salió.
   */
  readonly configured = true;

  private readonly codes = new Map<string, string>();
  private readonly resetTokens = new Map<string, string>();
  private readonly priceChangeCodes = new Map<string, string>();

  sendVerificationCode(email: string, code: string): Promise<void> {
    this.codes.set(email, code);
    return Promise.resolve();
  }

  sendPasswordReset(
    email: string,
    _firstName: string,
    token: string,
    _userId: string,
  ): Promise<void> {
    this.resetTokens.set(email, token);
    return Promise.resolve();
  }

  /**
   * Code emailed to confirm a listing price change. Changing the price is gated
   * behind an emailed code, so the E2E flow needs to read it from here.
   */
  sendPriceChangeCode(
    email: string,
    _listingTitle: string,
    _currentPrice: number,
    _newPrice: number,
    code: string,
  ): Promise<void> {
    this.priceChangeCodes.set(email, code);
    return Promise.resolve();
  }

  /** The most recent price-change code emailed to this address. */
  lastPriceChangeCode(email: string): string | undefined {
    return this.priceChangeCodes.get(email);
  }

  /** The most recent verification code emailed to this address. */
  lastCode(email: string): string | undefined {
    return this.codes.get(email);
  }

  /** The most recent password-reset token emailed to this address. */
  lastResetToken(email: string): string | undefined {
    return this.resetTokens.get(email);
  }

  // ── Avisos de una reserva ─────────────────────────────────────────────────
  //
  // Se ANOTAN en vez de descartarse. Antes eran no-ops, y con eso una prueba no
  // podía comprobar que el aviso saliera: si mañana alguien borra el envío al
  // inquilino, ninguna prueba se entera porque safeNotify se traga todo en
  // silencio. Ahora quedan registrados y se pueden revisar.
  private readonly avisosEnviados: {
    tipo: string;
    to: string;
    params?: unknown;
  }[] = [];

  /** Los avisos que salieron, opcionalmente filtrados por destinatario. */
  avisos(to?: string): { tipo: string; to: string; params?: unknown }[] {
    return to
      ? this.avisosEnviados.filter((a) => a.to === to)
      : [...this.avisosEnviados];
  }

  /** ¿Salió este aviso a esta dirección? */
  huboAviso(tipo: string, to: string): boolean {
    return this.avisosEnviados.some((a) => a.tipo === tipo && a.to === to);
  }

  private anotar(tipo: string, to: string, params?: unknown): Promise<void> {
    this.avisosEnviados.push({ tipo, to, params });
    return Promise.resolve();
  }

  sendBookingRequestedToOwner(to: string, params?: unknown): Promise<void> {
    return this.anotar("bookingRequestedToOwner", to, params);
  }

  sendBookingRequestedToRenter(to: string, params?: unknown): Promise<void> {
    return this.anotar("bookingRequestedToRenter", to, params);
  }

  sendBookingAcceptedToRenter(to: string, params?: unknown): Promise<void> {
    return this.anotar("bookingAcceptedToRenter", to, params);
  }

  sendBookingRejectedToRenter(to: string, params?: unknown): Promise<void> {
    return this.anotar("bookingRejectedToRenter", to, params);
  }

  sendBookingCancelled(to: string, params?: unknown): Promise<void> {
    return this.anotar("bookingCancelled", to, params);
  }

  sendPaymentReceipt(to: string, params?: unknown): Promise<void> {
    return this.anotar("paymentReceipt", to, params);
  }

  sendPaymentReceivedToOwner(to: string, params?: unknown): Promise<void> {
    return this.anotar("paymentReceivedToOwner", to, params);
  }

  sendPickupConfirmed(to: string, params?: unknown): Promise<void> {
    return this.anotar("pickupConfirmed", to, params);
  }

  sendReturnConfirmed(to: string, params?: unknown): Promise<void> {
    return this.anotar("returnConfirmed", to, params);
  }
}

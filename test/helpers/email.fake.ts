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

  // Booking notifications — no-ops in tests (assertions don't need them, but
  // the methods must exist so BookingsService.safeNotify stays quiet).
  sendBookingRequestedToOwner(): Promise<void> {
    return Promise.resolve();
  }

  sendBookingAcceptedToRenter(): Promise<void> {
    return Promise.resolve();
  }

  sendBookingRejectedToRenter(): Promise<void> {
    return Promise.resolve();
  }
}

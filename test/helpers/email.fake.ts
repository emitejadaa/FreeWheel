/**
 * Stand-in for EmailService used in tests. The real service emails verification
 * codes and password-reset tokens (never returning them over HTTP), so tests
 * capture them here to drive the verify-email / reset-password flows.
 */
export class FakeEmailService {
  private readonly codes = new Map<string, string>();
  private readonly resetTokens = new Map<string, string>();

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

  /** The most recent verification code emailed to this address. */
  lastCode(email: string): string | undefined {
    return this.codes.get(email);
  }

  /** The most recent password-reset token emailed to this address. */
  lastResetToken(email: string): string | undefined {
    return this.resetTokens.get(email);
  }
}

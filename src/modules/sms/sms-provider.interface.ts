/**
 * The seam between this application and whichever Bangladeshi bulk-SMS gateway
 * the business happens to be on. Everything above this interface — templates,
 * logging, retries, phone masking — is provider independent.
 */
export interface SmsSendResult {
  /** The gateway's own message id, kept for support tickets and reconciliation. */
  providerMessageId?: string;
  /** Anything the gateway returned that is worth keeping, for debugging. */
  raw?: unknown;
}

export interface SmsProvider {
  /** A short name recorded on every SmsLog row. */
  readonly name: string;

  /**
   * Sends one message. Must throw on failure — the queue relies on a thrown
   * error to trigger its retry with backoff.
   *
   * @param phone E.164, e.g. `+8801712345678`
   */
  send(phone: string, message: string): Promise<SmsSendResult>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

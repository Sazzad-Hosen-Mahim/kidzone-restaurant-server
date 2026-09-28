import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing. argon2id with parameters chosen to stay comfortably above
 * OWASP's 2024 minimum (19 MiB, 2 iterations) while keeping a login under
 * ~100 ms on modest POS hardware.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  private static readonly OPTIONS: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  };

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, PasswordService.OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch (error) {
      // A malformed stored hash must read as "wrong password", never as a crash.
      this.logger.error('Password verification failed', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * Burns roughly the same CPU as a real verification. Called when the phone or
   * email does not match any user, so a failed login takes the same time
   * whether or not the account exists.
   */
  async fakeVerify(): Promise<void> {
    await argon2.hash('timing-equalisation', PasswordService.OPTIONS);
  }
}

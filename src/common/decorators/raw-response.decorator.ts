import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'rawResponse';

/**
 * Opts a handler out of the `{ data, meta }` envelope. Used by endpoints that
 * return a file body (PDF receipts, Excel exports).
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);

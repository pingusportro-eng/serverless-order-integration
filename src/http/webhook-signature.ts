import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;
const TIMESTAMP_PATTERN = /^[0-9]{10}$/;

export class InvalidWebhookSignatureError extends Error {
  override readonly name = 'InvalidWebhookSignatureError';

  constructor() {
    super('The webhook signature or timestamp is invalid or expired.');
  }
}

export interface VerifyWebhookSignatureInput {
  readonly secret: string;
  readonly rawBody: string;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly toleranceSeconds: number;
  readonly now: Date;
}

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): void {
  if (
    input.timestamp === undefined ||
    input.signature === undefined ||
    !TIMESTAMP_PATTERN.test(input.timestamp) ||
    !Number.isSafeInteger(input.toleranceSeconds) ||
    input.toleranceSeconds <= 0
  ) {
    throw new InvalidWebhookSignatureError();
  }

  const timestampSeconds = Number(input.timestamp);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > input.toleranceSeconds) {
    throw new InvalidWebhookSignatureError();
  }

  const signatureMatch = SIGNATURE_PATTERN.exec(input.signature);
  if (signatureMatch === null) {
    throw new InvalidWebhookSignatureError();
  }

  const expected = Buffer.from(signWebhook(input.secret, input.timestamp, input.rawBody), 'utf8');
  const received = Buffer.from(input.signature, 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new InvalidWebhookSignatureError();
  }
}

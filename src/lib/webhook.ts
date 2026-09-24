import { createHmac, randomBytes } from 'crypto';

/**
 * Webhook signing secret. Generated once at creation and stored recoverably
 * (the worker signs every outbound delivery with it). Downstream apps hold the
 * same secret and verify the signature on each request.
 */
export const generateWebhookSecret = () => {
  return `whsec_${randomBytes(24).toString('hex')}`;
};

/**
 * Signs the raw request body: `sha256=<hex>`. Sent in the
 * `x-content-pilot-signature` header; the receiver recomputes and compares.
 */
export const signWebhookBody = (body: string, secret: string) => {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
};

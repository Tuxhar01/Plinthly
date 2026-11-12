import zlib from "zlib";

/**
 * Computes the IEEE 802.3 32-bit Cyclic Redundancy Check (CRC32) over raw payload bytes.
 * Returns the CRC32 as an unsigned 32-bit integer (0 to 4294967295).
 * 
 * PayPal Webhook verification requires CRC32 of the exact raw HTTP request body bytes,
 * formatted as a decimal integer string in the signature verification payload.
 */
export function computePayPalCrc32(rawPayload: Buffer): number {
  if (!Buffer.isBuffer(rawPayload)) {
    throw new TypeError("computePayPalCrc32: rawPayload must be a Buffer");
  }
  // zlib.crc32 returns an unsigned 32-bit integer
  return zlib.crc32(rawPayload) >>> 0;
}

export interface PayPalSignaturePayloadOptions {
  transmissionId: string;
  transmissionTime: string;
  webhookId: string;
  rawPayload: Buffer;
}

/**
 * Formats the canonical message buffer that PayPal signs with RSA-SHA256:
 * `<transmissionId>|<transmissionTime>|<webhookId>|<crc32Decimal>`
 */
export function formatPayPalSignatureMessage(options: PayPalSignaturePayloadOptions): Buffer {
  const { transmissionId, transmissionTime, webhookId, rawPayload } = options;

  if (!transmissionId || typeof transmissionId !== "string") {
    throw new Error("ERR_INVALID_TRANSMISSION_ID: transmissionId must be a non-empty string");
  }
  if (!transmissionTime || typeof transmissionTime !== "string") {
    throw new Error("ERR_INVALID_TRANSMISSION_TIME: transmissionTime must be a non-empty string");
  }
  if (!webhookId || typeof webhookId !== "string") {
    throw new Error("ERR_INVALID_WEBHOOK_ID: webhookId must be a non-empty string");
  }

  const crc32Val = computePayPalCrc32(rawPayload);
  const messageStr = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32Val}`;

  return Buffer.from(messageStr, "utf8");
}


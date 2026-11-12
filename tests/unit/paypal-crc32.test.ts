import { describe, it, expect } from "vitest";
import { computePayPalCrc32, formatPayPalSignatureMessage } from "../../lib/crypto/paypal-crc32";

describe("PayPal CRC32 and Signature Message Assembler", () => {
  it("computes exact standard IEEE 802.3 CRC32 values", () => {
    // Standard test vectors
    expect(computePayPalCrc32(Buffer.from(""))).toBe(0);
    expect(computePayPalCrc32(Buffer.from("hello"))).toBe(907060870);
    // Standard check string "123456789" = 0xCBF43926 = 3421780262
    expect(computePayPalCrc32(Buffer.from("123456789"))).toBe(3421780262);
  });

  it("returns unsigned 32-bit integer within valid range", () => {
    const randomBytes = Buffer.from("arbitrary test string with high bytes \xFF\xFE\xFD");
    const crc = computePayPalCrc32(randomBytes);
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(4294967295);
    expect(Number.isInteger(crc)).toBe(true);
  });

  it("throws TypeError if rawPayload is not a Buffer", () => {
    expect(() => computePayPalCrc32("string" as any)).toThrow(TypeError);
    expect(() => computePayPalCrc32(null as any)).toThrow(TypeError);
  });

  it("assembles canonical PayPal signature message buffer", () => {
    const rawPayload = Buffer.from('{"event_type":"PAYMENT.CAPTURE.COMPLETED"}', "utf8");
    const crc = computePayPalCrc32(rawPayload);
    const msg = formatPayPalSignatureMessage({
      transmissionId: "77a83d90-b184-11e6-8158-bfef0d276b6b",
      transmissionTime: "2026-11-07T12:00:00Z",
      webhookId: "WH-2RU25474D0430030W",
      rawPayload,
    });

    const expectedStr = `77a83d90-b184-11e6-8158-bfef0d276b6b|2026-11-07T12:00:00Z|WH-2RU25474D0430030W|${crc}`;
    expect(msg.toString("utf8")).toBe(expectedStr);
  });

  it("rejects invalid transmission metadata in message assembler", () => {
    const rawPayload = Buffer.from("{}");
    expect(() =>
      formatPayPalSignatureMessage({
        transmissionId: "",
        transmissionTime: "2026-11-07T12:00:00Z",
        webhookId: "WH-123",
        rawPayload,
      })
    ).toThrow("ERR_INVALID_TRANSMISSION_ID");

    expect(() =>
      formatPayPalSignatureMessage({
        transmissionId: "T-123",
        transmissionTime: "",
        webhookId: "WH-123",
        rawPayload,
      })
    ).toThrow("ERR_INVALID_TRANSMISSION_TIME");

    expect(() =>
      formatPayPalSignatureMessage({
        transmissionId: "T-123",
        transmissionTime: "2026-11-07T12:00:00Z",
        webhookId: "",
        rawPayload,
      })
    ).toThrow("ERR_INVALID_WEBHOOK_ID");
  });
});


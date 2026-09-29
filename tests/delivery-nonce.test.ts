import { describe, expect, it } from "vitest";
import { deliveryNonce } from "../src/discord/delivery-nonce.js";

describe("deliveryNonce", () => {
  it("is deterministic, bounded for Discord, and delivery-specific", () => {
    const value = deliveryNonce("channel", "completion", "countdown-1");
    expect(value).toBe(deliveryNonce("channel", "completion", "countdown-1"));
    expect(value).toHaveLength(25);
    expect(value).not.toBe(deliveryNonce("dm", "completion", "countdown-1", "user-1"));
    expect(value).not.toBe(deliveryNonce("channel", "reminder", "countdown-1", 60_000));
  });
});

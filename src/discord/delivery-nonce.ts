import { createHash } from "node:crypto";

export function deliveryNonce(...parts: readonly (string | number)[]): string {
  return createHash("sha256")
    .update(parts.map(String).join("\u001f"))
    .digest("base64url")
    .slice(0, 25);
}

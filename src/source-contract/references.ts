import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
import { ConnectorError } from "../errors.js";

export type SourceReference = {
  kind: "vehicle" | "article" | "labor" | "asset" | "cursor";
  catalog?: string;
  vehicleId?: string;
  articleId?: string;
  assetId?: string;
  assetKind?: "graphic" | "asset";
  scope?: string;
  filter?: string;
  offset?: number;
};

// A deterministic nonce makes a given source identity stable across processes.
// It is derived from the entire plaintext, so distinct identities use distinct nonces.
export function encodeReference(reference: SourceReference, key: Buffer): string {
  const plaintext = Buffer.from(JSON.stringify(reference), "utf8");
  const nonce = createHmac("sha256", key).update("bankone-source-ref-v1\0").update(plaintext).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `b1.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

export function decodeReference(value: string, key: Buffer, expected?: SourceReference["kind"]): SourceReference {
  if (!/^b1\.[A-Za-z0-9_-]{40,2000}$/.test(value)) throw new ConnectorError("invalid_request", "Invalid source reference", 400);
  try {
    const bytes = Buffer.from(value.slice(3), "base64url");
    const nonce = bytes.subarray(0, 12);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    const calculated = createHmac("sha256", key).update("bankone-source-ref-v1\0").update(plaintext).digest().subarray(0, 12);
    if (!timingSafeEqual(nonce, calculated)) throw new Error("invalid nonce");
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) throw new Error("invalid payload");
    const reference = parsed as SourceReference;
    if (!(["vehicle", "article", "labor", "asset", "cursor"] as unknown[]).includes(reference.kind) || (expected && reference.kind !== expected)) {
      throw new Error("invalid kind");
    }
    return reference;
  } catch {
    throw new ConnectorError("invalid_request", "Invalid source reference", 400);
  }
}

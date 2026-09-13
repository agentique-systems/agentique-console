import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ValidationError } from "@agentique-console/core";

/** AES-256-GCM; key material is supplied by the service manager, never written to the database or data directory. */
export class SecretVault {
  private readonly key: Buffer | null;
  constructor(encoded?: string) {
    this.key = encoded ? Buffer.from(encoded, "base64") : null;
    if (this.key && (this.key.length !== 32 || this.key.toString("base64") !== encoded)) throw new Error("CONSOLE_SETTINGS_KEY must be a canonical base64-encoded 32-byte key.");
  }
  get available(): boolean { return this.key !== null; }
  encrypt(slot: string, value: string): string {
    if (!this.key) throw new ValidationError("Credential storage is unavailable. Provision CONSOLE_SETTINGS_KEY in the service secret environment and restart.");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`agentique-settings:1:${slot}`));
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
  }
  decrypt(slot: string, payload: string): string {
    if (!this.key) throw new Error("Encrypted settings require CONSOLE_SETTINGS_KEY. Restore the original service key before starting.");
    try {
      const [version, nonce, tag, body] = payload.split(".");
      if (version !== "v1" || !nonce || !tag || !body) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonce, "base64"));
      cipher.setAAD(Buffer.from(`agentique-settings:1:${slot}`));
      cipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([cipher.update(Buffer.from(body, "base64")), cipher.final()]).toString("utf8");
    } catch { throw new Error("Credential decryption failed. Restore the original service key and matching database backup; no plaintext fallback is available."); }
  }
}

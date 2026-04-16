import { createCipheriv, randomBytes } from "crypto";

const CREDENTIALS_SCHEME = "aes-256-gcm-v1";
const KEY_BYTES = 32;

const decodeKey = (rawKey: string): Buffer | null => {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;

  const isLikelyHex = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2;
  const key = isLikelyHex ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  return key.length === KEY_BYTES ? key : null;
};

const getCredentialsKey = (): Buffer | null => {
  const rawKey = process.env.LINKEDIN_CREDENTIALS_KEY || "";
  return decodeKey(rawKey);
};

export type EncryptedPasswordPayload = {
  password_encrypted: string;
  password_scheme: string;
};

export const encryptLinkedinPassword = (password: string): EncryptedPasswordPayload => {
  const key = getCredentialsKey();
  if (!key) {
    throw new Error(
      "LINKEDIN_CREDENTIALS_KEY is missing or invalid. Provide a 32-byte key (base64 or hex)."
    );
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const packed = `${iv.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
  return {
    password_encrypted: packed,
    password_scheme: CREDENTIALS_SCHEME,
  };
};

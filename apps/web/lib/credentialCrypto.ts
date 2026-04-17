import { createCipheriv, randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const CREDENTIALS_SCHEME = "aes-256-gcm-v1";
const KEY_BYTES = 32;
const KEY_FILE_ENV = "LINKEDIN_CREDENTIALS_KEY_FILE";
const DEFAULT_KEY_FILE = path.resolve(process.cwd(), "..", "..", ".linkedin_credentials_key");

const decodeKey = (rawKey: string): Buffer | null => {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;

  const isLikelyHex = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2;
  const key = isLikelyHex ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  return key.length === KEY_BYTES ? key : null;
};

const getKeyFilePath = (): string => {
  const rawPath = (process.env[KEY_FILE_ENV] || "").trim();
  return rawPath || DEFAULT_KEY_FILE;
};

const readKeyFile = (filePath: string): Buffer | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return decodeKey(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const persistKeyFile = (filePath: string, key: Buffer): boolean => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, `${key.toString("base64")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "EEXIST") {
      return false;
    }
    throw error;
  }
};

export const resolveCredentialsKey = (): Buffer | null => {
  const envKey = decodeKey(process.env.LINKEDIN_CREDENTIALS_KEY || "");
  if (envKey) return envKey;

  const filePath = getKeyFilePath();
  const fileKey = readKeyFile(filePath);
  if (fileKey) return fileKey;
  if (fs.existsSync(filePath)) return null;

  const generated = randomBytes(KEY_BYTES);
  try {
    persistKeyFile(filePath, generated);
  } catch {
    return null;
  }

  return readKeyFile(filePath) || generated;
};

export type EncryptedPasswordPayload = {
  password_encrypted: string;
  password_scheme: string;
};

export const encryptLinkedinPassword = (password: string): EncryptedPasswordPayload => {
  const key = resolveCredentialsKey();
  if (!key) {
    throw new Error(
      "Credential encryption key is missing or unreadable. Set LINKEDIN_CREDENTIALS_KEY or make LINKEDIN_CREDENTIALS_KEY_FILE writable."
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

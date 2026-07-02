import crypto from "node:crypto";

const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function deriveKey(secret, salt, keylen = KEY_BYTES) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, keylen, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password, salt = crypto.randomBytes(16).toString("base64")) {
  const key = await deriveKey(password, salt);
  return {
    salt,
    hash: key.toString("base64"),
  };
}

export async function verifyPassword(password, salt, expectedHash) {
  const key = await deriveKey(password, salt);
  const expected = Buffer.from(expectedHash, "base64");
  return expected.length === key.length && crypto.timingSafeEqual(key, expected);
}

export function encryptWithKey(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

export function decryptWithKey(key, encryptedText) {
  const encrypted = typeof encryptedText === "string" ? JSON.parse(encryptedText) : encryptedText;
  if (!encrypted || encrypted.v !== 1 || encrypted.alg !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted payload.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export async function wrapDataKey(password, salt, dataKey) {
  const wrappingKey = await deriveKey(password, salt);
  return encryptWithKey(wrappingKey, dataKey.toString("base64"));
}

export async function unwrapDataKey(password, salt, encryptedDataKey) {
  const wrappingKey = await deriveKey(password, salt);
  return Buffer.from(decryptWithKey(wrappingKey, encryptedDataKey), "base64");
}

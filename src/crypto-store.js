import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const KEY_PATH = path.join(DATA_DIR, "simplefin-key");
const KEY_BYTES = 32;

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function parseEnvKey(value) {
  if (!value) return null;

  const trimmed = value.trim();
  const encodings = ["base64", "hex"];
  for (const encoding of encodings) {
    const key = Buffer.from(trimmed, encoding);
    if (key.length === KEY_BYTES) return key;
  }

  throw new Error(
    "SIMPLEFIN_ENCRYPTION_KEY must decode to 32 bytes as base64 or hex.",
  );
}

export async function getEncryptionKey() {
  const envKey = parseEnvKey(process.env.SIMPLEFIN_ENCRYPTION_KEY);
  if (envKey) return envKey;

  await ensureDataDir();
  try {
    const raw = await fs.readFile(KEY_PATH, "utf8");
    const key = Buffer.from(raw.trim(), "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(`${KEY_PATH} does not contain a 32-byte base64 key.`);
    }
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const key = crypto.randomBytes(KEY_BYTES);
  await fs.writeFile(KEY_PATH, `${key.toString("base64")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(KEY_PATH, 0o600);
  return key;
}

export async function encryptText(plaintext) {
  const key = await getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function decryptText(encrypted) {
  if (!encrypted || encrypted.alg !== "aes-256-gcm" || encrypted.v !== 1) {
    throw new Error("Unsupported encrypted value.");
  }

  const key = await getEncryptionKey();
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

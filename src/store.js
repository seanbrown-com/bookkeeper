import fs from "node:fs/promises";
import path from "node:path";
import { decryptText, encryptText } from "./crypto-store.js";

const DATA_DIR = path.join(process.cwd(), "data");
const CONNECTIONS_PATH = path.join(DATA_DIR, "simplefin-connections.json");

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readConnections() {
  try {
    const raw = await fs.readFile(CONNECTIONS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const connections = Array.isArray(parsed.connections) ? parsed.connections : [];
    let migrated = false;

    const sanitized = [];
    for (const connection of connections) {
      if (connection.accessUrl && !connection.accessUrlEncrypted) {
        migrated = true;
        sanitized.push({
          id: connection.id,
          accessUrlEncrypted: await encryptText(connection.accessUrl),
          label: connection.label || null,
          savedAt: connection.savedAt,
          updatedAt: new Date().toISOString(),
        });
      } else {
        sanitized.push(connection);
      }
    }

    if (migrated) {
      await fs.writeFile(
        CONNECTIONS_PATH,
        `${JSON.stringify({ connections: sanitized }, null, 2)}\n`,
        "utf8",
      );
    }

    return Promise.all(
      sanitized.map(async (connection) => {
        if (connection.accessUrlEncrypted) {
          return {
            ...connection,
            accessUrl: await decryptText(connection.accessUrlEncrypted),
          };
        }
        return connection;
      }),
    );
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function saveConnection(connection) {
  await ensureDataDir();
  const connections = await readConnections();
  const now = new Date().toISOString();
  const record = {
    id: connection.id,
    accessUrlEncrypted: await encryptText(connection.accessUrl),
    label: connection.label || null,
    savedAt: now,
  };

  const idx = connections.findIndex((item) => item.id === record.id);
  if (idx >= 0) {
    connections[idx] = {
      id: record.id,
      accessUrlEncrypted: record.accessUrlEncrypted,
      label: record.label,
      savedAt: connections[idx].savedAt || record.savedAt,
      updatedAt: now,
    };
  } else {
    connections.push(record);
  }

  await fs.writeFile(
    CONNECTIONS_PATH,
    `${JSON.stringify({ connections }, null, 2)}\n`,
    "utf8",
  );
  return record;
}

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decryptWithKey,
  encryptWithKey,
  hashPassword,
  randomToken,
  sha256,
  unwrapDataKey,
  verifyPassword,
  wrapDataKey,
} from "./security.js";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "bookkeeper.sqlite");
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;

const sessionKeys = new Map();

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export async function openAppDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      encryption_salt TEXT NOT NULL,
      encrypted_data_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cash',
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      linked_account_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#0d6b61',
      encrypted_meta TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(linked_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      UNIQUE(source, external_id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      sort_date TEXT NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      search_key TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_account_date
      ON transactions(account_id, sort_date DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_date
      ON transactions(sort_date DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_external
      ON transactions(account_id, source, external_id);

    CREATE TABLE IF NOT EXISTS simplefin_connections (
      id TEXT PRIMARY KEY,
      label TEXT,
      encrypted_access_url TEXT NOT NULL,
      last_sync_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_overrides (
      key TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS category_rules (
      key TEXT PRIMARY KEY,
      encrypted_payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      details TEXT
    );
  `);
  migrateDb(db);
  return db;
}

function migrateDb(db) {
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all().map((column) => column.name);
  if (!accountColumns.includes("linked_account_id")) {
    db.exec("ALTER TABLE accounts ADD COLUMN linked_account_id TEXT");
  }
  if (!accountColumns.includes("hidden")) {
    db.exec("ALTER TABLE accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }
}

export function isConfigured(db) {
  return Boolean(db.prepare("SELECT id FROM users WHERE id = 1").get());
}

export async function setupUser(db, { username, password }) {
  if (isConfigured(db)) throw new Error("Bookkeeper is already configured.");
  if (!username || !password || password.length < 10) {
    throw new Error("Use a username and a password of at least 10 characters.");
  }

  const passwordResult = await hashPassword(password);
  const encryptionSalt = randomToken(16);
  const dataKey = crypto.randomBytes(32);
  const encryptedDataKey = await wrapDataKey(password, encryptionSalt, dataKey);
  const now = nowIso();

  db.prepare(`
    INSERT INTO users (
      id, username, password_salt, password_hash, encryption_salt,
      encrypted_data_key, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    username,
    passwordResult.salt,
    passwordResult.hash,
    encryptionSalt,
    encryptedDataKey,
    now,
    now,
  );

  await logActivity(db, "info", "User created", { username });
  return createSession(db, dataKey);
}

export async function loginUser(db, { username, password }) {
  const user = db.prepare("SELECT * FROM users WHERE id = 1").get();
  if (!user || user.username !== username) throw new Error("Invalid login.");
  const ok = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) throw new Error("Invalid login.");

  const dataKey = await unwrapDataKey(password, user.encryption_salt, user.encrypted_data_key);
  await logActivity(db, "info", "User logged in", { username });
  return createSession(db, dataKey);
}

export async function changePassword(db, session, { currentPassword, newPassword }) {
  if (!newPassword || newPassword.length < 10) {
    throw new Error("New password must be at least 10 characters.");
  }
  const user = db.prepare("SELECT * FROM users WHERE id = 1").get();
  const ok = await verifyPassword(currentPassword, user.password_salt, user.password_hash);
  if (!ok) throw new Error("Current password is incorrect.");

  const passwordResult = await hashPassword(newPassword);
  const encryptedDataKey = await wrapDataKey(newPassword, user.encryption_salt, session.dataKey);
  db.prepare(`
    UPDATE users
    SET password_salt = ?, password_hash = ?, encrypted_data_key = ?, updated_at = ?
    WHERE id = 1
  `).run(passwordResult.salt, passwordResult.hash, encryptedDataKey, nowIso());
  await logActivity(db, "info", "Password changed");
}

function createSession(db, dataKey) {
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)")
    .run(tokenHash, expiresAt, nowIso());
  sessionKeys.set(tokenHash, dataKey);
  return { token, expiresAt };
}

export function getSession(db, token) {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  const dataKey = sessionKeys.get(tokenHash);
  if (!dataKey) return null;
  return { tokenHash, userId: row.user_id, dataKey, expiresAt: row.expires_at };
}

export function logoutSession(db, session) {
  if (!session) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.tokenHash);
  sessionKeys.delete(session.tokenHash);
}

export function encryptJson(dataKey, value) {
  return encryptWithKey(dataKey, JSON.stringify(value));
}

export function decryptJson(dataKey, value) {
  return JSON.parse(decryptWithKey(dataKey, value));
}

export async function logActivity(db, level, message, details = null) {
  db.prepare("INSERT INTO activity_log (level, message, details, created_at) VALUES (?, ?, ?, ?)")
    .run(level, message, details ? JSON.stringify(details) : null, nowIso());
}

export function listActivity(db, limit = 200) {
  return db.prepare("SELECT * FROM activity_log ORDER BY id DESC LIMIT ?").all(limit).map((row) => ({
    ...row,
    details: safeJsonParse(row.details),
  }));
}

export function upsertAccount(db, session, account) {
  const now = nowIso();
  const id = account.id || `${account.source || "manual"}_${sha256(account.externalId || account.name).slice(0, 14)}`;
  const existing = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  const encryptedMeta = encryptJson(session.dataKey, account.meta || {});
  const type = account.type || inferAccountType(account.name);
  if (existing) {
    db.prepare(`
      UPDATE accounts
      SET name = ?, type = ?, source = ?, external_id = ?, linked_account_id = ?, hidden = ?, color = ?, encrypted_meta = ?, updated_at = ?
      WHERE id = ?
    `).run(
      account.name || existing.name,
      type || existing.type,
      account.source || existing.source,
      account.externalId || existing.external_id,
      account.linkedAccountId ?? existing.linked_account_id,
      account.hidden ?? existing.hidden,
      account.color || existing.color,
      encryptedMeta,
      now,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO accounts (id, name, type, source, external_id, linked_account_id, hidden, color, encrypted_meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      account.name,
      type,
      account.source || "manual",
      account.externalId || null,
      account.linkedAccountId || null,
      account.hidden ? 1 : 0,
      account.color || "#0d6b61",
      encryptedMeta,
      now,
      now,
    );
  }
  return getAccount(db, session, id);
}

export function createManualAccount(db, session, account) {
  return upsertAccount(db, session, {
    id: `manual_${randomToken(8)}`,
    source: "manual",
    ...account,
  });
}

export function updateAccount(db, session, id, patch) {
  const existing = getAccount(db, session, id);
  if (!existing) throw new Error("Account not found.");
  db.prepare("UPDATE accounts SET name = ?, type = ?, color = ?, linked_account_id = ?, hidden = ?, updated_at = ? WHERE id = ?")
    .run(
      patch.name ?? existing.name,
      patch.type ?? existing.type,
      patch.color ?? existing.color,
      patch.linkedAccountId ?? existing.linkedAccountId,
      patch.hidden === undefined ? (existing.hidden ? 1 : 0) : (patch.hidden ? 1 : 0),
      nowIso(),
      id,
    );
  return getAccount(db, session, id);
}

export function getAccount(db, session, id) {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  return row ? decodeAccount(session, row) : null;
}

export function listAccounts(db, session) {
  return db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all().map((row) => decodeAccount(session, row));
}

export function mergeAccounts(db, session, sourceAccountId, targetAccountId) {
  if (sourceAccountId === targetAccountId) throw new Error("Choose two different accounts.");
  const source = getAccount(db, session, sourceAccountId);
  const target = getAccount(db, session, targetAccountId);
  if (!source || !target) throw new Error("Account not found.");
  db.prepare("UPDATE transactions SET account_id = ?, updated_at = ? WHERE account_id = ?")
    .run(targetAccountId, nowIso(), sourceAccountId);
  db.prepare("DELETE FROM accounts WHERE id = ?").run(sourceAccountId);
  return target;
}

function decodeAccount(session, row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    source: row.source,
    externalId: row.external_id,
    linkedAccountId: row.linked_account_id,
    hidden: Boolean(row.hidden),
    color: row.color,
    meta: row.encrypted_meta ? decryptJson(session.dataKey, row.encrypted_meta) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function inferAccountType(name = "") {
  const text = name.toLowerCase();
  if (text.includes("visa") || text.includes("credit") || text.includes("cc") || text.includes("card")) {
    return "credit";
  }
  if (text.includes("line of credit") || text.includes("loc") || text.includes("loan")) return "credit";
  return "cash";
}

export function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/\d{2,}/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

export function transactionFingerprint(accountId, tx) {
  if (tx.externalId) {
    return sha256([accountId, tx.source || "manual", tx.externalId].join("|"));
  }
  const base = [
    accountId,
    tx.date || "",
    Number(tx.amount || 0).toFixed(2),
    tx.balance === null || tx.balance === undefined ? "" : Number(tx.balance).toFixed(2),
    tx.type || "",
    normalizeText(tx.description || ""),
  ].join("|");
  return sha256(base);
}

function dateDistanceDays(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const first = new Date(`${a}T12:00:00`).getTime();
  const second = new Date(`${b}T12:00:00`).getTime();
  if (Number.isNaN(first) || Number.isNaN(second)) return Number.POSITIVE_INFINITY;
  return Math.abs(first - second) / (1000 * 60 * 60 * 24);
}

function pendingMatchScore(incoming, existing) {
  if (!existing.pending || incoming.pending) return 0;
  if (Math.abs(Number(existing.amount || 0) - Number(incoming.amount || 0)) > 0.01) return 0;
  if (dateDistanceDays(existing.date, incoming.date) > 5) return 0;
  const incomingText = normalizeText(incoming.description || "");
  const existingText = normalizeText(existing.description || "");
  if (!incomingText || !existingText) return 0;
  if (incomingText === existingText) return 1;
  if (incomingText.includes(existingText) || existingText.includes(incomingText)) return 0.9;
  const incomingWords = new Set(incomingText.split(" ").filter((word) => word.length > 2));
  const existingWords = new Set(existingText.split(" ").filter((word) => word.length > 2));
  if (!incomingWords.size || !existingWords.size) return 0;
  const overlap = [...incomingWords].filter((word) => existingWords.has(word)).length;
  return overlap / Math.max(incomingWords.size, existingWords.size);
}

function findPendingMatch(db, session, accountId, payload) {
  if (payload.pending) return null;
  const rows = db.prepare(`
    SELECT * FROM transactions
    WHERE account_id = ? AND source = ?
      AND sort_date >= date(?, '-5 days')
      AND sort_date <= date(?, '+5 days')
    ORDER BY sort_date DESC, id DESC
  `).all(accountId, payload.source, payload.date, payload.date);
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const existing = decodeTransaction(session, row);
    const score = pendingMatchScore(payload, existing);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= 0.75 ? best : null;
}

function updateTransactionRow(db, session, row, payload, fingerprint, searchKey, now) {
  const encryptedPayload = encryptJson(session.dataKey, { ...payload, id: row.id });
  db.prepare(`
    UPDATE transactions
    SET sort_date = ?, source = ?, external_id = ?, fingerprint = ?, search_key = ?, encrypted_payload = ?, updated_at = ?
    WHERE id = ?
  `).run(payload.date, payload.source, payload.externalId, fingerprint, searchKey, encryptedPayload, now, row.id);
  return { id: row.id, inserted: false };
}

export function upsertTransaction(db, session, accountId, tx) {
  const now = nowIso();
  const payload = {
    id: tx.id || null,
    accountId,
    date: tx.date,
    description: tx.description || "",
    amount: Number(tx.amount || 0),
    balance: tx.balance === null || tx.balance === undefined ? null : Number(tx.balance),
    type: tx.type || null,
    pending: Boolean(tx.pending),
    externalId: tx.externalId || null,
    source: tx.source || "manual",
    mcc: normalizeMcc(tx.mcc ?? tx.raw?.mcc),
    raw: tx.raw || null,
  };
  const fingerprint = transactionFingerprint(accountId, payload);
  const id = payload.id || `tx_${fingerprint.slice(0, 24)}`;
  payload.id = id;
  const encryptedPayload = encryptJson(session.dataKey, payload);
  const searchKey = normalizeText(payload.description);

  const existingByFingerprint = db.prepare("SELECT * FROM transactions WHERE fingerprint = ?").get(fingerprint);
  if (existingByFingerprint) {
    return updateTransactionRow(db, session, existingByFingerprint, payload, fingerprint, searchKey, now);
  }

  if (payload.externalId) {
    const existingByExternalId = db.prepare(`
      SELECT * FROM transactions
      WHERE account_id = ? AND source = ? AND external_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(accountId, payload.source, payload.externalId);
    if (existingByExternalId) {
      return updateTransactionRow(db, session, existingByExternalId, payload, fingerprint, searchKey, now);
    }
  }

  const pendingMatch = findPendingMatch(db, session, accountId, payload);
  if (pendingMatch) {
    return updateTransactionRow(db, session, pendingMatch, payload, fingerprint, searchKey, now);
  }

  db.prepare(`
    INSERT INTO transactions (
      id, account_id, sort_date, source, external_id, fingerprint, search_key,
      encrypted_payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    accountId,
    payload.date,
    payload.source,
    payload.externalId,
    fingerprint,
    searchKey,
    encryptedPayload,
    now,
    now,
  );
  return { id, inserted: true };
}

function chooseDuplicateKeeper(items) {
  return [...items].sort((a, b) => {
    if (a.tx.pending !== b.tx.pending) return a.tx.pending ? 1 : -1;
    const dateCompare = String(b.tx.date || "").localeCompare(String(a.tx.date || ""));
    if (dateCompare) return dateCompare;
    return String(b.row.updated_at || "").localeCompare(String(a.row.updated_at || ""));
  })[0];
}

export function dedupeAccountTransactions(
  db,
  session,
  accountId,
  { source = "simplefin", startDate = null, endDate = null, returnedExternalIds = null } = {},
) {
  const rows = db.prepare("SELECT * FROM transactions WHERE account_id = ? AND source = ? ORDER BY sort_date DESC, id DESC").all(accountId, source);
  const items = rows.map((row) => ({ row, tx: decodeTransaction(session, row) }));
  const deleteIds = new Set();

  const byExternalId = new Map();
  for (const item of items) {
    if (!item.tx.externalId) continue;
    const key = item.tx.externalId;
    if (!byExternalId.has(key)) byExternalId.set(key, []);
    byExternalId.get(key).push(item);
  }
  for (const duplicates of byExternalId.values()) {
    if (duplicates.length < 2) continue;
    const keep = chooseDuplicateKeeper(duplicates);
    for (const item of duplicates) {
      if (item.row.id !== keep.row.id) deleteIds.add(item.row.id);
    }
  }

  const posted = items.filter((item) => !deleteIds.has(item.row.id) && !item.tx.pending);
  const pending = items.filter((item) => !deleteIds.has(item.row.id) && item.tx.pending);
  for (const pendingItem of pending) {
    const match = posted.find((postedItem) => pendingMatchScore(postedItem.tx, pendingItem.tx) >= 0.75);
    if (match) deleteIds.add(pendingItem.row.id);
  }

  let staleDeleted = 0;
  if (startDate && endDate && returnedExternalIds) {
    const returned = new Set([...returnedExternalIds].filter(Boolean));
    for (const item of items) {
      if (deleteIds.has(item.row.id)) continue;
      if (item.tx.date < startDate || item.tx.date > endDate) continue;
      const generatedCorrection = item.tx.type === "BALANCE_CORRECTION"
        || String(item.tx.externalId || "").startsWith("correction_");
      if (generatedCorrection) continue;
      if (item.tx.externalId && returned.has(item.tx.externalId)) continue;
      deleteIds.add(item.row.id);
      staleDeleted += 1;
    }
  }

  if (!deleteIds.size) return { deleted: 0, staleDeleted: 0 };
  const remove = db.prepare("DELETE FROM transactions WHERE id = ?");
  for (const id of deleteIds) remove.run(id);
  return { deleted: deleteIds.size, staleDeleted };
}

export function decodeTransaction(session, row) {
  const payload = decryptJson(session.dataKey, row.encrypted_payload);
  return {
    ...payload,
    id: row.id,
    accountId: row.account_id,
    fingerprint: row.fingerprint,
    searchKey: row.search_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function backfillTransactionMcc(db, session) {
  const rows = db.prepare("SELECT * FROM transactions").all();
  const now = nowIso();
  let updated = 0;
  const update = db.prepare("UPDATE transactions SET encrypted_payload = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const payload = decryptJson(session.dataKey, row.encrypted_payload);
    const mcc = normalizeMcc(payload.mcc ?? payload.raw?.mcc);
    if (payload.mcc === mcc) continue;
    payload.mcc = mcc;
    update.run(encryptJson(session.dataKey, payload), now, row.id);
    updated += 1;
  }
  return updated;
}

function normalizeMcc(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).padStart(4, "0");
}

export function getTransaction(db, session, id) {
  const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
  if (!row) return null;
  const accounts = new Map(listAccounts(db, session).map((account) => [account.id, account]));
  const tx = decodeTransaction(session, row);
  return { ...tx, account: accounts.get(tx.accountId) || null };
}

export function listTransactions(db, session, { accountId = null, limit = 100, offset = 0 } = {}) {
  const rows = accountId
    ? db.prepare("SELECT * FROM transactions WHERE account_id = ? ORDER BY sort_date DESC, id DESC LIMIT ? OFFSET ?").all(accountId, limit, offset)
    : db.prepare("SELECT * FROM transactions ORDER BY sort_date DESC, id DESC LIMIT ? OFFSET ?").all(limit, offset);
  const accounts = new Map(listAccounts(db, session).map((account) => [account.id, account]));
  return rows.map((row) => {
    const tx = decodeTransaction(session, row);
    return { ...tx, account: accounts.get(tx.accountId) || null };
  });
}

export function listAllTransactions(db, session) {
  return db.prepare("SELECT * FROM transactions ORDER BY sort_date ASC, id ASC").all().map((row) => decodeTransaction(session, row));
}

export function getSummary(db, session) {
  const accounts = listAccounts(db, session);
  const transactions = listAllTransactions(db, session);
  const latestByAccount = new Map();
  for (const tx of transactions) {
    if (tx.balance !== null && tx.balance !== undefined) latestByAccount.set(tx.accountId, tx);
  }

  let cash = 0;
  let debt = 0;
  for (const account of accounts) {
    if (account.hidden) continue;
    const latest = latestByAccount.get(account.id);
    const balance =
      account.meta?.simplefinTrustedBalance === true
        ? account.meta.currentBalance ?? latest?.balance ?? 0
        : latest?.balance ?? account.meta?.currentBalance ?? 0;
    if (account.type === "credit") debt += Math.abs(Math.min(balance, 0) || balance);
    else cash += balance;
  }

  return { cash, debt, net: cash - debt };
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  return row ? safeJsonParse(row.value, fallback) : fallback;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export function deleteSimpleFinConnection(db, id) {
  db.prepare("DELETE FROM simplefin_connections WHERE id = ?").run(id);
}

export function createSyncJob(db, { id, kind, details = null }) {
  db.prepare("INSERT INTO sync_jobs (id, status, kind, started_at, details) VALUES (?, 'running', ?, ?, ?)")
    .run(id, kind, nowIso(), details ? JSON.stringify(details) : null);
}

export function finishSyncJob(db, id, status, details = null) {
  db.prepare("UPDATE sync_jobs SET status = ?, finished_at = ?, details = ? WHERE id = ?")
    .run(status, nowIso(), details ? JSON.stringify(details) : null, id);
}

export function listSyncJobs(db, limit = 20) {
  return db.prepare("SELECT * FROM sync_jobs ORDER BY started_at DESC LIMIT ?").all(limit).map((row) => ({
    ...row,
    details: safeJsonParse(row.details),
  }));
}

export function latestBalanceTransaction(db, session, accountId, date = null) {
  const rows = date
    ? db.prepare("SELECT * FROM transactions WHERE account_id = ? AND sort_date <= ? ORDER BY sort_date DESC, id DESC LIMIT 200").all(accountId, date)
    : db.prepare("SELECT * FROM transactions WHERE account_id = ? ORDER BY sort_date DESC, id DESC LIMIT 200").all(accountId);
  for (const row of rows) {
    const tx = decodeTransaction(session, row);
    if (tx.balance !== null && tx.balance !== undefined) return tx;
  }
  return null;
}

export function addBalanceCorrection(db, session, accountId, { date, targetBalance, source = "correction", reason = "Balance correction" }) {
  const latest = latestBalanceTransaction(db, session, accountId, date);
  if (!latest || targetBalance === null || targetBalance === undefined) return { inserted: false, amount: 0 };
  const diff = Number(targetBalance) - Number(latest.balance);
  if (Math.abs(diff) < 0.005) return { inserted: false, amount: 0 };
  const correctionHash = sha256(`${accountId}|${date}|${targetBalance}|${reason}`);
  const result = upsertTransaction(db, session, accountId, {
    id: `correction_${correctionHash.slice(0, 24)}`,
    date,
    description: reason,
    amount: Number(diff.toFixed(2)),
    balance: Number(targetBalance),
    type: "BALANCE_CORRECTION",
    source,
    externalId: `correction_${correctionHash.slice(0, 16)}`,
    raw: { targetBalance, previousBalance: latest.balance, reason },
  });
  return { ...result, amount: diff };
}

export function saveSimpleFinConnection(db, session, { id, label, accessUrl }) {
  const now = nowIso();
  const encrypted = encryptJson(session.dataKey, { accessUrl });
  const existing = db.prepare("SELECT id FROM simplefin_connections WHERE id = ?").get(id);
  if (existing) {
    db.prepare("UPDATE simplefin_connections SET label = ?, encrypted_access_url = ?, updated_at = ? WHERE id = ?")
      .run(label || null, encrypted, now, id);
  } else {
    db.prepare(`
      INSERT INTO simplefin_connections (id, label, encrypted_access_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, label || null, encrypted, now, now);
  }
}

export function listSimpleFinConnections(db, session, includeSecret = false) {
  return db.prepare("SELECT * FROM simplefin_connections ORDER BY created_at ASC").all().map((row) => {
    const secret = decryptJson(session.dataKey, row.encrypted_access_url);
    return {
      id: row.id,
      label: row.label,
      accessUrl: includeSecret ? secret.accessUrl : undefined,
      tokenPreview: obfuscateUrl(secret.accessUrl),
      lastSyncAt: row.last_sync_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function markSimpleFinSynced(db, id) {
  const now = nowIso();
  db.prepare("UPDATE simplefin_connections SET last_sync_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}

function obfuscateUrl(accessUrl) {
  try {
    const url = new URL(accessUrl);
    const user = url.username ? `${url.username.slice(0, 4)}...` : "user";
    const pass = url.password ? `${url.password.slice(0, 3)}...` : "pass";
    url.username = user;
    url.password = pass;
    return url.toString();
  } catch {
    return "hidden";
  }
}

export function getRecurringOverride(db, key) {
  return db.prepare("SELECT * FROM recurring_overrides WHERE key = ?").get(key);
}

export function saveRecurringOverride(db, key, action, payload = null) {
  const now = nowIso();
  const existing = getRecurringOverride(db, key);
  if (existing) {
    db.prepare("UPDATE recurring_overrides SET action = ?, payload = ?, updated_at = ? WHERE key = ?")
      .run(action, payload ? JSON.stringify(payload) : null, now, key);
  } else {
    db.prepare("INSERT INTO recurring_overrides (key, action, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, action, payload ? JSON.stringify(payload) : null, now, now);
  }
}

export function listRecurringOverrides(db) {
  return db.prepare("SELECT * FROM recurring_overrides").all().map((row) => ({
    key: row.key,
    action: row.action,
    payload: safeJsonParse(row.payload),
  }));
}

export function saveCategoryRule(db, session, { matchText, category, sourceTransactionId = null }) {
  const key = categoryRuleKey(matchText);
  const now = nowIso();
  const payload = {
    matchText: normalizeText(matchText),
    category,
    sourceTransactionId,
  };
  const encryptedPayload = encryptJson(session.dataKey, payload);
  const existing = db.prepare("SELECT key FROM category_rules WHERE key = ?").get(key);
  if (existing) {
    db.prepare("UPDATE category_rules SET encrypted_payload = ?, updated_at = ? WHERE key = ?")
      .run(encryptedPayload, now, key);
  } else {
    db.prepare("INSERT INTO category_rules (key, encrypted_payload, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(key, encryptedPayload, now, now);
  }
  return { key, ...payload };
}

export function listCategoryRules(db, session) {
  return db.prepare("SELECT * FROM category_rules").all().map((row) => ({
    key: row.key,
    ...decryptJson(session.dataKey, row.encrypted_payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function categoryRuleKey(matchText) {
  return sha256(normalizeText(matchText));
}

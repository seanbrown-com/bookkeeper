import { sha256 } from "./security.js";
import { listAllTransactions, listRecurringOverrides, normalizeText } from "./db.js";

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date) {
  return String(date).slice(0, 7);
}

export function recurringKey(tx) {
  return sha256(`${tx.accountId}|${normalizeText(tx.description)}|${Math.round(Math.abs(tx.amount || 0) * 100)}`);
}

export function transactionRegularKey(tx) {
  return sha256([
    "tx-recurring",
    tx.accountId,
    normalizeText(tx.description),
    Math.round(Number(tx.amount || 0) * 100),
    Number(String(tx.date || "").slice(8, 10)) || "",
  ].join("|"));
}

export function manualRegularKey({ dayOfMonth, description, amount }) {
  return sha256(`manual|${Number(dayOfMonth)}|${normalizeText(description)}|${Math.round(Number(amount || 0) * 100)}`);
}

export function acceptedRegularRules(db, session = null) {
  const txs = session ? listAllTransactions(db, session) : [];
  return listRecurringOverrides(db)
    .filter((override) => override.action === "accepted")
    .map((override) => {
      const payload = override.payload || {};
      const matchingTx = txs
        .filter((tx) => tx.accountId === payload.accountId)
        .filter((tx) => recurringKey(tx) === override.key || transactionRegularKey(tx) === override.key)
        .at(-1);
      const anchorDate = payload.date || matchingTx?.date || null;
      return {
        key: override.key,
        description: payload.description || "",
        amount: Number(payload.amount || 0),
        accountId: payload.accountId || null,
        date: anchorDate,
        dayOfMonth: payload.dayOfMonth || (anchorDate ? Number(anchorDate.slice(8, 10)) : null),
      };
    });
}

export function isRegularLike(tx, rules = []) {
  return rules.some((rule) => {
    const amountClose = Math.abs(Number(tx.amount || 0) - Number(rule.amount || 0)) <= 1;
    return amountClose && descriptionSimilarity(tx.description, rule.description) >= 0.9 && isRoughlyMonthly(tx, rule);
  });
}

function isRoughlyMonthly(tx, rule) {
  if (!tx.date || !rule.dayOfMonth) return false;
  if (rule.date && tx.date === rule.date) return true;
  if (rule.date && monthIndex(tx.date) === monthIndex(rule.date)) return false;
  const txDay = Number(String(tx.date).slice(8, 10));
  if (!Number.isFinite(txDay)) return false;
  return dayDistance(txDay, Number(rule.dayOfMonth)) <= 5;
}

function monthIndex(value) {
  const date = String(value);
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
}

function dayDistance(left, right) {
  const direct = Math.abs(left - right);
  return Math.min(direct, 31 - direct);
}

export function descriptionSimilarity(left, right) {
  const a = normalizeForSimilarity(left);
  const b = normalizeForSimilarity(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  if (!aBigrams.length || !bBigrams.length) return 0;
  const counts = new Map();
  for (const item of aBigrams) counts.set(item, (counts.get(item) || 0) + 1);
  let overlap = 0;
  for (const item of bBigrams) {
    const count = counts.get(item) || 0;
    if (count > 0) {
      overlap += 1;
      counts.set(item, count - 1);
    }
  }
  return (2 * overlap) / (aBigrams.length + bBigrams.length);
}

function normalizeForSimilarity(value = "") {
  return String(value)
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => !/[0-9]/.test(part))
    .join(" ")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bigrams(value) {
  const compact = ` ${value} `;
  const pairs = [];
  for (let i = 0; i < compact.length - 1; i += 1) pairs.push(compact.slice(i, i + 2));
  return pairs;
}

export function analyzeRecurring(db, session) {
  const overrides = new Map(listRecurringOverrides(db).map((override) => [override.key, override]));
  const accepted = [...overrides.values()].filter((override) => override.action === "accepted");
  const txs = listAllTransactions(db, session).filter((tx) => tx.description && tx.amount);
  const groups = new Map();

  for (const tx of txs) {
    const key = recurringKey(tx);
    const rows = groups.get(key) || [];
    rows.push(tx);
    groups.set(key, rows);
  }

  const guesses = [];
  const includedAccepted = new Set();
  for (const [key, rows] of groups.entries()) {
    const override = overrides.get(key);
    if (override?.action === "rejected") continue;
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const months = new Set(rows.map((tx) => monthKey(tx.date)));
    if (rows.length < 3 || months.size < 3) {
      if (override?.action !== "accepted") continue;
    }

    const last = rows.at(-1);
    const nextDate = iso(addMonths(new Date(`${last.date}T12:00:00`), 1));
    const avgAmount = rows.reduce((sum, tx) => sum + tx.amount, 0) / rows.length;
    const kind = avgAmount > 0 ? "income" : "bill";
    const manual = override?.action === "accepted";
    if (manual) includedAccepted.add(key);
    guesses.push({
      key,
      accountId: last.accountId,
      description: override?.payload?.description || last.description,
      amount: override?.payload?.amount ?? Number(avgAmount.toFixed(2)),
      kind,
      nextDate,
      occurrences: rows.length,
      months: months.size,
      manual,
      sample: rows.slice(-3),
    });
  }

  for (const override of accepted) {
    if (includedAccepted.has(override.key)) continue;
    const payload = override.payload || {};
    const amount = Number(payload.amount || 0);
    if (!payload.description || !amount) continue;
    if (payload.manualEntry) {
      const nextDate = nextDayOfMonth(payload.dayOfMonth || 1);
      guesses.push({
        key: override.key,
        accountId: null,
        description: payload.description,
        amount,
        kind: amount > 0 ? "income" : "bill",
        nextDate,
        occurrences: 1,
        months: 1,
        manual: true,
        manualEntry: true,
        sample: [],
      });
      continue;
    }
    const similarRows = txs
      .filter((tx) => tx.accountId === payload.accountId)
      .filter((tx) => Math.abs(Number(tx.amount) - amount) <= 1)
      .filter((tx) => descriptionSimilarity(tx.description, payload.description) >= 0.9)
      .filter((tx) => !payload.dayOfMonth || dayDistance(Number(String(tx.date).slice(8, 10)), Number(payload.dayOfMonth)) <= 5)
      .sort((a, b) => a.date.localeCompare(b.date));
    const last = similarRows.at(-1);
    const nextDate = last?.date
      ? iso(addMonths(new Date(`${last.date}T12:00:00`), 1))
      : nextDayOfMonth(payload.dayOfMonth || 1);
    guesses.push({
      key: override.key,
      accountId: payload.accountId || last?.accountId || null,
      description: payload.description,
      amount,
      kind: amount > 0 ? "income" : "bill",
      nextDate,
      occurrences: similarRows.length || 1,
      months: new Set(similarRows.map((tx) => monthKey(tx.date))).size || 1,
      manual: true,
      sample: similarRows.slice(-3),
    });
  }

  guesses.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  const cashDelta = guesses.reduce((sum, guess) => sum + guess.amount, 0);
  return { guesses, cashDelta };
}

function nextDayOfMonth(dayOfMonth) {
  const now = new Date();
  const day = Math.max(1, Math.min(31, Number(dayOfMonth) || 1));
  let year = now.getFullYear();
  let month = now.getMonth();
  let candidate = clampedDate(year, month, day);
  if (candidate < now) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    candidate = clampedDate(year, month, day);
  }
  return iso(candidate);
}

function clampedDate(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay), 12, 0, 0, 0);
}

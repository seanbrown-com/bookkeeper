import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addBalanceCorrection,
  backfillTransactionMcc,
  changePassword,
  createManualAccount,
  createSyncJob,
  dedupeAccountTransactions,
  deleteSimpleFinConnection,
  finishSyncJob,
  getMeta,
  getSession,
  getSummary,
  getTransaction,
  isConfigured,
  categoryRuleKey,
  listAccounts,
  listActivity,
  listAllTransactions,
  listCategoryRules,
  listSimpleFinConnections,
  listSyncJobs,
  listTransactions,
  latestBalanceTransaction,
  logActivity,
  loginUser,
  logoutSession,
  markSimpleFinSynced,
  mergeAccounts,
  openAppDb,
  saveRecurringOverride,
  saveCategoryRule,
  saveSimpleFinConnection,
  setMeta,
  setupUser,
  normalizeText,
  upsertAccount,
  upsertTransaction,
  updateAccount,
} from "./db.js";
import { getConfig, loadEnv } from "./env.js";
import {
  buildImportPreview,
  parseCsvText,
  parseGenericXlsxBuffer,
  parseWorkbookBuffer,
} from "./importers.js";
import { acceptedRegularRules, analyzeRecurring, isRegularLike, manualRegularKey, recurringKey, transactionRegularKey } from "./recurring.js";
import { accessId, claimSetupToken, fetchAccounts } from "./simplefin.js";
import { readConnections as readLegacyConnections } from "./store.js";

loadEnv();

const db = await openAppDb();
const config = getConfig();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const previews = new Map();
let unlockedSession = null;
let lastSchedulerMinute = "";
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function setCookie(res, token, expiresAt) {
  const expires = new Date(expiresAt).toUTCString();
  res.setHeader("Set-Cookie", `bk_session=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires}`);
}

function clearCookie(res) {
  res.setHeader("Set-Cookie", "bk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function readCookie(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function requireSession(req, res) {
  const session = getSession(db, readCookie(req, "bk_session"));
  if (!session) {
    sendJson(res, 401, { error: "Login required." });
    return null;
  }
  return session;
}

async function sendStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") sendJson(res, 404, { error: "Not found" });
    else throw error;
  }
}

async function maybeMigrateLegacySimpleFin(session) {
  const existing = listSimpleFinConnections(db, session);
  if (existing.length) return;

  const legacy = await readLegacyConnections().catch(() => []);
  for (const connection of legacy) {
    saveSimpleFinConnection(db, session, {
      id: connection.id,
      label: connection.label,
      accessUrl: connection.accessUrl,
    });
  }
  if (legacy.length) await logActivity(db, "info", "Migrated legacy SimpleFIN connections", { count: legacy.length });
}

function publicStatus(req) {
  const configured = isConfigured(db);
  const session = getSession(db, readCookie(req, "bk_session"));
  return { configured, authenticated: Boolean(session), appName: "Bookkeeper" };
}

async function handleAuth(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, publicStatus(req));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/setup") {
    const sessionInfo = await setupUser(db, await readJson(req));
    setCookie(res, sessionInfo.token, sessionInfo.expiresAt);
    const session = getSession(db, sessionInfo.token);
    unlockedSession = session;
    await maybeMigrateLegacySimpleFin(session);
    backfillTransactionMcc(db, session);
    sendJson(res, 201, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const sessionInfo = await loginUser(db, await readJson(req));
    setCookie(res, sessionInfo.token, sessionInfo.expiresAt);
    const session = getSession(db, sessionInfo.token);
    unlockedSession = session;
    await maybeMigrateLegacySimpleFin(session);
    backfillTransactionMcc(db, session);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = getSession(db, readCookie(req, "bk_session"));
    logoutSession(db, session);
    clearCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleAuth(req, res, url)) return;

  const session = requireSession(req, res);
  if (!session) return;

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const accounts = listAccounts(db, session);
    const visibleAccounts = accounts.filter((account) => !account.hidden);
    const rules = acceptedRegularRules(db, session);
    sendJson(res, 200, {
      summary: getSummary(db, session),
      accounts: visibleAccounts.map((account) => ({
        ...account,
        balance: accountBalance(session, account),
        recentTransactions: annotateTransactions(listTransactions(db, session, { accountId: account.id, limit: 5 }), rules),
      })),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    sendJson(res, 200, listAccounts(db, session));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const account = createManualAccount(db, session, await readJson(req));
    await logActivity(db, "info", "Account created", { accountId: account.id, name: account.name });
    sendJson(res, 201, account);
    return;
  }

  const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (req.method === "PATCH" && accountMatch) {
    const account = updateAccount(db, session, accountMatch[1], await readJson(req));
    sendJson(res, 200, account);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/transactions") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 100);
    const offset = Number(url.searchParams.get("offset") || 0);
    const accountId = url.searchParams.get("accountId") || null;
    const rules = acceptedRegularRules(db, session);
    const categoryRules = listCategoryRules(db, session);
    sendJson(res, 200, { transactions: annotateTransactions(listTransactions(db, session, { accountId, limit, offset }), rules, categoryRules) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transactions/category") {
    const body = await readJson(req);
    const tx = getTransaction(db, session, body.transactionId);
    const category = String(body.category || "").trim();
    if (!tx) throw new Error("Transaction not found.");
    if (!MASTER_CATEGORY_NAMES.includes(category)) throw new Error("Choose a valid category.");
    const matchTexts = transactionCategoryMatchTexts(tx);
    for (const matchText of matchTexts) {
      saveCategoryRule(db, session, { matchText, category, sourceTransactionId: tx.id });
    }
    await logActivity(db, "info", "Category rule saved", {
      transactionId: tx.id,
      category,
      rulesCreated: matchTexts.length,
    });
    sendJson(res, 200, { ok: true, category, rulesCreated: matchTexts.length });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/metrics") {
    const today = isoDate(new Date());
    const defaultStart = isoDate(addDays(new Date(), -30));
    const startDate = validDateParam(url.searchParams.get("startDate")) || defaultStart;
    const endDate = validDateParam(url.searchParams.get("endDate")) || today;
    if (startDate > endDate) throw new Error("Start date must be before end date.");
    sendJson(res, 200, buildMetrics(session, { startDate, endDate }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transactions/regular") {
    const body = await readJson(req);
    const tx = getTransaction(db, session, body.transactionId);
    if (!tx) throw new Error("Transaction not found.");
    const key = transactionRegularKey(tx);
    saveRecurringOverride(db, key, "accepted", {
      description: tx.description,
      amount: tx.amount,
      accountId: tx.accountId,
      date: tx.date,
      dayOfMonth: Number(String(tx.date).slice(8, 10)),
    });
    sendJson(res, 200, { ok: true, key });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings/simplefin") {
    sendJson(res, 200, {
      createUrl: config.simplefinCreateUrl,
      days: config.simplefinDays,
      pending: config.simplefinPending,
      connections: listSimpleFinConnections(db, session),
      sync: getSyncSettings(),
      jobs: listSyncJobs(db),
      accounts: listAccounts(db, session),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/simplefin") {
    const body = await readJson(req);
    const accessUrl = await claimSetupToken(body.setupToken);
    const id = accessId(accessUrl);
    saveSimpleFinConnection(db, session, { id, accessUrl, label: body.label || null });
    await logActivity(db, "info", "SimpleFIN token claimed", { id, label: body.label || null });
    sendJson(res, 201, { id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/simplefin/refresh") {
    const body = await readJson(req);
    const job = startSimpleFinRangeJob(session, {
      startDate: body.startDate,
      endDate: body.endDate,
      kind: "manual",
    });
    sendJson(res, 202, job);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/simplefin/force-today") {
    const today = todayIso();
    const job = startSimpleFinRangeJob(session, {
      startDate: today,
      endDate: today,
      kind: "force-today",
    });
    sendJson(res, 202, job);
    return;
  }

  const tokenDeleteMatch = url.pathname.match(/^\/api\/settings\/simplefin\/([^/]+)$/);
  if (req.method === "DELETE" && tokenDeleteMatch) {
    deleteSimpleFinConnection(db, decodeURIComponent(tokenDeleteMatch[1]));
    await logActivity(db, "info", "SimpleFIN token removed", { id: decodeURIComponent(tokenDeleteMatch[1]) });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings/sync") {
    const body = await readJson(req);
    const current = getSyncSettings();
    const next = {
      ...current,
      dailyHour: Number(body.dailyHour ?? current.dailyHour),
      dailyEnabled: Boolean(body.dailyEnabled) && Boolean(current.firstUserPullAt),
    };
    setMeta(db, "syncSettings", next);
    sendJson(res, 200, next);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings/raw-field-diagnostics") {
    sendJson(res, 200, buildRawFieldDiagnostics(session));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts/merge") {
    const body = await readJson(req);
    const account = mergeAccounts(db, session, body.sourceAccountId, body.targetAccountId);
    await logActivity(db, "info", "Accounts merged", {
      sourceAccountId: body.sourceAccountId,
      targetAccountId: body.targetAccountId,
    });
    sendJson(res, 200, account);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/password") {
    await changePassword(db, session, await readJson(req));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import/preview") {
    const body = await readJson(req);
    const preview = await createImportPreview(session, body);
    previews.set(preview.id, preview);
    sendJson(res, 200, redactPreview(preview));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import/commit") {
    const body = await readJson(req);
    const preview = previews.get(body.previewId);
    if (!preview) throw new Error("Import preview expired.");
    const committed = commitImport(session, preview, body.mappings || {});
    previews.delete(body.previewId);
    await logActivity(db, "info", "Import committed", committed);
    sendJson(res, 200, committed);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/month-ahead") {
    const recurring = analyzeRecurring(db, session);
    const summary = getSummary(db, session);
    const incomeDelta = recurring.guesses
      .filter((guess) => Number(guess.amount) > 0)
      .reduce((sum, guess) => sum + Number(guess.amount), 0);
    const obligationDelta = recurring.guesses
      .filter((guess) => Number(guess.amount) < 0)
      .reduce((sum, guess) => sum + Math.abs(Number(guess.amount)), 0);
    const estimatedCash = summary.cash + incomeDelta;
    const estimatedDebt = summary.debt + obligationDelta;
    sendJson(res, 200, {
      ...recurring,
      deltas: {
        income: incomeDelta,
        obligations: obligationDelta,
      },
      estimate: {
        cash: estimatedCash,
        debt: estimatedDebt,
        net: estimatedCash - estimatedDebt,
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/month-ahead/reject") {
    const body = await readJson(req);
    saveRecurringOverride(db, body.key, "rejected");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/month-ahead/manual") {
    const body = await readJson(req);
    const dayOfMonth = Number(body.dayOfMonth);
    const amount = Number(body.amount);
    const description = String(body.description || "").trim();
    if (!description || !Number.isFinite(amount) || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new Error("Provide day of month, description, and amount.");
    }
    const key = manualRegularKey({ dayOfMonth, description, amount });
    saveRecurringOverride(db, key, "accepted", {
      manualEntry: true,
      dayOfMonth,
      description,
      amount,
    });
    await logActivity(db, "info", "Manual regular item added", { dayOfMonth, description, amount });
    sendJson(res, 201, { ok: true, key });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/activity") {
    sendJson(res, 200, { logs: listActivity(db, 300) });
    return;
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

function annotateTransactions(transactions, rules = acceptedRegularRules(db), categoryRules = []) {
  return transactions.map((tx) => ({
    ...tx,
    isRegularLike: isRegularLike(tx, rules),
    category: categoryNameForTransaction(tx, categoryRules),
  }));
}

function buildRawFieldDiagnostics(session) {
  const transactions = listAllTransactions(db, session).filter((tx) => tx.source === "simplefin" && tx.raw);
  const fields = new Map();
  const categoryCandidates = new Map();

  for (const tx of transactions) {
    for (const field of flattenRawFields(tx.raw)) {
      const current = fields.get(field.path) || {
        path: field.path,
        count: 0,
        types: new Set(),
        sampleValues: new Set(),
      };
      current.count += 1;
      current.types.add(field.type);
      if (field.isCategoryCandidate && field.value !== null && field.value !== undefined && current.sampleValues.size < 8) {
        current.sampleValues.add(redactDiagnosticValue(field.value));
      }
      fields.set(field.path, current);

      if (field.isCategoryCandidate) {
        const candidate = categoryCandidates.get(field.path) || {
          path: field.path,
          count: 0,
          types: new Set(),
          sampleValues: new Set(),
        };
        candidate.count += 1;
        candidate.types.add(field.type);
        if (field.value !== null && field.value !== undefined && candidate.sampleValues.size < 12) {
          candidate.sampleValues.add(redactDiagnosticValue(field.value));
        }
        categoryCandidates.set(field.path, candidate);
      }
    }
  }

  return {
    transactionCount: transactions.length,
    fieldCount: fields.size,
    commonFields: formatDiagnosticFields([...fields.values()])
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, 80),
    categoryCandidates: formatDiagnosticFields([...categoryCandidates.values()])
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
  };
}

function flattenRawFields(value, prefix = "") {
  if (!value || typeof value !== "object") {
    return [{
      path: prefix || "(root)",
      type: Array.isArray(value) ? "array" : typeof value,
      value,
      isCategoryCandidate: isCategoryPath(prefix),
    }];
  }

  const entries = [];
  if (Array.isArray(value)) {
    entries.push({
      path: prefix || "(root)",
      type: "array",
      value: `[${value.length} items]`,
      isCategoryCandidate: isCategoryPath(prefix),
    });
    value.slice(0, 5).forEach((item, index) => {
      entries.push(...flattenRawFields(item, `${prefix}[${index}]`));
    });
    return entries;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") entries.push(...flattenRawFields(child, path));
    else {
      entries.push({
        path,
        type: child === null ? "null" : typeof child,
        value: child,
        isCategoryCandidate: isCategoryPath(path),
      });
    }
  }
  return entries;
}

function isCategoryPath(path = "") {
  return /\b(category|categories|classification|class|type|sic|mcc|merchant|payee)\b/i.test(path);
}

function redactDiagnosticValue(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text.length <= 32 && /^[\w .:/-]+$/.test(text)) return text;
  return `${text.slice(0, 12)}...`;
}

function formatDiagnosticFields(items) {
  return items.map((item) => ({
    path: item.path,
    count: item.count,
    types: [...item.types].sort(),
    sampleValues: [...item.sampleValues].sort(),
  }));
}

function accountBalance(session, account) {
  if (account.meta?.simplefinTrustedBalance === true && account.meta.currentBalance !== undefined) {
    return Number(account.meta.currentBalance || 0);
  }
  const latest = latestBalanceTransaction(db, session, account.id);
  return latest?.balance ?? account.meta?.currentBalance ?? 0;
}

function buildMetrics(session, { startDate, endDate }) {
  const accounts = listAccounts(db, session).filter((account) => !account.hidden);
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const rules = acceptedRegularRules(db, session);
  const categoryRules = listCategoryRules(db, session);
  const txs = listAllTransactions(db, session)
    .filter((tx) => accountMap.has(tx.accountId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const txsByAccount = new Map(accounts.map((account) => [
    account.id,
    txs.filter((tx) => tx.accountId === account.id),
  ]));
  const expensesByDate = new Map();
  const creditCardPaymentsByDate = new Map();
  const expenseCategories = new Map();
  const expenseMccs = new Map();

  for (const tx of txs) {
    if (tx.date < startDate || tx.date > endDate) continue;
    if (Number(tx.amount) >= 0 || isRegularLike(tx, rules)) continue;
    if (isCreditCardPaymentFromCash(tx, accountMap, txs)) {
      creditCardPaymentsByDate.set(tx.date, (creditCardPaymentsByDate.get(tx.date) || 0) + Math.abs(Number(tx.amount)));
      continue;
    }
    const expenseAmount = Math.abs(Number(tx.amount));
    expensesByDate.set(tx.date, (expensesByDate.get(tx.date) || 0) + expenseAmount);
    const mcc = normalizeMetricMcc(tx.mcc ?? tx.raw?.mcc);
    const mccSummary = expenseMccs.get(mcc) || { mcc, count: 0, value: 0 };
    mccSummary.count += 1;
    mccSummary.value += expenseAmount;
    expenseMccs.set(mcc, mccSummary);
    const category = categoryNameForTransaction(tx, categoryRules);
    expenseCategories.set(category, (expenseCategories.get(category) || 0) + expenseAmount);
  }

  const netSeries = [];
  const expenseSeries = [];
  const creditCardPaymentSeries = [];
  for (const date of dateRange(startDate, endDate)) {
    let cash = 0;
    let debt = 0;
    for (const account of accounts) {
      const trustedBalance = account.meta?.simplefinTrustedBalance === true
        ? Number(account.meta.currentBalance ?? 0)
        : null;
      const balance = balanceAtEndOfDay(txsByAccount.get(account.id) || [], date, {
        fallbackBalance: trustedBalance,
        fallbackDate: isoDate(new Date()),
      });
      if (account.type === "credit") debt += Math.abs(Math.min(balance, 0) || balance);
      else cash += balance;
    }

    netSeries.push({ date, value: Number((cash - debt).toFixed(2)) });
    expenseSeries.push({ date, value: Number((expensesByDate.get(date) || 0).toFixed(2)) });
    creditCardPaymentSeries.push({ date, value: Number((creditCardPaymentsByDate.get(date) || 0).toFixed(2)) });
  }

  return {
    startDate,
    endDate,
    net: downsampleSeries(netSeries, 90),
    nonRecurringExpenses: downsampleSeries(expenseSeries, 90),
    creditCardPayments: downsampleSeries(creditCardPaymentSeries, 90),
    nonRecurringExpenseCategories: [...expenseCategories.entries()]
      .map(([category, value]) => ({ category, value: Number(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value || a.category.localeCompare(b.category)),
    nonRecurringExpenseMccs: [...expenseMccs.values()]
      .map((item) => ({ ...item, value: Number(item.value.toFixed(2)), category: categoryNameForMcc(item.mcc) }))
      .sort((a, b) => b.value - a.value || a.mcc.localeCompare(b.mcc)),
  };
}

function downsampleSeries(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const sampled = [];
  const lastIndex = points.length - 1;
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(points[Math.round((lastIndex * index) / (maxPoints - 1))]);
  }
  return sampled;
}

function categoryNameForTransaction(tx, categoryRules = []) {
  const rule = categoryRuleForTransaction(tx, categoryRules);
  if (rule) return rule.category;
  const mcc = normalizeMetricMcc(tx.mcc ?? tx.raw?.mcc);
  if (mcc !== "0000") return categoryNameForMcc(mcc);
  return categoryNameFromText(tx.raw?.payee || tx.description || tx.raw?.memo) || "Uncategorized";
}

function categoryRuleForTransaction(tx, categoryRules = []) {
  const keys = transactionCategoryMatchTexts(tx).map((text) => categoryRuleKey(text));
  return categoryRules.find((rule) => keys.includes(rule.key)) || null;
}

function transactionCategoryMatchTexts(tx) {
  const values = [tx.raw?.payee, tx.description, tx.raw?.memo]
    .map((value) => normalizeText(value || ""))
    .filter(Boolean);
  return [...new Set(values)];
}

function categoryNameForMcc(value) {
  const mcc = normalizeMetricMcc(value);
  if (mcc === "0000") return "Uncategorized";
  if (MCC_CATEGORY_NAMES[mcc]) return MCC_CATEGORY_NAMES[mcc];
  const code = Number(mcc);
  if (code >= 3000 && code <= 3299) return "Airlines";
  if (code >= 3300 && code <= 3499) return "Car Rental";
  if (code >= 3500 && code <= 3999) return "Lodging";
  if (code >= 4111 && code <= 4789) return "Transportation";
  if (code >= 4812 && code <= 4899) return "Utilities";
  if (code >= 4900 && code <= 4999) return "Utilities";
  if (code >= 5000 && code <= 5599) return "Merchandise";
  if (code >= 5600 && code <= 5699) return "Clothing";
  if (code >= 5700 && code <= 7299) return "Services";
  if (code >= 7300 && code <= 7999) return "Business & Recreation";
  if (code >= 8000 && code <= 8999) return "Health & Education";
  if (code >= 9000 && code <= 9999) return "Government";
  return "Other";
}

function normalizeMetricMcc(value) {
  if (value === null || value === undefined || value === "") return "0000";
  return String(value).padStart(4, "0");
}

function categoryNameFromText(value = "") {
  const text = String(value).toLowerCase();
  if (!text) return null;
  if (/\b(habit|burger|restaurant|cafe|coffee|pizza|taco|sushi|grill|kitchen|deli|beer|concession|food)\b/.test(text)) {
    return "Restaurants";
  }
  if (/\b(costco|amazon|home depot|target|walmart|store|market|shop)\b/.test(text)) return "Merchandise";
  if (/\b(gas|fuel|shell|chevron|exxon|76|arco)\b/.test(text)) return "Fuel";
  if (/\b(gym|fitness|athletics|vie athletics)\b/.test(text)) return "Fitness";
  if (/\b(alarm|security|utility|wireless|verizon|comcast|xfinity)\b/.test(text)) return "Utilities";
  if (/\b(loan|payment|transfer|checking|credit card)\b/.test(text)) return "Transfers & Payments";
  return null;
}

const MCC_CATEGORY_NAMES = {
  "5300": "Wholesale & Discount Stores",
  "5310": "Discount Stores",
  "5311": "Department Stores",
  "5331": "Variety Stores",
  "5411": "Groceries",
  "5422": "Meat & Seafood",
  "5441": "Candy & Confectionery",
  "5451": "Dairy",
  "5462": "Bakeries",
  "5499": "Food Stores",
  "5511": "Auto Dealers",
  "5532": "Auto Parts",
  "5533": "Auto Parts",
  "5541": "Fuel",
  "5542": "Fuel",
  "5812": "Restaurants",
  "5813": "Bars",
  "5814": "Fast Food",
  "5912": "Pharmacy",
  "5921": "Liquor Stores",
  "5941": "Sporting Goods",
  "5942": "Books",
  "5943": "Office Supplies",
  "5945": "Toys & Games",
  "5999": "Miscellaneous Retail",
  "7011": "Hotels",
  "7832": "Movies",
  "7996": "Amusement Parks",
  "7997": "Clubs & Fitness",
  "7999": "Entertainment",
};

const MASTER_CATEGORY_NAMES = [
  "Groceries",
  "Restaurants",
  "Fast Food",
  "Bars",
  "Fuel",
  "Merchandise",
  "Wholesale & Discount Stores",
  "Discount Stores",
  "Department Stores",
  "Home Improvement",
  "Clothing",
  "Pharmacy",
  "Entertainment",
  "Fitness",
  "Travel",
  "Airlines",
  "Lodging",
  "Car Rental",
  "Transportation",
  "Utilities",
  "Services",
  "Health & Education",
  "Business & Recreation",
  "Government",
  "Transfers & Payments",
  "Other",
  "Uncategorized",
];

function isCreditCardPaymentFromCash(tx, accountMap, transactions) {
  const account = accountMap.get(tx.accountId);
  if (!account || account.type === "credit" || Number(tx.amount) >= 0) return false;
  const description = String(tx.description || "").toLowerCase();
  const looksLikeCardPayment =
    /\b(credit card|cardmember|card payment|cc payment|autopay|auto pay|online payment)\b/.test(description) ||
    /\b(chase|citi|citibank|costco|home depot|bank of america|bofa|amazon|visa|mastercard|amex|american express|discover)\b/.test(description) &&
      /\b(payment|pmt|paymnt|transfer)\b/.test(description);
  if (looksLikeCardPayment) return true;

  const txDate = parseLocalDate(tx.date);
  return transactions.some((candidate) => {
    const candidateAccount = accountMap.get(candidate.accountId);
    if (!candidateAccount || candidateAccount.type !== "credit") return false;
    if (Number(candidate.amount) <= 0) return false;
    const amountClose = Math.abs(Math.abs(Number(tx.amount)) - Math.abs(Number(candidate.amount))) <= 1;
    if (!amountClose) return false;
    const daysApart = Math.abs((parseLocalDate(candidate.date).getTime() - txDate.getTime()) / (1000 * 60 * 60 * 24));
    return daysApart <= 5;
  });
}

function balanceAtEndOfDay(transactions, date, { fallbackBalance = null, fallbackDate = null } = {}) {
  let latest = null;
  for (const tx of transactions) {
    if (tx.date > date) break;
    if (tx.balance !== null && tx.balance !== undefined) latest = tx;
  }
  if (latest) {
    const laterChange = latest.date === date
      ? 0
      : transactions
        .filter((tx) => tx.date > latest.date && tx.date <= date)
        .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
    return Number(latest.balance || 0) + laterChange;
  }

  const next = transactions.find((tx) => tx.date > date && tx.balance !== null && tx.balance !== undefined);
  if (!next) {
    if (fallbackBalance === null || fallbackBalance === undefined || !fallbackDate || fallbackDate < date) return 0;
    const laterTransactions = transactions.filter((tx) => tx.date > date && tx.date <= fallbackDate);
    const laterChange = laterTransactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
    return Number(fallbackBalance || 0) - laterChange;
  }
  const laterTransactions = transactions.filter((tx) => tx.date > date && tx.date <= next.date);
  const laterChange = laterTransactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  return Number(next.balance || 0) - laterChange;
}

function validDateParam(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(new Date(`${value}T12:00:00`).getTime()) ? null : value;
}

function dateRange(startDate, endDate) {
  const dates = [];
  const cursor = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  while (cursor <= end) {
    dates.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

async function refreshSimpleFin(session, { force = false, chunks = 1 } = {}) {
  const connections = listSimpleFinConnections(db, session, true);
  let accountsImported = 0;
  let transactionsImported = 0;
  let correctionsInserted = 0;
  let skipped = 0;
  const errors = [];
  const chunkCount = Math.max(1, Math.min(chunks, 12));

  for (const connection of connections) {
    if (!force && chunkCount === 1 && connection.lastSyncAt) {
      const age = Date.now() - new Date(connection.lastSyncAt).getTime();
      if (age < 1000 * 60 * 60 * 20) {
        skipped += 1;
        continue;
      }
    }

    try {
      for (let chunk = 0; chunk < chunkCount; chunk += 1) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const endDate = nowSeconds - chunk * config.simplefinDays * 24 * 60 * 60;
        const startDate = endDate - config.simplefinDays * 24 * 60 * 60;
        const accountSet = await fetchAccounts(connection.accessUrl, {
          startDate,
          endDate,
          pending: config.simplefinPending && chunk === 0,
        });
        const chunkResult = importSimpleFinAccountSet(session, accountSet);
        accountsImported += chunkResult.accountsImported;
        transactionsImported += chunkResult.transactionsImported;
        correctionsInserted += chunkResult.correctionsInserted;
      }
      markSimpleFinSynced(db, connection.id);
    } catch (error) {
      errors.push({ connectionId: connection.id, message: error.message });
    }
  }

  await logActivity(db, "info", "SimpleFIN refresh completed", {
    accountsImported,
    transactionsImported,
    correctionsInserted,
    chunks: chunkCount,
    skipped,
    errors,
  });
  return { accountsImported, transactionsImported, correctionsInserted, chunks: chunkCount, skipped, errors };
}

function getSyncSettings() {
  return {
    dailyHour: 3,
    dailyEnabled: false,
    firstUserPullAt: null,
    lastPulledThrough: null,
    ...getMeta(db, "syncSettings", {}),
  };
}

function saveSyncSettings(patch) {
  const next = { ...getSyncSettings(), ...patch };
  setMeta(db, "syncSettings", next);
  return next;
}

function startSimpleFinRangeJob(session, { startDate, endDate, kind = "manual" }) {
  if (!startDate || !endDate) throw new Error("Choose a start and end date.");
  if (new Date(startDate) > new Date(endDate)) throw new Error("Start date must be before end date.");
  const id = `sync_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  createSyncJob(db, { id, kind, details: { startDate, endDate } });
  runSimpleFinRangeJob(session, { id, startDate, endDate, kind }).catch(async (error) => {
    finishSyncJob(db, id, "failed", { error: error.message, startDate, endDate });
    await logActivity(db, "error", "SimpleFIN sync job failed", { id, error: error.message });
  });
  return { id, status: "running", startDate, endDate };
}

async function runSimpleFinRangeJob(session, { id, startDate, endDate, kind }) {
  const chunks = buildDateChunks(startDate, endDate);
  let totals = {
    accountsImported: 0,
    transactionsImported: 0,
    correctionsInserted: 0,
    duplicatesRemoved: 0,
    staleRemoved: 0,
    chunks: chunks.length,
    errors: [],
    accountDiagnostics: [],
  };

  for (const chunk of chunks) {
    const result = await refreshSimpleFinRange(session, chunk);
    totals.accountsImported += result.accountsImported;
    totals.transactionsImported += result.transactionsImported;
    totals.correctionsInserted += result.correctionsInserted;
    totals.duplicatesRemoved += result.duplicatesRemoved;
    totals.staleRemoved += result.staleRemoved;
    totals.errors.push(...result.errors);
    totals.accountDiagnostics.push(...result.accountDiagnostics.map((item) => ({ ...item, chunk })));
  }

  if (kind === "manual" && !totals.errors.length) {
    saveSyncSettings({
      firstUserPullAt: getSyncSettings().firstUserPullAt || new Date().toISOString(),
      lastPulledThrough: endDate,
    });
  }
  if (kind === "daily" && !totals.errors.length) {
    saveSyncSettings({ lastPulledThrough: endDate });
  }

  finishSyncJob(db, id, totals.errors.length ? "completed_with_errors" : "completed", totals);
  await logActivity(db, "info", "SimpleFIN sync job completed", { id, kind, ...totals });
  return totals;
}

async function refreshSimpleFinRange(session, { startDate, endDate }) {
  const connections = listSimpleFinConnections(db, session, true);
  let accountsImported = 0;
  let transactionsImported = 0;
  let correctionsInserted = 0;
  let duplicatesRemoved = 0;
  let staleRemoved = 0;
  const errors = [];
  const accountDiagnostics = [];
  const startSeconds = dateToUnix(startDate, false);
  const endSeconds = dateToUnix(endDate, true);

  for (const connection of connections) {
    try {
      const pendingRequested = endDate === todayIso();
      const accountSet = await fetchAccounts(connection.accessUrl, {
        startDate: startSeconds,
        endDate: endSeconds,
        pending: pendingRequested,
      });
      const chunkResult = importSimpleFinAccountSet(session, accountSet, {
        connectionId: connection.id,
        connectionLabel: connection.label,
        startDate,
        endDate,
        pendingRequested,
        accountsReturned: (accountSet.accounts || []).length,
      });
      accountsImported += chunkResult.accountsImported;
      transactionsImported += chunkResult.transactionsImported;
      correctionsInserted += chunkResult.correctionsInserted;
      duplicatesRemoved += chunkResult.duplicatesRemoved;
      staleRemoved += chunkResult.staleRemoved;
      accountDiagnostics.push(...chunkResult.accountDiagnostics);
      markSimpleFinSynced(db, connection.id);
    } catch (error) {
      errors.push({ connectionId: connection.id, message: error.message, startDate, endDate });
    }
  }

  return { accountsImported, transactionsImported, correctionsInserted, duplicatesRemoved, staleRemoved, errors, accountDiagnostics };
}

function buildDateChunks(startDate, endDate) {
  const chunks = [];
  let cursor = parseLocalDate(startDate);
  const final = parseLocalDate(endDate);
  while (cursor <= final) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + config.simplefinDays - 1);
    if (chunkEnd > final) chunkEnd.setTime(final.getTime());
    chunks.push({ startDate: isoDate(chunkStart), endDate: isoDate(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return chunks;
}

function parseLocalDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateToUnix(value, endOfDay = false) {
  const date = parseLocalDate(value);
  if (endOfDay) date.setHours(23, 59, 59, 999);
  else date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function unixDate(value) {
  return value ? new Date(Number(value) * 1000).toISOString().slice(0, 10) : null;
}

function simpleFinTransactionDate(tx) {
  return unixDate(tx.posted) || unixDate(tx.transacted_at) || todayIso();
}

function accountRangeCount(session, accountId, startDate, endDate) {
  if (!startDate || !endDate) return null;
  return listAllTransactions(db, session)
    .filter((tx) => tx.accountId === accountId && tx.source === "simplefin")
    .filter((tx) => tx.date >= startDate && tx.date <= endDate)
    .filter((tx) => tx.type !== "BALANCE_CORRECTION")
    .length;
}

function todayIso() {
  return isoDate(new Date());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function schedulerTick() {
  const settings = getSyncSettings();
  if (!settings.dailyEnabled || !settings.firstUserPullAt || !settings.lastPulledThrough) return;
  if (!unlockedSession) return;
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minuteKey === lastSchedulerMinute) return;
  lastSchedulerMinute = minuteKey;
  if (now.getMinutes() !== 0 || now.getHours() !== Number(settings.dailyHour)) return;

  const startDate = bufferedDailyStartDate(unlockedSession, settings.lastPulledThrough);
  const endDate = todayIso();
  startSimpleFinRangeJob(unlockedSession, { startDate, endDate, kind: "daily" });
}

function bufferedDailyStartDate(session, fallbackDate) {
  const accounts = listAccounts(db, session).filter((account) => account.source === "simplefin" && !account.hidden);
  const txs = listAllTransactions(db, session);
  const latestDates = accounts
    .map((account) => txs.filter((tx) => tx.accountId === account.id).map((tx) => tx.date).sort().at(-1))
    .filter(Boolean);
  if (!latestDates.length) return fallbackDate;
  const earliestLatest = latestDates.sort()[0];
  const buffered = isoDate(addDays(parseLocalDate(earliestLatest), -5));
  return [buffered, fallbackDate].filter(Boolean).sort()[0];
}

function importSimpleFinAccountSet(
  session,
  accountSet,
  {
    connectionId = null,
    connectionLabel = null,
    startDate = null,
    endDate = null,
    pendingRequested = false,
    accountsReturned = null,
  } = {},
) {
  let accountsImported = 0;
  let transactionsImported = 0;
  let correctionsInserted = 0;
  let duplicatesRemoved = 0;
  let staleRemoved = 0;
  const accountDiagnostics = [];

  const returnedAccountIds = new Set((accountSet.accounts || []).map((account) => account.id));

  for (const account of accountSet.accounts || []) {
    const savedAccount = upsertAccount(db, session, {
      id: `simplefin_${account.id}`,
      name: account.name,
      source: "simplefin",
      externalId: account.id,
      meta: {
        org: account.org,
        currency: account.currency,
        currentBalance: Number(account.balance || 0),
        availableBalance: Number(account["available-balance"] || account.balance || 0),
        balanceDate: account["balance-date"] || null,
        simplefinTrustedBalance: true,
        connectionId,
      },
    });
    accountsImported += 1;
    const storedInRangeBefore = accountRangeCount(session, savedAccount.id, startDate, endDate);
    let accountInserted = 0;
    const returnedDates = [];
    const postedDates = [];
    const transactedDates = [];
    let pendingReturned = 0;
    let postedReturned = 0;
    let missingPostedDate = 0;
    for (const tx of account.transactions || []) {
      const date = simpleFinTransactionDate(tx);
      const postedDate = unixDate(tx.posted);
      const transactedDate = unixDate(tx.transacted_at);
      returnedDates.push(date);
      if (postedDate) postedDates.push(postedDate);
      else missingPostedDate += 1;
      if (transactedDate) transactedDates.push(transactedDate);
      if (tx.pending) pendingReturned += 1;
      else postedReturned += 1;
      const result = upsertTransaction(db, session, savedAccount.id, {
        date,
        description: tx.description,
        amount: Number(tx.amount || 0),
        balance: null,
        pending: Boolean(tx.pending),
        externalId: tx.id,
        source: "simplefin",
        raw: tx,
      });
      if (result.inserted) {
        transactionsImported += 1;
        accountInserted += 1;
      }
    }

    if (account["balance-date"] && account.balance !== undefined) {
      const balanceDate = new Date(Number(account["balance-date"]) * 1000).toISOString().slice(0, 10);
      const correction = addBalanceCorrection(db, session, savedAccount.id, {
        date: balanceDate,
        targetBalance: Number(account.balance),
        source: "simplefin",
        reason: "Balance correction from SimpleFIN",
      });
      if (correction.inserted) correctionsInserted += 1;
    }

    const dedupe = dedupeAccountTransactions(db, session, savedAccount.id, {
      source: "simplefin",
      startDate,
      endDate,
      returnedExternalIds: new Set((account.transactions || []).map((tx) => tx.id).filter(Boolean)),
    });
    duplicatesRemoved += dedupe.deleted;
    staleRemoved += dedupe.staleDeleted;

    const storedInRangeAfter = accountRangeCount(session, savedAccount.id, startDate, endDate);
    const storedLatestDate = listAllTransactions(db, session)
      .filter((tx) => tx.accountId === savedAccount.id)
      .map((tx) => tx.date)
      .sort()
      .at(-1) || null;
    accountDiagnostics.push({
      connectionId,
      connectionLabel,
      simplefinAccountId: account.id,
      accountId: savedAccount.id,
      name: account.name,
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      pendingRequested,
      accountsReturned,
      transactionsReturned: (account.transactions || []).length,
      postedReturned,
      pendingReturned,
      missingPostedDate,
      transactionsInserted: accountInserted,
      duplicatesRemoved: dedupe.deleted,
      staleRemoved: dedupe.staleDeleted,
      storedInRangeBefore,
      storedInRangeAfter,
      earliestReturnedDate: returnedDates.sort()[0] || null,
      latestReturnedDate: returnedDates.sort().at(-1) || null,
      latestPostedDate: postedDates.sort().at(-1) || null,
      latestTransactedDate: transactedDates.sort().at(-1) || null,
      latestStoredDate: storedLatestDate,
      balanceDate: unixDate(account["balance-date"]),
    });
  }

  if (connectionId) {
    for (const account of listAccounts(db, session)) {
      if (account.source !== "simplefin") continue;
      if (account.meta?.connectionId !== connectionId) continue;
      if (returnedAccountIds.has(account.externalId)) continue;
      const storedLatestDate = listAllTransactions(db, session)
        .filter((tx) => tx.accountId === account.id)
        .map((tx) => tx.date)
        .sort()
        .at(-1) || null;
      accountDiagnostics.push({
        connectionId,
        connectionLabel,
        simplefinAccountId: account.externalId,
        accountId: account.id,
        name: account.name,
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        pendingRequested,
        accountsReturned,
        accountMissingFromResponse: true,
        transactionsReturned: 0,
        postedReturned: 0,
        pendingReturned: 0,
        missingPostedDate: 0,
        transactionsInserted: 0,
        duplicatesRemoved: 0,
        staleRemoved: 0,
        storedInRangeBefore: accountRangeCount(session, account.id, startDate, endDate),
        storedInRangeAfter: accountRangeCount(session, account.id, startDate, endDate),
        latestReturnedDate: null,
        latestPostedDate: null,
        latestTransactedDate: null,
        latestStoredDate: storedLatestDate,
        balanceDate: account.meta?.balanceDate ? unixDate(account.meta.balanceDate) : null,
      });
    }
  }

  return { accountsImported, transactionsImported, correctionsInserted, duplicatesRemoved, staleRemoved, accountDiagnostics };
}

async function createImportPreview(session, body) {
  if (!body.fileName || !body.contentBase64) throw new Error("Missing upload file.");
  const buffer = Buffer.from(body.contentBase64, "base64");
  const ext = path.extname(body.fileName).toLowerCase();
  const accounts = listAccounts(db, session);
  let parsed;

  if (ext === ".csv") {
    const account = accounts.find((item) => item.id === body.accountId);
    if (!account) throw new Error("Choose an account for CSV import.");
    parsed = parseCsvText(buffer.toString("utf8"), account.name);
  } else if (ext === ".xlsx" || ext === ".xls") {
    parsed = body.mode === "generic" && body.accountId
      ? await parseGenericXlsxBuffer(buffer, accounts.find((item) => item.id === body.accountId)?.name || "Imported Account")
      : await parseWorkbookBuffer(buffer, "xlsx");
  } else {
    throw new Error("Only CSV and Excel files are supported.");
  }

  return {
    id: `preview_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    fileName: body.fileName,
    parsed,
    preview: buildImportPreview(db, session, parsed, accounts),
  };
}

function redactPreview(preview) {
  return {
    id: preview.id,
    fileName: preview.fileName,
    ...preview.preview,
    accounts: preview.preview.accounts.map((account) => ({
      ...account,
      transactions: undefined,
    })),
  };
}

function commitImport(session, preview, mappings = {}) {
  let accountsCreated = 0;
  let inserted = 0;
  let duplicates = 0;
  let correctionsInserted = 0;

  for (const accountPreview of preview.preview.accounts) {
    const mapping = mappings[accountPreview.accountId] || {};
    const mappedAccount = mapping.accountId
      ? listAccounts(db, session).find((account) => account.id === mapping.accountId)
      : null;
    const account = mappedAccount || accountPreview.existingAccount || upsertAccount(db, session, {
      id: accountPreview.accountId,
      name: mapping.accountName || accountPreview.accountName,
      source: "import",
      externalId: accountPreview.accountName,
    });
    if (!mappedAccount && !accountPreview.existingAccount) accountsCreated += 1;

    const transactions = [...accountPreview.transactions].sort((a, b) => a.date.localeCompare(b.date));
    const boundaryCorrection = maybeCorrectBeforeImportBatch(session, account.id, transactions);
    if (boundaryCorrection.inserted) correctionsInserted += 1;
    for (const tx of transactions) {
      const result = upsertTransaction(db, session, account.id, {
        ...tx,
        source: "import",
      });
      if (result.inserted) inserted += 1;
      else duplicates += 1;
    }
  }

  return { accountsCreated, inserted, duplicates, correctionsInserted };
}

function maybeCorrectBeforeImportBatch(session, accountId, transactions) {
  const firstWithBalance = transactions.find((tx) => tx.balance !== null && tx.balance !== undefined);
  if (!firstWithBalance) return { inserted: false };
  const latest = latestBalanceTransaction(db, session, accountId, firstWithBalance.date);
  if (!latest || latest.balance === null || latest.balance === undefined) return { inserted: false };
  const expectedBalance = Number(latest.balance) + Number(firstWithBalance.amount || 0);
  const diff = Number(firstWithBalance.balance) - expectedBalance;
  if (Math.abs(diff) < 0.005) return { inserted: false };
  return addBalanceCorrection(db, session, accountId, {
    date: firstWithBalance.date,
    targetBalance: Number(latest.balance) + diff,
    source: "import",
    reason: "Balance correction before imported batch",
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) await handleApi(req, res);
    else await sendStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
    });
  }
});

server.listen(config.port, () => {
  console.log(`Bookkeeper running at http://localhost:${config.port}`);
});

setInterval(schedulerTick, 60 * 1000);

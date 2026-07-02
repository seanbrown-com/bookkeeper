import { unzipSync, strFromU8 } from "fflate";
import { transactionFingerprint, normalizeText } from "./db.js";

function excelDateToIso(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return excelSerialToIso(value);
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/[$,()]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (Number.isNaN(parsed)) return null;
  return String(value).includes("(") ? -Math.abs(parsed) : parsed;
}

function get(row, headers, names) {
  for (const name of names) {
    const idx = headers.findIndex((header) => normalizeHeader(header) === normalizeHeader(name));
    if (idx !== -1) return row[idx];
  }
  return null;
}

function normalizeHeader(header) {
  return String(header || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseRowsForAccount(rows, accountName, headers, startRow, source) {
  const transactions = [];
  for (let i = startRow; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const date = excelDateToIso(
      get(row, headers, ["Posting Date", "Posted Date", "Date", "Transaction Date", "Post Date"]),
    );
    const description =
      get(row, headers, ["Description", "Payee", "Memo"]) ||
      get(row, headers, ["Reference Number"]) ||
      "";
    let amount = num(get(row, headers, ["Amount", "Amount Debit", "Debit"]));
    const credit = num(get(row, headers, ["Amount Credit", "Credit"]));

    if (amount === null && credit !== null) amount = credit;
    else if (credit !== null && credit !== 0) amount = credit;

    const debit = num(get(row, headers, ["Debit", "Amount Debit"]));
    if (debit !== null && credit === null && normalizeHeader(headers.join(" ")).includes("credit")) {
      amount = -Math.abs(debit);
    }

    const balance = num(get(row, headers, ["Balance"]));
    if (!date || amount === null || !description) continue;
    transactions.push({
      date,
      description: String(description),
      amount,
      balance,
      type: String(get(row, headers, ["Type", "Category"]) || ""),
      source,
      raw: row,
      accountName,
    });
  }
  return transactions;
}

function excelSerialToIso(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Number(serial) * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function workbookRows(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const sharedStrings = parseSharedStrings(readZipText(files, "xl/sharedStrings.xml") || "");
  const workbookXml = readZipText(files, "xl/workbook.xml") || "";
  const sheetName = decodeXml(matchAttr(workbookXml, /<sheet\b[^>]*name="([^"]+)"/) || "Sheet1");
  const sheetXml = readZipText(files, "xl/worksheets/sheet1.xml");
  if (!sheetXml) throw new Error("Workbook does not contain xl/worksheets/sheet1.xml.");
  return { sheetName, rows: parseSheet(sheetXml, sharedStrings) };
}

function readZipText(files, name) {
  const file = files[name];
  return file ? strFromU8(file) : "";
}

function matchAttr(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : "";
}

function decodeXml(value = "") {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function stripTags(value = "") {
  return decodeXml(value.replace(/<[^>]+>/g, ""));
}

function parseSharedStrings(xml) {
  const strings = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const text = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => decodeXml(part[1]))
      .join("");
    strings.push(text || stripTags(match[1]));
  }
  return strings;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  let maxCol = 0;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1]);
    const row = rows[rowNumber - 1] || [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] || cellMatch[2] || "";
      const body = cellMatch[3] || "";
      const ref = matchAttr(attrs, /\br="([^"]+)"/);
      const type = matchAttr(attrs, /\bt="([^"]+)"/);
      const col = columnIndex(ref.replace(/\d+/g, ""));
      maxCol = Math.max(maxCol, col + 1);
      row[col] = parseCellValue(type, body, sharedStrings);
    }
    rows[rowNumber - 1] = row;
  }

  return rows.map((row) => {
    const filled = [];
    for (let i = 0; i < maxCol; i += 1) filled.push(row?.[i] ?? "");
    return filled;
  });
}

function parseCellValue(type, body, sharedStrings) {
  if (type === "s") {
    const idx = Number(matchAttr(body, /<v>([\s\S]*?)<\/v>/));
    return sharedStrings[idx] ?? "";
  }
  if (type === "inlineStr") {
    return stripTags(body);
  }
  const value = matchAttr(body, /<v>([\s\S]*?)<\/v>/);
  if (!value) return "";
  const numeric = Number(value);
  return Number.isNaN(numeric) ? decodeXml(value) : numeric;
}

function columnIndex(letters) {
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

export async function parseWorkbookBuffer(buffer, source = "xlsx") {
  const { sheetName, rows } = await workbookRows(buffer);
  if (rows.length < 3) throw new Error("Workbook does not contain enough rows to import.");

  const titleRow = rows[0];
  const headerRow = rows[1];
  const starts = [];
  for (let i = 0; i < titleRow.length; i += 1) {
    if (titleRow[i]) starts.push(i);
  }

  const accounts = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : titleRow.length;
    const accountName = String(titleRow[start]).trim();
    const headers = headerRow.slice(start, end);
    if (!headers.some((header) => normalizeHeader(header).includes("date"))) continue;
    if (!headers.some((header) => normalizeHeader(header).includes("amount") || normalizeHeader(header).includes("debit"))) continue;
    const accountRows = rows.map((row) => row.slice(start, end));
    const transactions = parseRowsForAccount(accountRows, accountName, headers, 3, source);
    if (transactions.length) accounts.push({ accountName, headers, transactions });
  }
  return { sheetName, accounts };
}

export async function parseGenericXlsxBuffer(buffer, accountName) {
  const { rows } = await workbookRows(buffer);
  return parseGenericRows(rows, accountName, "xlsx");
}

export function parseCsvText(text, accountName) {
  return parseGenericRows(parseCsv(text), accountName, "csv");
}

function parseGenericRows(rows, accountName, source) {
  if (rows.length < 2) throw new Error("File needs a header row and at least one transaction row.");
  const headers = rows[0];
  return {
    sheetName: "CSV/XLSX",
    accounts: [
      {
        accountName,
        headers,
        transactions: parseRowsForAccount(rows, accountName, headers, 1, source),
      },
    ],
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export function buildImportPreview(db, session, parsed, existingAccounts) {
  const existingFingerprints = new Set(
    db.prepare("SELECT fingerprint FROM transactions").all().map((row) => row.fingerprint),
  );

  const accounts = parsed.accounts.map((accountBlock) => {
    const account =
      existingAccounts.find((item) => item.name === accountBlock.accountName) ||
      existingAccounts.find((item) => normalizeText(item.name) === normalizeText(accountBlock.accountName));
    const accountId = account?.id || `import_${normalizeText(accountBlock.accountName).replace(/\s+/g, "_")}`;
    let duplicates = 0;
    const transactions = accountBlock.transactions.map((tx) => {
      const fingerprint = transactionFingerprint(accountId, tx);
      if (existingFingerprints.has(fingerprint)) duplicates += 1;
      return { ...tx, fingerprint };
    });
    const balanceImpact = transactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
    return {
      accountId,
      accountName: accountBlock.accountName,
      detectedAccountName: accountBlock.accountName,
      existingAccount: account || null,
      matchedAccountId: account?.id || null,
      willCreateAccount: !account,
      headers: accountBlock.headers,
      total: transactions.length,
      duplicates,
      balanceImpact,
      sample: transactions.slice(0, 8),
      transactions,
    };
  });

  return {
    sheetName: parsed.sheetName,
    accountCount: accounts.length,
    transactionCount: accounts.reduce((sum, account) => sum + account.total, 0),
    duplicateCount: accounts.reduce((sum, account) => sum + account.duplicates, 0),
    accounts,
  };
}

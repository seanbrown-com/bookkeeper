import crypto from "node:crypto";
import https from "node:https";
import { URL } from "node:url";

function requestJsonOrText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed = raw;
          const contentType = res.headers["content-type"] || "";
          if (contentType.includes("application/json")) {
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              // Keep raw text for malformed JSON.
            }
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const message =
              parsed?.msg ||
              parsed?.error ||
              (typeof parsed === "string" && parsed.trim()) ||
              `SimpleFIN returned ${res.statusCode}`;
            const error = new Error(message);
            error.statusCode = res.statusCode;
            error.body = parsed;
            reject(error);
          }
        });
      },
    );

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export function accessId(accessUrl) {
  return crypto.createHash("sha256").update(accessUrl).digest("hex").slice(0, 16);
}

export function decodeSetupToken(setupToken) {
  const trimmed = setupToken.trim();
  if (!trimmed) throw new Error("Setup token is required.");

  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  const claimUrl = new URL(decoded);
  if (claimUrl.protocol !== "https:") {
    throw new Error("SimpleFIN claim URL must use HTTPS.");
  }
  return claimUrl;
}

export async function claimSetupToken(setupToken) {
  const claimUrl = decodeSetupToken(setupToken);
  const accessUrl = String(
    await requestJsonOrText(claimUrl, {
      method: "POST",
      headers: {
        "Content-Length": "0",
      },
    }),
  ).trim();

  const parsed = new URL(accessUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("SimpleFIN access URL must use HTTPS.");
  }
  if (!parsed.username || !parsed.password) {
    throw new Error("SimpleFIN access URL did not include credentials.");
  }

  return accessUrl;
}

export async function fetchAccounts(accessUrl, options = {}) {
  const parsed = new URL(accessUrl);
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  parsed.username = "";
  parsed.password = "";

  const rootPath = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = `${rootPath}/accounts`;
  parsed.search = "";
  parsed.searchParams.set("version", "2");

  if (options.days) {
    const days = Math.min(Number(options.days), 30);
    const start = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
    parsed.searchParams.set("start-date", String(start));
  }
  if (options.startDate) parsed.searchParams.set("start-date", String(options.startDate));
  if (options.endDate) parsed.searchParams.set("end-date", String(options.endDate));
  if (options.pending) parsed.searchParams.set("pending", "1");
  if (options.balancesOnly) parsed.searchParams.set("balances-only", "1");

  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  return requestJsonOrText(parsed, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "User-Agent": "bookkeeper-simplefin-poc/0.1",
    },
  });
}

export async function buildSnapshot(connection, options = {}) {
  const accountSet = await fetchAccounts(connection.accessUrl, options);
  return {
    id: connection.id,
    label: connection.label,
    claimedAt: connection.claimedAt,
    ...accountSet,
  };
}

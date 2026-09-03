const crypto = require("crypto");
function md5hex(s) { return crypto.createHash("md5").update(s).digest("hex"); }
// Shared sqlp client for netfs. Handles header acquisition and request forwarding.
const config = require("../config");

const NETLIFY_URL = "https://venerable-smakager-8ddc52.netlify.app";
// const NETLIFY_URL = "https://phpcookie.susuki.de5.net";

let _cachedHeaders = null;

async function fetchHeaders(targetHost) {
  const resp = await fetch(NETLIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: targetHost }),
  });
  if (!resp.ok) throw new Error("netfs: failed to get headers: " + resp.status);
  const h = await resp.json();
  // Build a clean headers object for use in subsequent requests
  const result = { "Content-Type": "application/json" };
  if (h.cookie) result["Cookie"] = h.cookie;
  if (h["user-agent"]) result["User-Agent"] = h["user-agent"];
  return result;
}

function targetHost(sqlpUrl) {
  return new URL(sqlpUrl).origin;
}

async function doRequest(headers, sql, args, token) {
  const url = config.netfsSqlpUrl;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ sql, args, token: token ? md5hex(token) : "" }),
  });
  if (!res.ok) throw new Error("netfs sqlp http error: " + res.status);
  const text = await res.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("netfs sqlp non-JSON response: " + text.slice(0, 200));
  }
  if (result.status !== "success") throw new Error("netfs sqlp error: " + JSON.stringify(result));
  return result;
}

async function sqlp(sql, args = [], token = "") {
  const url = config.netfsSqlpUrl;
  if (!_cachedHeaders) {
    _cachedHeaders = await fetchHeaders(targetHost(url));
  }
  try {
    return await doRequest({ ..._cachedHeaders }, sql, args, token);
  } catch (e) {
    // On auth error, do not retry
    if (e.message && /认证|auth|token/i.test(e.message)) throw e;
    // Refresh headers once and retry on other failures
    _cachedHeaders = await fetchHeaders(targetHost(url));
    return await doRequest({ ..._cachedHeaders }, sql, args, token);
  }
}

module.exports = { sqlp };

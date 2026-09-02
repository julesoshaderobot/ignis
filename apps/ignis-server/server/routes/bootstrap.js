// Bootstrap endpoint for cold start.
//
// Combines vault info, vault list, metadata tree, and plugin list into a single pre-compressed response.
// Cache is per-vault and invalidated by directory mtime check + explicit invalidateVault() calls from the write/delete routes.

const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const zlib = require("zlib");
const config = require("../config");
const {
  getDiscoveredPlugins,
  getVirtualPluginsForVault,
} = require("../plugin-system/manager");
const { getVersion } = require("../version");
const settings = require("../settings");
const { sanitizeError, writeCoalescer } = require("@ignis/server-core");
const { getPending } = writeCoalescer;

const router = express.Router();

// vaultId -> { response, dirMtimes, compressed: { br, gz }, etag }
const cache = new Map();

// vaultId -> Promise<entry>  (in-flight build dedup)
const pendingBuilds = new Map();

// The nonce keeps /tree ETags from repeating across server restarts.
const bootNonce = require("crypto").randomBytes(6).toString("hex");
let revisionCounter = 0;

function preCompress(buf) {
  return Promise.all([
    new Promise((resolve, reject) => {
      zlib.brotliCompress(
        buf,
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
        (err, result) => (err ? reject(err) : resolve(result)),
      );
    }),
    new Promise((resolve, reject) => {
      zlib.gzip(buf, { level: 6 }, (err, result) =>
        err ? reject(err) : resolve(result),
      );
    }),
  ]).then(([br, gz]) => ({ br, gz }));
}

async function walkTree(rootPath) {
  const tree = {};
  const dirMtimes = {};

  async function walk(dir, prefix) {
    const stat = await fsp.stat(dir);
    dirMtimes[prefix] = stat.mtimeMs;

    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        tree[rel] = { type: "directory" };
        await walk(full, rel);
      } else {
        try {
          const buffered = getPending(full);

          if (buffered) {
            const s = await fsp.stat(full).catch(() => null);
            const size = Buffer.isBuffer(buffered.data)
              ? buffered.data.length
              : Buffer.byteLength(buffered.data, buffered.encoding || "utf-8");

            tree[rel] = {
              type: "file",
              size,
              mtime: Date.now(),
              ctime: s ? s.ctimeMs : Date.now(),
            };
          } else {
            const s = await fsp.stat(full);

            tree[rel] = {
              type: "file",
              size: s.size,
              mtime: s.mtimeMs,
              ctime: s.ctimeMs,
            };
          }
        } catch {
          tree[rel] = { type: "file" };
        }
      }
    }
  }

  await walk(rootPath, "");

  return { tree, dirMtimes };
}

async function buildNetfsTree(vaultId, token) {
  const { sqlp } = require("./netfs-client");
  const prefix = "/ignis/" + vaultId + "/";
  console.log(`[buildNetfsTree] vaultId=${vaultId} token_len=${(token||"").length} token_prefix=${(token||"").slice(0,6)}`);
  const result = await sqlp(
    "SELECT name, mtime, CHAR_LENGTH(content) as len FROM t_file WHERE name LIKE ?",
    [prefix + "%"],
    token,
  );
  const rows = result.data || [];
  const tree = {};
  for (const row of rows) {
    const relPath = row.name.slice(prefix.length);
    if (!relPath) continue;
    const size = Math.floor(((row.len || 0) * 3) / 4);
    tree[relPath] = { type: "file", size, mtime: (row.mtime || 0) * 1000 };
    const parts = relPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join("/");
      if (!tree[dirPath]) tree[dirPath] = { type: "directory" };
    }
  }
  return tree;
}

function buildVaultInfo(vaultId, vaultPath) {
  return {
    id: vaultId,
    name: vaultId,
    path: vaultPath,
    platform: process.platform,
    version: config.obsidianVersion,
  };
}

function buildVaultList() {
  return Object.entries(config.vaults).map(([id, vaultPath]) => ({
    id,
    name: id,
    path: vaultPath,
  }));
}

async function dirMtimesUnchanged(vaultPath, dirMtimes) {
  const checks = await Promise.all(
    Object.entries(dirMtimes).map(async ([relDir, oldMtime]) => {
      const absDir = relDir
        ? path.join(vaultPath, relDir.split("/").join(path.sep))
        : vaultPath;

      try {
        const s = await fsp.stat(absDir);
        return s.mtimeMs === oldMtime;
      } catch {
        return false;
      }
    }),
  );

  return checks.every(Boolean);
}

async function buildEntry(vaultId, token) {
  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultPath) {
    return null;
  }

  // ── NetFS vault: build tree from SQL, skip local fs ──
  if (config.isNetfsVault(vaultId)) {
    const cached = cache.get(vaultId);
    if (cached) return cached;

    const t0 = Date.now();
    const etag = '"' + bootNonce + "-" + ++revisionCounter + '"';
    const vault = buildVaultInfo(vaultId, vaultPath);
    const tree = await buildNetfsTree(vaultId, token);

    const response = {
      vault,
      vaultList: buildVaultList(),
      tree,
      treeRevision: etag,
      plugins: config.demoMode ? [] : getDiscoveredPlugins(),
      virtualPlugins: getVirtualPluginsForVault(vaultId, getVersion()),
      settings: {
        contentCacheBytes: settings.get("contentCacheBytes"),
        inputCacheBytes: settings.get("inputCacheBytes"),
        inputCacheTtlMs: settings.get("inputCacheTtlMs"),
        directFetchHosts: settings.get("directFetchHosts"),
      },
    };

    const jsonBuf = Buffer.from(JSON.stringify(response));
    let compressed = {};
    try {
      compressed = await preCompress(jsonBuf);
    } catch (e) {
      console.warn("[bootstrap] precompression failed:", e.message);
    }

    const entry = { response, dirMtimes: {}, compressed, etag };
    cache.set(vaultId, entry);
    console.log(
      `[bootstrap] netfs vault=${vaultId} build files=${Object.keys(tree).filter((k) => tree[k].type === "file").length} time=${Date.now() - t0}ms`,
    );
    return entry;
  }

  const cached = cache.get(vaultId);

  if (cached && (await dirMtimesUnchanged(vaultPath, cached.dirMtimes))) {
    return cached;
  }

  const t0 = Date.now();
  const etag = '"' + bootNonce + "-" + ++revisionCounter + '"';
  const vault = buildVaultInfo(vaultId, vaultPath);
  const { tree, dirMtimes } = await walkTree(vaultPath);

  const response = {
    vault,
    vaultList: buildVaultList(),
    tree,
    treeRevision: etag,
    plugins: config.demoMode ? [] : getDiscoveredPlugins(),
    virtualPlugins: getVirtualPluginsForVault(vaultId, getVersion()),
    settings: {
      contentCacheBytes: settings.get("contentCacheBytes"),
      inputCacheBytes: settings.get("inputCacheBytes"),
      inputCacheTtlMs: settings.get("inputCacheTtlMs"),
      directFetchHosts: settings.get("directFetchHosts"),
    },
  };

  const jsonBuf = Buffer.from(JSON.stringify(response));
  let compressed = {};

  try {
    compressed = await preCompress(jsonBuf);
  } catch (e) {
    console.warn("[bootstrap] precompression failed:", e.message);
  }

  const entry = { response, dirMtimes, compressed, etag };
  cache.set(vaultId, entry);

  const ms = Date.now() - t0;
  const fileCount = Object.keys(tree).filter(
    (k) => tree[k].type === "file",
  ).length;
  const dirCount = Object.keys(dirMtimes).length;

  console.log(
    `[bootstrap] vault=${vaultId} build files=${fileCount} dirs=${dirCount} time=${ms}ms`,
  );

  return entry;
}

async function getOrBuild(vaultId, token) {
  if (pendingBuilds.has(vaultId)) {
    return pendingBuilds.get(vaultId);
  }

  const promise = buildEntry(vaultId, token).finally(() => {
    pendingBuilds.delete(vaultId);
  });

  pendingBuilds.set(vaultId, promise);

  return promise;
}

function invalidateVault(vaultId) {
  cache.delete(vaultId);
}

function invalidateAll() {
  cache.clear();
}

async function warmUp() {
  const ids = Object.keys(config.vaults);

  for (const id of ids) {
    // Skip netfs vaults: they require a token from the request context.
    if (config.isNetfsVault(id)) continue;
    try {
      await buildEntry(id);
    } catch (e) {
      console.warn(`[bootstrap] warm-up failed for vault ${id}:`, e.message);
    }
  }
}

router.get("/", async (req, res) => {
  const vaultId = req.query.vault || config.defaultVaultId;

  if (!vaultId || !config.getVaultPath(vaultId)) {
    return res.status(404).json({ error: "Vault not found", id: vaultId });
  }

  try {
    const token = req.headers["x-token"] || "";
    console.log(`[bootstrap] vault=${vaultId} token_len=${token.length} token_prefix=${token.slice(0,6)}`);
    const entry = await getOrBuild(vaultId, token);

    if (!entry) {
      return res.status(404).json({ error: "Vault not found" });
    }

    // don't cache the bootstrap response, since it contains the metadata tree which can change frequently.
    res.setHeader("Cache-Control", "no-store");

    // In demo mode, route through res.json so the demo middleware can translate vault names per-session.
    // The pre-compressed buffer path bakes the storage prefix in and would bypass the response wrapper.
    // Deep-clone so the demo translator's in-place mutation doesn't pollute the cached response object.
    if (req._demoSessionId) {
      return res.json(JSON.parse(JSON.stringify(entry.response)));
    }

    const ae = req.headers["accept-encoding"] || "";
    const { compressed } = entry;
    let buf, encoding;

    if (ae.includes("br") && compressed.br) {
      buf = compressed.br;
      encoding = "br";
    } else if (
      (ae.includes("gzip") || ae.includes("deflate")) &&
      compressed.gz
    ) {
      buf = compressed.gz;
      encoding = "gzip";
    }

    if (buf) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Content-Length", buf.length);

      return res.status(200).end(buf);
    }

    res.json(entry.response);
  } catch (e) {
    console.error("[bootstrap] error:", e);
    res.status(500).json(sanitizeError(e));
  }
});

module.exports = router;
module.exports.invalidateVault = invalidateVault;
module.exports.invalidateAll = invalidateAll;
module.exports.warmUp = warmUp;
module.exports.walkTree = walkTree;
module.exports.getOrBuild = getOrBuild;

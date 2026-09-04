const express = require("express");
const config = require("../config");
const { sqlp } = require("./netfs-client");

// WebSocket broadcast function, set via setWss()
let _wss = null;

function setWss(wss) {
  _wss = wss;
}

function getToken(req) {
  return req.headers["x-token"] || "";
}

// Broadcast a file change event to all connected clients for this vault
function broadcast(vaultId, event) {
  if (_wss) {
    _wss.broadcastToVault(vaultId, event);
  }
}

// sqlp.php blocks INSERT with 'content' in column list; use two-step upsert instead
async function upsertFile(name, b64, ctime, mtime, token) {
  await sqlp(
    "INSERT IGNORE INTO t_file (name, ctime, mtime) VALUES (?, ?, ?)",
    [name, ctime, mtime],
    token
  );
  await sqlp(
    "UPDATE t_file SET content = ?, mtime = ? WHERE name = ?",
    [b64, mtime, name],
    token
  );
}

const router = express.Router();

function netfsPrefix(vaultId) {
  return "/ignis/" + vaultId + "/";
}

function toNetfsName(vaultId, relPath) {
  // relPath is relative to vault root, no leading slash
  const p = (relPath || "").replace(/^\/+/, "");
  return netfsPrefix(vaultId) + p;
}

function getVaultId(req, res) {
  const vaultId = req.query.vault || req.body?.vault || config.defaultVaultId;
  if (!config.isNetfsVault(vaultId)) {
    res.status(404).json({ error: "Vault not found", id: vaultId });
    return null;
  }
  req._vaultId = vaultId;
  return vaultId;
}

function getRelPath(req, res, source = "query") {
  const p = source === "body" ? req.body?.path : req.query.path;
  if (p === undefined || p === null) {
    res.status(400).json({ error: "Missing path parameter" });
    return null;
  }
  // Reject path traversal
  const normalized = p.replace(/\\/g, "/");
  if (normalized.includes("../") || normalized.includes("/..")) {
    res.status(403).json({ error: "Path traversal rejected" });
    return null;
  }
  return normalized.replace(/^\/+/, "");
}

// GET /api/fs/stat?path=...&vault=...
router.get("/stat", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const relPath = getRelPath(req, res);
  if (relPath === null) return;

  // Directory: virtual, always exists if empty path or ends with /
  if (relPath === "" || relPath.endsWith("/")) {
    return res.json({ type: "directory", mtime: Date.now(), size: 0 });
  }

  try {
    const name = toNetfsName(vaultId, relPath);
    const result = await sqlp(
      "SELECT ctime, mtime, CHAR_LENGTH(content) as len FROM t_file WHERE name = ?",
      [name],
      getToken(req)
    );
    const rows = result.data || [];
    if (!rows.length) {
      return res.status(404).json({ error: "ENOENT", code: "ENOENT" });
    }
    const row = rows[0];
    // base64: actual byte size ~ len * 3/4
    const size = Math.floor((row.len || 0) * 3 / 4);
    res.json({
      type: "file",
      size,
      mtime: (row.mtime || 0) * 1000,
      ctime: (row.ctime || 0) * 1000,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fs/readFile?path=...&vault=...&encoding=...
router.get("/readFile", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const relPath = getRelPath(req, res);
  if (relPath === null) return;

  try {
    const name = toNetfsName(vaultId, relPath);
    const result = await sqlp(
      "SELECT content FROM t_file WHERE name = ?",
      [name],
      getToken(req)
    );
    const rows = result.data || [];
    if (!rows.length) {
      return res.status(404).json({ error: "ENOENT", code: "ENOENT" });
    }
    const b64 = rows[0].content || "";
    const buf = Buffer.from(b64, "base64");
    const encoding = req.query.encoding || "";
    if (encoding === "utf8" || encoding === "utf-8") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.send(buf.toString("utf-8"));
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fs/writeFile { path, content, encoding?, base64?, vault? }
router.post("/writeFile", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const relPath = getRelPath(req, res, "body");
  if (relPath === null) return;

  try {
    const name = toNetfsName(vaultId, relPath);
    let buf;
    if (req.body.base64) {
      buf = Buffer.from(req.body.content, "base64");
    } else {
      const enc = req.body.encoding || "utf-8";
      buf = Buffer.from(req.body.content, enc);
    }
    const b64 = buf.toString("base64");
    const now = Math.floor(Date.now() / 1000);
    await upsertFile(name, b64, now, now, getToken(req));
    broadcast(vaultId, { type: "modified", path: relPath, stat: { size: buf.length, mtime: now * 1000 } });
    res.json({ ok: true, mtime: now * 1000, size: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fs/appendFile { path, content, vault? }
router.post("/appendFile", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const relPath = getRelPath(req, res, "body");
  if (relPath === null) return;

  try {
    const name = toNetfsName(vaultId, relPath);
    // Read existing
    const result = await sqlp(
      "SELECT content FROM t_file WHERE name = ?",
      [name],
      getToken(req)
    );
    const rows = result.data || [];
    const existing = rows.length ? Buffer.from(rows[0].content || "", "base64") : Buffer.alloc(0);
    const appended = Buffer.from(req.body.content || "", "utf-8");
    const merged = Buffer.concat([existing, appended]);
    const b64 = merged.toString("base64");
    const now = Math.floor(Date.now() / 1000);
    await upsertFile(name, b64, now, now, getToken(req));
    broadcast(vaultId, { type: "modified", path: relPath, stat: { size: merged.length, mtime: now * 1000 } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fs/mkdir { path, vault? } - no-op for netfs
router.post("/mkdir", (req, res) => {
  res.json({ ok: true });
});

// POST /api/fs/rename { oldPath, newPath, vault? }
router.post("/rename", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  if (!req.body?.oldPath || !req.body?.newPath) {
    return res.status(400).json({ error: "Missing oldPath or newPath" });
  }
  const oldRel = (req.body.oldPath || "").replace(/^\/+/, "");
  const newRel = (req.body.newPath || "").replace(/^\/+/, "");

  try {
    const oldName = toNetfsName(vaultId, oldRel);
    const newName = toNetfsName(vaultId, newRel);
    const prefix = netfsPrefix(vaultId);
    // Rename single file or directory subtree
    const likePattern = oldName + "/%";
    // Rename exact file
    await sqlp(
      "UPDATE t_file SET name = ? WHERE name = ?",
      [newName, oldName],
      getToken(req)
    );
    // Rename subtree (directory rename)
    const subtreeResult = await sqlp(
      "SELECT name FROM t_file WHERE name LIKE ?",
      [likePattern],
      getToken(req)
    );
    const rows = subtreeResult.data || [];
    for (const row of rows) {
      const newSubName = newName + "/" + row.name.slice(oldName.length + 1);
      await sqlp(
        "UPDATE t_file SET name = ? WHERE name = ?",
        [newSubName, row.name],
        getToken(req)
      );
    }
    broadcast(vaultId, { type: "deleted", path: oldRel });
    broadcast(vaultId, { type: "created", path: newRel });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fs/copyFile { src, dest, vault? }
router.post("/copyFile", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  if (!req.body?.src || !req.body?.dest) {
    return res.status(400).json({ error: "Missing src or dest" });
  }
  const srcRel = (req.body.src || "").replace(/^\/+/, "");
  const destRel = (req.body.dest || "").replace(/^\/+/, "");

  try {
    const srcName = toNetfsName(vaultId, srcRel);
    const destName = toNetfsName(vaultId, destRel);
    const result = await sqlp(
      "SELECT content, ctime FROM t_file WHERE name = ?",
      [srcName],
      getToken(req)
    );
    const rows = result.data || [];
    if (!rows.length) {
      return res.status(404).json({ error: "ENOENT", code: "ENOENT" });
    }
    const { content, ctime } = rows[0];
    const now = Math.floor(Date.now() / 1000);
    await upsertFile(destName, content, ctime, now, getToken(req));
    broadcast(vaultId, { type: "created", path: destRel, stat: { size: Math.floor((content.length || 0) * 3 / 4), mtime: now * 1000 } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/fs/unlink?path=...&vault=...
router.delete("/unlink", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const relPath = getRelPath(req, res);
  if (relPath === null) return;

  try {
    const name = toNetfsName(vaultId, relPath);
    await sqlp("DELETE FROM t_file WHERE name = ?", [name], getToken(req));
    broadcast(vaultId, { type: "deleted", path: relPath });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/fs/rmdir?path=...&vault=... - no-op
router.delete("/rmdir", (req, res) => {
  res.json({ ok: true });
});

// DELETE /api/fs/rm?path=...&recursive=true&vault=...
router.delete("/rm", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const relPath = getRelPath(req, res);
  if (relPath === null) return;

  try {
    const name = toNetfsName(vaultId, relPath);
    if (req.query.recursive === "true") {
      await sqlp("DELETE FROM t_file WHERE name = ? OR name LIKE ?", [name, name + "/%"], getToken(req));
    broadcast(vaultId, { type: "deleted", path: relPath });
    } else {
      await sqlp("DELETE FROM t_file WHERE name = ?", [name], getToken(req));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fs/access?path=...&vault=...
router.get("/access", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const relPath = getRelPath(req, res);
  if (relPath === null) return;

  // Vault root always accessible
  if (relPath === "") return res.json({ ok: true });

  try {
    const name = toNetfsName(vaultId, relPath);
    const result = await sqlp(
      "SELECT 1 FROM t_file WHERE name = ? OR name LIKE ? LIMIT 1",
      [name, name + "/%"],
      getToken(req)
    );
    const rows = result.data || [];
    if (!rows.length) {
      return res.status(404).json({ error: "ENOENT", code: "ENOENT" });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fs/utimes { path, atime, mtime, vault? }
router.post("/utimes", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const relPath = getRelPath(req, res, "body");
  if (relPath === null) return;

  try {
    const name = toNetfsName(vaultId, relPath);
    const mtime = Math.floor((req.body.mtime || Date.now()) / 1000);
    await sqlp("UPDATE t_file SET mtime = ? WHERE name = ?", [mtime, name], getToken(req));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fs/batch-read { paths, vault }
router.post("/batch-read", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  if (paths.length > 1000) {
    return res.status(400).json({ error: "too many paths in batch-read" });
  }
  if (paths.length === 0) return res.json({ files: {} });

  try {
    const names = paths.map((p) => toNetfsName(vaultId, p.replace(/^\/+/, "")));
    const placeholders = names.map(() => "?").join(",");
    const result = await sqlp(
      `SELECT name, content FROM t_file WHERE name IN (${placeholders})`,
      names,
      getToken(req)
    );
    const rows = result.data || [];
    const files = {};
    const prefix = netfsPrefix(vaultId);
    for (const row of rows) {
      const relPath = row.name.startsWith(prefix) ? row.name.slice(prefix.length) : row.name;
      try {
        files[relPath] = Buffer.from(row.content || "", "base64").toString("utf-8");
      } catch {
        // skip non-utf8
      }
    }
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fs/tree?vault=...
router.get("/tree", async (req, res) => {
  const vaultId = getVaultId(req, res);
  if (!vaultId) return;

  try {
    const prefix = netfsPrefix(vaultId);
    const likePattern = prefix + "%";
    const result = await sqlp(
      "SELECT name, mtime, CHAR_LENGTH(content) as len FROM t_file WHERE name LIKE ?",
      [likePattern],
      getToken(req)
    );
    const rows = result.data || [];
    const tree = {};
    for (const row of rows) {
      const relPath = row.name.slice(prefix.length);
      if (!relPath) continue;
      const size = Math.floor((row.len || 0) * 3 / 4);
      tree[relPath] = { type: "file", size, mtime: (row.mtime || 0) * 1000 };
      // Ensure parent directories appear in tree
      const parts = relPath.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join("/");
        if (!tree[dirPath]) {
          tree[dirPath] = { type: "directory" };
        }
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(tree);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fs/auth { token } - verify token against sqlps.php
router.post("/auth", async (req, res) => {
  const token = req.body?.token || "";
  if (!token) {
    return res.status(400).json({ ok: false, error: "Missing token" });
  }
  try {
    await sqlp("SELECT 1", [], token);
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.setWss = setWss;

"use strict";

require("dotenv").config();   // baca .env jika ada

const express  = require("express");
const path     = require("path");
const fs       = require("fs");
const multer   = require("multer");
const Database = require("better-sqlite3");
const crypto   = require("crypto");

// ─────────────────────────────────────────────
//  KONFIGURASI
// ─────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

/* P3 — Password dari environment variable */
const ADMIN_PASSWORD_RAW = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD_RAW) {
    console.error(
        "\n[FATAL] Environment variable ADMIN_PASSWORD belum diatur.\n" +
        "Buat file .env atau jalankan: set ADMIN_PASSWORD=kataSandiAnda\n"
    );
    process.exit(1);
}

/* Hash password sekali saat startup — pakai SHA-256 sebagai KDF ringan
   (scrypt lebih baik tapi butuh async; untuk jaringan lokal ini sudah memadai) */
const ADMIN_PASSWORD_HASH = crypto
    .createHash("sha256")
    .update(ADMIN_PASSWORD_RAW)
    .digest();

const ROOT_DIR    = __dirname;
const PUBLIC_DIR  = path.join(ROOT_DIR, "public");

// DATA_DIR harus menunjuk ke persistent disk saat production. Tanpa nilai ini,
// perilaku lokal tetap sama: database, upload, dan backup disimpan di proyek.
const DATA_DIR     = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : ROOT_DIR;
const DATABASE_DIR = path.join(DATA_DIR, "database");
const UPLOAD_DIR   = path.join(DATA_DIR, "uploads");
const BACKUP_DIR   = path.join(DATA_DIR, "backup");
const DATABASE_FILE = path.join(DATABASE_DIR, "pilketos.db");

[PUBLIC_DIR, DATABASE_DIR, UPLOAD_DIR, BACKUP_DIR].forEach(function (d) {
    fs.mkdirSync(d, { recursive: true });
});

// ─────────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────────
const db = new Database(DATABASE_FILE);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");   // WAL memungkinkan backup online via db.backup()

db.exec(`
CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    chairman TEXT NOT NULL,
    vice TEXT NOT NULL,
    photo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS election_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'DRAFT',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS voter_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS voter_classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS voter_departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(class_id, name),
    FOREIGN KEY(class_id) REFERENCES voter_classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS voter_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    role_id INTEGER,
    class_id INTEGER,
    department_id INTEGER,
    used INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME,
    FOREIGN KEY(role_id) REFERENCES voter_roles(id),
    FOREIGN KEY(class_id) REFERENCES voter_classes(id),
    FOREIGN KEY(department_id) REFERENCES voter_departments(id)
);

CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    voter_code_id INTEGER NOT NULL UNIQUE,
    role_id INTEGER,
    class_id INTEGER,
    department_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(candidate_id) REFERENCES candidates(id),
    FOREIGN KEY(voter_code_id) REFERENCES voter_codes(id),
    FOREIGN KEY(role_id) REFERENCES voter_roles(id),
    FOREIGN KEY(class_id) REFERENCES voter_classes(id),
    FOREIGN KEY(department_id) REFERENCES voter_departments(id)
);

CREATE TABLE IF NOT EXISTS vote_tokens (
    token TEXT PRIMARY KEY,
    voter_code_id INTEGER NOT NULL,
    role_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(voter_code_id) REFERENCES voter_codes(id)
);

CREATE TABLE IF NOT EXISTS admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    detail TEXT,
    election_status TEXT,
    rows_affected INTEGER DEFAULT 0,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS votes_archive (
    id INTEGER PRIMARY KEY,
    candidate_id INTEGER NOT NULL,
    voter_code_id INTEGER NOT NULL,
    role_id INTEGER,
    class_id INTEGER,
    department_id INTEGER,
    original_created_at DATETIME,
    archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    batch_id TEXT NOT NULL,
    deleted_reason TEXT
);
`);

// ── Migrasi aman (cek sebelum ALTER) ────────
function columnExists(table, column) {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
    return cols.some(function (c) { return c.name === column; });
}

function tableExists(tbl) {
    return !!db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(tbl);
}

if (!columnExists("candidates", "created_at")) {
    db.exec("ALTER TABLE candidates ADD COLUMN created_at DATETIME");
    db.exec("UPDATE candidates SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL");
}
if (!columnExists("election_settings", "updated_at")) {
    db.exec("ALTER TABLE election_settings ADD COLUMN updated_at DATETIME");
    db.exec("UPDATE election_settings SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL");
}
if (!columnExists("election_settings", "published")) {
    db.exec("ALTER TABLE election_settings ADD COLUMN published INTEGER DEFAULT 0");
}
if (!columnExists("election_settings", "hero_image")) {
    db.exec("ALTER TABLE election_settings ADD COLUMN hero_image TEXT");
}

try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_dept_class_name ON voter_departments(class_id, name)");
} catch (e) {}

// Migrasi voter_codes nullable role
(function () {
    const cols  = db.prepare("PRAGMA table_info(voter_codes)").all();
    const roleCol = cols.find(function (c) { return c.name === "role_id"; });
    if (!roleCol || roleCol.notnull === 0) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS voter_codes_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
            role_id INTEGER, class_id INTEGER, department_id INTEGER,
            used INTEGER NOT NULL DEFAULT 0, created_at DATETIME, used_at DATETIME
        );
        INSERT OR IGNORE INTO voter_codes_new SELECT id,code,role_id,class_id,department_id,used,created_at,used_at FROM voter_codes;
        DROP TABLE voter_codes;
        ALTER TABLE voter_codes_new RENAME TO voter_codes;
    `);
}());

// Migrasi votes nullable role
(function () {
    const cols  = db.prepare("PRAGMA table_info(votes)").all();
    const roleCol = cols.find(function (c) { return c.name === "role_id"; });
    if (!roleCol || roleCol.notnull === 0) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS votes_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL,
            voter_code_id INTEGER NOT NULL UNIQUE, role_id INTEGER,
            class_id INTEGER, department_id INTEGER, created_at DATETIME
        );
        INSERT OR IGNORE INTO votes_new SELECT id,candidate_id,voter_code_id,role_id,class_id,department_id,created_at FROM votes;
        DROP TABLE votes;
        ALTER TABLE votes_new RENAME TO votes;
    `);
}());

// Seed data awal
if (!db.prepare("SELECT id FROM election_settings WHERE id = 1").get()) {
    db.prepare("INSERT INTO election_settings (id, status) VALUES (1, 'DRAFT')").run();
}
["SISWA", "GURU", "STAFF"].forEach(function (n) {
    db.prepare("INSERT OR IGNORE INTO voter_roles (name, active) VALUES (?, 1)").run(n);
});
["Kelas 10", "Kelas 11", "Kelas 12"].forEach(function (n) {
    db.prepare("INSERT OR IGNORE INTO voter_classes (name, active) VALUES (?, 1)").run(n);
});

// ─────────────────────────────────────────────
//  UTILITAS UPLOAD GAMBAR
// ─────────────────────────────────────────────
const ALLOWED_IMAGE_SIGNATURES = [
    { bytes: [0xFF, 0xD8, 0xFF], ext: ".jpg" },
    { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], ext: ".png" },
    { bytes: [0x52, 0x49, 0x46, 0x46], ext: ".webp", extra: [0x57, 0x45, 0x42, 0x50], extraOffset: 8 }
];

function detectImageType(filePath) {
    try {
        const fd  = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(12);
        fs.readSync(fd, buf, 0, 12, 0);
        fs.closeSync(fd);
        for (const sig of ALLOWED_IMAGE_SIGNATURES) {
            if (!sig.bytes.every(function (b, i) { return buf[i] === b; })) continue;
            if (sig.extra && !sig.extra.every(function (b, i) { return buf[sig.extraOffset + i] === b; })) continue;
            return sig.ext;
        }
        return null;
    } catch (e) { return null; }
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
    filename:    function (req, file, cb) {
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.tmp`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const allowed = ["image/jpeg", "image/png", "image/webp"];
        if (!allowed.includes((file.mimetype || "").toLowerCase())) {
            return cb(Object.assign(new Error("Format foto harus JPG, PNG, atau WEBP."), { isValidation: true }));
        }
        cb(null, true);
    }
});

// ─────────────────────────────────────────────
//  UTILITAS DATABASE
// ─────────────────────────────────────────────
function getElectionStatus() {
    const row = db.prepare("SELECT status FROM election_settings WHERE id = 1").get();
    return row ? row.status : "DRAFT";
}

function getElectionSettings() {
    return db.prepare("SELECT status, published, hero_image AS heroImage FROM election_settings WHERE id = 1").get()
        || { status: "DRAFT", published: 0, heroImage: null };
}

function setElectionStatus(status) {
    db.prepare("UPDATE election_settings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").run(status);
}

function getRoleById(id)       { return db.prepare("SELECT id, name, active FROM voter_roles WHERE id = ?").get(id); }
function getClassById(id)      { return db.prepare("SELECT id, name, active FROM voter_classes WHERE id = ?").get(id); }

function validateCandidateNumber(number, excludeId = null) {
    const parsed = Number(number);
    if (!Number.isInteger(parsed) || parsed <= 0) return false;
    const row = excludeId
        ? db.prepare("SELECT id FROM candidates WHERE number = ? AND id != ?").get(parsed, excludeId)
        : db.prepare("SELECT id FROM candidates WHERE number = ?").get(parsed);
    return !row;
}

function normalizeCode(code) {
    return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generateVoterCode(existingCodes) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (let attempt = 0; attempt < 10000; attempt++) {
        const bytes = crypto.randomBytes(5);
        let code = "";
        for (let i = 0; i < 5; i++) code += chars[bytes[i] % chars.length];
        if (!existingCodes.has(code)) { existingCodes.add(code); return code; }
    }
    throw new Error("Gagal membuat kode pemilih unik.");
}

function getClientIp(req) {
    return String(
        req.headers["x-forwarded-for"] ||
        req.socket?.remoteAddress ||
        "unknown"
    ).split(",")[0].trim().substring(0, 45);
}

// ─────────────────────────────────────────────
//  AUDIT LOG
// ─────────────────────────────────────────────
function auditLog(action, detail, rowsAffected, req) {
    try {
        db.prepare(
            "INSERT INTO admin_log (action, detail, election_status, rows_affected, ip) VALUES (?, ?, ?, ?, ?)"
        ).run(
            String(action).substring(0, 100),
            detail ? String(detail).substring(0, 500) : null,
            getElectionStatus(),
            Number(rowsAffected) || 0,
            req ? getClientIp(req) : null
        );
    } catch (e) { console.error("[audit_log]", e.message); }
}

// ─────────────────────────────────────────────
//  BACKUP OTOMATIS
// ─────────────────────────────────────────────
const MAX_BACKUPS = 20;

async function createBackup(label) {
    try {
        const ts   = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const name = `pilketos-${label}-${ts}.db`;
        const dest = path.join(BACKUP_DIR, name);
        await db.backup(dest);
        console.log(`[backup] Dibuat: ${name}`);
        pruneBackups();
        return name;
    } catch (e) {
        console.error("[backup] Gagal:", e.message);
        return null;
    }
}

function pruneBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(function (f) { return f.endsWith(".db"); })
            .map(function (f) { return { f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }; })
            .sort(function (a, b) { return b.t - a.t; });
        files.slice(MAX_BACKUPS).forEach(function (item) {
            try { fs.unlinkSync(path.join(BACKUP_DIR, item.f)); } catch (e) {}
        });
    } catch (e) {}
}

// Ekspor hasil ke CSV/JSON sebelum destruktif
function exportResultsToBackup(label) {
    try {
        const ts   = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const candidates = db.prepare(`
            SELECT c.number, c.name, c.chairman, c.vice, COUNT(v.id) AS total
            FROM candidates c LEFT JOIN votes v ON v.candidate_id = c.id
            GROUP BY c.id ORDER BY c.number ASC
        `).all();
        const roles = db.prepare(`
            SELECT vr.name AS role, COUNT(v.id) AS total
            FROM voter_roles vr LEFT JOIN votes v ON v.role_id = vr.id
            GROUP BY vr.id ORDER BY vr.id
        `).all();
        const totalVotes = db.prepare("SELECT COUNT(*) AS n FROM votes").get().n;

        /* JSON */
        const jsonData = JSON.stringify({ totalVotes, candidates, roles, exportedAt: new Date().toISOString() }, null, 2);
        fs.writeFileSync(path.join(BACKUP_DIR, `hasil-${label}-${ts}.json`), jsonData, "utf8");

        /* CSV */
        const lines = ["Paslon,Nama,Ketua,Wakil,Suara"];
        candidates.forEach(function (c) {
            lines.push(`${c.number},"${c.name}","${c.chairman}","${c.vice}",${c.total}`);
        });
        lines.push("", "Jenis Pemilih,Suara");
        roles.forEach(function (r) { lines.push(`"${r.role}",${r.total}`); });
        lines.push(``, `Total Suara,${totalVotes}`);
        fs.writeFileSync(path.join(BACKUP_DIR, `hasil-${label}-${ts}.csv`), lines.join("\r\n"), "utf8");

        console.log(`[export] Hasil diekspor: hasil-${label}-${ts}`);
        pruneBackups();
    } catch (e) { console.error("[export]", e.message); }
}

// ─────────────────────────────────────────────
//  AUTENTIKASI ADMIN
// ─────────────────────────────────────────────

/* P3 — Rate limiting login (simpel, in-memory, per-IP) */
const loginFailures = new Map(); // ip → { count, resetAt }
const LOGIN_MAX_FAIL  = 10;       // percobaan gagal
const LOGIN_WINDOW_MS = 60 * 1000; // 1 menit
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // 5 menit lockout

function checkLoginRateLimit(ip) {
    const now = Date.now();
    const rec = loginFailures.get(ip);
    if (!rec) return true;
    if (now > rec.resetAt) { loginFailures.delete(ip); return true; }
    return rec.count < LOGIN_MAX_FAIL;
}

function recordLoginFailure(ip) {
    const now = Date.now();
    const rec = loginFailures.get(ip) || { count: 0, resetAt: now + LOGIN_LOCKOUT_MS };
    rec.count++;
    if (rec.count >= LOGIN_MAX_FAIL) rec.resetAt = now + LOGIN_LOCKOUT_MS;
    loginFailures.set(ip, rec);
}

function clearLoginFailure(ip) {
    loginFailures.delete(ip);
}

function checkAdminPassword(req) {
    const raw =
        req.headers["x-admin-password"] ||
        req.body?.password ||
        req.query?.password;
    if (!raw) return false;
    // Perbandingan waktu-konstan (timingSafeEqual)
    const incoming = crypto.createHash("sha256").update(String(raw)).digest();
    try {
        return crypto.timingSafeEqual(incoming, ADMIN_PASSWORD_HASH);
    } catch (e) { return false; }
}

function requireAdmin(req, res, next) {
    const ip = getClientIp(req);
    if (!checkLoginRateLimit(ip)) {
        return res.status(429).json({ success: false, message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." });
    }
    if (!checkAdminPassword(req)) {
        recordLoginFailure(ip);
        return res.status(401).json({ success: false, message: "Password administrator tidak valid." });
    }
    clearLoginFailure(ip);
    next();
}

function requireDraft(req, res, next) {
    if (getElectionStatus() !== "DRAFT") {
        return res.status(403).json({ success: false, message: "Pengaturan hanya dapat dilakukan saat status DRAFT." });
    }
    next();
}

// ─────────────────────────────────────────────
//  P1 — VOTE TOKEN (in-memory, TTL 10 menit)
// ─────────────────────────────────────────────
const voteTokens = new Map(); // token → { voterCodeId, roleId, classId, departmentId, expiresAt, used }
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 menit

/* Bersihkan token kedaluwarsa setiap 5 menit */
setInterval(function () {
    const now = Date.now();
    for (const [tok, data] of voteTokens) {
        if (now > data.expiresAt) voteTokens.delete(tok);
    }
}, 5 * 60 * 1000);

function createVoteToken(voterCodeId, roleId, classId, departmentId) {
    const token = crypto.randomBytes(32).toString("hex"); // 64 karakter hex
    voteTokens.set(token, {
        voterCodeId,
        roleId:       roleId || null,
        classId:      classId || null,
        departmentId: departmentId || null,
        expiresAt:    Date.now() + TOKEN_TTL_MS,
        used:         false
    });
    return token;
}

// ─────────────────────────────────────────────
//  RATE LIMIT VERIFY-CODE (per IP)
// ─────────────────────────────────────────────
const verifyFailures = new Map(); // ip → { count, resetAt }
const VERIFY_MAX_FAIL  = 10;
const VERIFY_WINDOW_MS = 60 * 1000;

function checkVerifyRateLimit(ip) {
    const now = Date.now();
    const rec = verifyFailures.get(ip);
    if (!rec) return true;
    if (now > rec.resetAt) { verifyFailures.delete(ip); return true; }
    return rec.count < VERIFY_MAX_FAIL;
}

function recordVerifyFailure(ip) {
    const now = Date.now();
    const rec = verifyFailures.get(ip) || { count: 0, resetAt: now + VERIFY_WINDOW_MS };
    rec.count++;
    if (rec.count >= VERIFY_MAX_FAIL) rec.resetAt = now + VERIFY_WINDOW_MS;
    verifyFailures.set(ip, rec);
}

function clearVerifyFailure(ip) { verifyFailures.delete(ip); }

// ─────────────────────────────────────────────
//  BACKUP BERKALA SAAT OPEN (tiap 15 menit)
// ─────────────────────────────────────────────
setInterval(async function () {
    if (getElectionStatus() === "OPEN") {
        await createBackup("auto-open");
    }
}, 15 * 60 * 1000);

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR, {
    setHeaders: function (res, filePath) {
        if ([".js", ".css", ".html"].some(function (e) { return filePath.endsWith(e); })) {
            res.setHeader("Cache-Control", "no-store");
        }
    }
}));

// ─────────────────────────────────────────────
//  ROUTES — HALAMAN
// ─────────────────────────────────────────────
app.get("/",            function (req, res) { res.sendFile(path.join(PUBLIC_DIR, "index.html")); });
app.get("/admin.html",  function (req, res) { res.sendFile(path.join(PUBLIC_DIR, "admin.html")); });
app.get("/vote.html",   function (req, res) { res.sendFile(path.join(PUBLIC_DIR, "vote.html")); });
app.get("/results.html",function (req, res) { res.sendFile(path.join(PUBLIC_DIR, "results.html")); });

// ─────────────────────────────────────────────
//  ROUTES — API PUBLIK
// ─────────────────────────────────────────────
app.get("/api/election", function (req, res) {
    try {
        const s = getElectionSettings();
        res.json({ success: true, status: s.status, published: s.published === 1, heroImage: s.heroImage || null });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengambil status pemilihan." });
    }
});

app.get("/api/candidates", function (req, res) {
    try {
        const candidates = db.prepare("SELECT id, number, name, chairman, vice, photo, created_at FROM candidates ORDER BY number ASC").all();
        res.json({ success: true, candidates });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengambil data Paslon." });
    }
});

app.get("/api/voter-config", function (req, res) {
    try {
        const roles = db.prepare(`
            SELECT id, name, active FROM voter_roles WHERE active = 1
            ORDER BY CASE name WHEN 'SISWA' THEN 1 WHEN 'GURU' THEN 2 WHEN 'STAFF' THEN 3 ELSE 4 END
        `).all();
        const classes = db.prepare("SELECT id, name, active FROM voter_classes WHERE active = 1 ORDER BY id ASC").all();
        res.json({ success: true, roles, classes });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengambil konfigurasi pemilih." });
    }
});

/* Hasil suara publik */
app.get("/api/results", function (req, res) {
    try {
        const s = getElectionSettings();
        if (!s.published) {
            return res.status(403).json({ success: false, message: "Hasil suara belum dipublikasikan oleh administrator." });
        }
        res.json({ success: true, published: true, ...buildResultsData() });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengambil hasil suara." });
    }
});

function buildResultsData() {
    const candidates = db.prepare(`
        SELECT c.id, c.number, c.name, COUNT(v.id) AS total
        FROM candidates c LEFT JOIN votes v ON v.candidate_id = c.id
        GROUP BY c.id, c.number, c.name ORDER BY c.number ASC
    `).all();

    const roles = db.prepare(`
        SELECT vr.id, vr.name AS role, COUNT(v.id) AS total
        FROM voter_roles vr LEFT JOIN votes v ON v.role_id = vr.id
        GROUP BY vr.id, vr.name ORDER BY vr.id ASC
    `).all();

    const nonStudents = db.prepare(`
        SELECT vr.id, vr.name AS role, vr.name AS displayName, COUNT(v.id) AS total
        FROM voter_roles vr LEFT JOIN votes v ON v.role_id = vr.id
        WHERE UPPER(vr.name) != 'SISWA' GROUP BY vr.id, vr.name ORDER BY vr.id ASC
    `).all();

    const studentClassRows = db.prepare(`
        SELECT vc.id, vc.name, vc.name AS displayName, COUNT(v.id) AS total
        FROM voter_classes vc
        LEFT JOIN votes v ON v.class_id = vc.id
            AND v.role_id = (SELECT id FROM voter_roles WHERE UPPER(name) = 'SISWA' LIMIT 1)
        GROUP BY vc.id, vc.name ORDER BY vc.id ASC
    `).all();

    const siswaRoleRow = db.prepare("SELECT id FROM voter_roles WHERE UPPER(name) = 'SISWA' LIMIT 1").get();
    const unclassed    = siswaRoleRow
        ? db.prepare("SELECT COUNT(*) AS total FROM votes WHERE role_id = ? AND class_id IS NULL").get(siswaRoleRow.id)
        : { total: 0 };

    const studentClasses = studentClassRows.slice();
    if (unclassed.total > 0) {
        studentClasses.push({ id: 0, name: "Tanpa Kelas", displayName: "Siswa (Tanpa Kelas)", total: unclassed.total });
    }

    const totalVotes = db.prepare("SELECT COUNT(*) AS total FROM votes").get().total;
    return { totalVotes, candidates, roles, nonStudents, studentClasses };
}

// ─────────────────────────────────────────────
//  ROUTES — VOTING
// ─────────────────────────────────────────────

/* Verifikasi kode — kembalikan voteToken, bukan codeId */
app.post("/api/vote/verify-code", function (req, res) {
    const ip = getClientIp(req);

    if (!checkVerifyRateLimit(ip)) {
        return res.status(429).json({
            success: false,
            message: "Terlalu banyak percobaan kode salah. Coba lagi dalam 1 menit."
        });
    }

    try {
        if (getElectionStatus() !== "OPEN") {
            return res.status(403).json({ success: false, message: "Pemilihan belum dibuka." });
        }

        const code = normalizeCode(req.body.code);
        if (!/^[A-Z0-9]{5}$/.test(code)) {
            recordVerifyFailure(ip);
            return res.status(400).json({ success: false, message: "Kode pemilih harus terdiri dari 5 karakter." });
        }

        const voter = db.prepare(`
            SELECT vc.id, vc.code, vc.used,
                   vc.role_id AS roleId, vr.name AS role, vr.active AS roleActive,
                   vc.class_id AS classId, vcl.name AS className, vcl.active AS classActive,
                   vc.department_id AS departmentId,
                   vd.name AS departmentName, vd.active AS departmentActive, vd.class_id AS departmentClassId
            FROM voter_codes vc
            LEFT JOIN voter_roles vr ON vr.id = vc.role_id
            LEFT JOIN voter_classes vcl ON vcl.id = vc.class_id
            LEFT JOIN voter_departments vd ON vd.id = vc.department_id
            WHERE vc.code = ?
        `).get(code);

        if (!voter) {
            recordVerifyFailure(ip);
            return res.status(404).json({ success: false, message: "Kode pemilih tidak ditemukan." });
        }
        if (voter.used) {
            recordVerifyFailure(ip);
            return res.status(400).json({ success: false, message: "Kode pemilih sudah digunakan." });
        }
        if (voter.roleId !== null && voter.roleId !== undefined) {
            if (!voter.roleActive) {
                return res.status(403).json({ success: false, message: "Jenis pemilih ini sedang tidak diaktifkan." });
            }
            if (voter.role === "SISWA" && voter.classId && voter.departmentId) {
                if (!voter.classActive)      return res.status(403).json({ success: false, message: "Kelas pemilih sedang tidak aktif." });
                if (!voter.departmentActive) return res.status(403).json({ success: false, message: "Jurusan pemilih sedang tidak aktif." });
                if (Number(voter.departmentClassId) !== Number(voter.classId))
                    return res.status(400).json({ success: false, message: "Data kelas dan jurusan pemilih tidak sesuai." });
            }
            if (voter.role !== "SISWA") {
                voter.classId = null; voter.className = null;
                voter.departmentId = null; voter.departmentName = null;
            }
        }

        // ── Buat voteToken — TIDAK mengembalikan id internal ──
        clearVerifyFailure(ip);
        const voteToken = createVoteToken(voter.id, voter.roleId, voter.classId, voter.departmentId);

        res.json({
            success: true,
            voter: {
                voteToken,                          // ← token, bukan id
                code:           voter.code,
                roleId:         voter.roleId  || null,
                role:           voter.role    || null,
                classId:        voter.classId || null,
                className:      voter.className || null,
                departmentId:   voter.departmentId || null,
                departmentName: voter.departmentName || null
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal memverifikasi kode pemilih." });
    }
});

/* Submit suara — hanya menerima voteToken, BUKAN codeId */
app.post("/api/vote", function (req, res) {
    try {
        if (getElectionStatus() !== "OPEN") {
            return res.status(403).json({ success: false, message: "Pemilihan belum dibuka." });
        }

        const voteToken   = String(req.body.voteToken || "").trim();
        const candidateId = Number(req.body.candidateId);
        const bodyRoleId  = Number(req.body.roleId);

        if (!voteToken) {
            return res.status(400).json({ success: false, message: "Token pemilih tidak valid." });
        }
        if (!Number.isInteger(candidateId)) {
            return res.status(400).json({ success: false, message: "Data Paslon tidak valid." });
        }

        // Validasi token
        const tokenData = voteTokens.get(voteToken);
        if (!tokenData) {
            return res.status(400).json({ success: false, message: "Token tidak valid atau sudah kedaluwarsa. Masukkan kode pemilih kembali." });
        }
        if (tokenData.used) {
            return res.status(400).json({ success: false, message: "Token sudah digunakan." });
        }
        if (Date.now() > tokenData.expiresAt) {
            voteTokens.delete(voteToken);
            return res.status(400).json({ success: false, message: "Sesi verifikasi kedaluwarsa (10 menit). Masukkan kode pemilih kembali." });
        }

        const codeId = tokenData.voterCodeId;

        // Validasi voter_code masih ada & belum dipakai
        const voter = db.prepare(`
            SELECT vc.id, vc.used, vc.role_id AS roleId, vr.name AS role,
                   vr.active AS roleActive, vc.class_id AS classId,
                   vcl.active AS classActive, vc.department_id AS departmentId,
                   vd.active AS departmentActive
            FROM voter_codes vc
            LEFT JOIN voter_roles vr ON vr.id = vc.role_id
            LEFT JOIN voter_classes vcl ON vcl.id = vc.class_id
            LEFT JOIN voter_departments vd ON vd.id = vc.department_id
            WHERE vc.id = ?
        `).get(codeId);

        if (!voter) {
            voteTokens.delete(voteToken);
            return res.status(404).json({ success: false, message: "Data pemilih tidak ditemukan." });
        }
        if (voter.used) {
            voteTokens.delete(voteToken);
            return res.status(400).json({ success: false, message: "Kode pemilih sudah digunakan." });
        }

        // Resolve roleId
        let finalRoleId = voter.roleId;
        if (finalRoleId === null || finalRoleId === undefined) {
            if (!Number.isInteger(bodyRoleId) || bodyRoleId <= 0) {
                return res.status(400).json({ success: false, message: "Jenis pemilih wajib dipilih." });
            }
            const chosenRole = getRoleById(bodyRoleId);
            if (!chosenRole) return res.status(404).json({ success: false, message: "Jenis pemilih tidak ditemukan." });
            if (!chosenRole.active) return res.status(400).json({ success: false, message: "Jenis pemilih sedang tidak aktif." });
            finalRoleId = bodyRoleId;
        }

        if (!db.prepare("SELECT id FROM candidates WHERE id = ?").get(candidateId)) {
            return res.status(404).json({ success: false, message: "Paslon tidak ditemukan." });
        }

        // Transaksi atomik
        db.transaction(function () {
            const result = db.prepare(
                "UPDATE voter_codes SET used = 1, used_at = CURRENT_TIMESTAMP WHERE id = ? AND used = 0"
            ).run(codeId);
            if (result.changes !== 1) throw new Error("Kode pemilih sudah digunakan.");

            db.prepare(`
                INSERT INTO votes (candidate_id, voter_code_id, role_id, class_id, department_id)
                VALUES (?, ?, ?, ?, ?)
            `).run(candidateId, codeId, finalRoleId, voter.classId, voter.departmentId);
        })();

        // Tandai token sebagai terpakai (dan hapus dari map)
        voteTokens.delete(voteToken);

        res.json({ success: true, message: "Suara berhasil dikirim." });
    } catch (e) {
        console.error(e);
        const msg = String(e.message || "");
        if (msg.includes("UNIQUE") || msg.includes("sudah digunakan")) {
            return res.status(400).json({ success: false, message: "Kode pemilih sudah digunakan." });
        }
        res.status(500).json({ success: false, message: "Gagal mengirim suara." });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — ADMIN: AUTH
// ─────────────────────────────────────────────
app.post("/api/admin/verify", function (req, res) {
    const ip = getClientIp(req);
    if (!checkLoginRateLimit(ip)) {
        return res.status(429).json({ success: false, message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." });
    }
    if (!checkAdminPassword(req)) {
        recordLoginFailure(ip);
        auditLog("LOGIN_FAIL", null, 0, req);
        return res.status(401).json({ success: false, message: "Password administrator salah." });
    }
    clearLoginFailure(ip);
    res.json({ success: true, message: "Password administrator benar." });
});

// ─────────────────────────────────────────────
//  ROUTES — ADMIN: STATUS PEMILIHAN
// ─────────────────────────────────────────────
app.post("/api/election/ready", requireAdmin, function (req, res) {
    try {
        if (getElectionStatus() !== "DRAFT") {
            return res.status(400).json({ success: false, message: "Pemilihan hanya dapat disiapkan dari status DRAFT." });
        }
        const candidateCount = db.prepare("SELECT COUNT(*) AS total FROM candidates").get().total;
        const codeCount      = db.prepare("SELECT COUNT(*) AS total FROM voter_codes WHERE used = 0").get().total;
        if (candidateCount < 2) return res.status(400).json({ success: false, message: "Minimal harus ada 2 Paslon." });
        if (codeCount < 1)      return res.status(400).json({ success: false, message: "Minimal harus ada 1 kode pemilih." });
        setElectionStatus("READY");
        auditLog("STATUS_CHANGE", "DRAFT → READY", 1, req);
        res.json({ success: true, status: "READY", message: "Pemilihan berhasil disiapkan." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menyiapkan pemilihan." });
    }
});

app.post("/api/election/open", requireAdmin, function (req, res) {
    try {
        if (getElectionStatus() !== "READY") {
            return res.status(400).json({ success: false, message: "Pemilihan hanya dapat dimulai dari status READY." });
        }
        setElectionStatus("OPEN");
        auditLog("STATUS_CHANGE", "READY → OPEN", 1, req);
        res.json({ success: true, status: "OPEN", message: "Pemilihan berhasil dibuka." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal membuka pemilihan." });
    }
});

app.post("/api/election/unlock", requireAdmin, function (req, res) {
    try {
        if (getElectionStatus() !== "READY") {
            return res.status(400).json({ success: false, message: "Konfigurasi hanya dapat dibuka kembali saat status READY." });
        }
        setElectionStatus("DRAFT");
        auditLog("STATUS_CHANGE", "READY → DRAFT (unlock)", 1, req);
        res.json({ success: true, status: "DRAFT", message: "Konfigurasi berhasil dibuka kembali." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal membuka kembali konfigurasi." });
    }
});

app.post("/api/election/close", requireAdmin, function (req, res) {
    try {
        if (getElectionStatus() !== "OPEN") {
            return res.status(400).json({ success: false, message: "Pemilihan hanya dapat diselesaikan saat status OPEN." });
        }
        setElectionStatus("CLOSED");
        auditLog("STATUS_CHANGE", "OPEN → CLOSED", 1, req);
        res.json({ success: true, status: "CLOSED", message: "Pemilihan berhasil diselesaikan." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menyelesaikan pemilihan." });
    }
});

/* P2A+P2B+P2C — Reset pemilihan dengan backup + ekspor */
app.post("/api/election/reset", requireAdmin, async function (req, res) {
    try {
        if (getElectionStatus() !== "CLOSED") {
            return res.status(400).json({ success: false, message: "Reset hanya dapat dilakukan saat status CLOSED." });
        }

        // P2C — verifikasi kata kunci dari client
        const confirmPhrase = String(req.body.confirmPhrase || "").trim();
        if (confirmPhrase !== "RESET PEMILIHAN") {
            return res.status(400).json({
                success: false,
                message: "Ketik RESET PEMILIHAN untuk mengonfirmasi."
            });
        }

        const voteCount = db.prepare("SELECT COUNT(*) AS n FROM votes").get().n;

        // P2B — backup + ekspor sebelum hapus
        exportResultsToBackup("sebelum-reset");
        await createBackup("sebelum-reset");

        // P2D — arsip suara ke votes_archive sebelum dihapus
        const batchId = crypto.randomBytes(8).toString("hex");
        db.transaction(function () {
            db.prepare(`
                INSERT OR IGNORE INTO votes_archive
                    (id, candidate_id, voter_code_id, role_id, class_id, department_id, original_created_at, batch_id, deleted_reason)
                SELECT id, candidate_id, voter_code_id, role_id, class_id, department_id, created_at, ?, 'election_reset'
                FROM votes
            `).run(batchId);
            db.prepare("DELETE FROM votes").run();
            db.prepare("DELETE FROM voter_codes").run();
            db.prepare("UPDATE election_settings SET status = 'DRAFT', published = 0, updated_at = CURRENT_TIMESTAMP WHERE id = 1").run();
        })();

        auditLog("ELECTION_RESET", `${voteCount} suara diarsip (batch ${batchId}), semua kode dihapus`, voteCount, req);
        res.json({ success: true, status: "DRAFT", message: "Pemilihan berhasil direset. Data suara diarsip." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mereset pemilihan." });
    }
});

app.post("/api/election/publish", requireAdmin, function (req, res) {
    try {
        db.prepare("UPDATE election_settings SET published = 1 WHERE id = 1").run();
        auditLog("PUBLISH", "Hasil suara dipublikasikan", 1, req);
        res.json({ success: true, published: true, message: "Hasil suara berhasil dipublikasikan." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mempublikasikan hasil." });
    }
});

app.post("/api/election/unpublish", requireAdmin, function (req, res) {
    try {
        db.prepare("UPDATE election_settings SET published = 0 WHERE id = 1").run();
        auditLog("UNPUBLISH", "Hasil suara disembunyikan", 1, req);
        res.json({ success: true, published: false, message: "Hasil suara disembunyikan dari publik." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menyembunyikan hasil." });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — ADMIN: HAPUS DATA SUARA (P2A)
// ─────────────────────────────────────────────
app.post("/api/admin/votes/clear", requireAdmin, async function (req, res) {
    try {
        const status = getElectionStatus();

        // P2A — blokir saat OPEN atau READY
        if (status === "OPEN" || status === "READY") {
            return res.status(403).json({
                success: false,
                message: `Tidak dapat menghapus data suara saat pemilihan ${status}. Selesaikan atau tutup pemilihan terlebih dahulu.`
            });
        }

        // P2C — verifikasi kata kunci
        const confirmPhrase = String(req.body.confirmPhrase || "").trim();
        if (confirmPhrase !== "HAPUS SEMUA SUARA") {
            return res.status(400).json({
                success: false,
                message: "Ketik HAPUS SEMUA SUARA untuk mengonfirmasi."
            });
        }

        const voteCount = db.prepare("SELECT COUNT(*) AS n FROM votes").get().n;

        // P2B — backup + ekspor sebelum hapus
        exportResultsToBackup("sebelum-hapus-suara");
        await createBackup("sebelum-hapus-suara");

        // P2D — arsip ke votes_archive
        const batchId = crypto.randomBytes(8).toString("hex");
        db.transaction(function () {
            db.prepare(`
                INSERT OR IGNORE INTO votes_archive
                    (id, candidate_id, voter_code_id, role_id, class_id, department_id, original_created_at, batch_id, deleted_reason)
                SELECT id, candidate_id, voter_code_id, role_id, class_id, department_id, created_at, ?, 'manual_clear'
                FROM votes
            `).run(batchId);
            db.prepare("DELETE FROM votes").run();
            db.prepare("UPDATE voter_codes SET used = 0, used_at = NULL").run();
        })();

        auditLog("VOTES_CLEAR", `${voteCount} suara diarsip (batch ${batchId}), kode direset`, voteCount, req);
        res.json({
            success: true,
            votesArchived: voteCount,
            batchId,
            message: `${voteCount} data suara diarsip. Kode pemilih direset.`
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menghapus data pemilihan." });
    }
});

/* P2D — Batalkan penghapusan terakhir (restore batch terbaru dari arsip) */
app.post("/api/admin/votes/restore-last", requireAdmin, function (req, res) {
    try {
        const status = getElectionStatus();
        if (status === "OPEN") {
            return res.status(403).json({ success: false, message: "Tidak dapat memulihkan data saat pemilihan sedang OPEN." });
        }

        const latestBatch = db.prepare(
            "SELECT batch_id, COUNT(*) AS n FROM votes_archive GROUP BY batch_id ORDER BY MIN(archived_at) DESC LIMIT 1"
        ).get();

        if (!latestBatch) {
            return res.status(404).json({ success: false, message: "Tidak ada data arsip untuk dipulihkan." });
        }

        const batchId = latestBatch.batch_id;

        db.transaction(function () {
            db.prepare(`
                INSERT OR IGNORE INTO votes (id, candidate_id, voter_code_id, role_id, class_id, department_id, created_at)
                SELECT id, candidate_id, voter_code_id, role_id, class_id, department_id, original_created_at
                FROM votes_archive WHERE batch_id = ?
            `).run(batchId);

            // Tandai kode sebagai terpakai kembali
            db.prepare(`
                UPDATE voter_codes SET used = 1, used_at = CURRENT_TIMESTAMP
                WHERE id IN (SELECT voter_code_id FROM votes_archive WHERE batch_id = ?)
            `).run(batchId);

            db.prepare("DELETE FROM votes_archive WHERE batch_id = ?").run(batchId);
        })();

        const restored = latestBatch.n;
        auditLog("VOTES_RESTORE", `${restored} suara dipulihkan dari batch ${batchId}`, restored, req);
        res.json({ success: true, restored, message: `${restored} suara berhasil dipulihkan.` });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal memulihkan data suara." });
    }
});

/* Info arsip (untuk ditampilkan di admin) */
app.get("/api/admin/votes/archive-info", requireAdmin, function (req, res) {
    try {
        const batches = db.prepare(`
            SELECT batch_id, COUNT(*) AS n, MIN(original_created_at) AS oldest, MAX(archived_at) AS archivedAt, deleted_reason
            FROM votes_archive GROUP BY batch_id ORDER BY MIN(archived_at) DESC LIMIT 5
        `).all();
        res.json({ success: true, batches });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengambil info arsip." });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — ADMIN: HERO IMAGE
// ─────────────────────────────────────────────
app.post("/api/admin/hero-image", requireAdmin, upload.single("image"), function (req, res) {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: "File gambar belum dipilih." });
        const realExt = detectImageType(req.file.path);
        if (!realExt) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, message: "File bukan gambar valid (JPG, PNG, WEBP)." });
        }
        const finalName = req.file.filename.replace(".tmp", realExt);
        const finalPath = path.join(UPLOAD_DIR, finalName);
        fs.renameSync(req.file.path, finalPath);
        const imageUrl = `/uploads/${finalName}`;
        const current  = db.prepare("SELECT hero_image FROM election_settings WHERE id = 1").get();
        if (current && current.hero_image) {
            const oldPath = path.join(ROOT_DIR, current.hero_image.replace(/^\/+/, ""));
            if (fs.existsSync(oldPath) && oldPath.startsWith(UPLOAD_DIR)) { try { fs.unlinkSync(oldPath); } catch (e) {} }
        }
        db.prepare("UPDATE election_settings SET hero_image = ? WHERE id = 1").run(imageUrl);
        res.json({ success: true, heroImage: imageUrl });
    } catch (e) {
        console.error(e);
        if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch (e2) {} }
        res.status(500).json({ success: false, message: "Gagal mengunggah gambar hero." });
    }
});

app.delete("/api/admin/hero-image", requireAdmin, function (req, res) {
    try {
        const current = db.prepare("SELECT hero_image FROM election_settings WHERE id = 1").get();
        if (current && current.hero_image) {
            const oldPath = path.join(ROOT_DIR, current.hero_image.replace(/^\/+/, ""));
            if (fs.existsSync(oldPath) && oldPath.startsWith(UPLOAD_DIR)) { try { fs.unlinkSync(oldPath); } catch (e) {} }
        }
        db.prepare("UPDATE election_settings SET hero_image = NULL WHERE id = 1").run();
        res.json({ success: true, message: "Gambar hero dihapus." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menghapus gambar hero." });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — ADMIN: PASLON
// ─────────────────────────────────────────────
app.post("/api/admin/candidates", requireAdmin, requireDraft, function (req, res) {
    try {
        const number   = Number(req.body.number);
        const name     = String(req.body.name     || "").trim();
        const chairman = String(req.body.chairman || "").trim();
        const vice     = String(req.body.vice     || "").trim();
        const photo    = req.body.photo || null;

        if (!Number.isInteger(number) || number <= 0) return res.status(400).json({ success: false, message: "Nomor Paslon tidak valid." });
        if (!name || !chairman || !vice) return res.status(400).json({ success: false, message: "Nama Paslon, Ketua, dan Wakil wajib diisi." });
        if (!validateCandidateNumber(number)) return res.status(400).json({ success: false, message: "Nomor Paslon sudah digunakan." });

        const result = db.prepare("INSERT INTO candidates (number, name, chairman, vice, photo) VALUES (?, ?, ?, ?, ?)").run(number, name, chairman, vice, photo);
        const candidate = db.prepare("SELECT * FROM candidates WHERE id = ?").get(result.lastInsertRowid);
        res.json({ success: true, candidate });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menambahkan Paslon." });
    }
});

app.post("/api/admin/candidates/upload/:number", requireAdmin, requireDraft, upload.single("photo"), function (req, res) {
    try {
        const number = Number(req.params.number);
        if (!req.file) return res.status(400).json({ success: false, message: "Foto belum dipilih." });
        const realExt = detectImageType(req.file.path);
        if (!realExt) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, message: "File bukan gambar yang valid (JPG, PNG, atau WEBP)." });
        }
        const finalName = req.file.filename.replace(".tmp", realExt);
        const finalPath = path.join(UPLOAD_DIR, finalName);
        fs.renameSync(req.file.path, finalPath);
        const candidate = db.prepare("SELECT * FROM candidates WHERE number = ?").get(number);
        if (!candidate) {
            fs.unlinkSync(finalPath);
            return res.status(404).json({ success: false, message: "Paslon tidak ditemukan." });
        }
        const photo = `/uploads/${finalName}`;
        db.prepare("UPDATE candidates SET photo = ? WHERE id = ?").run(photo, candidate.id);
        if (candidate.photo) {
            const oldPath = path.join(ROOT_DIR, candidate.photo.replace(/^\/+/, ""));
            if (fs.existsSync(oldPath) && oldPath.startsWith(UPLOAD_DIR)) { try { fs.unlinkSync(oldPath); } catch (e) {} }
        }
        res.json({ success: true, photo });
    } catch (e) {
        console.error(e);
        if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch (e2) {} }
        res.status(500).json({ success: false, message: "Gagal mengunggah foto Paslon." });
    }
});

app.put("/api/admin/candidates/:id", requireAdmin, requireDraft, function (req, res) {
    try {
        const id       = Number(req.params.id);
        const number   = Number(req.body.number);
        const name     = String(req.body.name     || "").trim();
        const chairman = String(req.body.chairman || "").trim();
        const vice     = String(req.body.vice     || "").trim();
        const photo    = req.body.photo;

        const existing = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
        if (!existing) return res.status(404).json({ success: false, message: "Paslon tidak ditemukan." });
        if (!Number.isInteger(number) || number <= 0) return res.status(400).json({ success: false, message: "Nomor Paslon tidak valid." });
        if (!name || !chairman || !vice) return res.status(400).json({ success: false, message: "Nama Paslon, Ketua, dan Wakil wajib diisi." });
        if (!validateCandidateNumber(number, id)) return res.status(400).json({ success: false, message: "Nomor Paslon sudah digunakan." });

        const finalPhoto = photo === undefined ? existing.photo : photo || null;
        db.prepare("UPDATE candidates SET number=?,name=?,chairman=?,vice=?,photo=? WHERE id=?").run(number, name, chairman, vice, finalPhoto, id);
        res.json({ success: true, candidate: db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal memperbarui Paslon." });
    }
});

app.delete("/api/admin/candidates/:id", requireAdmin, requireDraft, function (req, res) {
    try {
        const id = Number(req.params.id);
        const candidate = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
        if (!candidate) return res.status(404).json({ success: false, message: "Paslon tidak ditemukan." });
        if (db.prepare("SELECT COUNT(*) AS n FROM votes WHERE candidate_id = ?").get(id).n > 0) {
            return res.status(400).json({ success: false, message: "Paslon yang sudah memiliki suara tidak dapat dihapus." });
        }
        db.prepare("DELETE FROM candidates WHERE id = ?").run(id);
        if (candidate.photo) {
            const p = path.join(ROOT_DIR, candidate.photo.replace(/^\/+/, ""));
            if (fs.existsSync(p) && p.startsWith(UPLOAD_DIR)) { try { fs.unlinkSync(p); } catch (e) {} }
        }
        res.json({ success: true, message: "Paslon berhasil dihapus." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menghapus Paslon." });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — ADMIN: KONFIGURASI PEMILIH
// ─────────────────────────────────────────────
app.get("/api/admin/voter-config", requireAdmin, function (req, res) {
    try {
        const roles = db.prepare(`
            SELECT id, name, active FROM voter_roles
            ORDER BY CASE name WHEN 'SISWA' THEN 1 WHEN 'GURU' THEN 2 WHEN 'STAFF' THEN 3 ELSE 4 END
        `).all();
        const classes     = db.prepare("SELECT id, name, active FROM voter_classes ORDER BY id ASC").all();
        const departments = db.prepare(`
            SELECT vd.id, vd.class_id AS classId, vd.name, vd.active, vc.name AS className, vc.active AS classActive
            FROM voter_departments vd JOIN voter_classes vc ON vc.id = vd.class_id ORDER BY vc.id ASC, vd.name ASC
        `).all();
        const codes = db.prepare(`
            SELECT vc.id, vc.code, vc.role_id AS roleId, vr.name AS role,
                   vc.class_id AS classId, vcl.name AS className,
                   vc.department_id AS departmentId, vd.name AS department,
                   vc.used, vc.created_at AS createdAt, vc.used_at AS usedAt
            FROM voter_codes vc
            LEFT JOIN voter_roles vr ON vr.id = vc.role_id
            LEFT JOIN voter_classes vcl ON vcl.id = vc.class_id
            LEFT JOIN voter_departments vd ON vd.id = vc.department_id
            ORDER BY vc.id DESC
        `).all();
        res.json({ success: true, roles, classes, departments, codes });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengambil pengaturan pemilih." });
    }
});

app.put("/api/admin/voter-roles/:id", requireAdmin, requireDraft, function (req, res) {
    try {
        const id     = Number(req.params.id);
        const active = req.body.active === true || req.body.active === 1 || req.body.active === "1";
        if (!getRoleById(id)) return res.status(404).json({ success: false, message: "Jenis pemilih tidak ditemukan." });
        db.prepare("UPDATE voter_roles SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
        res.json({ success: true, role: db.prepare("SELECT id, name, active FROM voter_roles WHERE id = ?").get(id) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengubah status jenis pemilih." });
    }
});

app.post("/api/admin/voter-classes", requireAdmin, requireDraft, function (req, res) {
    try {
        const name = String(req.body.name || "").trim();
        if (!name) return res.status(400).json({ success: false, message: "Nama kelas wajib diisi." });
        const result = db.prepare("INSERT INTO voter_classes (name, active) VALUES (?, 1)").run(name);
        res.json({ success: true, class: db.prepare("SELECT id, name, active FROM voter_classes WHERE id = ?").get(result.lastInsertRowid) });
    } catch (e) {
        if (String(e.message).includes("UNIQUE")) return res.status(400).json({ success: false, message: "Kelas tersebut sudah ada." });
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menambahkan kelas." });
    }
});

app.delete("/api/admin/voter-classes/:id", requireAdmin, requireDraft, function (req, res) {
    try {
        const id = Number(req.params.id);
        if (!getClassById(id)) return res.status(404).json({ success: false, message: "Kelas tidak ditemukan." });
        const used = db.prepare("SELECT COUNT(*) AS n FROM voter_codes WHERE class_id = ?").get(id).n +
                     db.prepare("SELECT COUNT(*) AS n FROM votes WHERE class_id = ?").get(id).n;
        if (used > 0) return res.status(400).json({ success: false, message: "Kelas yang sudah digunakan tidak dapat dihapus." });
        db.prepare("DELETE FROM voter_classes WHERE id = ?").run(id);
        res.json({ success: true, message: "Kelas berhasil dihapus." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menghapus kelas." });
    }
});

// Endpoint department (tetap dipertahankan di server, panel UI-nya dihapus per permintaan)
app.post("/api/admin/voter-departments", requireAdmin, requireDraft, function (req, res) {
    try {
        const classId = Number(req.body.class_id ?? req.body.classId);
        const name    = String(req.body.name || "").trim();
        if (!Number.isInteger(classId)) return res.status(400).json({ success: false, message: "Kelas tidak valid." });
        if (!name) return res.status(400).json({ success: false, message: "Nama jurusan wajib diisi." });
        const classItem = getClassById(classId);
        if (!classItem) return res.status(404).json({ success: false, message: "Kelas tidak ditemukan." });
        if (!classItem.active) return res.status(400).json({ success: false, message: "Kelas sedang tidak aktif." });
        const result = db.prepare("INSERT INTO voter_departments (class_id, name, active) VALUES (?, ?, 1)").run(classId, name);
        const dept = db.prepare(`
            SELECT vd.id, vd.name, vd.class_id AS classId, vd.active, vc.name AS className, vc.active AS classActive
            FROM voter_departments vd JOIN voter_classes vc ON vc.id = vd.class_id WHERE vd.id = ?
        `).get(result.lastInsertRowid);
        res.json({ success: true, department: dept });
    } catch (e) {
        if (String(e.message).includes("UNIQUE")) return res.status(400).json({ success: false, message: "Jurusan tersebut sudah ada pada kelas tersebut." });
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menambahkan jurusan." });
    }
});

app.delete("/api/admin/voter-departments/:id", requireAdmin, requireDraft, function (req, res) {
    try {
        const id = Number(req.params.id);
        const dept = db.prepare("SELECT id FROM voter_departments WHERE id = ?").get(id);
        if (!dept) return res.status(404).json({ success: false, message: "Jurusan tidak ditemukan." });
        const used = db.prepare("SELECT COUNT(*) AS n FROM voter_codes WHERE department_id = ?").get(id).n +
                     db.prepare("SELECT COUNT(*) AS n FROM votes WHERE department_id = ?").get(id).n;
        if (used > 0) return res.status(400).json({ success: false, message: "Jurusan yang sudah digunakan tidak dapat dihapus." });
        db.prepare("DELETE FROM voter_departments WHERE id = ?").run(id);
        res.json({ success: true, message: "Jurusan berhasil dihapus." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menghapus jurusan." });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — ADMIN: KODE PEMILIH
// ─────────────────────────────────────────────
app.post("/api/admin/voter-codes/generate", requireAdmin, requireDraft, function (req, res) {
    try {
        const roleId     = Number(req.body.role_id ?? req.body.roleId);
        const classId    = req.body.classId ? Number(req.body.classId) : null;
        const amount     = Number(req.body.amount ?? req.body.quantity ?? req.body.count);

        if (!Number.isInteger(roleId) || roleId <= 0) return res.status(400).json({ success: false, message: "Jenis pemilih wajib dipilih." });
        if (!Number.isInteger(amount) || amount < 1 || amount > 5000) return res.status(400).json({ success: false, message: "Jumlah kode harus antara 1 sampai 5000." });

        const role = getRoleById(roleId);
        if (!role) return res.status(404).json({ success: false, message: "Jenis pemilih tidak ditemukan." });
        if (!role.active) return res.status(400).json({ success: false, message: "Jenis pemilih sedang tidak aktif." });

        let finalClassId = null;
        if (classId) {
            const classItem = getClassById(classId);
            if (!classItem) return res.status(404).json({ success: false, message: "Kelas tidak ditemukan." });
            finalClassId = classId;
        }
        if (role.name === "SISWA" && !finalClassId) {
            return res.status(400).json({ success: false, message: "Kelas wajib dipilih untuk pemilih Siswa." });
        }

        const existingCodes = new Set(db.prepare("SELECT code FROM voter_codes").all().map(function (r) { return r.code; }));
        const generated = [];
        const insert = db.prepare("INSERT INTO voter_codes (code, role_id, class_id, department_id, used) VALUES (?, ?, ?, NULL, 0)");
        db.transaction(function () {
            for (let i = 0; i < amount; i++) {
                const code = generateVoterCode(existingCodes);
                insert.run(code, roleId, finalClassId);
                generated.push(code);
            }
        })();

        auditLog("GENERATE_CODES", `${amount} kode untuk role=${roleId} class=${finalClassId}`, amount, req);
        res.json({ success: true, amount: generated.length, codes: generated });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal membuat kode pemilih." });
    }
});

app.delete("/api/admin/voter-codes", requireAdmin, requireDraft, async function (req, res) {
    try {
        const body      = req.body || {};
        const deleteAll = body.all === true || body.all === "true";
        const ids       = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];

        if (!deleteAll && ids.length === 0) return res.status(400).json({ success: false, message: "Tidak ada kode yang dipilih." });

        // Backup sebelum hapus massal
        if (deleteAll) await createBackup("sebelum-hapus-kode");

        let deleted = 0;
        if (deleteAll) {
            deleted = db.prepare("DELETE FROM voter_codes WHERE used = 0").run().changes;
        } else {
            const placeholders = ids.map(function () { return "?"; }).join(",");
            deleted = db.prepare(`DELETE FROM voter_codes WHERE id IN (${placeholders}) AND used = 0`).run(...ids).changes;
        }

        auditLog("DELETE_CODES", deleteAll ? "hapus semua aktif" : `hapus ${ids.length} kode`, deleted, req);
        res.json({ success: true, deleted, message: `${deleted} kode berhasil dihapus.` });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menghapus kode pemilih." });
    }
});

app.delete("/api/admin/voter-codes/:id", requireAdmin, requireDraft, function (req, res) {
    try {
        const id   = Number(req.params.id);
        const code = db.prepare("SELECT * FROM voter_codes WHERE id = ?").get(id);
        if (!code) return res.status(404).json({ success: false, message: "Kode pemilih tidak ditemukan." });
        if (code.used) return res.status(400).json({ success: false, message: "Kode yang sudah digunakan tidak dapat dihapus." });
        db.prepare("DELETE FROM voter_codes WHERE id = ?").run(id);
        res.json({ success: true, message: "Kode pemilih berhasil dihapus." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal menghapus kode pemilih." });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — ADMIN: HASIL SUARA
// ─────────────────────────────────────────────
app.get("/api/admin/results", requireAdmin, function (req, res) {
    try {
        const data = buildResultsData();
        const classResults = db.prepare(`
            SELECT vc.id, vc.name, COUNT(v.id) AS total
            FROM voter_classes vc LEFT JOIN votes v ON v.class_id = vc.id
            GROUP BY vc.id, vc.name ORDER BY vc.id ASC
        `).all();
        const departmentResults = db.prepare(`
            SELECT vd.id, vd.name, vc.name AS className, COUNT(v.id) AS total
            FROM voter_departments vd JOIN voter_classes vc ON vc.id = vd.class_id
            LEFT JOIN votes v ON v.department_id = vd.id
            GROUP BY vd.id, vd.name, vc.name ORDER BY vc.id ASC, vd.name ASC
        `).all();
        res.json({ success: true, ...data, classes: classResults, departments: departmentResults });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengambil hasil suara." });
    }
});

/* Audit log untuk admin */
app.get("/api/admin/audit-log", requireAdmin, function (req, res) {
    try {
        const logs = db.prepare(
            "SELECT id, action, detail, election_status, rows_affected, ip, created_at FROM admin_log ORDER BY id DESC LIMIT 100"
        ).all();
        res.json({ success: true, logs });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengambil log." });
    }
});

// ─────────────────────────────────────────────
//  ERROR HANDLER
// ─────────────────────────────────────────────
app.use("/api", function (req, res) {
    res.status(404).json({ success: false, message: "Endpoint API tidak ditemukan." });
});

app.use(function (error, req, res, next) {
    console.error(error);
    if (error instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: "Upload foto gagal: " + (error.message || "Ukuran atau format tidak sesuai.") });
    }
    if (error && error.isValidation) {
        return res.status(400).json({ success: false, message: error.message || "Validasi gagal." });
    }
    res.status(500).json({ success: false, message: error.message || "Terjadi kesalahan pada server." });
});

app.listen(PORT, function () {
    console.log(`PILKETOS server berjalan di http://localhost:${PORT}`);
});

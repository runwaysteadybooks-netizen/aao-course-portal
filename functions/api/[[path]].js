// FPSC Exam Portal — API (Cloudflare Pages Functions + D1)
// All endpoints live under /api/*. The D1 binding must be named DB.
// Secrets: SESSION_SECRET (signs login sessions), ADMIN_SETUP_KEY (one-time admin setup).

const COOKIE = "sca_sess";
const te = new TextEncoder();
const td = new TextDecoder();

/* ---------- small helpers ---------- */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fromB64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a.buffer); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Normalise any Pakistani mobile format to 03XXXXXXXXX
function normPhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("92")) d = "0" + d.slice(2);
  if (d.length === 10 && d.startsWith("3")) d = "0" + d;
  return /^03\d{9}$/.test(d) ? d : null;
}

/* ---------- password hashing (PBKDF2, light enough for the free CPU limit) ---------- */
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: te.encode(salt), iterations: 10000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}

/* ---------- sessions (HMAC-signed cookie) ---------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function makeSession(env, user) {
  const payload = b64url(te.encode(JSON.stringify({ u: user.id, r: user.role, e: Date.now() + 7 * 864e5 })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), te.encode(payload));
  return payload + "." + b64url(sig);
}
async function readSession(env, request) {
  if (!env.SESSION_SECRET) return null;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)sca_sess=([^;]+)/);
  if (!m) return null;
  const [p, s] = m[1].split(".");
  if (!p || !s) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), fromB64url(s), te.encode(p));
    if (!ok) return null;
    const payload = JSON.parse(td.decode(fromB64url(p)));
    return payload.e > Date.now() ? payload : null;
  } catch { return null; }
}
const setCookie = t => ({ "Set-Cookie": `${COOKIE}=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800` });
const clearCookie = () => ({ "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });

/* ---------- auth gates ---------- */
async function getUser(env, request) {
  const s = await readSession(env, request);
  if (!s) return null;
  try {
    return await env.DB.prepare(
      "SELECT id, phone, name, role, active, paid, device_id FROM users WHERE id = ?"
    ).bind(s.u).first();
  } catch { return null; }
}
async function getSetting(env, key, fallback) {
  try {
    const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
    return r ? r.value : fallback;
  } catch { return fallback; }
}
function isExpired(expiry) { return expiry && new Date().toISOString().slice(0, 10) > expiry; }

// Students must be active and inside the access window; admin always passes.
async function requireAccess(env, request) {
  const user = await getUser(env, request);
  if (!user) return { err: json({ error: "auth" }, 401) };
  if (user.role !== "admin") {
    if (!user.active) return { err: json({ error: "inactive" }, 403) };
    const expiry = await getSetting(env, "expiry_date", "2027-01-31");
    if (isExpired(expiry)) return { err: json({ error: "expired", expiry }, 403) };
  }
  return { user };
}
async function requireAdmin(env, request) {
  const user = await getUser(env, request);
  if (!user) return { err: json({ error: "auth" }, 401) };
  if (user.role !== "admin") return { err: json({ error: "forbidden" }, 403) };
  return { user };
}

/* ---------- schema + sample seed ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    active INTEGER NOT NULL DEFAULT 1,
    paid INTEGER NOT NULL DEFAULT 0,
    device_id TEXT,
    note TEXT,
    failed INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part TEXT NOT NULL,
    section TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS mcqs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    a TEXT NOT NULL, b TEXT NOT NULL, c TEXT NOT NULL, d TEXT NOT NULL,
    correct TEXT NOT NULL,
    explanation TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    topic_id INTEGER,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  )`,
];

const S = "SAMPLE NOTES — replace with your own material before launch.\n\n";
const TOPICS = [
  ["I", "English", "Vocabulary", S + "Build exam vocabulary in themes: synonyms, antonyms, one-word substitutes and commonly confused pairs (affect/effect, principal/principle). Practise 20 words a day and revise with the MCQs here."],
  ["I", "English", "Grammar Usage", S + "High-yield rules: subject–verb agreement (either/neither take singular), tense consistency, prepositions after common verbs, articles, and pronoun agreement. Most paper questions test agreement and prepositions."],
  ["I", "English", "Sentence Structuring", S + "Spot the correctly built sentence: watch for dangling modifiers, parallel structure (not only…but also), misplaced clauses and run-ons. Read each option aloud in your head; the wrong ones usually break parallelism."],
  ["II", "Accounting", "Financial Accounting: Cycle to Final Accounts", S + "The accounting cycle: transaction → journal → ledger → trial balance → adjustments → adjusted trial balance → financial statements → closing entries. Know adjusting entries (accruals, prepayments, depreciation, bad debts) and the format of final accounts."],
  ["II", "Accounting", "Partnership & Company Accounts", S + "Partnership: profit-sharing in the absence of an agreement, interest on capital/drawings, admission and retirement, goodwill valuation (average profit and super profit methods). Company: share issue, forfeiture, and valuation of shares."],
  ["II", "Accounting", "Financial Statement Analysis & Ratios", S + "Liquidity (current, quick), profitability (gross/net margin, ROE), solvency (debt-equity, interest cover) and activity ratios (inventory and receivable turnover). Practise computing from a small balance sheet and reading what the number means."],
  ["II", "Accounting", "Cost & Management Accounting", S + "Cost classification, prime cost and conversion cost, overhead absorption, marginal vs absorption costing, CVP and break-even, standard costing and variances, budgets and budgetary control."],
  ["II", "Auditing", "Auditing: Scope, Objectives, Evidence & Working Papers", S + "Objective of an external audit, types of audit, audit programme, sufficiency (quantity) vs appropriateness (quality) of evidence, and working papers: purpose, ownership and retention."],
  ["II", "Auditing", "Internal Controls, Fraud & IT Audit", S + "Components of internal control, segregation of duties, control testing vs substantive testing, the auditor's responsibilities for fraud, investigation of accounts, and computer-assisted audit techniques (CAATs)."],
  ["II", "Public Sector", "Public Sector Auditing & ISSAIs", S + "Financial attest, compliance and performance audit (economy, efficiency, effectiveness). ISSAIs are issued by INTOSAI; know the role of Supreme Audit Institutions and how public-sector audit differs from private audit."],
  ["II", "Public Sector", "Auditor-General: Articles 168–171 & PAC", S + "Constitution of Pakistan, Articles 168–171: appointment and terms of the Auditor-General, functions and powers, and audit reports — Article 171 reports on federal accounts go to the President, who causes them to be laid before Parliament. The Public Accounts Committee examines them."],
  ["II", "Public Sector", "Public Sector Accounting: IPSAS", S + "Cash basis vs accrual basis, and International Public Sector Accounting Standards issued by the IPSAS Board. Know what each basis recognises and Pakistan's move toward accrual reporting."],
  ["II", "Public Sector", "PFM Act 2019 & Public Procurement Rules", S + "Public Finance Management Act, 2019: budget preparation, authorisation of expenditure, and reporting duties. Public Procurement Rules: open competitive bidding as the default, and the role of PPRA."],
  ["II", "Economy", "Economy of Pakistan: Budget, Taxation & Fiscal Issues", S + "The Annual Budget Statement (Article 80), direct vs indirect taxes, the role of FBR, fiscal deficit and how it is financed. Skim the latest Economic Survey summary before the test."],
];

// [topicIndex (0-based into TOPICS), question, A, B, C, D, correct, explanation]
const MCQS = [
  [0, "Choose the word closest in meaning to 'prudent'.", "Wasteful", "Careful", "Arrogant", "Sudden", "b", "Prudent means acting with care and thought for the future."],
  [0, "Choose the antonym of 'transparent'.", "Opaque", "Clear", "Visible", "Obvious", "a", "Opaque means not able to be seen through — the opposite of transparent."],
  [1, "Neither of the officers ___ present at the briefing.", "were", "was", "are", "have been", "b", "'Neither' is singular, so it takes the singular verb 'was'."],
  [1, "The audit report, along with its annexures, ___ submitted yesterday.", "were", "have been", "was", "are", "c", "The subject is 'the audit report' (singular); phrases after 'along with' do not change the verb."],
  [2, "Choose the correctly structured sentence.", "Having completed the audit, the report was submitted by the team.", "Having completed the audit, the team submitted its report.", "The team, having completed the audit, its report was submitted.", "The report having completed the audit was submitted.", "b", "The modifier 'having completed the audit' must describe the team, not the report."],
  [3, "In the accounting cycle, the step immediately after journalising transactions is:", "Preparing the trial balance", "Posting to the ledger", "Making adjusting entries", "Closing the accounts", "b", "Entries are journalised first and then posted to ledger accounts; the trial balance comes later."],
  [3, "Agreement of a trial balance confirms:", "That no errors exist at all", "The arithmetical accuracy of posting", "That profit is correctly calculated", "That all transactions were recorded", "b", "A trial balance proves arithmetical accuracy only; errors of omission or principle can still exist."],
  [4, "In the absence of a partnership agreement, profits are shared:", "In the ratio of capitals", "Equally", "In the ratio of time devoted", "In the ratio of drawings", "b", "Where no agreement exists, partnership law provides for equal profit sharing."],
  [4, "Average annual profit is Rs. 200,000. Goodwill at 3 years' purchase of average profit is:", "Rs. 200,000", "Rs. 400,000", "Rs. 600,000", "Rs. 66,667", "c", "3 years' purchase means 3 × average profit = 3 × 200,000 = Rs. 600,000."],
  [5, "Current assets are Rs. 500,000 and current liabilities Rs. 250,000. The current ratio is:", "0.5 : 1", "1 : 2", "2 : 1", "4 : 1", "c", "Current ratio = current assets ÷ current liabilities = 500,000 ÷ 250,000 = 2:1."],
  [5, "Which ratio measures the ability to meet short-term obligations without relying on inventory?", "Current ratio", "Quick ratio", "Debt-equity ratio", "Gross profit ratio", "b", "The quick (acid-test) ratio excludes inventory from current assets."],
  [6, "Prime cost consists of:", "Direct materials, direct labour and direct expenses", "Direct materials and factory overheads", "All factory costs", "Total cost less selling expenses", "a", "Prime cost is the total of all direct costs; factory overhead is added later to reach works cost."],
  [6, "Under marginal costing, fixed production costs are treated as:", "Product costs", "Period costs", "Deferred costs", "Direct costs", "b", "Marginal costing charges fixed costs wholly to the period; only variable costs attach to units."],
  [7, "The primary objective of an external audit of financial statements is to:", "Detect all fraud", "Prepare the financial statements", "Express an opinion on the financial statements", "Guarantee the company's solvency", "c", "The auditor expresses an opinion on whether the statements give a true and fair view."],
  [7, "Audit working papers are the property of:", "The client", "The auditor", "The shareholders", "The tax authority", "b", "Working papers belong to the auditor, who must keep them confidential and retain them."],
  [7, "In audit evidence, 'sufficiency' refers to the:", "Quality of evidence", "Quantity of evidence", "Source of evidence", "Timing of evidence", "b", "Sufficiency is the measure of quantity; appropriateness is the measure of quality."],
  [8, "Segregation of duties primarily reduces the risk that:", "Employees take excessive leave", "One person can both commit and conceal an error or fraud", "Budgets are exceeded", "Assets are depreciated incorrectly", "b", "Splitting authorisation, custody and recording means no one person controls a transaction end to end."],
  [8, "CAATs stands for:", "Computer Assisted Audit Techniques", "Centralised Accounting and Audit Tools", "Compliance and Attestation Tests", "Cost Accounting Analysis Techniques", "a", "CAATs are computer-assisted audit techniques used to test data and systems."],
  [9, "ISSAIs — the standards for public-sector auditing — are issued by:", "IFAC", "INTOSAI", "ICAP", "The World Bank", "b", "The International Organization of Supreme Audit Institutions (INTOSAI) issues the ISSAIs."],
  [9, "A performance audit examines:", "Only the arithmetic of the accounts", "Economy, efficiency and effectiveness", "Compliance with tax law only", "The bank reconciliation", "b", "Performance audit assesses the 3 Es: economy, efficiency and effectiveness of operations."],
  [10, "The Articles of the Constitution of Pakistan that deal with the Auditor-General are:", "Articles 160–163", "Articles 168–171", "Articles 199–201", "Articles 62–63", "b", "Articles 168 to 171 cover the Auditor-General's appointment, functions, powers and reports."],
  [10, "Under Article 171, audit reports relating to the accounts of the Federation are submitted to the President, who causes them to be laid before:", "The Supreme Court", "The Senate only", "Parliament (Majlis-e-Shoora)", "The Council of Common Interests", "c", "Article 171: federal reports go to the President, who lays them before both Houses of Parliament."],
  [11, "Under the cash basis of accounting, revenue is recognised when:", "It is earned", "Cash is received", "The invoice is issued", "The budget is approved", "b", "Cash-basis accounting recognises revenue on receipt of cash and expenditure on payment."],
  [11, "IPSAS are issued by:", "The IPSAS Board", "The State Bank of Pakistan", "INTOSAI", "The Auditor-General", "a", "International Public Sector Accounting Standards are issued by the IPSAS Board (IPSASB)."],
  [12, "The Public Finance Management Act applicable at federal level was enacted in:", "2010", "2017", "2019", "2023", "c", "The Public Finance Management Act, 2019 governs federal budgeting, spending and reporting."],
  [12, "PPRA stands for:", "Public Procurement Regulatory Authority", "Pakistan Public Revenue Agency", "Provincial Procurement Review Authority", "Public Private Resource Alliance", "a", "PPRA regulates public procurement and its rules make open competitive bidding the default."],
  [13, "The Annual Budget Statement is laid before the National Assembly under Article:", "Article 73", "Article 80", "Article 160", "Article 184", "b", "Article 80 of the Constitution requires the Annual Budget Statement for each financial year."],
  [13, "FBR stands for:", "Federal Bank of Revenue", "Federal Board of Revenue", "Finance and Budget Review", "Federal Bureau of Reporting", "b", "The Federal Board of Revenue administers federal taxes in Pakistan."],
];

async function runSetup(env, body) {
  if (!env.ADMIN_SETUP_KEY) return json({ error: "config", message: "ADMIN_SETUP_KEY is not set in Cloudflare → Settings → Variables and secrets." }, 500);
  if (!env.SESSION_SECRET) return json({ error: "config", message: "SESSION_SECRET is not set in Cloudflare → Settings → Variables and secrets." }, 500);
  if (!body || body.key !== env.ADMIN_SETUP_KEY) return json({ error: "bad_key", message: "Setup key is incorrect." }, 403);

  const phone = normPhone(body.phone);
  if (!phone) return json({ error: "bad_phone", message: "Enter a valid Pakistani mobile number (03XXXXXXXXX)." }, 400);
  if (!body.password || body.password.length < 8) return json({ error: "bad_password", message: "Admin password must be at least 8 characters." }, 400);

  for (const sql of SCHEMA) await env.DB.prepare(sql).run();

  const salt = randHex(16);
  const hash = await hashPassword(body.password, salt);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (phone, name, pass_salt, pass_hash, role, active, paid, created_at)
     VALUES (?, ?, ?, ?, 'admin', 1, 1, ?)
     ON CONFLICT(phone) DO UPDATE SET pass_salt=excluded.pass_salt, pass_hash=excluded.pass_hash, role='admin', active=1`
  ).bind(phone, body.name || "Admin", salt, hash, now).run();

  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('expiry_date', '2027-01-31') ON CONFLICT(key) DO NOTHING`).run();

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM topics").first();
  if (!count || count.n === 0) {
    const stmts = [];
    TOPICS.forEach((t, i) => {
      stmts.push(env.DB.prepare("INSERT INTO topics (part, section, title, notes, sort) VALUES (?, ?, ?, ?, ?)").bind(t[0], t[1], t[2], t[3], i + 1));
    });
    await env.DB.batch(stmts);
    const rows = (await env.DB.prepare("SELECT id FROM topics ORDER BY sort").all()).results;
    const qs = MCQS.map(q =>
      env.DB.prepare("INSERT INTO mcqs (topic_id, question, a, b, c, d, correct, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(rows[q[0]].id, q[1], q[2], q[3], q[4], q[5], q[6], q[7]));
    await env.DB.batch(qs);
  }
  return json({ ok: true, message: "Setup complete. You can now sign in as admin." });
}

/* ---------- login ---------- */
async function handleLogin(env, body) {
  if (!env.SESSION_SECRET) return json({ error: "config", message: "SESSION_SECRET is not set in Cloudflare → Settings → Variables and secrets." }, 500);
  const phone = normPhone(body && body.phone);
  if (!phone || !body.password) return json({ error: "auth" }, 401);

  let user;
  try {
    user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
  } catch {
    return json({ error: "config", message: "Database is not ready. Run first-time setup from the admin page." }, 500);
  }
  if (!user) return json({ error: "auth" }, 401);

  const now = Date.now();
  if (user.locked_until > now) return json({ error: "locked", minutes: Math.ceil((user.locked_until - now) / 60000) }, 429);

  const hash = await hashPassword(body.password, user.pass_salt);
  if (hash !== user.pass_hash) {
    const failed = (user.failed || 0) + 1;
    const locked = failed >= 5 ? now + 15 * 60000 : 0;
    await env.DB.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE id = ?").bind(failed >= 5 ? 0 : failed, locked, user.id).run();
    return locked ? json({ error: "locked", minutes: 15 }, 429) : json({ error: "auth" }, 401);
  }

  if (!user.active) return json({ error: "inactive" }, 403);

  // One device per student. Admin is exempt.
  if (user.role !== "admin") {
    const device = (body.device_id || "").slice(0, 64);
    if (!device) return json({ error: "auth" }, 401);
    if (user.device_id && user.device_id !== device) return json({ error: "device" }, 403);
    if (!user.device_id) await env.DB.prepare("UPDATE users SET device_id = ? WHERE id = ?").bind(device, user.id).run();
  }

  await env.DB.prepare("UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?").bind(user.id).run();
  const token = await makeSession(env, user);
  return json({ ok: true, role: user.role, name: user.name }, 200, setCookie(token));
}

/* ---------- router ---------- */
export async function onRequest(context) {
  const { request, env, params } = context;
  const path = "/" + (Array.isArray(params.path) ? params.path.join("/") : params.path || "");
  const method = request.method;
  let body = null;
  if (method === "POST") { try { body = await request.json(); } catch { body = {}; } }

  if (!env.DB) return json({ error: "config", message: "D1 binding DB is missing. Add it in Cloudflare → Settings → Bindings." }, 500);

  /* public */
  if (path === "/setup" && method === "POST") return runSetup(env, body);
  if (path === "/login" && method === "POST") return handleLogin(env, body);
  if (path === "/logout" && method === "POST") return json({ ok: true }, 200, clearCookie());

  if (path === "/me" && method === "GET") {
    const user = await getUser(env, request);
    if (!user) return json({ error: "auth" }, 401);
    const expiry = await getSetting(env, "expiry_date", "2027-01-31");
    return json({ id: user.id, name: user.name, phone: user.phone, role: user.role, paid: !!user.paid, expiry, expired: user.role !== "admin" && isExpired(expiry) });
  }

  /* student content */
  if (path === "/content" && method === "GET") {
    const g = await requireAccess(env, request); if (g.err) return g.err;
    const rows = (await env.DB.prepare("SELECT id, part, section, title, sort FROM topics ORDER BY sort").all()).results;
    return json({ topics: rows });
  }
  if (path === "/notes" && method === "GET") {
    const g = await requireAccess(env, request); if (g.err) return g.err;
    const id = Number(new URL(request.url).searchParams.get("id"));
    const t = await env.DB.prepare("SELECT id, part, section, title, notes FROM topics WHERE id = ?").bind(id).first();
    if (!t) return json({ error: "not_found" }, 404);
    return json({ topic: t });
  }
  if (path === "/mcqs" && method === "GET") {
    const g = await requireAccess(env, request); if (g.err) return g.err;
    const sp = new URL(request.url).searchParams;
    const topicId = Number(sp.get("topic_id"));
    const limit = Math.min(Number(sp.get("limit")) || 20, 50);
    const rows = (await env.DB.prepare(
      "SELECT id, question, a, b, c, d, correct, explanation FROM mcqs WHERE topic_id = ? ORDER BY id"
    ).bind(topicId).all()).results;
    return json({ questions: shuffle(rows).slice(0, limit) });
  }
  if (path === "/mock" && method === "GET") {
    const g = await requireAccess(env, request); if (g.err) return g.err;
    const all = (await env.DB.prepare(
      `SELECT m.id, m.question, m.a, m.b, m.c, m.d, m.correct, m.explanation, t.part, t.title AS topic
       FROM mcqs m JOIN topics t ON t.id = m.topic_id`
    ).all()).results;
    const eng = shuffle(all.filter(q => q.part === "I")).slice(0, 20);
    const prof = shuffle(all.filter(q => q.part === "II")).slice(0, 80);
    const questions = [...eng, ...prof];
    return json({ questions, minutes: Math.max(10, questions.length) });
  }
  if (path === "/attempt" && method === "POST") {
    const g = await requireAccess(env, request); if (g.err) return g.err;
    const kind = body.kind === "mock" ? "mock" : "practice";
    const score = Math.max(0, Number(body.score) || 0);
    const total = Math.max(1, Number(body.total) || 1);
    await env.DB.prepare(
      "INSERT INTO attempts (user_id, kind, topic_id, score, total, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(g.user.id, kind, body.topic_id || null, Math.min(score, total), total, null, new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (path === "/progress" && method === "GET") {
    const g = await requireAccess(env, request); if (g.err) return g.err;
    const byTopic = (await env.DB.prepare(
      `SELECT topic_id, COUNT(*) AS attempts, MAX(ROUND(100.0 * score / total)) AS best
       FROM attempts WHERE user_id = ? AND kind = 'practice' AND topic_id IS NOT NULL GROUP BY topic_id`
    ).bind(g.user.id).all()).results;
    const recent = (await env.DB.prepare(
      `SELECT kind, topic_id, score, total, created_at FROM attempts WHERE user_id = ? ORDER BY id DESC LIMIT 15`
    ).bind(g.user.id).all()).results;
    return json({ byTopic, recent });
  }

  /* admin */
  if (path === "/admin/students" && method === "GET") {
    const g = await requireAdmin(env, request); if (g.err) return g.err;
    const rows = (await env.DB.prepare(
      `SELECT id, phone, name, role, active, paid, note, created_at,
              CASE WHEN device_id IS NULL THEN 0 ELSE 1 END AS has_device
       FROM users ORDER BY id DESC`
    ).all()).results;
    return json({ students: rows });
  }
  if (path === "/admin/students" && method === "POST") {
    const g = await requireAdmin(env, request); if (g.err) return g.err;
    const phone = normPhone(body.phone);
    if (!phone) return json({ error: "bad_phone", message: "Enter a valid Pakistani mobile number (03XXXXXXXXX)." }, 400);
    if (!body.name) return json({ error: "bad_name", message: "Name is required." }, 400);
    if (!body.password || body.password.length < 8) return json({ error: "bad_password", message: "Password must be at least 8 characters." }, 400);
    const exists = await env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first();
    if (exists) return json({ error: "exists", message: "A user with this phone number already exists." }, 409);
    const salt = randHex(16);
    const hash = await hashPassword(body.password, salt);
    await env.DB.prepare(
      "INSERT INTO users (phone, name, pass_salt, pass_hash, role, active, paid, note, created_at) VALUES (?, ?, ?, ?, 'student', 1, ?, ?, ?)"
    ).bind(phone, body.name, salt, hash, body.paid ? 1 : 0, body.note || null, new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (path === "/admin/student/update" && method === "POST") {
    const g = await requireAdmin(env, request); if (g.err) return g.err;
    const id = Number(body.id);
    const target = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(id).first();
    if (!target) return json({ error: "not_found" }, 404);
    const action = body.action;
    if (action === "password") {
      if (!body.value || body.value.length < 8) return json({ error: "bad_password", message: "Password must be at least 8 characters." }, 400);
      const salt = randHex(16);
      const hash = await hashPassword(body.value, salt);
      await env.DB.prepare("UPDATE users SET pass_salt = ?, pass_hash = ?, failed = 0, locked_until = 0 WHERE id = ?").bind(salt, hash, id).run();
    } else if (action === "toggle_active") {
      if (target.role === "admin") return json({ error: "forbidden", message: "The admin account cannot be disabled." }, 403);
      await env.DB.prepare("UPDATE users SET active = 1 - active WHERE id = ?").bind(id).run();
    } else if (action === "toggle_paid") {
      await env.DB.prepare("UPDATE users SET paid = 1 - paid WHERE id = ?").bind(id).run();
    } else if (action === "reset_device") {
      await env.DB.prepare("UPDATE users SET device_id = NULL WHERE id = ?").bind(id).run();
    } else if (action === "note") {
      await env.DB.prepare("UPDATE users SET note = ? WHERE id = ?").bind(body.value || null, id).run();
    } else {
      return json({ error: "bad_action" }, 400);
    }
    return json({ ok: true });
  }
  if (path === "/admin/settings" && method === "GET") {
    const g = await requireAdmin(env, request); if (g.err) return g.err;
    return json({ expiry_date: await getSetting(env, "expiry_date", "2027-01-31") });
  }
  if (path === "/admin/settings" && method === "POST") {
    const g = await requireAdmin(env, request); if (g.err) return g.err;
    const v = String(body.expiry_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return json({ error: "bad_date", message: "Use the format YYYY-MM-DD." }, 400);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('expiry_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(v).run();
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

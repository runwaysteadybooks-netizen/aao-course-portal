/**
 * FPSC Exam Portal – question bank sync (Simply Commerce Academy)
 *
 * Reads this Google Doc, files every question under the subject heading it sits under,
 * and sends the result to the portal. Runs on its own every 15 minutes (only sends when
 * the document has changed) and from the "Portal" menu in the document.
 *
 * Fill in the two settings below, then follow the setup steps you were given.
 */
const PORTAL_URL = "https://fpsc-course-portal.pages.dev";   // your portal address
const SYNC_KEY   = "PASTE-THE-SAME-DOC_SYNC_KEY-YOU-SAVED-IN-CLOUDFLARE";

/* ---------------- menu and triggers ---------------- */
function onOpen() {
  DocumentApp.getUi().createMenu("Portal")
    .addItem("Sync questions now", "syncNow")
    .addItem("Turn on automatic sync (every 15 min)", "installAutoSync")
    .addItem("Turn off automatic sync", "removeAutoSync")
    .addToUi();
}
function installAutoSync() {
  removeAutoSync();
  ScriptApp.newTrigger("autoSync").timeBased().everyMinutes(15).create();
  try { DocumentApp.getUi().alert("Automatic sync is on. The portal will pick up changes within about 15 minutes."); } catch (e) {}
}
function removeAutoSync() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "autoSync") ScriptApp.deleteTrigger(t); });
}
function autoSync() { runSync_(false, false); }               // silent, only when the doc changed
function syncNow() {                                           // from the menu: always sends, shows the result
  const r = runSync_(true, false);
  let ui; try { ui = DocumentApp.getUi(); } catch (e) { Logger.log(r.text); return; }
  if (r.needsForce) {
    const b = ui.alert("Large drop in questions", r.text + "\n\nSend it anyway?", ui.ButtonSet.YES_NO);
    if (b === ui.Button.YES) ui.alert(runSync_(true, true).text);
    return;
  }
  ui.alert(r.text);
}

/* ---------------- sync ---------------- */
function runSync_(always, force) {
  const doc = DocumentApp.getActiveDocument() || DocumentApp.openById(PropertiesService.getScriptProperties().getProperty("DOC_ID"));
  const body = doc.getBody();
  const props = PropertiesService.getDocumentProperties();
  const fp = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, body.getText()));
  if (!always && props.getProperty("lastFingerprint") === fp) return { text: "No changes since the last sync." };

  const parsed = parseBank_(readParagraphs_(body));
  const report = {
    total: parsed.questions.length,
    topics: parsed.topics.map(t => ({ title: t.title, section: t.section, n: parsed.questions.filter(q => q.topic === t.title).length })),
    problems: parsed.problems.slice(0, 50), duplicates: parsed.duplicates.slice(0, 50), missingNumbers: parsed.missingNumbers.slice(0, 50),
  };
  const res = UrlFetchApp.fetch(PORTAL_URL.replace(/\/$/, "") + "/api/doc-push", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { "X-Sync-Key": SYNC_KEY },
    payload: JSON.stringify({ topics: parsed.topics, questions: parsed.questions, report: report, force: !!force }),
  });
  let out = {}; try { out = JSON.parse(res.getContentText()); } catch (e) { out = { ok: false, message: "The portal replied with HTTP " + res.getResponseCode() }; }
  if (out.ok) props.setProperty("lastFingerprint", fp);

  let text = out.ok
    ? "Synced " + report.total + " questions in " + report.topics.length + " subjects.\n\n" + report.topics.map(t => "• " + t.n + " – " + t.title).join("\n")
    : "Not synced: " + (out.message || "unknown error");
  if (report.problems.length) text += "\n\nQuestions skipped (fix these in the doc):\n" + report.problems.map(p => "• Q" + p.q + (p.topic ? " (" + p.topic.slice(0, 40) + ")" : "") + ": " + p.reason).join("\n");
  if (report.duplicates.length) text += "\n\nExact duplicates ignored: Q" + report.duplicates.join(", Q");
  if (report.missingNumbers.length) text += "\n\nQuestion numbers not found: Q" + report.missingNumbers.join(", Q");
  return { text: text, needsForce: !!out.needsForce };
}

/* Each paragraph or list item of the doc, with whether it is a heading. Tables are skipped. */
function readParagraphs_(body) {
  const out = [];
  const n = body.getNumChildren();
  for (let i = 0; i < n; i++) {
    const el = body.getChild(i);
    const type = el.getType();
    if (type === DocumentApp.ElementType.PARAGRAPH) {
      const p = el.asParagraph();
      out.push({ text: p.getText(), heading: p.getHeading() !== DocumentApp.ParagraphHeading.NORMAL, list: false });
    } else if (type === DocumentApp.ElementType.LIST_ITEM) {
      out.push({ text: el.asListItem().getText(), heading: false, list: true });
    }
  }
  return out;
}

/* ---------------- reading the questions ---------------- */
const KNOWN_TOPICS_ = [
  ["Vocabulary: synonyms and antonyms", "I", "English"],
  ["Grammar usage: parts of speech, prepositions, idioms", "I", "English"],
  ["Sentence structuring", "I", "English"],
  ["Financial accounting: accounting cycle, journal, ledger, trial balance, adjustments and final accounts", "II", "Accounting"],
  ["Partnership and company accounts; valuation of goodwill and shares", "II", "Accounting"],
  ["Analysis of financial statements and ratio analysis", "II", "Accounting"],
  ["Cost and management accounting: costing methods, budgeting, budgetary control and variance analysis", "II", "Accounting"],
  ["Auditing: scope and objectives, types of audit, audit programme, audit evidence and working papers", "II", "Auditing"],
  ["Verification of assets and liabilities; rights, powers, duties and liabilities of the auditor", "II", "Auditing"],
  ["Public sector auditing: financial attest, compliance and performance audit; ISSAIs", "II", "Public Sector"],
  ["Constitutional provisions relating to the Auditor-General of Pakistan (Articles 168 to 171)", "II", "Public Sector"],
  ["Planning, conduct and reporting of audit; role of Public Accounts Committees", "II", "Public Sector"],
  ["Public sector accounting: cash and accrual basis; IPSAS", "II", "Public Sector"],
  ["Public Finance Management Act, 2019 and Public Procurement Rules, 2026", "II", "Public Sector"],
  ["Internal controls, investigation of accounts and detection of fraud; IT audit and CAATs", "II", "Auditing"],
  ["Economy of Pakistan: budget, taxation and fiscal issues", "II", "Economy"],
  ["Public sector accountability and transparency", "II", "Public Sector"],
];
function normKey_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function inferSection_(title, part) {
  if (part === "I") return "English";
  const t = title.toLowerCase();
  if (/public|constitution|article|pfm|procurement|ipsas|issai|accountab|transparen|\bpac\b|auditor-general|government/.test(t)) return "Public Sector";
  if (/econom|tax|budget|fiscal/.test(t)) return "Economy";
  if (/audit|verification|control|fraud|caat/.test(t)) return "Auditing";
  return "Accounting";
}
function hash53_(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function parseBank_(paras) {
  const KNOWN = new Map(KNOWN_TOPICS_.map(t => [normKey_(t[0]), t]));
  const topics = [], seenTopic = new Set(), questions = [], problems = [], numbers = [];
  let part = null, topic = null, cur = null, started = false, pos = 0;
  const useTopic = (title) => {
    const known = KNOWN.get(normKey_(title));
    const t = known ? known[0] : title.replace(/\s+/g, " ").trim();
    const pt = known ? known[1] : (part || "II");
    if (!seenTopic.has(t)) { seenTopic.add(t); topics.push({ title: t, part: pt, section: known ? known[2] : inferSection_(t, pt), sort: topics.length + 1 }); }
    return t;
  };
  const finish = () => {
    if (!cur) return;
    const miss = [];
    if (!cur.topic) miss.push("it is not under any subject heading");
    ["a", "b", "c", "d"].forEach(k => { if (!cur[k]) miss.push("option " + k.toUpperCase() + " is missing"); });
    if (!cur.correct) miss.push("the Answer line is missing");
    if (!cur.question) miss.push("the question text is missing");
    if (miss.length) problems.push({ q: cur.n, topic: cur.topic || "", reason: miss.join(", ") });
    else questions.push(cur);
    cur = null;
  };
  for (const p of paras) {
    const l = String(p.text || "").replace(/\u00a0/g, " ").replace(/\u000b/g, " ").trim();
    if (!l) continue;
    const partM = l.length < 80 && l.match(/^part\s*[-–—:]?\s*(ii|2|i|1)\b/i);
    if (partM) { finish(); part = /^(ii|2)$/i.test(partM[1]) ? "II" : "I"; started = true; topic = null; continue; }
    if (p.heading && started) { finish(); topic = useTopic(l); continue; }
    if ((!cur || cur.correct) && l.length < 200 && KNOWN.has(normKey_(l))) { finish(); topic = useTopic(l); started = true; continue; }
    if (!started) continue;
    const qm = l.match(/^Q\s*(\d+)\s*[.):\-]\s*(.*)$/i);
    if (qm) { finish(); pos++; numbers.push(+qm[1]); cur = { n: +qm[1], topic: topic, question: qm[2].trim(), pos: pos }; continue; }
    if (!cur) continue;
    const am = l.match(/^(?:Answer|Ans)\s*[:\-–.]?\s*\(?\s*([A-D])\s*\)?(.*)$/i);
    if (am) {
      cur.correct = am[1].toLowerCase();
      let ex = "";
      const dash = am[2].search(/\s[—–]\s|\s--\s/);
      if (dash >= 0) ex = am[2].slice(dash).replace(/^\s*[—–-]+\s*/, "");
      ex = ex.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
      if (/^option [a-d] changed from|site key/i.test(ex)) ex = "";
      cur.explanation = ex;
      continue;
    }
    if (!cur.correct) {
      const om = l.match(/^\(?([A-Da-d])\s*[).:]\s*(.+)$/);
      if (om) { cur[om[1].toLowerCase()] = om[2].trim(); continue; }
      if (p.list && cur.question) {                      // options typed as an automatic list (a., b., …)
        const free = ["a", "b", "c", "d"].find(k => !cur[k]);
        if (free) { cur[free] = l; continue; }
      }
    }
    if (/^\d+\s+MCQs?$/i.test(l)) continue;
    if (!cur.a && !cur.correct) cur.question = (cur.question + " " + l).trim();
  }
  finish();
  const used = new Set(questions.map(q => q.topic));
  const keptTopics = topics.filter(t => used.has(t.title)).map((t, i) => Object.assign({}, t, { sort: i + 1 }));
  questions.forEach(q => { q.qkey = hash53_((q.question + "|" + q.a + "|" + q.b + "|" + q.c + "|" + q.d + "|" + q.correct).toLowerCase().replace(/\s+/g, " ")); });
  const seen = new Set(), duplicates = [];
  const unique = questions.filter(q => { if (seen.has(q.qkey)) { duplicates.push(q.n); return false; } seen.add(q.qkey); return true; });
  const missingNumbers = [];
  if (numbers.length) { const got = new Set(numbers); const max = Math.max.apply(null, numbers); for (let i = 1; i <= max; i++) if (!got.has(i)) missingNumbers.push(i); }
  return {
    topics: keptTopics,
    questions: unique.map(q => ({ topic: q.topic, question: q.question, a: q.a, b: q.b, c: q.c, d: q.d, correct: q.correct, explanation: q.explanation || "", qkey: q.qkey, pos: q.pos })),
    problems: problems, duplicates: duplicates, missingNumbers: missingNumbers,
  };
}

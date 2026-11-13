# FPSC Exam Portal — Simply Commerce Academy

Paid prep portal for the FPSC **Assistant Audit Officer (BS-17)** test (Office of the Auditor-General of Pakistan). Students log in with a mobile number and a password issued by the admin, on one device, until the access expiry date.

Live on Cloudflare Pages: production deploys from `main`, previews from every other branch.

## Stack
- Cloudflare Pages (static pages, no build step)
- Pages Functions: `functions/api/[[path]].js` (all `/api/*` endpoints)
- Cloudflare D1, binding name `DB` (database `fpsc-portal-db`)

## Required Cloudflare settings (Production)
- Bindings: D1 database, variable name `DB`; Workers AI, variable name `AI` (free AI explanations)
- Secrets: `SESSION_SECRET` (signs sessions), `DOC_SYNC_KEY` (Google Doc sync), `ADMIN_SETUP_KEY` (first-time setup only; delete afterwards)
- Bindings and secrets take effect on the next deployment (Deployments → ⋯ → Retry deployment).

## First-time setup (once, after secrets are added)
1. Open `/admin.html` on the deployed site.
2. Fill the "First-time setup" card: setup key, admin number `03322466420`, a strong admin password.
3. This creates the tables, the admin account, the default expiry (2027-01-31) and the SAMPLE syllabus + MCQs.
4. Log in at `/` with the admin number and password.

## Daily operation
- Student pays on WhatsApp (Easypaisa or JazzCash) → admin adds them in `/admin.html` (Generate password) → send number + password on WhatsApp.
- One device per student; use "reset device" when a student changes phones.
- Change the expiry date in "Access window" once FPSC announces the test date.

## Question bank (Google Doc = source of truth)
- The bank lives in the FPSC_AAO_MCQ_Bank Google Doc. `tools/PortalSync.gs` is the Apps Script attached to that doc (Extensions → Apps Script). It reads every question under its subject heading and pushes it to `/api/doc-push` with `DOC_SYNC_KEY`.
- Doc menu: Portal → Sync questions now; automatic sync every 15 minutes.
- Unchanged questions keep their id, so saved AI explanations and progress survive. The portal refuses a sync that would drop more than half the questions unless confirmed.
- Format: subject headings in a Heading style; `Q1. …`, `(A) …` to `(D) …`, `Answer: (B) — optional explanation`.
- The admin panel's "Google Doc sync" card shows the last sync and counts per subject. Manual `.json` import is still available.

## AI explanations
Cloudflare Workers AI (free daily allowance, resets 5:00 AM PKT). The best available model is tried first; each question is explained once and saved. Admin → AI explanations → Test AI now shows which model answered.

## Files
- `index.html` — sign-in and prospectus (post details, what's included, road to the test, how to join)
- `app.html` — student portal (syllabus, topic MCQs, practice, question bank with print, mock test, progress)
- `admin.html` — admin panel + first-time setup
- `assets/logo.js` — temporary logo (replace with the original export)
- `functions/api/[[path]].js` — API
- `tools/PortalSync.gs` — Google Apps Script for the question-bank doc (set `SYNC_KEY` inside it)

## Content rules
- Users are Pakistani: write in standard Pakistani English (as in FPSC/PPSC notices and Pakistani textbooks), not American or British idiom.
- MCQs follow the pattern of Pakistani testing bodies (FPSC, PPSC, SPSC and similar): four options (A)–(D), Pakistani context, amounts in Rs., Pakistani laws and institutions. No US or UK-sourced questions.

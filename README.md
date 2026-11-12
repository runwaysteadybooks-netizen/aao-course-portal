# FPSC Exam Portal — Simply Commerce Academy

Paid prep portal for the FPSC **Assistant Audit Officer (BS-17)** test (Office of the Auditor-General of Pakistan). Students sign in with a phone number and a password issued by the admin, on one device, until the access expiry date.

Live on Cloudflare Pages: production deploys from `main`, previews from every other branch.

## Stack
- Cloudflare Pages (static pages, no build step)
- Pages Functions: `functions/api/[[path]].js` (all `/api/*` endpoints)
- Cloudflare D1, binding name `DB` (database `fpsc-portal-db`)

## Required Cloudflare settings (Production AND Preview)
- Binding: D1 database, variable name `DB`
- Secrets: `SESSION_SECRET` (signs sessions), `ADMIN_SETUP_KEY` (one-time setup)

## First-time setup (once, after secrets are added)
1. Open `/admin.html` on the deployed site.
2. Fill the "First-time setup" card: setup key, admin number `03322466420`, a strong admin password.
3. This creates the tables, the admin account, the default expiry (2027-01-31) and the SAMPLE syllabus + MCQs.
4. Sign in at `/` with the admin number and password.

## Daily operation
- Student pays on WhatsApp → admin adds them in `/admin.html` (Generate password) → send number + password on WhatsApp.
- One device per student; use "reset device" when a student changes phones.
- Change the expiry date in "Access window" once FPSC announces the test date.

## Content status
All topics, notes and MCQs are **samples** and marked as such. Replace them before launch; the FPSC syllabus should be verified against fpsc.gov.pk when published.

## Files
- `index.html` — sign-in
- `app.html` — student portal (syllabus, notes, practice, mock test, progress)
- `admin.html` — admin panel + first-time setup
- `assets/logo.js` — temporary logo (replace with the original export)
- `functions/api/[[path]].js` — API

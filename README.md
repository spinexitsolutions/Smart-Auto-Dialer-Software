# Smart Auto Dialer

A SIM-based auto dialer with a built-in CRM, live agent monitoring and reports, for **sales, telecalling, support and collection teams**. It is built to be sold either as SaaS (many client companies on one server, each with its own licence) or as an on-premise install.

```
┌──────────────────────┐   Socket.IO + REST    ┌──────────────────────────────┐
│  Web panel (browser) │ ◀───────────────────▶ │  Node.js server + SQLite     │
│  Admin / Manager /   │                       │  dialer engine, CRM, reports │
│  Agent / Super admin │                       └──────────────▲───────────────┘
└──────────────────────┘                                      │
                                                              │ dial / call state / recordings
                                              ┌───────────────┴──────────────┐
                                              │ Android app on agent's phone │
                                              │ places calls from the SIM    │
                                              └──────────────────────────────┘
```

## Features

### Calling
- **SIM-based calling.** The Android app places real calls from the agent's own SIM (dual-SIM support, choose the SIM per agent or per campaign). There are no VoIP or telecom charges beyond the SIM plan.
- **Auto dialer modes:**
  - **Preview**: the agent sees the lead first, then taps Call or Skip.
  - **Progressive**: the next lead is dialed automatically after each wrap-up.
  - **Power**: progressive, plus unanswered calls are marked "No Answer" automatically and the next number is dialed.
- **Smart lead queue.**
  - Due callbacks come first, then priority, then fewest attempts.
  - A lead is locked while one agent is calling it, so two agents never dial it at once.
  - Each campaign sets its retry gap and maximum attempts.
- **Compliance.**
  - Calling hours are set per campaign, in the company's time zone.
  - A Do-Not-Call (DNC) list is checked on import, on auto-dial and on manual dial.
  - Agents can be shown masked phone numbers.
- **Manual / click-to-call** from anywhere in the CRM, plus a dial pad.
- **Call recordings.** The app uploads the phone's built-in call recording automatically. Recordings play inside the panel and are deleted after a retention period you set.
- **Demo mode.** Calls are simulated, so you can demo the whole product to a customer without a phone.

### Real-time agent monitoring
- Live wallboard showing each agent's state: on call, dialing, wrap-up, ready, on break or offline. Each tile shows a timer, the current customer and today's stats.
- Supervisor controls: message one agent, broadcast to all, force a break, pause dialing, force logout.
- Attendance (first login, last logout, login hours) and break tracking with reasons.

### CRM & lead management
- **CSV import.**
  - Columns are detected automatically (name, mobile, email, city, amount due, …). Unknown columns become custom fields.
  - Duplicates can be skipped, updated or allowed.
  - Leads can be assigned round-robin.
- **Lead list.** Filters, search, sorting and pagination. Bulk actions: assign, distribute equally, change campaign, status or priority, tag, DNC, delete. CSV export.
- **Lead profile.**
  - Editable details and custom fields, plus a duplicate warning.
  - Full call history with recordings and an activity timeline.
  - Follow-ups and tickets.
- **Dispositions** you can configure. Each can change the lead's status, schedule a callback, put the lead back in the queue for retry, or count as a success.
- **Follow-ups / callbacks**, grouped as overdue, next 24 hours and upcoming. They are re-dialed automatically and closed automatically once the customer is reached.
- **WhatsApp & SMS templates** with placeholders (`{{name}}`, `{{amount_due}}`, …), opened in one click, and every message is logged on the lead.

### For each type of team
- **Sales:** deal value, conversion tracking and lead-source ROI report.
- **Telecalling:** call script with live placeholders, daily call target with a progress bar.
- **Collections:** amount due, due date, Promise-to-Pay date and amount, and PTP totals on the dashboard.
- **Support:** tickets with priority, status and assignee, linked to the customer.

### Reports (all exportable to CSV)
- Dashboard: today compared with yesterday, calls by hour, outcomes, top agents, lead pipeline.
- Agent performance: calls, connect %, talk time, average talk time, conversions, login and break time, productivity %.
- Campaign penetration, dispositions, hourly, daily trend, attendance, lead sources.

### Selling it (vendor features)
- **Multi-tenant.** Every client company's data is fully separate.
- **Super Admin console.** Create clients, choose a plan (Trial / Starter / Professional / Enterprise), set seat limits and expiry dates, extend licences, suspend clients, reset a client admin's password.
- Expired or suspended clients are blocked automatically, and admins see a warning before expiry.
- **White-label.** Change `BRAND_NAME`, the logo (`public/img/logo.svg`), and the Android app name, package and default server URL.
- **Integrations.**
  - A REST lead-capture API with an API key, for website forms, Facebook lead ads through Zapier, IndiaMART, etc.
  - Signed webhooks for `call.ended`, `call.disposed`, `lead.created` and `lead.status_changed`.
- **Security.**
  - Logins are limited to prevent password guessing.
  - Roles: super admin, admin, manager, agent.
  - Changing a password signs the user out of their other sessions.
  - An audit log records actions.

## Quick start

Requires **Node.js 22.13+**. There is no separate database server: SQLite is built into Node.

```bash
npm install
```

```bash
npm run seed -- --reset
```

```bash
npm start
```

The seed command fills the database with demo data. Then open http://localhost:3000.

| Role | Login | Password |
|---|---|---|
| Super admin (you, the vendor) | owner@smartdialer.local | owner123 |
| Company admin | admin@demo.com | demo123 |
| Manager | manager@demo.com | demo123 |
| Agents | agent1@demo.com … agent5@demo.com | demo123 |

The demo company runs in **demo mode** (simulated calls). Log in as an agent, choose a campaign and click **Start dialing**.

For a fresh production install, skip the seed. On first start the server creates the super admin from `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`, or prints a random password. From the Super Admin console you then create each client company.

## Deploying

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: a small VPS (1 vCPU / 1 GB) running `docker compose up -d` behind Nginx with HTTPS.

## Android app

The source is in [`android/`](android/README.md). Open it in Android Studio, set your server URL and branding, and build the APK. Agents install the APK, enter the server URL and log in. Dialing then happens on their SIM automatically.

> Google Play restricts the call-log permission. Distribute the APK directly (or through MDM), as most SIM-dialer vendors do. The Android README has the details.

## Project layout

```
src/
  server.js        Express + Socket.IO bootstrap, housekeeping jobs
  dialer.js        dialer engine: agent states, lead queue, calls, dispositions, monitoring, webhooks
  db.js            SQLite schema & helpers (node:sqlite)
  auth.js          JWT auth, roles, licence checks
  settings.js      per-company settings, time-zone helpers
  routes/          REST API (auth, users, campaigns, leads, calls, crm, reports, admin, public)
  seed.js          demo data
public/            web panel (no build step): index.html, css/app.css, js/app.js, js/pages/*
android/           Android SIM dialer app (Kotlin)
test/              API + dialer flow tests (npm test)
docs/              deployment, API and sales docs
```

## Tests

```bash
npm test
```

The tests cover licensing, seat limits, CSV import (duplicates, DNC, round robin), the public API, the full auto-dial → call → disposition → callback flow over real sockets, DNC blocking and licence expiry.

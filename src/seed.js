'use strict';
/**
 * Creates a fully populated demo company for sales presentations:
 *   node src/seed.js            (adds demo company if missing)
 *   node src/seed.js --reset    (deletes the database first)
 */
const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('./config');

if (process.argv.includes('--reset') && config.dbFile !== ':memory:') {
  for (const f of [config.dbFile, config.dbFile + '-wal', config.dbFile + '-shm']) fs.rmSync(f, { force: true });
  console.log('Database reset.');
}

const db = require('./db');
const { seedCompanyDefaults } = require('./defaults');
const { phoneKey, sqlNow, randomKey } = require('./util');
const { saveSettings } = require('./settings');

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan', 'Rohan', 'Rahul', 'Amit', 'Suresh', 'Ramesh',
  'Priya', 'Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Kavya', 'Pooja', 'Neha', 'Sneha', 'Anjali', 'Meera', 'Ritu', 'Sunita', 'Imran', 'Faizan', 'Zoya', 'Harpreet', 'Gurpreet', 'Joseph', 'Mary'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Patel', 'Singh', 'Kumar', 'Reddy', 'Nair', 'Iyer', 'Khan', 'Shaikh', 'Joshi', 'Mehta', 'Agarwal', 'Chopra', 'Das', 'Banerjee', 'Yadav', 'Mishra', 'Pandey'];
const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Pune', 'Chennai', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Lucknow', 'Indore', 'Surat', 'Noida', 'Gurugram'];
const SOURCES = ['Facebook Ads', 'Google Ads', 'Website', 'IndiaMART', 'Referral', 'Walk-in', 'JustDial'];

let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const phone = () => '+91' + pick(['9', '8', '7', '6']) + String(Math.floor(rand() * 1e9)).padStart(9, '0');

function run() {
  db.init();
  if (!db.get("SELECT id FROM users WHERE role = 'superadmin'")) {
    db.run("INSERT INTO users (company_id, name, email, password_hash, role) VALUES (NULL, 'Software Owner', 'owner@smartdialer.local', ?, 'superadmin')", [bcrypt.hashSync('owner123', 10)]);
    console.log('Super admin: owner@smartdialer.local / owner123');
  }
  if (db.get("SELECT id FROM users WHERE email = 'admin@demo.com'")) {
    console.log('Demo company already exists. Use --reset to recreate.');
    return;
  }
  const exp = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const cid = db.run(
    "INSERT INTO companies (name, contact_name, contact_email, contact_phone, plan, max_agents, expires_at, api_key) VALUES (?,?,?,?,?,?,?,?)",
    ['Demo Finserv Pvt Ltd', 'Rakesh Malhotra', 'admin@demo.com', '+919800000000', 'professional', 25, exp, randomKey('sad')]
  ).id;
  seedCompanyDefaults(cid);
  saveSettings(cid, { demo_mode: true, auto_dial_delay_sec: 3, custom_fields: ['Loan Amount', 'Occupation'] });

  const pw = bcrypt.hashSync('demo123', 10);
  const mkUser = (name, email, role, team) => db.run('INSERT INTO users (company_id, name, email, password_hash, role, team, phone) VALUES (?,?,?,?,?,?,?)', [cid, name, email, pw, role, team, phone()]).id;
  const admin = mkUser('Rakesh Malhotra', 'admin@demo.com', 'admin', null);
  const manager = mkUser('Neha Kapoor', 'manager@demo.com', 'manager', 'Sales');
  const agents = [
    mkUser('Amit Sharma', 'agent1@demo.com', 'agent', 'Sales'),
    mkUser('Priya Verma', 'agent2@demo.com', 'agent', 'Sales'),
    mkUser('Rohan Gupta', 'agent3@demo.com', 'agent', 'Collections'),
    mkUser('Sneha Iyer', 'agent4@demo.com', 'agent', 'Support'),
    mkUser('Imran Khan', 'agent5@demo.com', 'agent', 'Sales'),
  ];

  const camp = (name, type, mode, script, extra = {}) => db.run(
    `INSERT INTO campaigns (company_id, name, type, dial_mode, script, description, wrapup_sec, max_attempts, retry_minutes, call_start, call_end, auto_skip_unanswered)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, name, type, mode, script, extra.description || null, extra.wrapup || 30, 3, 60, '00:00', '23:59', extra.autoskip ? 1 : 0]
  ).id;
  const c1 = camp('Home Loan - Oct Leads', 'sales', 'progressive',
    'Namaste {{name}} ji, main {{agent_name}} bol raha/rahi hoon Demo Finserv se.\n\n1. Aapne home loan ke liye enquiry ki thi - kya abhi 2 minute baat kar sakte hain?\n2. Loan amount kitna chahiye? Property kis city me hai?\n3. Aapki monthly income approx kitni hai? (Salaried / Self-employed)\n4. Hamare current rates 8.35% se start hote hain, processing fee 0.5%.\n5. Documents WhatsApp par bhej dijiye - main abhi aapko checklist bhejta/bhejti hoon.\n\nObjection: "Rate zyada hai" -> Balance transfer + top-up option batayein.',
    { description: 'Facebook + Google home loan leads' });
  const c2 = camp('EMI Collections - Bucket 1', 'collection', 'power',
    'Hello {{name}} ji, Demo Finserv se {{agent_name}} baat kar raha/rahi hoon.\nAapki EMI of Rs. {{amount_due}} due date {{due_date}} ko pending hai.\n\n- Payment kab tak kar payenge? (PTP date + amount note karein)\n- Online payment link WhatsApp par bhej dun?\n- Late fee aur CIBIL impact politely batayein.',
    { autoskip: true, wrapup: 20, description: '1-30 DPD customers' });
  const c3 = camp('Customer Support Callbacks', 'support', 'preview',
    'Hello {{name}}, this is {{agent_name}} from Demo Finserv support. You raised a request with us - I am calling to help resolve it.\n\n1. Confirm issue details\n2. Check ticket history\n3. Resolve or escalate (create ticket)\n4. Ask for feedback (1-5)',
    { description: 'Service requests & complaint callbacks' });
  for (const a of agents.slice(0, 2).concat(agents[4])) db.run('INSERT INTO campaign_agents VALUES (?,?)', [c1, a]);
  db.run('INSERT INTO campaign_agents VALUES (?,?)', [c2, agents[2]]);
  db.run('INSERT INTO campaign_agents VALUES (?,?)', [c2, agents[0]]);
  db.run('INSERT INTO campaign_agents VALUES (?,?)', [c3, agents[3]]);
  db.run('INSERT INTO campaign_agents VALUES (?,?)', [c3, agents[1]]);

  const disp = db.all('SELECT * FROM dispositions WHERE company_id = ?', [cid]);
  const byName = (n) => disp.find((d) => d.name.startsWith(n));
  const campAgents = { [c1]: [agents[0], agents[1], agents[4]], [c2]: [agents[2], agents[0]], [c3]: [agents[3], agents[1]] };

  const leads = [];
  db.tx(() => {
    for (let i = 0; i < 360; i++) {
      const campaign = i < 200 ? c1 : i < 300 ? c2 : c3;
      const p = phone();
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const created = new Date(Date.now() - Math.floor(rand() * 10) * 86400000 - Math.floor(rand() * 8) * 3600000);
      const custom = campaign === c1 ? { 'Loan Amount': `${pick([15, 20, 25, 35, 50, 75])} Lakh`, Occupation: pick(['Salaried', 'Self-employed', 'Business']) } : {};
      const id = db.run(
        `INSERT INTO leads (company_id, campaign_id, name, phone, phone_key, email, city, source, status, priority, custom, amount_due, due_date, deal_value, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'new', ?, ?, ?, ?, ?, ?, ?)`,
        [cid, campaign, name, p, phoneKey(p), `${name.split(' ')[0].toLowerCase()}${i}@example.com`, pick(CITIES), campaign === c2 ? 'Loan Book' : pick(SOURCES),
          rand() < 0.15 ? 1 : 0, JSON.stringify(custom),
          campaign === c2 ? Math.round(3000 + rand() * 30000) : null,
          campaign === c2 ? new Date(Date.now() - Math.floor(rand() * 25) * 86400000).toISOString().slice(0, 10) : null,
          campaign === c1 ? Math.round(1500000 + rand() * 6000000) : null,
          sqlNow(created), sqlNow(created)]
      ).id;
      leads.push({ id, campaign, phone: p, created });
    }

    // Historic calls over the last 7 days (about 60% of leads touched).
    const hist = leads.filter(() => rand() < 0.6);
    for (const l of hist) {
      const agent = pick(campAgents[l.campaign]);
      const attempts = 1 + Math.floor(rand() * 2);
      let lastDisp = null;
      for (let k = 0; k < attempts; k++) {
        const day = Math.floor(rand() * 7);
        const t = new Date(Date.now() - day * 86400000);
        t.setUTCHours(4 + Math.floor(rand() * 10), Math.floor(rand() * 60), Math.floor(rand() * 60));
        if (t > new Date()) t.setTime(Date.now() - Math.floor(rand() * 3600000));
        const connected = rand() < 0.6;
        let d;
        if (!connected) d = pick([byName('No Answer'), byName('No Answer'), byName('Busy'), byName('Switched Off')]);
        else if (l.campaign === c2) d = pick([byName('Promise to Pay'), byName('Promise to Pay'), byName('Payment Done'), byName('Call Back'), byName('Not Interested')]);
        else if (l.campaign === c3) d = pick([byName('Issue Resolved'), byName('Issue Resolved'), byName('Call Back'), byName('Not Interested')]);
        else d = pick([byName('Interested'), byName('Call Back'), byName('Not Interested'), byName('Send Details'), byName('Sale Done'), byName('Wrong Number'), byName('Interested')]);
        const dur = connected ? 20 + Math.floor(rand() * 280) : 0;
        db.run(
          `INSERT INTO calls (company_id, lead_id, campaign_id, user_id, phone, mode, status, connected, started_at, answered_at, ended_at, duration, disposition_id, disposition, disposed_at)
           VALUES (?,?,?,?,?, 'sim', 'ended', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [cid, l.id, l.campaign, agent, l.phone, connected ? 1 : 0, sqlNow(t), connected ? sqlNow(new Date(t.getTime() + 8000)) : null,
            sqlNow(new Date(t.getTime() + 8000 + dur * 1000)), dur, d.id, d.name, sqlNow(new Date(t.getTime() + 20000 + dur * 1000))]
        );
        db.run('INSERT INTO activities (company_id, lead_id, user_id, type, text, created_at) VALUES (?,?,?,?,?,?)',
          [cid, l.id, agent, 'disposition', d.name, sqlNow(t)]);
        lastDisp = { d, t, agent };
      }
      const d = lastDisp.d;
      const status = d.lead_status || 'contacted';
      let next = null;
      if (d.needs_callback) {
        next = new Date(Date.now() + (rand() < 0.4 ? -1 : 1) * Math.floor(rand() * 48) * 3600000);
        db.run('INSERT INTO followups (company_id, lead_id, user_id, due_at, note) VALUES (?,?,?,?,?)', [cid, l.id, lastDisp.agent, sqlNow(next), d.name]);
      }
      const ptp = d.name.startsWith('Promise') ? new Date(Date.now() + Math.floor(rand() * 7) * 86400000).toISOString().slice(0, 10) : null;
      db.run(
        `UPDATE leads SET status = ?, attempts = ?, last_called_at = ?, last_disposition = ?, next_call_at = ?, assigned_to = ?, ptp_date = ?, ptp_amount = CASE WHEN ? IS NOT NULL THEN amount_due ELSE NULL END WHERE id = ?`,
        [status, attempts, sqlNow(lastDisp.t), d.name, next ? sqlNow(next) : null, d.needs_callback ? lastDisp.agent : null, ptp, ptp, l.id]
      );
    }

    // Attendance + breaks for the last 7 days.
    for (const a of agents) {
      for (let day = 1; day <= 7; day++) {
        const login = new Date(Date.now() - day * 86400000); login.setUTCHours(3, 30 + Math.floor(rand() * 40), 0);
        const logout = new Date(login.getTime() + (8 + rand()) * 3600000);
        db.run('INSERT INTO agent_sessions (company_id, user_id, login_at, logout_at) VALUES (?,?,?,?)', [cid, a, sqlNow(login), sqlNow(logout)]);
        const b = new Date(login.getTime() + 4 * 3600000);
        db.run('INSERT INTO agent_breaks (company_id, user_id, reason, start_at, end_at) VALUES (?,?,?,?,?)', [cid, a, 'Lunch', sqlNow(b), sqlNow(new Date(b.getTime() + (25 + rand() * 20) * 60000))]);
      }
    }

    // Some support tickets.
    const subjects = ['Statement not received', 'EMI auto-debit failed', 'Change registered mobile', 'Foreclosure charges query', 'NOC not received', 'Wrong late fee applied'];
    leads.filter((l) => l.campaign === c3).slice(0, 12).forEach((l, i) => {
      db.run('INSERT INTO tickets (company_id, lead_id, subject, description, priority, status, assigned_to, created_by) VALUES (?,?,?,?,?,?,?,?)',
        [cid, l.id, subjects[i % subjects.length], 'Customer called regarding this issue.', pick(['low', 'medium', 'high', 'urgent']), pick(['open', 'open', 'in_progress', 'resolved']), agents[3], manager]);
    });

    for (let i = 0; i < 8; i++) {
      const p = phone();
      db.run('INSERT OR IGNORE INTO dnc (company_id, phone, phone_key, reason) VALUES (?,?,?,?)', [cid, p, phoneKey(p), 'Customer request']);
    }
  });

  console.log('\nDemo company created: Demo Finserv Pvt Ltd (demo mode ON - calls are simulated)');
  console.log('  Admin:    admin@demo.com    / demo123');
  console.log('  Manager:  manager@demo.com  / demo123');
  console.log('  Agents:   agent1@demo.com ... agent5@demo.com / demo123');
  void admin;
}

run();
db.close();

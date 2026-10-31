'use strict';
const db = require('./db');

const DEFAULT_DISPOSITIONS = [
  // name, category, lead_status, is_success, needs_callback, retry, color
  ['Interested', 'connected', 'interested', 1, 0, 0, '#16a34a'],
  ['Sale Done / Converted', 'connected', 'converted', 1, 0, 0, '#059669'],
  ['Call Back Later', 'connected', 'follow_up', 0, 1, 0, '#2563eb'],
  ['Send Details on WhatsApp', 'connected', 'follow_up', 0, 1, 0, '#0ea5e9'],
  ['Promise to Pay (PTP)', 'connected', 'follow_up', 1, 1, 0, '#7c3aed'],
  ['Payment Done', 'connected', 'converted', 1, 0, 0, '#047857'],
  ['Issue Resolved', 'connected', 'converted', 1, 0, 0, '#0d9488'],
  ['Not Interested', 'connected', 'not_interested', 0, 0, 0, '#dc2626'],
  ['Wrong Number', 'connected', 'invalid', 0, 0, 0, '#9f1239'],
  ['Do Not Call', 'connected', 'dnc', 0, 0, 0, '#111827'],
  ['Language Barrier', 'connected', null, 0, 0, 1, '#a16207'],
  ['No Answer', 'not_connected', null, 0, 0, 1, '#f59e0b'],
  ['Busy', 'not_connected', null, 0, 0, 1, '#ea580c'],
  ['Switched Off / Not Reachable', 'not_connected', null, 0, 0, 1, '#78716c'],
  ['Invalid Number', 'not_connected', 'invalid', 0, 0, 0, '#be123c'],
];

const DEFAULT_TEMPLATES = [
  ['Intro + Brochure', 'whatsapp', 'Hi {{first_name}}, this is {{agent_name}} from {{business_name}}. As discussed, sharing the details here. Feel free to reply with any questions!'],
  ['Missed you', 'whatsapp', 'Hi {{first_name}}, I tried calling you from {{business_name}}. Please let me know a good time to talk. - {{agent_name}}'],
  ['Payment reminder', 'whatsapp', 'Dear {{name}}, a gentle reminder that your payment of Rs. {{amount_due}} is due on {{due_date}}. Please pay to avoid late charges. - {{business_name}}'],
  ['PTP confirmation', 'sms', 'Dear {{name}}, thank you for confirming payment on {{ptp_date}}. - {{business_name}}'],
  ['Callback SMS', 'sms', 'Hi {{first_name}}, {{agent_name}} from {{business_name}} tried to reach you. Call us back at {{agent_phone}}.'],
];

function seedCompanyDefaults(companyId) {
  if (!db.get('SELECT 1 AS x FROM dispositions WHERE company_id = ?', [companyId])) {
    DEFAULT_DISPOSITIONS.forEach(([name, category, lead_status, is_success, needs_callback, retry, color], i) => {
      db.run(
        'INSERT INTO dispositions (company_id, name, category, lead_status, is_success, needs_callback, retry, color, sort) VALUES (?,?,?,?,?,?,?,?,?)',
        [companyId, name, category, lead_status, is_success, needs_callback, retry, color, i]
      );
    });
  }
  if (!db.get('SELECT 1 AS x FROM templates WHERE company_id = ?', [companyId])) {
    for (const [name, channel, body] of DEFAULT_TEMPLATES) {
      db.run('INSERT INTO templates (company_id, name, channel, body) VALUES (?,?,?,?)', [companyId, name, channel, body]);
    }
  }
}

module.exports = { seedCompanyDefaults, DEFAULT_DISPOSITIONS };

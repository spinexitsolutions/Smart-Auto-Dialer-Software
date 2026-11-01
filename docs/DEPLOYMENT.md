# Deployment guide

## Option A: Docker (recommended)

1. Get a VPS with Ubuntu 22.04+, 1 vCPU / 1 GB RAM (enough for about 50 agents). Install Docker on it.
2. Copy the project to the server, then create the settings file:

   ```bash
   cp .env.example .env
   ```

   In `.env`, set `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, `BRAND_NAME`, and a long random `JWT_SECRET`.
3. Start the server:

   ```bash
   docker compose up -d --build
   ```

   The database and recordings are stored in `./data` on the host. Back that folder up.

## Option B: plain Node.js

```bash
npm ci --omit=dev
```

```bash
npm start
```

To keep it running and restart it on reboot, use pm2:

```bash
npm i -g pm2
```

```bash
pm2 start "npm start" --name dialer
```

```bash
pm2 save
```

## HTTPS with Nginx

Use HTTPS in production: browsers and the Android app send passwords and tokens.

```nginx
server {
  server_name dialer.yourcompany.com;
  client_max_body_size 60m;            # call recordings
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;     # Socket.IO websockets
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

Then get a certificate:

```bash
sudo certbot --nginx -d dialer.yourcompany.com
```

## Backups

The database is a single SQLite file, `data/dialer.db`, plus `data/recordings/`. A nightly copy is enough:

```bash
sqlite3 data/dialer.db ".backup 'backup/dialer-$(date +%F).db'"
```

## Onboarding a new client (SaaS)

1. Log in as the super admin and open **Clients & Licences**, then **New client**. Choose the plan, number of seats and expiry date, and set the client admin's email and password.
2. Send the client their login and the Android APK.
3. The client admin then:
   - adds agents (Team);
   - creates campaigns;
   - imports leads (CSV);
   - adjusts dispositions and templates (Settings);
   - optionally connects their website using the API key (Settings → API & Webhooks).
4. Agents install the APK, enter the server URL, log in and press **Start dialing**.

## Lead capture API

```bash
curl -X POST https://dialer.yourcompany.com/api/public/leads \
  -H "X-API-Key: <company api key>" -H "Content-Type: application/json" \
  -d '{"name":"Rahul","phone":"9876543210","source":"Website","campaign_id":1,"message":"Need home loan"}'
```

- To send many leads at once, use `{"leads":[{...},{...}], "campaign_id":1}`.
- If the number already exists, no new lead is created. The existing lead gets a note and its priority is raised.

## Webhooks

Settings → API & Webhooks. Each webhook is sent as `POST` JSON in the form `{event, at, data}`. The header `X-Signature` carries an HMAC-SHA256 of the raw body, signed with the webhook secret.

Events:
- `call.ended`
- `call.disposed`
- `call.inbound`
- `call.missed`
- `lead.created`
- `lead.status_changed`

## Integrations checklist

- **Lead-source webhooks** (Facebook, Google Ads, IndiaMART, JustDial, website) need the server reachable on a public **HTTPS** domain. Meta and Google will not call `localhost` or a plain IP address.
  - Each connection's URL is shown under Integrations → Lead sources. It looks like `https://dialer.yourcompany.com/api/hooks/<secret-token>`.
  - Deleting the connection disables the URL.
- **Facebook Lead Ads** needs a Meta app with the `leads_retrieval` and `pages_manage_metadata` permissions, plus a long-lived Page access token.
- **WhatsApp automations:**
  - Messages sent outside the 24-hour window must use a template that Meta has approved. Put the template name and its parameters on the automation.
  - MSG91 SMS needs a DLT-approved Flow ID.
- **AI call analysis** costs money per call. You need two keys:
  - a speech-to-text key (Sarvam AI, Deepgram or OpenAI);
  - an Anthropic API key.

  Claude Opus 5.5 is the default model. Choose Claude Haiku 5.5 in Integrations → AI to lower the cost. Analysis only runs for calls that have a recording.
- **Outgoing traffic:** the server must be able to reach `graph.facebook.com`, `mapi.indiamart.com`, `control.msg91.com`, `api.anthropic.com`, and your speech-to-text provider.

# Sales Guide (software kaise bechein)

## Kis ko bechna hai
- **Loan / insurance / credit card DSA** aur NBFC tele-sales teams
- **Collection agencies** (EMI reminders, PTP tracking)
- **Real estate**, education counselling, coaching institutes
- **Customer support teams**, service centres
- **BPO / telecalling vendors** (10 se 200 agents)

## Customer ko 30 second ka pitch
> "Aapke agents apne normal SIM se hi calls karenge, lekin numbers khud lagenge. Ek call khatam hote hi agla customer apne aap dial ho jaata hai. Har call ka result, recording aur follow-up CRM me save hota hai. Manager live dekh sakta hai ki kaun call par hai, kaun break par hai, aur aaj kisne kitni calls aur sales ki. VoIP ya telecom ka koi extra kharcha nahi hai."

## Demo kaise dein (10 min)
1. Server ko demo data ke saath start karein (seed command repo ke `README.md` me hai). `npm start` ke baad do browser windows kholein.
2. Window 1 me **manager@demo.com** se Live Monitor kholein.
3. Window 2 me **agent1@demo.com** se Start dialing dabaayein. Calls simulate hongi, aur monitor par sab live dikhega.
4. Disposition dikhayein: "Call Back Later" chunein. Follow-up apne aap ban jaata hai, aur agla lead apne aap dial hota hai.
5. Leads page par CSV import dikhayein (sample CSV download karke). Saath me bulk assign bhi.
6. Reports dikhayein: agent performance, attendance aur CSV export.
7. Asli demo ke liye: Android app phone par install karke ek real SIM call karke dikhayein.

## Pricing suggestion (India)
| Plan | Seats | Price idea |
|---|---|---|
| Trial | 3 agents, 14 days | Free |
| Starter | up to 5 agents | ₹499–799 / agent / month |
| Professional | up to 25 agents | ₹399–599 / agent / month |
| Enterprise | 25+ agents, white-label, on-premise | ₹2–5 lakh one-time + AMC |

- Plan, seats aur expiry Super Admin console me set karein. Expiry ke baad client ka login apne aap block ho jaata hai.
- **Extend +30 / +365** se renewal hota hai.

## White-label (client ke naam se bechna)
- **Server:** `.env` me `BRAND_NAME` badlein, aur `public/img/logo.svg` me apna logo rakhein.
- **Android app:** `android/app/build.gradle.kts` me app name, package aur default server URL badlein.
- **Domain:** har bade client ke liye alag domain, ya ek hi SaaS server par sab clients.

## Zaroori baatein (customer ko pehle batayein)
- **Google Play:** call-log permission ki wajah se app Play Store par nahi jaati. APK seedha share hota hai (sab SIM-dialer companies aisa hi karti hain).
- **Call recording:** phone ka built-in call recorder ON hona chahiye. Android 10+ par third-party recording allowed nahi hai.
- **Android 13+:** app install karne ke baad agent ko App info → ⋮ → "Allow restricted settings" karna hoga.
- **TRAI / DND:** calling hours aur DNC list ka use karein. Promotional calls ke rules client ki zimmedari hain.

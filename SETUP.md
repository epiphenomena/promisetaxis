# Setup

Everything here is free. A domain is optional and is the only thing that could
cost money.

Work through it in order — **Part 1 needs no accounts at all**, so you can build
and demo the entire system before touching Meta. Start Part 3 (business
verification) early anyway: it is the long pole and it runs in the background
while you build.

---

## Part 1 — Run it locally (no accounts needed)

```bash
npm install
npm run db:reset      # apply migrations + load seed data
npm run dev
```

Two pages, both live at <http://localhost:8787>:

- **/** — the **office dashboard** the dispatcher uses: waiting hails with
  tap-to-assign, live fleet status, and reports with CSV export.
- **/harness.html** — the **fake WhatsApp harness**: customer on the left,
  driver on the right, live fleet state on the right edge. Tap through a whole
  hail without a phone, a Meta account, or an internet connection.

The two link to each other in the header. Open them side by side and you can
watch a hail land on the dispatcher's board as you tap through it.

```bash
npm test              # 48 tests, real workerd + real local D1, no network
npm run typecheck
```

Useful while developing:

| Command | What it does |
| --- | --- |
| `npm run db:reset` | Drop local D1, re-migrate, re-seed |
| `npm run db:console "SELECT * FROM trips"` | Query local D1 |
| Reset button in the harness | Clear trips/sessions without touching the gazetteer |
| Run sweep button | Fire the one-minute cron job immediately |

### Replace the seed data early

`seeds/dev.sql` ships **plausible placeholders, not surveyed data**. The
gazetteer is the part locals will judge instantly — a missing alias ("la parada"
vs "la terminal") makes the bot feel broken. Walk the town with the nonprofit,
then rewrite the `zones`, `landmarks`, and `zone_times` inserts. Keep each zone
to **9 landmarks or fewer**: WhatsApp caps a list at 10 rows and one is reserved
for "Otro lugar…".

For `zone_times`, an afternoon of driving a tuktuk around with a phone and a
notepad beats any estimate. The numbers self-correct from real trips afterward,
but a bad seed means bad wait quotes on day one.

---

## Part 2 — Meta developer account and the test number

The test number is Meta-owned and free, messages up to **5 OTP-verified
recipients**, and needs no business verification. It is for you and a teammate —
**not a field pilot** (see Part 3).

### 2.1 Create the Business Portfolio
1. Go to <https://business.facebook.com> and create a Business Portfolio for the
   nonprofit (or use an existing one).
2. Note the portfolio name — verification in Part 3 attaches to it.

### 2.2 Create **two** apps, not one
At <https://developers.facebook.com/apps>, create two apps of type **Business**:

- `tuktuk-dev`
- `tuktuk-prod`

**Why two:** the webhook callback URL is configured *per app*. With one app you
would re-point that URL every time you develop, breaking production each time.
Each app gets its own free test number, so this costs nothing.

For each app: **Add product → WhatsApp → Set up**. Meta provisions a test phone
number automatically and shows its **Phone number ID** — copy it.

### 2.3 Add your test recipients
In **WhatsApp → API Setup**, under "To", click **Manage phone number list** and
add your own number. Meta sends an OTP; enter it. Repeat for up to 5 numbers
total (your phone, a teammate's, etc.).

> Tip: install **WhatsApp** *and* **WhatsApp Business** on one phone with two
> different numbers. That is the cheapest way to play customer and driver at the
> same time and watch both sides of a dispatch.

### 2.4 Create a permanent token — do this now, not later

**The token on the API Setup page expires in about 24 hours.** Everything works
on day one and returns 401 the next morning. Avoid the whole trap:

1. **Business Settings → Users → System Users → Add**
   Name it `tuktuk-bot`, role **Admin**.
2. **Add Assets** → assign both the app and the WhatsApp Business Account, with
   full control.
3. **Generate New Token** → select the app → check:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
4. Set expiry to **Never**. Copy the token immediately — it is shown once.

### 2.5 Get the app secret
**App Settings → Basic → App Secret → Show.** This signs webhook deliveries; the
Worker rejects any request whose signature does not match.

---

## Part 3 — Business verification (start early, finish before the pilot)

The test number **cannot be migrated** to a production number — switching means
every driver re-saves a new contact. So a real pilot needs a real number, and a
real number needs verification. It can take days to weeks.

1. **Business Settings → Business Info → Start Verification.**
2. Provide the nonprofit's legal name, address, phone, and website, plus a
   supporting document (registration certificate, utility bill, bank statement).
   Every detail must match the document exactly.
3. Once verified, add the real phone number under **WhatsApp Manager → Phone
   Numbers → Add**, verify ownership by SMS or call, and submit a display name.

The number must not currently be registered to a regular WhatsApp account — if
it is, delete that account first.

**Messaging limits barely matter here.** The 250/day cap on unverified numbers
counts *business-initiated* conversations, and nearly everything this system
sends is a free reply inside the 24-hour window a customer or driver opened by
messaging first.

---

## Part 4 — Cloudflare and the staging Worker

### 4.1 Create the databases
```bash
npx wrangler login
npx wrangler d1 create tuktuk-staging   # copy database_id into wrangler.jsonc
npx wrangler d1 create tuktuk-prod      # copy database_id into wrangler.jsonc
```

Edit `wrangler.jsonc` and replace the two `REPLACE_AFTER_D1_CREATE` values and
the two `WHATSAPP_PHONE_NUMBER_ID` placeholders.

### 4.2 Secrets
```bash
npx wrangler secret put WHATSAPP_TOKEN        --env staging   # the permanent one
npx wrangler secret put WHATSAPP_APP_SECRET   --env staging
npx wrangler secret put WHATSAPP_VERIFY_TOKEN --env staging   # any random string
```
Repeat with `--env production` using the prod app's values.

### 4.3 Deploy and migrate
```bash
npm run db:migrate:staging
npm run deploy:staging        # → https://tuktuk-staging.<subdomain>.workers.dev
```

### 4.4 Point the dev app's webhook at staging — once
In `tuktuk-dev` → **WhatsApp → Configuration → Webhook → Edit**:

- **Callback URL**: `https://tuktuk-staging.<subdomain>.workers.dev/wa`
- **Verify token**: the `WHATSAPP_VERIFY_TOKEN` you set

Click **Verify and save**, then **Manage** and subscribe to the **`messages`**
field. Without that subscription the webhook stays silent and nothing arrives.

**Do not tunnel for webhook work.** `wrangler dev --tunnel` (or pressing `t`)
gives a random `*.trycloudflare.com` hostname per session, and Meta's callback
URL is a manual dashboard paste — so every restart means re-pasting. Deploy to
staging instead and iterate with `npm run deploy:staging`, which takes seconds.
Keep `npm run dev` for the harness, the dashboard, and logic work.

*(A stable named tunnel is the alternative, but it requires a domain on
Cloudflare. Staging is simpler and free.)*

### 4.5 Protect the office dashboard
**Workers & Pages → `tuktuk-staging` → Access tab → Protect this Worker behind
Access → All traffic.** Add a policy allowing the dispatchers' email addresses.

This covers routes, custom domains, the `workers.dev` hostname, and preview
URLs — which is why **no domain is required**. Buy one later only if you want a
memorable dashboard URL.

---

## Part 5 — Day-one smoke test

Before building anything on top of them, confirm the three interactive message
types the whole design rests on. Meta's docs let you get all three wrong
silently. From the test number to your own phone, in one sitting:

1. **Location request.** Send one, tap "Send location", and confirm the webhook
   receives `latitude`/`longitude`. Every hail starts here.
2. **List message.** Send one with sections, confirm the reply arrives as a
   **row ID** (not the label), and confirm **10 rows** is really the ceiling.
3. **Reply buttons.** Send three, confirm the button ID round-trips, and confirm
   there is no fourth.

Watch it land:
```bash
npx wrangler tail --env staging
```

Quick manual send (substitute your values):
```bash
curl -X POST "https://graph.facebook.com/v21.0/$PHONE_NUMBER_ID/messages" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","to":"504XXXXXXXX","type":"interactive",
       "interactive":{"type":"location_request_message",
       "body":{"text":"¿Dónde está usted?"},"action":{"name":"send_location"}}}'
```

The repo already asserts the button and row ceilings in `test/adapter.test.ts`,
so a menu that outgrows them fails in CI rather than in front of a customer.

---

## Part 6 — Register drivers

Open the office dashboard, go to the **Conductores** tab, and click
**+ Agregar conductor**. There is no separate driver signup: a phone number in
the roster *is* a driver, and every other number is a customer, so nobody ever
has to declare which they are.

The phone number is the one field that matters. Role detection is a lookup of
the number Meta puts in the webhook's `from` field, so the stored value has to
match it exactly. The form normalizes what you type — `9999-0001`,
`+504 9999 0001`, and `50499990001` all save as `50499990001` — so type it
however is natural.

New drivers start as **fuera** (off). They join dispatch the first time they
message the bot to start a shift, not the moment you save the form.

A few rules the form enforces, so they cannot be got wrong quietly:

- A number already on the roster is refused, naming who holds it.
- If the number belongs to a *deactivated* driver, it tells you to reactivate
  them instead of creating a duplicate.
- A driver with a trip in progress cannot be deactivated — that would orphan
  the trip, and the next ✅ Listo would close the wrong one.

**Deactivate rather than delete.** A deactivated driver stops receiving trips
but keeps their completed trips attributable in the reports.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Worked yesterday, 401 today | The temporary token expired. Part 2.4. |
| Webhook verifies but no messages arrive | The `messages` field is not subscribed. Part 4.4. |
| `bad signature` 401s in the log | `WHATSAPP_APP_SECRET` is wrong, or from the other app. |
| A driver's messages get the customer flow | Their number is not on the roster, or was saved in a different format. Check the Conductores tab. |
| Harness shows nothing | `DEV_MODE` is not `"true"`, or `npm run db:reset` was never run. |
| Bot replies but the customer sees nothing | The 5-recipient test list. Part 2.3. |

To test the lapsed-window path without waiting a day, edit the timestamp
directly:

```bash
npm run db:console "UPDATE sessions SET window_expires_at = 0 WHERE phone = '504XXXXXXXX'"
```

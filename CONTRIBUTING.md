# Contributing a plugin

The goal is that your first plugin takes under half an hour. If it takes longer,
that is a bug in this document or in the tooling — please say so in an issue.

## Before anything else: the three rules

These come from §8.4 of the project's specification and they are checked in
review. They limit what this project can cover, deliberately.

1. **Never circumvent a technical protection measure.** No captcha solving, no
   spoofed fingerprints, no code whose purpose is to look less like automation.
   If a portal blocks you, the plugin must fail cleanly so the user knows to
   fetch that one by hand.
2. **Keep to a human request rate.** The engine spaces requests out for you.
3. **Collect nothing but the user's own documents.** No directory scraping, no
   other people's data, no product catalogues.

A pull request that breaks these is closed, not fixed.

## Setting up

```bash
git clone https://github.com/Invoices-Retriever/plugins
cd plugins
export PATH="/Applications/Invoices Retriever.app/Contents/MacOS:$PATH"
irctl help
```

Point your editor at the schema so it autocompletes and validates as you type.
For VS Code, `.vscode/settings.json` in this repository already does it. For
anything else, the `$schema` key at the top of each plugin is the URL.

## The anatomy of a plugin

```jsonc
{
  "id": "ovh",                     // lowercase, stable forever, matches the filename
  "name": "OVHcloud",
  "version": "1.0.0",              // bump on every merged change
  "country": ["FR", "EU"],
  "engine": ">=1.0.0",
  "allowedDomains": ["ovh.com", "*.ovh.com"],   // the sandbox — see below
  "configSchema": { },             // what the app asks the user for
  "checkAuth":    [ /* … */ ],     // "am I still signed in?"
  "startAuth":    [ /* … */ ],     // "sign me in"
  "getDocuments": [ /* … */ ]      // "list and download the invoices"
}
```

### `allowedDomains` is the important one

The application blocks every network request the plugin makes to a domain that
is not in this list — navigations *and* subresources, enforced by WebKit, not by
the plugin. Without it, a plugin could carry the user's live session cookies
anywhere.

Consequences for you:

- List every domain the portal actually uses, including the CDN the PDFs come
  from and the API subdomain the front-end calls. If a step mysteriously does
  nothing, a blocked request is the first thing to check — the run log names it.
- `*.ovh.com` does **not** cover `ovh.com`. List both if you need both.
- Keep it as narrow as it can be while working. A reviewer will ask about any
  domain that is not obviously the supplier's.

### `checkAuth` must be able to say no

It runs first, on every collection, against the session stored from last time.
It must **end in a verification step** — `checkURL` or `checkElementExists` —
because that step's success or failure is how the engine decides whether to ask
the user to sign in.

The usual shape: navigate to the billing page, then assert that something only a
signed-in user sees is present.

```jsonc
"checkAuth": [
  { "action": "navigate", "url": "https://www.ovh.com/manager/#/billing/history" },
  { "action": "waitForElement", "selector": "[data-testid='bill-list']", "timeout": 15000 },
  { "action": "checkElementExists", "selector": "[data-testid='bill-list']" }
]
```

A common mistake is asserting on something that is also present when signed
out — a header, a logo — which makes the plugin think it is signed in and fail
confusingly ten steps later.

### `startAuth` may fail, and that is fine

The browser window is visible while this runs and the user is watching. If your
automatic form fill does not work — the portal moved its login form again — the
engine falls back to letting the person sign in by hand, then re-runs
`checkAuth`. So write `startAuth` optimistically; do not contort it to handle
every variant of a login flow.

Never put a real credential in a plugin. Use `{{config.<key>}}` for ordinary
values, `{{secret.<key>}}` for passwords, `{{totp.<key>}}` for a generated
two-factor code, and declare every one of them in `configSchema`. CI rejects
anything that looks like a hard-coded secret or an e-mail address.

### `getDocuments` emits documents

The usual shape is a table, one row per invoice:

```jsonc
"getDocuments": [
  { "action": "navigate", "url": "https://www.ovh.com/manager/#/billing/history" },
  { "action": "waitForElement", "selector": "tr[data-bill-id]" },
  {
    "action": "extractAll",
    "selector": "tr[data-bill-id]",
    "fields": {
      "number": { "selector": "td.number" },
      "date":   { "selector": "td.date" },
      "total":  { "selector": "td.total" },
      "pdf":    { "selector": "a.download", "attribute": "href" }
    },
    "forEach": [
      {
        "action": "downloadPdf",
        "url": "{{item.pdf}}",
        "document": {
          "id":     "{{item.number}}",
          "date":   "{{item.date}}",
          "total":  "{{item.total}}",
          "number": "{{item.number}}"
        }
      }
    ]
  }
]
```

`document.id` must be **stable for the life of the invoice**: it is half of the
deduplication key, so a value that changes between runs means the user gets the
same invoice again every month. The invoice number is almost always the right
choice. A row index never is.

`date` and `total` are parsed leniently — `31/03/2026`, `1 234,56 €` and
`$1,234.56` all work — so pass the portal's own text rather than trying to
reformat it in the plugin.

If a row fails, the engine logs it and carries on with the next one. One broken
invoice does not cost the user the other eleven.

### A plugin that is *only* an API

The section below is about borrowing the session a user signed in for. This one
is the other case: the supplier issues **API credentials**, and the plugin uses
those instead of a password. Declare an `api` block and the plugin never opens a
browser at all — no window, no password in the keychain, no two-factor code, and
collection that can run unattended.

```jsonc
"engine": ">=1.2.0",
"allowedDomains": ["eu.api.ovh.com", "*.ovhcloud.com"],
"configSchema": {
  "applicationKey":    { "type": "string",   "label": "Application key",    "required": true },
  "applicationSecret": { "type": "password", "label": "Application secret", "required": true },
  "consumerKey":       { "type": "password", "label": "Consumer key",       "required": true }
},
"api": {
  "baseUrl": "https://eu.api.ovh.com/1.0",
  "credentialsUrl": "https://api.ovh.com/createToken/",
  "auth": { "type": "signature", "…": "see below" }
},
"checkAuth": [
  // The call *is* the verification: wrong keys answer 401.
  { "action": "apiRequest", "url": "/me", "assignTo": "account" }
],
"getDocuments": [
  { "action": "apiRequest", "url": "/me/bill?date.from={{cutoff.date}}T00:00:00Z", "assignTo": "ids" },
  { "action": "extractAll", "items": "{{ids}}", "forEach": [ /* … */ ] }
]
```

Steps may use paths relative to `baseUrl`, which is why `/me` above is enough.
There is no `startAuth`: nothing is interactive. Browser steps — `navigate`,
`click`, `type`, `runJs`, `printPdf` and the rest — are refused by CI, because
there is no page for them to act on.

#### Declaring the authentication

Authentication is declared as a **recipe from a closed vocabulary**, never as
code. That is not bureaucracy: it is the property the whole project rests on —
a reviewer who is not a programmer has to be able to read what a plugin does
with someone's credentials.

Four types cover what exists in practice:

- `header` — an API key or a bearer token. Put it in `auth.headers`.
- `basic` — HTTP Basic, from `username` and `password` templates.
- `oauth2ClientCredentials` — exchanges a client id and secret for a token, then
  sends it. The only OAuth2 flow that needs no browser, which is why it is the
  only one here.
- `signature` — hashes an ordered list of parts into a header. Most APIs that
  predate OAuth2 work this way.

A signature is written out rather than computed in code:

```jsonc
"auth": {
  "type": "signature",
  "headers": {
    "X-Ovh-Application": "{{config.applicationKey}}",
    "X-Ovh-Consumer":    "{{secret.consumerKey}}",
    "X-Ovh-Timestamp":   "{{api.time}}"
  },
  // Some schemes are checked against the server's clock, not yours.
  // Read once per run, then advanced locally.
  "time": { "url": "https://eu.api.ovh.com/1.0/auth/time", "format": "text" },
  "signature": {
    "header": "X-Ovh-Signature",
    "algorithm": "sha1",          // or sha256/sha512, or hmacSha1/hmacSha256/hmacSha512 with a "key"
    "encoding": "hex",            // or base64
    "prefix": "$1$",
    "separator": "+",
    "parts": [
      "{{secret.applicationSecret}}", "{{secret.consumerKey}}",
      "{{request.method}}", "{{request.url}}", "{{request.body}}", "{{api.time}}"
    ]
  }
}
```

Inside `parts` you also get `{{request.method}}`, `{{request.url}}`,
`{{request.body}}` and `{{api.time}}` — everything a request-signing scheme has
ever needed, and nothing that reaches further.

Two rules CI enforces, both about where credentials end up:

- **Every host the transport touches must be in `allowedDomains`** — the base
  URL, the time endpoint, the token endpoint. The sandbox is not relaxed
  because there is no browser.
- **A field whose name reads like a credential must be `type: "password"`.**
  Only password fields reach the Keychain; a key in a plain string field would
  sit in the database in clear.

Test it with `irctl run plugins/your-plugin.json --step`, the same as any other
plugin. There is no window, so what you watch is the step log.

### If the portal has an API, use it

A great many portals are a thin interface over their own JSON API — the table
you are about to scrape was drawn from it in the browser. Reading that API
instead is less work and far more durable: a redesign changes the markup every
year, the API rarely.

`apiRequest` makes the call **from the page you are already on**, with the
session cookies you already have. There is no second set of credentials to ask
the user for, no token to store, and the call is subject to the same
`allowedDomains` sandbox as everything else — so the API host must be declared
there too.

```jsonc
"getDocuments": [
  // Be on the portal first: the call inherits this page's session.
  { "action": "navigate", "url": "https://manager.example.com/billing" },
  {
    "action": "apiRequest",
    "url": "https://manager.example.com/apiv6/me/bill?date.from={{cutoff.date}}T00:00:00Z",
    "assignTo": "billIds"
  },
  {
    // `items` walks a JSON list the way `selector` walks the page.
    "action": "extractAll",
    "items": "{{billIds}}",
    "forEach": [
      // A list of plain identifiers: each one is {{item}}.
      { "action": "apiRequest", "url": ".../me/bill/{{item}}", "assignTo": "bill" },
      {
        "action": "downloadPdf",
        "url": "{{bill.pdfUrl}}",
        "document": {
          "id":    "{{bill.billId}}",
          "date":  "{{bill.date}}",
          "total": "{{bill.priceWithTax.text}}"
        }
      }
    ]
  }
]
```

Worth knowing:

- **Say `"engine": ">=1.1.0"`.** That is the version `apiRequest` and `items`
  appeared in. An application older than that then reports "needs a newer
  version of the app" and moves on; leave `engine` at `>=1.0.0` and it reports
  your plugin as *invalid* instead, sending users to look for a fault that is
  not there. CI refuses the mismatch, so you cannot ship it by accident.
- **`GET` and `POST` only.** A collector reads; it must never be able to change
  anything on a portal, and the validator enforces that.
- **`{{cutoff.date}}`** is the date of the last successful run. An API that
  filters by date turns incremental collection into a smaller request rather
  than a longer loop.
- **`jsonPath`** pulls a nested list out of an envelope: `"jsonPath": "data.items"`.
- A list of **objects** exposes `{{item.field}}`; a list of **plain values**
  exposes `{{item}}`. Both are common — many APIs answer a list of identifiers
  and expect a second call for each.
- Use `{{variable.field.subfield}}` to reach into anything `assignTo` stored.
- This is **not** `runJs`. A plugin reading an API stays declarative and is not
  flagged as running its own code.

Finding the endpoint is usually a minute of work: open the portal's billing page
with the browser's network inspector, filter on XHR, and read the request the
page made. If the supplier documents its API publicly, link to it from the
step's `description` — the next person to fix this plugin will need it.

### When there is no PDF

Some portals only ever show an invoice as a web page. Navigate to it and use
`printPdf`. The result is not as good as a real PDF, but it is a document the
user can hand to an accountant, which is the point.

### `runJs` is a last resort

It works, and it is flagged everywhere: the plugin is marked as running its own
JavaScript in the catalogue, and CI cannot merge it — a human has to review it.
Use it when the declarative vocabulary genuinely cannot express something, and
say why in the pull request. Most uses turn out to be an `extract` with a regex.

## Testing

```bash
irctl validate plugins/my-supplier.json   # schema plus every rule CI applies
irctl run plugins/my-supplier.json \
  --config customerID=ab12345 \
  --secret password="$(security find-generic-password -s my-supplier -w)" \
  --step                                  # pause before each step
```

`--step` prints each step before running it and waits for return; type `v` to
dump the current variables. On failure it writes `irctl-failure.png` — a
screenshot of exactly what the browser was looking at.

Run it twice. The second run should download nothing, because everything is
already known. If it re-downloads, your `document.id` is not stable.

### Offline tests

Save an anonymised copy of the listing page to `tests/<id>/listing.html`, with
every real name, number and amount replaced. CI then checks that your selectors
still match without needing an account, which is how a broken plugin gets caught
before a user notices.

## Submitting

- One plugin per pull request. Filename must be `<id>.json`.
- `plugins/` is for plugins you have run against a real account. If you have
  written one from documentation but cannot test it, put it in `drafts/` and say
  so — drafts are validated by CI but not published to users.
- Say which country the supplier serves and roughly how many invoices you tested
  against.
- Do not include screenshots containing your own data.

CI checks the schema, the id and version, that no domain is navigated outside
`allowedDomains`, that nothing looks like a secret, and that `usesJs` matches
reality. A first-time contributor gets a welcome comment and a maintainer will
walk you through anything that failed.

## Maintenance

Portals change. A plugin failing for several people is marked **degraded** in
the catalogue; a plugin unmaintained and broken for 90 days is **archived** and
no longer offered for installation. Listing yourself in `maintainers` means you
are willing to be pinged when it breaks — it is the single most useful thing you
can do for this project after writing the plugin itself.

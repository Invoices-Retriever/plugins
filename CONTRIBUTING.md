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

# Finishing the OVHcloud plugin

The sign-in half of `ovh.json` was checked against the real portal. The billing
table was not — that needs an account. This is the ten minutes of work between
a draft and something users can rely on.

## What is already verified

Read on `auth.eu.ovhcloud.com/signin/`, so you do not have to take it on trust:

| | |
| --- | --- |
| Customer field | `#account` |
| Password field | `#password` |
| Submit button | `#login-submit` ("Se connecter") |
| Manager host | `manager.<region>.ovhcloud.com`, region is `eu`, `ca` or `us` |
| Signed-out behaviour | the manager redirects to `auth.<region>.ovhcloud.com/signin/` |
| Two-factor field | `#totp` — `input[type=number][name=totp]` inside `form#2fa` |
| Two-factor submit | `#totpSubmit` — `button[name="otpMethod"]` |

**Click `#totpSubmit`; do not submit the two-factor form from the keyboard.**
The button carries `name="otpMethod"`, and a submission without it tells OVHcloud
that a form arrived but not which method was chosen. The page comes back
unchanged, which reads as nothing happening at all.

**Do not "fix" the selectors back to `input[name=…]`.** OVH randomises the
`name` attribute of both fields on every page load — `name="6736c45e"` on one
visit, something else on the next. Worse, `input[name='account']` *does* match
an element: the hidden "forgot my password" field. A plugin using it types the
customer number into the wrong form and reports a failed login.

## What is left

Three selectors in `getDocuments`: the invoice rows, the columns inside a row,
and the link to the PDF.

```bash
export PATH="/Applications/Invoices Retriever.app/Contents/MacOS:$PATH"
cd plugins

# 1. Confirm the sign-in half. A browser window opens; sign in, deal with 2FA.
irctl run drafts/ovh.json --section checkAuth --config region=eu

# 2. Walk through the collection one step at a time.
irctl run drafts/ovh.json --config region=eu --config customerID=ab12345-ovh --step
```

`--step` pauses before each step and prints what it is about to do; type `v` and
return to dump the variables it has collected so far. When a step fails it stops
and writes `irctl-failure.png` — a screenshot of exactly what the browser was
looking at.

To find the right selectors, open the billing history in your own browser, right
click a row, Inspect. Prefer, in this order:

1. `[data-testid=…]` or another attribute that reads like it was put there on
   purpose. These survive a redesign.
2. A semantic structure: `table tbody tr`, `td:nth-child(2)`.
3. Generated class names such as `.css-1x2y3z`. These break on the next deploy;
   use one only if there is nothing else, and say so in the pull request.

Then run it **twice**. The second run must download nothing. If it downloads
again, `document.id` is not stable between runs and every user would collect
duplicates every month.

## A better route, once the format allows it

OVH's manager is an Angular application that reads its own public API. The
schema at `https://eu.api.ovh.com/1.0/me.json` documents exactly what is
available, and it is far steadier than any rendered table:

- `GET /me/bill` → `string[]`, the bill ids, filterable with `date.from` and
  `date.to` — which maps directly onto incremental collection.
- `GET /me/bill/{billId}` → `billing.Bill`, with `billId`, `date` (datetime),
  `pdfUrl`, and `priceWithTax` as `{ value, text, currencyCode }`.

The engine can already observe those responses with `extractNetworkResponse`.
What it cannot yet do is iterate a JSON array: `extractAll` walks DOM elements
only, so there is no way to loop over the ids `/me/bill` returns and fetch each
one. That is a gap in the format rather than in this plugin, and it will show up
again for every modern single-page portal. It is tracked in the application
repository; until it closes, scraping the table is the way.

## Before opening a pull request

- Move the file from `drafts/` to `plugins/` and add yourself to `maintainers`.
- Bump `version`.
- Save an anonymised copy of the billing page to `tests/ovh/listing.html` with
  every real number and amount replaced, plus a `tests/ovh/listing.json` saying
  what the selectors should read. CI then catches the next OVH redesign before a
  user does.
- Say which region and account type you tested, and how many invoices it found.

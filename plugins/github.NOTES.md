# Notes on the GitHub plugin

Published as `unverified`: the URLs, the flow and the domain list are real, and
the CSS selectors have not been checked against a live account. That is the
whole of what is left to do, and it is about ten minutes.

## Why there is no API module

There is a GitHub REST billing API, and it is the wrong tool: it exposes
budgets, cost centres, billing usage and usage report exports — consumption
figures, not financial documents. No endpoint returns a receipt or an invoice.

So this plugin drives the browser, and it prints rather than downloads:
**GitHub serves its receipts as HTML only**, with no PDF anywhere. `printPdf` is
the correct step here, not a workaround for a link nobody found.

## Personal account or organisation

Leave `account` empty for a personal account; fill it with the organisation's
name to bill an organisation. The two differ only by a URL prefix, which is why
both `checkAuth` and `getDocuments` open with an `if`:

```
personal      https://github.com/settings/billing/payment_history
organisation  https://github.com/organizations/{account}/settings/billing/payment_history
```

## Signing in

`startAuth` deliberately stops after the login form appears. GitHub very often
follows a password with a device verification — a code sent by e-mail — and no
plugin can or should try to get past that. The user finishes by hand in the
window, which is what interactive sign-in is for.

There is no password in `configSchema` on purpose: with device verification in
the way, storing one would buy nothing.

## What to check, with an account

```bash
export PATH="/Applications/Invoices Retriever.app/Contents/MacOS:$PATH"
irctl run plugins/github.json --step
```

Three selectors, all of them guesses until someone looks:

| | |
| --- | --- |
| The rows | `li:has(a[href*='/receipt/']), tr:has(a[href*='/receipt/'])` — deliberately broad, because GitHub has shipped this page as both a list and a table |
| The date | `time[datetime]` — likely right, GitHub is consistent about this |
| The amount | `.text-right, td:last-child` — the weakest of the three |

`document.id` is the receipt's href, which is stable for the life of the
receipt. Run the collection **twice**: the second run must download nothing.

If it works, change `status` to `active` and say in the pull request whether you
tested a personal account or an organisation — they are different enough that
one working does not prove the other does.

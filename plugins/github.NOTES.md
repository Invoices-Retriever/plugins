# Notes on the GitHub plugin

Selectors, URLs and the PDF endpoint were checked against a live personal
account on 28 August 2026 — 21 payments over 18 months. Still published as
`unverified` because no full collection run has been executed end to end, and
because the organisation path could not be exercised: none of the organisations
available for testing has ever been billed.

## Why there is no API module

There is a GitHub REST billing API, and it is the wrong tool: it exposes
budgets, cost centres, billing usage and usage report exports — consumption
figures, not financial documents. No endpoint returns a receipt or an invoice.

## The receipts are PDFs, and this plugin downloads them

An earlier version of this file claimed GitHub serves receipts as HTML only, and
used `printPdf`. That was wrong. Every row of the payment history carries two
links, and the second one is a real PDF:

```
/account/receipt/ch_3U6a…         HTML rendering
/account/receipt/ch_3U6a….pdf     Content-Type: application/pdf
```

So the plugin walks the history and downloads, which is both faster and more
faithful than printing a page. The href is read from the row rather than rebuilt
from an identifier: personal accounts and organisations differ by URL prefix,
and reading the link means neither case has to be special-cased.

## Personal account or organisation

Leave `account` empty for a personal account; fill it with the organisation's
name to bill an organisation. The two differ only by a URL prefix, which is why
both `checkAuth` and `getDocuments` open with an `if`:

```
personal      https://github.com/account/billing/history
organisation  https://github.com/organizations/{account}/billing/history
```

Both were confirmed by reading the links GitHub itself puts in the billing
sidebar. The paths this file used to carry — `/settings/billing/payment_history`
— do not exist.

## Signing in

`configSchema` asks for username, password and, optionally, a TOTP secret;
`autofill` is `true`, so the engine fills them and answers the two-factor prompt
on its own.

The last step of `startAuth` is what makes that safe to attempt: it waits up to
two minutes for the account-menu button to appear. GitHub frequently follows a
correct password with a device verification — a code sent by e-mail — or asks
for a passkey, and no plugin can or should try to get past that. Whatever GitHub
puts in the way, the user finishes it by hand in the window and the run carries
on. That is also the answer for anyone whose second factor is a passkey or an
SMS: leave `mfa` empty, the flow still works, it just needs a pair of hands once
per session.

## What the rows look like

```
.payment-history li.Box-row
  .date      2026-08-20               already ISO, no locale parsing needed
  .id code   0XHZNSTH                 short reference, the tail of the charge id
  .method    MasterCard ending in 2981
  .amount    $4.00
  .status    Success                  plus a duplicate hidden for screen readers
  .receipt a[href$='.pdf']
```

Two consequences worth keeping in mind if you touch the extraction:

- The rows are filtered with `:has(.receipt a[href$='.pdf'])` rather than by
  reading `.status`. That cell contains `Success` **and** a screen-reader-only
  `Succeeded`, separated by a newline — text that breaks anything expecting one
  word, and that has no business being interpolated anywhere.
- Every text field goes through `regex`, which trims and pins the shape at once:
  a date that stops looking like `\d{4}-\d{2}-\d{2}` fails loudly instead of
  arriving mangled at the extractor.

`document.id` is the short reference from the `.id` cell — the tail of the
Stripe charge id, unique per payment and stable for the life of the receipt.
Run the collection **twice**: the second run must download nothing.

## What is left to check, with an account

```bash
export PATH="/Applications/Invoices Retriever.app/Contents/MacOS:$PATH"
irctl run plugins/github.json --step
```

- A full run on a personal account, then a second one to prove deduplication.
- An organisation that actually has payments. The markup is presumed identical
  — same Rails view — but presumed is not checked.
- The `Invoice` column. It holds an `<invoice-download>` element that stayed on
  *Loading* on a card-paid account; it most likely concerns accounts billed on
  invoice, and nothing is done with it today.
- Sign-in with a wrong password, to confirm the run fails cleanly rather than
  hanging on the two-minute wait.

If it works, change `status` to `active` and say in the pull request whether you
tested a personal account or an organisation — they are different enough that
one working does not prove the other does.

## Known limits

- GitHub keeps a sliding window of payment history: 18 months on the account
  seen here. Older receipts are simply not listed any more.
- The document is a *receipt*, not an EU-style invoice: it carries no
  intra-community VAT number, only the line `VAT/GST paid directly by GitHub,
  where applicable`. Hence `"type": "receipt"`.

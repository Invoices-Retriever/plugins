# Notes on the OVHcloud plugin

Everything here was read off the live portal or off OVHcloud's own published
sources, so a future maintainer does not have to rediscover it — and does not
have to take any of it on trust.

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
| After two-factor | an OVH Telecom customer lands on `www.ovhtelecom.fr`, hence that domain |
| Remember the account | `#remember_account`, ticked before submitting |
| Billing page | rendered inside an `iframe`; the shell document contains no table |

**Do not navigate to the login page if you are already on it.** `checkAuth`
gets redirected there with a callback that returns to the manager; navigating
afresh discards it, and the sign-in ends on whatever the account's default
destination happens to be. For an OVH Telecom customer that is
`www.ovhtelecom.fr`, which the sandbox then blocks — reported as "the two-factor
screen does not click Validate", because the click did work and the navigation
after it did not.

**Click `#totpSubmit`; do not submit the two-factor form from the keyboard.**
The button carries `name="otpMethod"`, and a submission without it tells OVHcloud
that a form arrived but not which method was chosen. The page comes back
unchanged, which reads as nothing happening at all.

**Do not "fix" the selectors back to `input[name=…]`.** OVH randomises the
`name` attribute of both fields on every page load — `name="6736c45e"` on one
visit, something else on the next. Worse, `input[name='account']` *does* match
an element: the hidden "forgot my password" field. A plugin using it types the
customer number into the wrong form and reports a failed login.

## How the collection works

`getDocuments` does **not** read the billing table. It calls OVHcloud's own
API v6, the same one the manager's Angular application calls to draw that table:

```
GET /engine/apiv6/me/bill?date.from=…   → ["FR12345678", …]
GET /engine/apiv6/me/bill/{billId}      → { billId, date, pdfUrl, priceWithTax }
```

The base path is relative to the manager origin — `/engine/apiv6` on
`manager.<region>.ovhcloud.com` — and the call carries nothing but the session
cookies the sign-in already established. There is no API key, no consumer key,
and no second set of credentials to ask the user for. The full schema is at
`https://eu.api.ovh.com/1.0/me.json`.

This is why the first step navigates to the billing page before calling
anything: `apiRequest` issues the call *from the page the browser is on*, so it
inherits that page's session and stays inside the same `allowedDomains` sandbox
as everything else.

`date.from` is filled from `{{cutoff.date}}`, the last successful run, so the
second collection of the month asks for a short list rather than filtering a
long one.

### Statuses that mean "sign in again"

The manager's own client treats `401`, `403` with `This session is invalid`,
and `471` ("low order session" — real but too weak for this call) as reasons to
send the user back to the login page. The engine does the same: those three
statuses raise an authentication error, so the app offers **Sign in** instead of
showing an HTTP code the user can do nothing with.

## What is left to verify

The sign-in half is confirmed against the live portal. The API half is written
from OVHcloud's published schema and its manager's source, and still needs one
run against a real account with invoices:

```bash
export PATH="/Applications/Invoices Retriever.app/Contents/MacOS:$PATH"
cd plugins

# A browser window opens; sign in and deal with 2FA.
irctl run plugins/ovh.json --section checkAuth --config region=eu

# Then the whole collection, one step at a time.
irctl run plugins/ovh.json --config region=eu --config customerID=ab12345-ovh --step
```

`--step` pauses before each step and prints what it is about to do; type `v` and
return to dump the variables collected so far — which is how you check that
`billIds` really came back as a list. When a step fails it stops and writes
`irctl-failure.png`.

Then run it **twice**. The second run must download nothing. `document.id` is
`billId`, which OVHcloud does not recycle, so it should not — but that is the
check that catches a duplicate-every-month bug before a user finds it.

If the API route ever stops working, the table is still there:
`table.oui-datagrid tbody tr` inside the billing iframe, matched 11 rows on a
real account. Scraping it is the fallback, not the plan.

## Before opening a pull request

- Bump `version` and add yourself to `maintainers`.
- Say which region and account type you tested, and how many invoices it found.
- If you changed the API calls, quote the response shape you actually saw. The
  schema is generous about what a field *may* contain; only a real answer says
  what it *does*.

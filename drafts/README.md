# Drafts

Plugins in this folder are **structurally valid but unverified**. They have not
been run against a live account, so their CSS selectors are informed guesses:
the URLs, the domain lists and the shape of each flow are real, the selectors
are where they will break.

They are validated by CI like anything else, and they are **not** included in
the signed index, so no user installs one by accident.

## Why bother checking

`ovh.json`, now in `plugins/`, is the worked example. Its sign-in half was
checked against the real portal, and doing so found a trap a plausible-looking
guess walks straight into: OVH randomises the `name` attribute of its login
fields, so `input[name='account']` matches the hidden "forgot my password" field
rather than the customer number. A plugin using it reports a failed login and
never says why.

Ten minutes with a real account is worth more than any amount of careful
guessing.

## Adopting one

You need an account with the supplier. Then:

```bash
export PATH="/Applications/Invoices Retriever.app/Contents/MacOS:$PATH"

irctl run drafts/ovh.json --section checkAuth --step
# → sign in by hand in the window that opens, then confirm the selector matches

irctl run drafts/ovh.json --config customerID=ab12345 --step
# → walk through getDocuments one step at a time
```

When a step fails, the run stops and writes `irctl-failure.png`. Open the
browser's inspector on that page, find a selector that works, and fix the JSON.
Prefer selectors that survive a redesign: `[data-testid=…]`, `[name=…]`,
`text=Télécharger`, rather than a chain of generated class names.

Then run it twice. The second run must download nothing — if it does, the
`document.id` is not stable and users would collect duplicates every month.

## Promoting it

Move the file to `plugins/`, add yourself to `maintainers`, and open a pull
request saying which account type you tested against and how many invoices it
found. If you can, add an anonymised capture under `tests/<id>/` so CI catches
the next redesign before a user does.

That last step is what turns a draft into something the project can promise.

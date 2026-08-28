# Notes on the OVHcloud API module

This is the sibling of `ovh.json`. Both collect the same invoices; they differ
in how they get in, and the trade-off is worth stating plainly:

| | `ovh.json` | `ovh-api.json` |
| --- | --- | --- |
| Credentials | customer id, password, 2FA secret | three API keys |
| Setup | none | create the keys once |
| Browser | yes, and a sign-in to pass | never |
| Can run unattended | no — a session expires | yes |
| Breaks when | OVHcloud redesigns the sign-in | the keys are revoked |

Neither is the successor of the other. Someone who collects once a quarter will
prefer the portal; someone who schedules it wants the keys.

## Creating the keys

Use the link the plugin carries, which pre-fills the form with the single right
it needs:

<https://www.ovh.com/auth/api/createToken?GET=/me/bill*>

Set the **validity to Unlimited**. Any other value makes collection stop on the
day the key expires, with no warning beforehand — the app can only report that
the credentials were refused, the morning after.

`GET /me/bill*` covers both calls the plugin makes: the list, and each bill.
Grant nothing else. `checkAuth` deliberately probes `/me/bill` restricted to
today rather than `/me`, so that one right is genuinely all that is needed — an
empty list is still a 200, and therefore still proof the keys work.

## How it authenticates

OVHcloud signs each request rather than using a bearer token:

```
X-Ovh-Signature = "$1$" + sha1_hex(
    applicationSecret + "+" + consumerKey + "+" + METHOD + "+" +
    full URL + "+" + body + "+" + timestamp)
```

That is written out in the plugin's `api.auth.signature` block as an ordered
list of parts, a separator and an algorithm — not as code. The implementation is
checked in the application's test suite against signatures computed
independently (python `hashlib`), so a bug in the engine cannot agree with a bug
in the test.

The timestamp is **OVHcloud's**, not this machine's: `/auth/time` is read once
per run and the local clock advances it afterwards. A user whose Mac is a minute
off would otherwise be rejected for no visible reason.

## Regions, and why allowedDomains covers all of ovh.com

`baseUrl` is the European endpoint. Canada is `https://ca.api.ovh.com/1.0` and
the United States `https://api.us.ovhcloud.com/1.0`. Making it a config option
is a small change to `baseUrl`, worth doing the first time somebody outside
Europe asks.

The sandbox lists OVHcloud's domains with wildcards — `ovh.com`, `*.ovh.com`,
and the same for `ovhcloud.com` and `ovh.net` — rather than the three or four
hosts the plugin is known to touch. That is deliberate. `pdfUrl` points at
`www.ovh.com`, the API at `eu.api.ovh.com`, and neither is documented as stable;
enumerating them means a user discovers the next one as a failed collection.
Covering the supplier's own domains costs nothing in safety — those are the
hosts this plugin is *for* — and removes a whole class of breakage.

What it deliberately does not do is allow every domain. The keys are injected
into whatever host a step names, so an unrestricted plugin could send them
anywhere; the sandbox is the one control that makes a plugin from a catalogue
safe to run at all.

## Still to verify

Written from OVHcloud's published API and signature scheme, and the signature is
covered by tests, but the whole has not yet run against a real account:

```bash
irctl run plugins/ovh-api.json --step
```

Run it twice. The second run must download nothing — `document.id` is `billId`,
which OVHcloud does not recycle.

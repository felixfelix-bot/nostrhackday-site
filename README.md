# Nostrhackday

**Let's Build on Nostr** — Tue **29.09.2026**, 10:00–18:30, c-base, Rungestraße 20, 10179 Berlin.
Two days before bitcoin++ Berlin (payments edition, 01.10.–03.10.2026) — https://btcpp.dev/

## Live

- https://nostrhackday.orangesync.tech/
- https://felixfelix-bot.github.io/nostrhackday-site/
- https://npub15xyvqavhg8sw9f2uqnnxx5e7myl9d54lw697tp6aemf0n5p8sx0qmusn8g.nsite.lol/

## RSVP = in-browser proof of work

One page, no server, no accounts, no email. The page mines a nostr keypair whose
npub carries a **leet prefix** (3 chars, `n05…`) plus a **low-entropy "raindrop"
window** (9 chars, ≤6 distinct) — both readable off the screen — then signs a
kind-1337 event and publishes it to public relays. Accepted RSVPs raise the
difficulty ladder.

The miner, the verifier, the org collection script and the tests all share one
module: `js/pow-ratchet.js`.

## Publishing as an nsite

```bash
export PATH="$HOME/.deno/bin:$HOME/.local/bin:$PATH"
./deploy-nsite.sh
```

`nsyte deploy` reads `.nsite/config.json` and signs with the key at
`~/.hermes/state/nostrhackday-nsec.key` (not in this repo).

After any republish, restart the serving gateway — it caches manifests and will
otherwise keep serving the previous copy:

```bash
ssh debian@23.182.128.51 'docker restart tollgate-nsite-gateway'
```

## GitHub Pages

Push to `main`; the workflow in `.github/workflows/` builds and deploys.

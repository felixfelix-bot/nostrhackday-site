# vendored browser modules

The RSVP page (`signup.html`) is a static page with **no build step** and **no CDN
at runtime** — it must work from plain static hosting (GitHub Pages, an nsite
gateway, or `python3 -m http.server` on a laptop with no internet above it).
Everything it imports is therefore checked into this directory.

These are esm.sh's own pre-bundled outputs (`.bundle.mjs`), so this is a *mirror*,
not a bundler round-trip: the bytes we serve are the bytes esm.sh compiled.
Only two mechanical rewrites were applied (see `fixup_vendor.py`):

1. absolute esm.sh specifiers (`/foo@1/es2022/bar.mjs`) → relative paths inside
   this tree;
2. the same for bare sibling specifiers inside esm.sh's `/node/*` shims, which
   are not resolvable by browsers as-is.

## versions

| package | version | source |
| --- | --- | --- |
| `applesauce-core` | 6.2.0 | https://esm.sh/applesauce-core@6.2.0/es2022/applesauce-core.bundle.mjs |
| `applesauce-relay` | 6.2.1 | https://esm.sh/applesauce-relay@6.2.1/es2022/applesauce-relay.bundle.mjs |
| `nostr-tools` | 2.23.3 | `…/es2022/pure.bundle.mjs`, `…/es2022/nip19.bundle.mjs` |
| `@noble/curves` | 2.0.1 | transitive (schnorr / secp256k1) |
| `@noble/hashes` | 2.0.1, 2.4.0, unpinned 2.x stub | transitive (sha256) |

Who uses what:

* `js/pow-ratchet.js` → `nostr-tools/pure` (keygen, schnorr verify, event hashing),
  `nostr-tools/nip19` (bech32 npub/nsec), `@noble/hashes/sha2` (its own NIP-01 id
  computation).
* `js/signup.js` → `applesauce-core` (`EventStore` + reactive `store.timeline`),
  `applesauce-relay` (`RelayPool` subscriptions and publishing).
* `scripts/collect-rsvps.mjs` → the same applesauce pair, in Node (Node ≥ 22 has a
  global `WebSocket`, so no polyfill is needed).

## sha256

```
4b9d6693155b23f92c847190758e52c59fcb6323576526603896b2be6ef647fa  applesauce-core@6.2.0/es2022/applesauce-core.bundle.mjs
6ad063aa998aac10fafcddc38adc95151855edc03352ed17509fb9ec6f5bbabd  applesauce-relay@6.2.1/es2022/applesauce-relay.bundle.mjs
b8911681c866acc83328eedca6638ad8cf918b1ab5740bd7604c135423fcdf60  @noble/curves@2.0.1/es2022/abstract/curve.mjs
1e367fe7b01effb22dcd599fa7bee1ffc526c4ee5d8f26e73b146d226f45307b  @noble/curves@2.0.1/es2022/abstract/hash-to-curve.mjs
e3f4433b4fd952fc1bc1aef84617fec7e4198194de745f0db3ca37fb051ad6ca  @noble/curves@2.0.1/es2022/abstract/modular.mjs
6f5a6c9ad97e6452d15b23c71233916fabf6cb94568e3f2116a615d36d29e760  @noble/curves@2.0.1/es2022/abstract/weierstrass.mjs
c6018863abd0b2492c5e9e40259f3279610e9ba03d30bf71485e91ec8f6fb1e2  @noble/curves@2.0.1/es2022/utils.mjs
5338eb1d436cfc443c6daac25a87261d6c9b4fdc3ebe15ce325ad67ee2bd492a  @noble/hashes@2.0.1/es2022/hmac.mjs
9bb9822cc8fdaa2920bee40d6144674497336ff87479db53f7a968409efdcd3a  @noble/hashes@2.0.1/es2022/_md.mjs
8a759b7294226d3d0a3fa24bc733ffac8ad7a703479c6ee2985b39762939d603  @noble/hashes@2.0.1/es2022/_u64.mjs
791b6e5af54b7f310e560257a19c8cd7fc267772ef3ec2082563c5f245231fb7  @noble/hashes@2.0.1/es2022/utils.mjs
26d117e5e8e36425981569d2782b5e98e66dbbd89b9abc0f40e0ffe459b9739d  @noble/hashes@_2.2.0/sha2.mjs
3bdfa6d2db5a2e553a042603bfdcd3e29e612a967b32d960c03c16baf052c3aa  @noble/hashes@2.4.0/es2022/_md.mjs
200da33336e05ec6a26911193cefcd2f1e4b8f3617bca4e57d9cc471fd164b27  @noble/hashes@2.4.0/es2022/sha2.mjs
e172bd53b9f18f6d50d7067f9ce0d1da3e8e4cbbccfef74398f2bebc041985de  @noble/hashes@2.4.0/es2022/_u64.mjs
b47dc5dcf9233275be882007cdae87e72864d36a6590ae95987fc969883dcc29  @noble/hashes@2.4.0/es2022/utils.mjs
b7862dbfba8bbbca956f19e4e08280b529e4b27468779775a9093aef8c92dc1d  node/async_hooks.mjs
1283706bbf95f2c545f1623df66cfcc309ae2902ad266c7f96bd55dfce019e18  node/events.mjs
981e47d1d8121380c2db5704163f22aa03804b4d147dd44a99a6582dfeddd548  node/process.mjs
c66ff4b406bad449bfb2ced355f15badf16f4d9e035d2d300e33b5aeee64e3be  node/tty.mjs
7036323aa7ddbe93c19b016e2def0cd091e36fd676fc8f68701857a89a78eb99  nostr-tools@2.23.3/es2022/nip19.bundle.mjs
1ba59e346e213e2d8ad5a8a0bec1dac5edc544f3becedca10e4acf46902fd36f  nostr-tools@2.23.3/es2022/pure.bundle.mjs
```

Verify with:

```sh
cd vendor && sha256sum $(find esm -type f | sort) | sed 's#  esm/#  #'
```

`@noble/hashes@_2.2.0/sha2.mjs` is esm.sh's re-export stub for the unpinned
range `@noble/hashes@^2.2.0` that `applesauce-relay` asks for (the `^` is
rewritten to `_` because `^` is not URL-safe). It forwards to the resolved
2.4.0 build, which is vendored alongside it.

## regenerating

```sh
# 1. mirror the esm.sh module graph into a fresh tree
python3 vendor/vendor_esm.py /some/out/dir \
  "/nostr-tools@2.23.3/es2022/pure.bundle.mjs" \
  "/nostr-tools@2.23.3/es2022/nip19.bundle.mjs" \
  "/applesauce-core@6.2.0/es2022/applesauce-core.bundle.mjs" \
  "/applesauce-relay@6.2.1/es2022/applesauce-relay.bundle.mjs"
# 2. make filenames URL-safe + extension-complete and rewrite the specifiers
python3 vendor/fixup_vendor.py /some/out/dir
# 3. diff against vendor/esm/, then update this file's hashes
```

Both scripts are plain Python 3 (stdlib only) and are checked in next to the tree
so the mirror is reproducible without any package manager.

## licences

`nostr-tools` (MIT), `applesauce-*` (MIT), `@noble/curves` and `@noble/hashes`
(MIT). The vendored files keep their upstream headers; no modifications beyond
the import-specifier rewrites described above.

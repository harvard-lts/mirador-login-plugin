# Demo harness

`npm run serve` starts Vite on <http://localhost:9000> with this directory as the
root, loading the plugin from `../src` — so changes hot-reload with no build,
pack, or install step.

The port is pinned (`strictPort`), so the server refuses to start if something
else holds 9000 rather than quietly moving to 9001. Other Mirador plugin demos in
this org default to the same port; stop those first.

`index.html` is a landing page linking to one page per demo. Each demo is a
standalone HTML entry plus its own config module, so switching between them is a
click rather than an edit:

| Page | Entry | Manifest |
| --- | --- | --- |
| `public.html` | `publicDemoEntry.js` | public Houghton manifest — no auth services, plugin idle |
| `restricted.html` | `restrictedDemoEntry.js` | `local-restricted.json` — local kiosk auth flow |

To add another demo, drop in `<name>.html` + `<name>DemoEntry.js` and link it
from `index.html`; Vite's dev server picks up HTML entries automatically.

## Local restricted image (kiosk auth)

`local-restricted.json` is a hand-written IIIF 3 manifest whose only image
service points at a **locally running** `mps-asset-delivery-images`. It exists so
the IIIF Auth kiosk flow can be exercised without NRS, without mps-viewer, and
without coordinating an override on a shared environment.

### Prerequisites

| Service | Port | Needs |
| --- | --- | --- |
| `mps-asset-delivery-images` | 23002 | `ENV=development`, `OVERRIDE_IP_ENABLED=true`, `OVERRIDE_IP` set, `LIBRARY_DEVICE_API_URL` → local mpsinlib |
| `mpsinlib` | 23087 | must answer `result: true` for that `OVERRIDE_IP` |
| `mps-url-redirects` | 23016 | only for the **success** path, not for the blocked-popup path |
| `mps-login` | 23000 | only for the **success** path |

`KIOSK_PREFLIGHT_BASE_URL` must be `http://localhost:23016`, not
`host.docker.internal` — it becomes the kiosk `@id` in the info.json, so it is
resolved by the *browser*, not from inside a container.

### Verify the fixture before debugging the plugin

```bash
curl -s http://localhost:23087/api/inlib/<your OVERRIDE_IP>
# -> {"result":true,"status":200}

curl -si http://localhost:23002/assets/images/drs:400338711/info.json \
  | grep -i x-mps-client-ip

curl -s http://localhost:23002/assets/images/drs:400338711/info.json \
  | jq '.service | map(.profile)'
# -> [".../login", ".../kiosk", ".../external"]
```

The response must be **401** (that is what makes Mirador treat the info response
as degraded and start the auth workflow) and `X-MPS-Client-IP` must echo your
override IP. If `kiosk` is missing from the service list, fix that before looking
at plugin code — the fixture, not the plugin, is broken.

### Reproducing the blocked-pop-up crash

> **This is expected behavior at this commit.** The restricted demo reproduces
> the LTSMPS-1048 crash on purpose, so the fix can be demonstrated against it.
> It is not a bug in the fixture.

The kiosk pop-up is opened with no user gesture behind it, so browsers block it
under their default pop-up policy. `window.open` then returns `null`, and
Mirador's `NewBrowserWindow` cleanup calls `newWindow.close()` unguarded — the
window dies with a red `TypeError: Cannot read properties of null (reading
'close')` error boundary, taking the image and top bar down with it.

To block pop-ups deliberately rather than relying on the browser default:

- **Chrome** — click the icon left of the URL → **Site settings** → **Pop-ups and
  redirects** → **Block**. Or add `http://localhost:9000` under "Not allowed" at
  `chrome://settings/content/popups`.
- **Safari** — Settings → Websites → Pop-up Windows → set the host to **Block**.
- **Firefox** — Settings → Privacy & Security → Permissions → **Block pop-up
  windows** → Exceptions.

Then load the **Restricted Demo** from the landing page and hard-reload.

Confirm the block actually applied by looking for the blocked-pop-up icon in the
address bar. A run where the pop-up simply opened proves nothing — you will see
the success path (window opens and closes, image goes full resolution) instead,
which requires `mps-url-redirects` and `mps-login` to be running too.

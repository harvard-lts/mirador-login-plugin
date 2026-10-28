# mirador-login-plugin

[![Node Unit Tests](https://github.com/harvard-lts/mirador-login-plugin/actions/workflows/coverage-node.yml/badge.svg)](https://github.com/harvard-lts/mirador-login-plugin/actions/workflows/coverage-node.yml)

<a href="https://github.com/harvard-lts/mirador-login-plugin/actions/workflows/coverage-node.yml"><img src="https://github.com/harvard-lts/mirador-login-plugin/raw/badges/test-coverage/coverage.svg"></a>

A Mirador 4 plugin that repairs the visible canvas image after a login — or a logout — that Mirador core failed to refresh on its own.

## What it does, and why it is not a blanket refresh

Stock Mirador refreshes images after auth from exactly one trigger —
`takeEvery(RECEIVE_ACCESS_TOKEN, refetchInfoResponses)` — and that refetch only
re-requests info responses advertising a token service whose id matches the token
action. Two gaps follow, both observed live against HarvardKey:

- **A login round-trip that never produces a token action refreshes nothing.**
  Core takes `openWindow = window.open` and never watches the handle, so it has
  no popup-close detection at all. Symptom: the *first* login of a session does
  not refresh, while later ones do.
- **When more than one auth service is in play** (e.g. an interactive login
  service plus an IIIF Auth `external` block), core's token-service-scoped filter
  can miss the visible image. Symptom: the auth/logout bar updates but the image
  stays degraded.

An earlier version of this plugin (`< 2.1.0`) papered over these by refreshing on
every auth `postMessage`, which duplicated core's own refetch and fired a second,
redundant request on every healthy login. That double-refresh is why it was
removed from the viewer builds.

`2.1.x` replaces that with **verify-then-repair**:

1. Notice a login completed — an access token succeeded, *or* the auth popup closed.
2. Note which visible image services hold a **degraded** info response. This is
   core's own flag: the `infoResponses` reducer stores `degraded: true` for
   `RECEIVE_DEGRADED_INFO_RESPONSE` (the 401 path, i.e. low-res tiles) and
   `degraded: false` for a normal 200. If nothing is degraded there is nothing to
   fix, so stop here without arming anything.
3. Wait `REPAIR_GRACE_MS` (1.5s) for core to act.
4. Re-request **only** the services that are *both* still degraded *and*
   untouched by core (identity comparison — every info-response action replaces
   the entry, so an unchanged reference proves core ignored it).

On a healthy silent sign-in (an already-signed-in page load) every entry has
changed by step 4, so this plugin dispatches nothing and core's single request
stands, and the extra 1.5s applies only to the repair path that previously never
recovered at all. An interactive login is the one deliberate exception — see
[Rebuilding the image after an interactive login](#rebuilding-the-image-after-an-interactive-login-230).

> **2.1.0 is broken — use 2.1.1 or later.** 2.1.0 omitted the `degraded` test in
> steps 2 and 4 and asked only "did core act?". For a user who is *already*
> signed in, the first info.json fetch returns full resolution, so core correctly
> does nothing — and 2.1.0 read that silence as failure, reloading a
> perfectly good image 1.5s after every single page load.

## Logout (2.2.0)

Logout is the mirror image of the above and needs the opposite treatment. After a
logout the cached info responses are the **full-resolution** ones, so nothing is
`degraded` and verify-then-repair would correctly refuse to act — yet those are
exactly the responses that must be re-requested, so they come back degraded.
Core's `refetchInfoResponsesOnLogout` does not cover it either: it is scoped to
the single `tokenServiceId` that fired, while MPS advertises two auth services
(`login` + `external`). Symptom: the auth bar flips back to "Sign in" but the
image keeps rendering full-resolution tiles until the page is reloaded.

So `2.2.0` adds a second, unfiltered path:

1. The `window.open` interception now also tracks urls containing `logout`, and
   records which kind of popup it was.
2. A `message` listener accepts `{ type: 'mps-logout-complete' }` — posted by
   mps-login's `logout-close` view — but **only** from the origin the logout popup
   was opened at. Never `*`, never a login popup's own messages.
3. On a match, every visible image service is re-requested with no `degraded`
   filter and no grace period: mps-login clears its cookies *before* rendering
   `logout-close`, so by the time the message arrives the refetch correctly 401s.
4. If the logout popup closes without a message — dismissed by hand, or a blocked
   `postMessage` — the focus handler refreshes anyway. The shared
   `REFRESH_DEBOUNCE_MS` guard keeps that from doubling up.

> The `postMessage` handshake requires the logout response to carry
> `Cross-Origin-Opener-Policy: unsafe-none`. Helmet's default `same-origin` nulls
> out `window.opener` in the popup whenever the viewer and login origins differ,
> which would also break the `popup.closed` fallback. mps-login sets this on the
> `logout-close` response only.

## Rebuilding the image after an interactive login (2.3.0)

After a popup login, core *does* refresh the info response, yet the image can
stay blurry while the auth bar already says "Logout" (LTSVIEWER-507, reproduced
in Chrome with the cache disabled):

1. While logged out, OpenSeadragon requests the full-size tiles. The image
   delivery service redirects each one to login, the browser rejects the
   redirect (Chrome blocks it outright with `ERR_BLOCKED_BY_ORB`), and
   OpenSeadragon 5 marks every failed tile `exists = false` — it never requests
   that tile again for the life of the tiled image.
2. After login, core's `refetchInfoResponses` replaces the degraded info response
   with a full-access one **in place**, without a `REQUEST_INFO_RESPONSE`. Mirador
   keeps the mounted tiled image, so no tile is re-requested.
3. Verify-then-repair never even armed. Core sets the access token's `success`
   only when that same refetch lands, so the access-token trigger fires in the
   render where the image is already undegraded, and step 2 finds nothing.

So `2.3.0` adds a rebuild path that does not depend on that ordering:

1. When the `window.open` interception sees a **login or kiosk popup**, it
   records which visible services are degraded at that moment — their tiles were
   requested while logged out.
2. As soon as core flips one of them to full access in place (`degraded: false`,
   not in flight), it is re-requested. `requestInfoResponse` resets the entry,
   Mirador unmounts and rebuilds the tiled image, and the tiles load with the new
   cookie.
3. A recorded service that goes through a request first (core's, or the
   verify-then-repair path's) or is removed is dropped instead: its tiled image is
   rebuilt anyway, so nothing is requested twice. Logout clears the record.

This deliberately costs one extra info.json request per degraded image, and only
after a popup. An already-signed-in page load goes through the same
degraded-then-refreshed sequence via the silent `external` token probe, but its
tiles were requested with a valid cookie and loaded fine, so it is left alone —
the 2.1.0 "reload a good image on every load" regression stays fixed. Each image
is rebuilt at most once per popup, and a blocked popup does not count.

> This is what lets mps-login send `Cross-Origin-Opener-Policy: unsafe-none` on
> its `/login` routes. With Helmet's default `same-origin`, Chrome severs the
> popup, core reads `popup.closed` as true immediately and requests the token
> before the login finishes; with `unsafe-none` core gets the token, and this
> rebuild is what makes the image follow.

## Compatibility

This plugin is **Mirador 4-compatible** (React 18/19, MUI 7). It is **not** backwards compatible with Mirador 3 — the upgrade contains breaking changes (top-level `mirador` imports, function/hook components, MUI 7 + Emotion).

Versioning convention:

- **Mirador 4** releases are tagged `2.x`.
- **Mirador 3** releases are tagged `0.x` / `1.x` — pin one of these if you still need Mirador 3.

## Requirements

- [NVM](https://github.com/nvm-sh/nvm)

## Setup

1. Run `nvm use` to ensure your version of matches that in the `.nvmrc` file
2. Run `npm i` to install dependencies
3. Use one of the [NPM scripts](#npm-scripts) to perform the actions described below.

## NPM scripts

The following are some useful scripts can be ran using `npm run <script>`. A full list can be seen in [package.json](./package.json)

| Script  | Description                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `clean` | Removes the `dist` directories                                                                                             |
| `build` | Builds the source files into the `./dist` directory                                                                        |
| `serve` | Runs a local web server where the plugin can be viewed in a vanilla Mirador instance (helpful for testing and development) |
| `test`  | Runs the automated test suites  

## Installing in Mirador

The `mirador-login-plugin` requires an instance of Mirador 4. Visit the [Mirador wiki](https://github.com/ProjectMirador/mirador/wiki) and the [Creating a Mirador 4 Plugin](https://github.com/ProjectMirador/mirador/wiki/Creating-a-Mirador-4-Plugin) page for information about installing and developing plugins.

Package you will need to install:

```bash
npm i @harvard-lts/mirador-login-plugin
```

## Configuration

Configurations for this plugin are injected when Mirador is initialized under the `miradorReplaceLoginPlugin` key. See the [demo entry](./demo/demoEntry.js) for an example of importing and configuring `mirador-analytics-plugin`.

```js
...
  id: 'mirador',
  miradorReplaceLoginPlugin: {
    ...
  }
...
```

## Contribute
Mirador's development, design, and maintenance is driven by community needs and ongoing feedback and discussion. Join us at our regularly scheduled community calls, on [IIIF slack #mirador](http://bit.ly/iiif-slack), or the [mirador-tech](https://groups.google.com/forum/#!forum/mirador-tech) and [iiif-discuss](https://groups.google.com/forum/#!forum/iiif-discuss) mailing lists. To suggest features, report bugs, and clarify usage, please submit a GitHub issue.

[build-badge]: https://img.shields.io/travis/projectmirador/mirador-share-plugin/master.png?style=flat-square
[build]: https://travis-ci.org/projectmirador/mirador-share-plugin

[npm-badge]: https://img.shields.io/npm/v/mirador-share-plugin.png?style=flat-square
[npm]: https://www.npmjs.org/package/mirador-share-plugin

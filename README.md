# mirador-login-plugin

[![Node Unit Tests](https://github.com/harvard-lts/mirador-login-plugin/actions/workflows/coverage-node.yml/badge.svg)](https://github.com/harvard-lts/mirador-login-plugin/actions/workflows/coverage-node.yml)

<a href="https://github.com/harvard-lts/mirador-login-plugin/actions/workflows/coverage-node.yml"><img src="https://github.com/harvard-lts/mirador-login-plugin/raw/badges/test-coverage/coverage.svg"></a>

A Mirador 4 plugin that repairs the visible canvas image after a login that Mirador core failed to refresh on its own.

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

On a healthy login every entry has changed by step 4, so this plugin dispatches
nothing and core's single request stands. It cannot double-refresh by
construction, and the extra 1.5s applies only to the repair path that previously
never recovered at all.

> **2.1.0 is broken — use 2.1.1 or later.** 2.1.0 omitted the `degraded` test in
> steps 2 and 4 and asked only "did core act?". For a user who is *already*
> signed in, the first info.json fetch returns full resolution, so core correctly
> does nothing — and 2.1.0 read that silence as failure, reloading a
> perfectly good image 1.5s after every single page load.

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

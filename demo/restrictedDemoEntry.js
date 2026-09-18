import Mirador from "mirador";
import Plugin from "../src/index";

// Exercises the IIIF Auth kiosk flow against a locally running
// mps-asset-delivery-images. See demo/README.md for the required services and
// env, and for how to reproduce the blocked-pop-up crash.
document.addEventListener("DOMContentLoaded", () => {
  const config = {
    id: "mirador",
    // Must match the info.json `service` array order that
    // mps-asset-delivery-images emits ([login, kiosk, external]). Mirador picks
    // an auth service twice, by two different rules: `doAuthWorkflow` walks the
    // info.json array, `selectCurrentAuthServices` walks THIS array. If they
    // disagree the kiosk popup is never attempted and the auth bar renders
    // nothing at all — which looks like a broken fixture rather than the bug
    // under test. See LTSMPS-1048.
    auth: {
      serviceProfiles: [
        { profile: "http://iiif.io/api/auth/1/kiosk", kiosk: true },
        { profile: "http://iiif.io/api/auth/1/external", external: true },
        { profile: "http://iiif.io/api/auth/1/clickthrough" },
        { profile: "http://iiif.io/api/auth/1/login" },
      ],
    },
    windows: [
      {
        // Derived from the page origin rather than hardcoded, so the fixture
        // still resolves if the dev server is run on another port.
        manifestId: new URL(
          "local-restricted.json",
          window.location.href,
        ).href,
      },
    ],
  };

  const plugins = [...Plugin];

  // Exposed for debugging from the console — the auth state machine is the hard
  // part to reason about from the UI alone. Useful checks:
  //   __DEMO_STORE__.getState().auth                            // which service, what status
  //   __DEMO_STORE__.getState().miradorLoginPluginPopupBlocked   // did a block get recorded
  window.__DEMO_STORE__ = Mirador.viewer(config, plugins).store;
});

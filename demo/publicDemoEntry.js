import Mirador from "mirador";
import Plugin from "../src/index";

// A public manifest: no IIIF Auth services, so nothing triggers the plugin.
// If you point this at a restricted object you also need the `auth.serviceProfiles`
// ordering from restrictedDemoEntry.js, or the auth bar renders nothing at all.
document.addEventListener("DOMContentLoaded", () => {
  const config = {
    id: "mirador",
    windows: [
      {
        manifestId:
          "https://nrs.harvard.edu/URN-3:FHCL.HOUGH:105813588:MANIFEST:3",
      },
    ],
  };

  const plugins = [...Plugin];

  Mirador.viewer(config, plugins);
});

import { useCallback, useEffect, useRef } from 'react';
import {
  getWindowIds,
  getVisibleCanvases,
  selectInfoResponses,
  getAccessTokens,
  getAuth,
  requestInfoResponse,
  MiradorCanvas,
} from 'mirador';
import { popupBlocked as popupBlockedAction } from '../state/popupBlocked';

// How long to wait after a login signal before deciding core failed to refresh.
// Core's own path is `takeEvery(RECEIVE_ACCESS_TOKEN, refetchInfoResponses)`,
// which dispatches synchronously off the token action, so anything it intends to
// do has landed well inside this window.
export const REPAIR_GRACE_MS = 1500;
// Floor between two repairs, so a login that trips both triggers (auth state
// settling *and* the popup closing) can only repair once.
export const REFRESH_DEBOUNCE_MS = 2000;
// Delay after regaining focus before reading `popup.closed` — the popup's state
// is not always updated at the instant focus returns.
export const POPUP_CLOSE_DELAY_MS = 100;
// The message mps-login's `logout-close` view posts to `window.opener` once the
// session is deleted and every MPS cookie has been cleared.
export const LOGOUT_COMPLETE_TYPE = 'mps-logout-complete';

/**
 * Map the image service id of every visible canvas to the first window showing
 * it. A canvas that cannot be wrapped is logged and skipped rather than aborting
 * the whole sweep.
 */
export const windowIdsByImageService = (visibleCanvasesByWindow) => {
  const windowIds = new Map();
  if (!visibleCanvasesByWindow) return windowIds;

  Object.entries(visibleCanvasesByWindow).forEach(([windowId, canvases]) => {
    (canvases || []).forEach((canvas, index) => {
      try {
        new MiradorCanvas(canvas).imageServiceIds.forEach((serviceId) => {
          if (serviceId && !windowIds.has(serviceId)) windowIds.set(serviceId, windowId);
        });
      } catch (error) {
        console.error(`[LoginMonitor] Error processing canvas ${index + 1}:`, error);
      }
    });
  });

  return windowIds;
};

/** Collect the image service id of every visible canvas across every window. */
export const visibleImageServiceIds = (visibleCanvasesByWindow) => [
  ...windowIdsByImageService(visibleCanvasesByWindow).keys(),
];

/**
 * The origin a popup url will land on, for checking `event.origin` against.
 * Relative urls resolve against the viewer's own location. Returns null for a
 * url that cannot be parsed, which the message handler treats as "no match".
 */
export const originOf = (url) => {
  try {
    return new URL(url, window.location.href).origin;
  } catch (error) {
    return null;
  }
};

/**
 * Login Monitor
 *
 * Repairs the one thing stock Mirador gets wrong after a successful login: the
 * visible image is not always re-requested with the new credentials, so the
 * viewer keeps showing degraded tiles even though the auth bar has updated.
 *
 * This is deliberately NOT a blind post-login refresh. An earlier version of
 * this plugin refreshed on every auth postMessage, which duplicated core's own
 * `refetchInfoResponses` and fired a second, redundant request on every healthy
 * login — the reason the plugin was removed from the viewer builds. Instead we
 * *verify, then repair*:
 *
 *   1. Notice a login completed (an access token succeeded, or the auth popup
 *      closed — core has no popup-close detection of its own, which is why the
 *      first login of a HarvardKey session could refresh nothing at all).
 *   2. Note which visible image services are holding a DEGRADED info response
 *      (core's own 401 flag) — if none are, there is nothing to fix, so stop.
 *   3. Wait REPAIR_GRACE_MS for core to do its job.
 *   4. Re-request ONLY the services that are both still degraded and untouched
 *      by core.
 *
 * Because step 2 requires actual evidence of a degraded image and step 4 skips
 * anything core already replaced, the healthy paths issue exactly one request —
 * core's, or none at all — and this plugin issues none.
 *
 * The one exception is an interactive login (a login or kiosk popup): an image
 * core refreshed in place still shows the tiled image built while logged out,
 * whose failed tiles never reload, so it is re-requested once to rebuild it.
 * See the rebuild effect below. An already-signed-in page load never opens a
 * popup and keeps its single request.
 *
 * Logout is the mirror image and needs the opposite treatment. After logout the
 * cached info responses are full-resolution and MUST be re-requested so they come
 * back degraded, so there is nothing to verify first — see `refreshAll`.
 *
 * Renders no UI.
 */
const LoginMonitor = ({
  visibleCanvasesByWindow, infoResponses, authSucceeded, requestInfoResponse,
  auth = undefined, popupBlocked = undefined,
}) => {
  // Keep latest props in a ref so timers and event handlers registered once on
  // mount always read current values.
  const propsRef = useRef({ visibleCanvasesByWindow, infoResponses, requestInfoResponse });
  /**
   * Assigned during render, NOT in an effect. `window.open` is called from
   * core's `NewBrowserWindow` mount effect, and BackgroundPluginArea renders
   * after Workspace — so core's effect runs a full commit before any effect of
   * ours. An effect-updated ref would still hold the previous auth state at the
   * moment the popup is blocked, and the lookup below would find nothing.
   */
  const authRef = useRef(auth);
  const popupBlockedRef = useRef(popupBlocked);
  authRef.current = auth;
  popupBlockedRef.current = popupBlocked;
  const activePopupRef = useRef(null);
  // Visible services that were degraded when a login (or kiosk) popup opened,
  // i.e. whose tiles were requested while logged out. See the rebuild effect.
  const degradedAtLoginRef = useRef(null);
  const lastRepairRef = useRef(0);
  const repairTimerRef = useRef(null);
  const prevAuthSucceededRef = useRef(authSucceeded);

  useEffect(() => {
    propsRef.current = { visibleCanvasesByWindow, infoResponses, requestInfoResponse };
  }, [visibleCanvasesByWindow, infoResponses, requestInfoResponse]);

  /**
   * Dispatch `requestInfoResponse` for the given services. The request resets
   * each entry, so Mirador also rebuilds its tiled image — a service requested
   * here no longer needs the post-login rebuild.
   *
   * The window id must go with it. A degraded response restarts core's silent
   * `external` probe for that window, and core only renders the token iframe
   * for an auth request whose window matches — without one the token stays
   * fetching forever and no auth bar shows. That is what happened after logging
   * out of a page that signed in through the `external` probe on load.
   */
  const dispatchRequests = useCallback((serviceIds) => {
    lastRepairRef.current = Date.now();
    serviceIds.forEach((serviceId) => degradedAtLoginRef.current?.delete(serviceId));
    if (degradedAtLoginRef.current?.size === 0) degradedAtLoginRef.current = null;

    const { requestInfoResponse: dispatchRequest, visibleCanvasesByWindow: visible } = propsRef.current;
    const windowIds = windowIdsByImageService(visible);
    serviceIds.forEach((serviceId) => dispatchRequest(serviceId, undefined, windowIds.get(serviceId)));
  }, []);

  /** Re-request info.json for the given image services, so tiles reload with auth. */
  const repair = useCallback((serviceIds) => {
    if (Date.now() - lastRepairRef.current < REFRESH_DEBOUNCE_MS) return;
    dispatchRequests(serviceIds);
  }, [dispatchRequests]);

  /**
   * Arm a deferred check: note which visible services are serving a DEGRADED
   * info response, and after the grace period repair the ones core left that way.
   *
   * `degraded` is core's own flag, set by the infoResponses reducer —
   * RECEIVE_DEGRADED_INFO_RESPONSE (the 401 path) stores `degraded: true`, a
   * normal RECEIVE_INFO_RESPONSE stores `degraded: false`. It is the only honest
   * test of "this image needs re-requesting". Asking merely whether core acted is
   * not: when the viewer is loaded by an already-signed-in user the very first
   * fetch returns full resolution, so core correctly does nothing and there is
   * nothing to repair — reading that silence as failure caused a pointless
   * reload of a perfectly good image 1.5s after every load.
   */
  const armRepair = useCallback(() => {
    const ids = visibleImageServiceIds(propsRef.current.visibleCanvasesByWindow)
      .filter((id) => propsRef.current.infoResponses?.[id]?.degraded === true);
    if (ids.length === 0) return;

    // Identity, not deep equality: every info-response action (request, receive,
    // degrade, remove) replaces the entry, so a changed reference — or a removed
    // entry — proves core acted on that service.
    const before = new Map(ids.map((id) => [id, propsRef.current.infoResponses[id]]));

    clearTimeout(repairTimerRef.current);
    repairTimerRef.current = setTimeout(() => {
      const after = propsRef.current.infoResponses;
      // Repair only what is BOTH untouched by core and still degraded. The second
      // clause also means an in-flight core refetch (isFetching, no `degraded`)
      // or one that landed on a still-degraded response is left alone rather than
      // piled onto.
      const stillDegraded = ids.filter(
        (id) => before.get(id) === after?.[id] && after?.[id]?.degraded === true,
      );
      if (stillDegraded.length > 0) repair(stillDegraded);
    }, REPAIR_GRACE_MS);
  }, [repair]);

  /**
   * Rebuild an image core refreshed in place after an interactive login.
   *
   * Core's `refetchInfoResponses` replaces the degraded info response with a
   * full-access one without a REQUEST_INFO_RESPONSE, so Mirador keeps the
   * OpenSeadragon tiled image it built while logged out. Every tile that image
   * requested was redirected to login (Chrome blocks the redirect outright),
   * and OpenSeadragon marks a failed tile `exists = false` and never requests it
   * again — the image stays blurry while the auth bar says "Logout".
   * Re-requesting the service makes Mirador unmount and rebuild the tiled image,
   * which then loads its tiles with the new cookie.
   *
   * This cannot hang off `armRepair`: core only sets the token's `success` when
   * that same refetch lands, so the access-token trigger fires in the render
   * where the image is already undegraded and finds nothing to arm. Instead the
   * services degraded when the popup opened are recorded, and each is rebuilt
   * the moment core flips it to full access. A service that goes through a
   * request (core's or ours) or is removed is dropped: its tiled image is
   * rebuilt anyway.
   *
   * Costs one extra info.json request per degraded image, and only after a
   * login or kiosk popup. An already-signed-in page load goes through the same
   * degraded-then-refreshed sequence via the silent token probe, but its tiles
   * were requested with a valid cookie and loaded fine, so it is left alone.
   */
  useEffect(() => {
    const pending = degradedAtLoginRef.current;
    if (!pending) return;

    const refreshed = [];
    [...pending].forEach((id) => {
      const current = infoResponses?.[id];
      if (!current || current.isFetching) {
        pending.delete(id);
      } else if (current.degraded === false) {
        refreshed.push(id);
      }
    });
    if (pending.size === 0) degradedAtLoginRef.current = null;
    if (refreshed.length > 0) dispatchRequests(refreshed);
  }, [infoResponses, dispatchRequests]);

  /**
   * Re-request EVERY visible image service, with no `degraded` filter — the
   * logout path.
   *
   * The verify-then-repair logic above is useless here: after logout the cached
   * responses are the full-resolution ones, so `degraded` is false for exactly
   * the services that need re-requesting. Nor can core be relied on to do it:
   * `refetchInfoResponsesOnLogout` is scoped to the single `tokenServiceId` that
   * fired, while MPS advertises two auth services (`external` + `login`), so the
   * visible image is routinely missed.
   *
   * No grace period either. mps-login clears its cookies *before* rendering
   * `logout-close`, so by the time the message arrives the credentials are
   * already gone and the refetch correctly 401s into a degraded response —
   * unlike core's blind 2s delay. Any pending login repair is cancelled: the
   * session it was arming for no longer exists.
   */
  const refreshAll = useCallback(() => {
    clearTimeout(repairTimerRef.current);
    degradedAtLoginRef.current = null;
    const ids = visibleImageServiceIds(propsRef.current.visibleCanvasesByWindow);
    if (ids.length > 0) repair(ids);
  }, [repair]);

  // Trigger 1: an access token just succeeded. Covers the already-signed-in
  // case, where the silent probe resolves with no popup at all and core's
  // token-service-scoped refetch can miss the visible image entirely.
  useEffect(() => {
    if (authSucceeded && !prevAuthSucceededRef.current) armRepair();
    prevAuthSucceededRef.current = authSucceeded;
  }, [authSucceeded, armRepair]);

  // Triggers 2 and 3: the auth popup closed, and the logout popup reported back.
  // Core never watches the handle it gets back from window.open, so a round-trip
  // that ends without a token action — the first HarvardKey login of a session,
  // or any logout — otherwise refreshes nothing.
  useEffect(() => {
    /**
     * Note the popup, and which kind it was, so the handlers below can branch.
     * `logout` matches nothing in the login patterns: mps-login's logout popup
     * is `…/logout/mirador`.
     */
    const originalWindowOpen = window.open;
    window.open = function trackedOpen(...args) {
      const popup = originalWindowOpen.apply(this, args);
      const url = args[0];
      /**
       * A blocked popup makes `window.open` return `null`. Core's
       * `NewBrowserWindow` null-checks that in its poll interval but not in its
       * unmount cleanup, which calls `newWindow.close()` unconditionally — so
       * handing back a bare `null` throws inside an effect cleanup and the
       * window's error boundary replaces everything, image and top bar
       * included. An already-closed stub takes core's own "popup dismissed"
       * path instead: the interval sees `closed`, fires `onClose`, and the auth
       * request resolves rather than hanging at `isFetching` forever.
       *
       * Deliberately not tracked in `activePopupRef`: no window ever opened, so
       * there is no round-trip to wait for and nothing to repair on focus.
       *
       * This matters most for the in-library kiosk service, which core opens
       * with no user gesture behind it — the case browsers block by default.
       * See LTSMPS-1048.
       */
      if (!popup) {
        /**
         * Tell the banner which auth request was blocked so Retry can
         * re-dispatch it. Core builds the popup url as
         * `${authServiceId}?origin=…`, and the matching auth entry already
         * exists in state by the time it opens the window, so the entry gives
         * us the windowId and profile that `addAuthenticationRequest` needs.
         */
        const authServiceId = (url || '').split('?')[0];
        const entry = authServiceId && authRef.current?.[authServiceId];
        if (entry?.windowId && popupBlockedRef.current) {
          popupBlockedRef.current({
            authServiceId,
            profile: entry.profile,
            windowId: entry.windowId,
          });
        }
        return { closed: true, close() {}, focus() {} };
      }
      if (url) {
        if (url.includes('logout')) {
          activePopupRef.current = { popup, kind: 'logout', origin: originOf(url) };
        } else if (url.includes('login') || url.includes('auth')) {
          activePopupRef.current = { popup, kind: 'login', origin: originOf(url) };
          // These images' tiles were requested while logged out.
          const { visibleCanvasesByWindow: visible, infoResponses: current } = propsRef.current;
          const degraded = visibleImageServiceIds(visible)
            .filter((id) => current?.[id]?.degraded === true);
          if (degraded.length > 0) degradedAtLoginRef.current = new Set(degraded);
        }
      }
      return popup;
    };

    /**
     * The logout popup finished: session deleted, cookies cleared. Only accept it
     * from the origin we opened the logout popup at — never `*`, and never from a
     * login popup, whose own postMessages are core's business.
     *
     * This handshake depends on mps-login sending
     * `Cross-Origin-Opener-Policy: unsafe-none` on the `logout-close` response;
     * helmet's default `same-origin` would null out `window.opener` in the popup
     * (viewer origin ≠ login origin) and take the `popup.closed` fallback below
     * with it.
     */
    const handleMessage = (event) => {
      if (event.data?.type !== LOGOUT_COMPLETE_TYPE) return;
      const tracked = activePopupRef.current;
      if (!tracked || tracked.kind !== 'logout') return;
      if (!tracked.origin || event.origin !== tracked.origin) return;

      activePopupRef.current = null;
      refreshAll();
    };

    /** User came back to the main window — if the popup has closed, act on it. */
    const handleWindowFocus = () => {
      if (!activePopupRef.current) return;

      setTimeout(() => {
        const tracked = activePopupRef.current;
        if (!tracked) return;
        try {
          if (!tracked.popup.closed) return;
        } catch (error) {
          // Cross-origin popup we can no longer read; treat as closed.
        }
        activePopupRef.current = null;
        // A logout popup that closed without a message — dismissed by hand, or a
        // postMessage that never arrived. Refresh anyway; the debounce in
        // `repair` keeps this from doubling up on a message that did arrive.
        if (tracked.kind === 'logout') refreshAll();
        else armRepair();
      }, POPUP_CLOSE_DELAY_MS);
    };

    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('message', handleMessage);
      window.open = originalWindowOpen;
      clearTimeout(repairTimerRef.current);
    };
  }, [armRepair, refreshAll]);

  return null;
};

/**
 * Map Redux state to component props. Viewer-wide (not scoped to one window):
 * every window's visible canvases, the info-response cache used as the
 * before/after evidence, and whether any access token has succeeded.
 */
export const mapStateToProps = (state) => {
  const visibleCanvasesByWindow = {};
  getWindowIds(state).forEach((windowId) => {
    visibleCanvasesByWindow[windowId] = getVisibleCanvases(state, { windowId });
  });

  const accessTokens = getAccessTokens(state) || {};

  return {
    auth: getAuth(state),
    authSucceeded: Object.values(accessTokens).some((token) => token?.success),
    infoResponses: selectInfoResponses(state),
    visibleCanvasesByWindow,
  };
};

export const mapDispatchToProps = {
  popupBlocked: popupBlockedAction,
  requestInfoResponse,
};

/**
 * Plugin configuration
 * Uses BackgroundPluginArea for invisible monitoring without affecting UI
 */
export default {
  target: 'BackgroundPluginArea',
  mode: 'add',
  component: LoginMonitor,
  mapStateToProps,
  mapDispatchToProps,
};

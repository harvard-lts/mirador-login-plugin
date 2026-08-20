import { useCallback, useEffect, useRef } from 'react';
import {
  getWindowIds,
  getVisibleCanvases,
  selectInfoResponses,
  getAccessTokens,
  requestInfoResponse,
  MiradorCanvas,
} from 'mirador';

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
 * Collect the image service id of every visible canvas across every window.
 * A canvas that cannot be wrapped is logged and skipped rather than aborting
 * the whole sweep.
 */
export const visibleImageServiceIds = (visibleCanvasesByWindow) => {
  if (!visibleCanvasesByWindow) return [];

  const ids = [];
  Object.values(visibleCanvasesByWindow).forEach((canvases) => {
    (canvases || []).forEach((canvas, index) => {
      try {
        new MiradorCanvas(canvas).imageServiceIds.forEach((serviceId) => {
          if (serviceId) ids.push(serviceId);
        });
      } catch (error) {
        console.error(`[LoginMonitor] Error processing canvas ${index + 1}:`, error);
      }
    });
  });

  return [...new Set(ids)];
};

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
 * Logout is the mirror image and needs the opposite treatment. After logout the
 * cached info responses are full-resolution and MUST be re-requested so they come
 * back degraded, so there is nothing to verify first — see `refreshAll`.
 *
 * Renders no UI.
 */
const LoginMonitor = ({
  visibleCanvasesByWindow, infoResponses, authSucceeded, requestInfoResponse,
}) => {
  // Keep latest props in a ref so timers and event handlers registered once on
  // mount always read current values.
  const propsRef = useRef({ visibleCanvasesByWindow, infoResponses, requestInfoResponse });
  const activePopupRef = useRef(null);
  const lastRepairRef = useRef(0);
  const repairTimerRef = useRef(null);
  const prevAuthSucceededRef = useRef(authSucceeded);

  useEffect(() => {
    propsRef.current = { visibleCanvasesByWindow, infoResponses, requestInfoResponse };
  }, [visibleCanvasesByWindow, infoResponses, requestInfoResponse]);

  /** Re-request info.json for the given image services, so tiles reload with auth. */
  const repair = useCallback((serviceIds) => {
    const now = Date.now();
    if (now - lastRepairRef.current < REFRESH_DEBOUNCE_MS) return;
    lastRepairRef.current = now;

    const { requestInfoResponse: dispatchRequest } = propsRef.current;
    serviceIds.forEach((serviceId) => dispatchRequest(serviceId));
  }, []);

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
      if (popup && url) {
        if (url.includes('logout')) {
          activePopupRef.current = { popup, kind: 'logout', origin: originOf(url) };
        } else if (url.includes('login') || url.includes('auth')) {
          activePopupRef.current = { popup, kind: 'login', origin: originOf(url) };
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
    visibleCanvasesByWindow,
    infoResponses: selectInfoResponses(state),
    authSucceeded: Object.values(accessTokens).some((token) => token?.success),
  };
};

export const mapDispatchToProps = {
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

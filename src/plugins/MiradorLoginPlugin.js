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
 *   2. Snapshot the info response currently held for each visible image service.
 *   3. Wait REPAIR_GRACE_MS for core to do its job.
 *   4. Re-request ONLY the services whose info response core left untouched.
 *
 * Because step 4 skips anything core already replaced, the healthy path issues
 * exactly one request — core's — and this plugin issues none.
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
   * Arm a deferred check: snapshot what core is holding now, and after the grace
   * period repair whichever visible services core never touched.
   */
  const armRepair = useCallback(() => {
    const ids = visibleImageServiceIds(propsRef.current.visibleCanvasesByWindow);
    if (ids.length === 0) return;

    // Identity, not deep equality: every info-response action (request, receive,
    // degrade, remove) replaces the entry, so a changed reference — or a removed
    // entry — proves core acted on that service.
    const before = new Map(ids.map((id) => [id, propsRef.current.infoResponses?.[id]]));

    clearTimeout(repairTimerRef.current);
    repairTimerRef.current = setTimeout(() => {
      const after = propsRef.current.infoResponses;
      const untouched = ids.filter((id) => before.get(id) === after?.[id]);
      if (untouched.length > 0) repair(untouched);
    }, REPAIR_GRACE_MS);
  }, [repair]);

  // Trigger 1: an access token just succeeded. Covers the already-signed-in
  // case, where the silent probe resolves with no popup at all and core's
  // token-service-scoped refetch can miss the visible image entirely.
  useEffect(() => {
    if (authSucceeded && !prevAuthSucceededRef.current) armRepair();
    prevAuthSucceededRef.current = authSucceeded;
  }, [authSucceeded, armRepair]);

  // Trigger 2: the auth popup closed. Core never watches the handle it gets back
  // from window.open, so a round-trip that ends without a token action — the
  // first HarvardKey login of a session — otherwise refreshes nothing.
  useEffect(() => {
    /** Note the popup so the focus handler knows to watch for it closing. */
    const originalWindowOpen = window.open;
    window.open = function trackedOpen(...args) {
      const popup = originalWindowOpen.apply(this, args);
      const url = args[0];
      if (popup && url && (url.includes('login') || url.includes('auth'))) {
        activePopupRef.current = popup;
      }
      return popup;
    };

    /** User came back to the main window — if the popup has closed, verify. */
    const handleWindowFocus = () => {
      if (!activePopupRef.current) return;

      setTimeout(() => {
        try {
          if (!activePopupRef.current.closed) return;
        } catch (error) {
          // Cross-origin popup we can no longer read; treat as closed.
        }
        activePopupRef.current = null;
        armRepair();
      }, POPUP_CLOSE_DELAY_MS);
    };

    window.addEventListener('focus', handleWindowFocus);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      window.open = originalWindowOpen;
      clearTimeout(repairTimerRef.current);
    };
  }, [armRepair]);

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

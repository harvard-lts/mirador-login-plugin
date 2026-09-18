import { miradorSlice } from 'mirador';

/**
 * Redux state for "a kiosk/login popup was blocked by the browser".
 *
 * This exists because detection and display happen in different plugin
 * components mounted in different parts of the tree: the `window.open` patch
 * lives in `LoginMonitor` (BackgroundPluginArea, mounted once), while the
 * banner renders per window. They cannot share React state, so the flag goes
 * through the store.
 *
 * Mirador spreads plugin reducers into its root `combineReducers` alongside
 * `auth`, `windows`, etc., so this slice lands at the same level as core's.
 * The key is namespaced to avoid colliding with core or another plugin.
 */
export const POPUP_BLOCKED_STATE_KEY = 'miradorLoginPluginPopupBlocked';

export const POPUP_BLOCKED = 'mirador-login-plugin/POPUP_BLOCKED';
export const POPUP_BLOCKED_CLEARED = 'mirador-login-plugin/POPUP_BLOCKED_CLEARED';

/**
 * A popup was requested and the browser returned no window handle.
 * `authServiceId` and `profile` are kept so Retry can re-dispatch the same
 * auth request that was blocked.
 */
export const popupBlocked = ({ windowId, authServiceId, profile }) => ({
  authServiceId, profile, type: POPUP_BLOCKED, windowId,
});

export const clearPopupBlocked = ({ windowId }) => ({
  type: POPUP_BLOCKED_CLEARED, windowId,
});

/** Keyed by windowId: `{ [windowId]: { authServiceId, profile } }`. */
export const popupBlockedReducer = (state = {}, action = {}) => {
  switch (action.type) {
    case POPUP_BLOCKED: {
      if (!action.windowId) return state;
      return {
        ...state,
        [action.windowId]: {
          authServiceId: action.authServiceId,
          profile: action.profile,
        },
      };
    }
    case POPUP_BLOCKED_CLEARED: {
      if (!(action.windowId in state)) return state;
      const next = { ...state };
      delete next[action.windowId];
      return next;
    }
    default:
      return state;
  }
};

/**
 * `miradorSlice` is used rather than reading `state` directly because an
 * embedding app can namespace the whole Mirador store under
 * `config.state.slice`; core's own selectors go through it for the same reason.
 */
export const selectPopupBlocked = (state, windowId) => (
  miradorSlice(state)?.[POPUP_BLOCKED_STATE_KEY]?.[windowId]
);

export const popupBlockedReducers = {
  [POPUP_BLOCKED_STATE_KEY]: popupBlockedReducer,
};

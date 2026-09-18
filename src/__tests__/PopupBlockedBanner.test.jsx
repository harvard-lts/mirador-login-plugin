import {
  describe, it, expect, vi,
} from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock `mirador` for the same reason the LoginMonitor tests do: importing the
// real bundle drags in the whole viewer and trips jsdom's missing canvas.
const addAuthenticationRequest = vi.fn();

vi.mock('mirador', () => ({
  addAuthenticationRequest: (...args) => addAuthenticationRequest(...args),
  // The banner selector goes through `miradorSlice`; with no configured state
  // slice it is the identity function, which is what core does too.
  miradorSlice: (state) => state,
}));

// Import AFTER vi.mock so the mock is in effect.
const stateMod = await import('../state/popupBlocked.js');
const {
  POPUP_BLOCKED_STATE_KEY,
  clearPopupBlocked,
  popupBlocked,
  popupBlockedReducer,
  selectPopupBlocked,
} = stateMod;

const bannerMod = await import('../plugins/PopupBlockedBanner.jsx');
const {
  default: plugin, PopupBlockedBanner, mapStateToProps,
} = bannerMod;

const blockedEntry = {
  authServiceId: 'https://iiif.example.edu/kiosk',
  profile: 'http://iiif.io/api/auth/1/kiosk',
};

describe('popupBlocked reducer', () => {
  it('records the blocked auth request against its window', () => {
    const next = popupBlockedReducer({}, popupBlocked({
      windowId: 'w1', ...blockedEntry,
    }));

    expect(next).toEqual({ w1: blockedEntry });
  });

  it('keeps windows independent', () => {
    let state = popupBlockedReducer({}, popupBlocked({ windowId: 'w1', ...blockedEntry }));
    state = popupBlockedReducer(state, popupBlocked({ windowId: 'w2', ...blockedEntry }));

    expect(Object.keys(state)).toEqual(['w1', 'w2']);
  });

  it('clears only the window that was dismissed', () => {
    let state = popupBlockedReducer({}, popupBlocked({ windowId: 'w1', ...blockedEntry }));
    state = popupBlockedReducer(state, popupBlocked({ windowId: 'w2', ...blockedEntry }));
    state = popupBlockedReducer(state, clearPopupBlocked({ windowId: 'w1' }));

    expect(state).toEqual({ w2: blockedEntry });
  });

  // Identity matters: a new object on every unrelated action would re-render
  // the banner in every window.
  it('returns the same state for an unknown action', () => {
    const state = { w1: blockedEntry };

    expect(popupBlockedReducer(state, { type: 'SOMETHING_ELSE' })).toBe(state);
  });

  it('returns the same state when clearing a window it is not tracking', () => {
    const state = { w1: blockedEntry };

    expect(popupBlockedReducer(state, clearPopupBlocked({ windowId: 'nope' }))).toBe(state);
  });

  // The action is built from an auth entry, which may not have a windowId if
  // core's state shape ever shifts; recording it under `undefined` would show
  // the banner in the wrong window.
  it('ignores a blocked action with no windowId', () => {
    const state = {};

    expect(popupBlockedReducer(state, popupBlocked({ ...blockedEntry }))).toBe(state);
  });
});

describe('selectPopupBlocked', () => {
  it('reads the entry for the given window', () => {
    const state = { [POPUP_BLOCKED_STATE_KEY]: { w1: blockedEntry } };

    expect(selectPopupBlocked(state, 'w1')).toEqual(blockedEntry);
  });

  it('is undefined when nothing is blocked', () => {
    expect(selectPopupBlocked({}, 'w1')).toBeUndefined();
    expect(mapStateToProps({}, { windowId: 'w1' }).blocked).toBeUndefined();
  });
});

describe('plugin descriptor', () => {
  it('adds to Window and registers its reducer', () => {
    expect(plugin.target).toBe('Window');
    expect(plugin.mode).toBe('add');
    expect(plugin.component).toBe(PopupBlockedBanner);
    expect(plugin.reducers[POPUP_BLOCKED_STATE_KEY]).toBe(popupBlockedReducer);
  });
});

describe('PopupBlockedBanner', () => {
  const renderBanner = (blocked) => {
    const dismiss = vi.fn();
    const requestAuth = vi.fn();
    const utils = render(
      <PopupBlockedBanner
        blocked={blocked}
        dismiss={dismiss}
        requestAuth={requestAuth}
        windowId="w1"
      />,
    );
    return { dismiss, requestAuth, ...utils };
  };

  it('renders nothing when no popup was blocked', () => {
    const { container } = renderBanner(undefined);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the message and the reload hint when a popup was blocked', () => {
    renderBanner(blockedEntry);

    expect(screen.getByText('In-library access needs a pop-up window.')).toBeInTheDocument();
    expect(
      screen.getByText('Still blocked? Allow pop-ups for this site, then reload.'),
    ).toBeInTheDocument();
  });

  /**
   * The whole point of the button: the original popup was opened by core with
   * no user gesture, which browsers block. Re-dispatching the same auth request
   * from a click carries transient user activation, so the popup is allowed.
   */
  it('re-dispatches the blocked auth request on Retry', () => {
    const { requestAuth } = renderBanner(blockedEntry);

    screen.getByRole('button', { name: 'Retry' }).click();

    expect(requestAuth).toHaveBeenCalledWith(
      'w1', blockedEntry.authServiceId, blockedEntry.profile,
    );
  });

  // Cleared so a second block re-dispatches and brings the banner back, rather
  // than leaving it stuck on screen after a successful retry.
  it('clears its own window before retrying', () => {
    const { dismiss } = renderBanner(blockedEntry);

    screen.getByRole('button', { name: 'Retry' }).click();

    expect(dismiss).toHaveBeenCalledWith({ windowId: 'w1' });
  });
});

import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { render } from '@testing-library/react';

// Mock `mirador` so we control the selectors/actions and avoid loading the full
// bundle (which triggers a jsdom HTMLCanvasElement.getContext error).
const getWindowIds = vi.fn();
const getVisibleCanvases = vi.fn();
const selectInfoResponses = vi.fn();
const getAccessTokens = vi.fn();
const requestInfoResponse = vi.fn();
const MiradorCanvas = vi.fn();

vi.mock('mirador', () => ({
  getWindowIds: (...args) => getWindowIds(...args),
  getVisibleCanvases: (...args) => getVisibleCanvases(...args),
  selectInfoResponses: (...args) => selectInfoResponses(...args),
  getAccessTokens: (...args) => getAccessTokens(...args),
  requestInfoResponse: (...args) => requestInfoResponse(...args),
  MiradorCanvas: function (...args) { return MiradorCanvas(...args); },
}));

// Import AFTER vi.mock so the mock is in effect.
const mod = await import('../plugins/MiradorLoginPlugin.js');
const {
  default: plugin, REPAIR_GRACE_MS, REFRESH_DEBOUNCE_MS, LOGOUT_COMPLETE_TYPE, originOf,
} = mod;
const { component: LoginMonitor, mapStateToProps, mapDispatchToProps } = plugin;

describe('plugin descriptor', () => {
  it('targets BackgroundPluginArea in add mode', () => {
    expect(plugin.target).toBe('BackgroundPluginArea');
    expect(plugin.mode).toBe('add');
    expect(plugin.component).toBe(LoginMonitor);
  });

  it('wires requestInfoResponse into mapDispatchToProps', () => {
    expect(mapDispatchToProps.requestInfoResponse).toBeDefined();
  });
});

describe('mapStateToProps', () => {
  beforeEach(() => {
    getWindowIds.mockReset();
    getVisibleCanvases.mockReset();
    selectInfoResponses.mockReset();
    getAccessTokens.mockReset();
    getAccessTokens.mockReturnValue({});
  });

  it('builds a map of visible canvases per window', () => {
    getWindowIds.mockReturnValue(['w1', 'w2']);
    getVisibleCanvases.mockImplementation((state, { windowId }) => [`canvas-${windowId}`]);
    selectInfoResponses.mockReturnValue({ 'svc-1': {} });

    const props = mapStateToProps({});

    expect(props.visibleCanvasesByWindow).toEqual({
      w1: ['canvas-w1'],
      w2: ['canvas-w2'],
    });
    expect(props.infoResponses).toEqual({ 'svc-1': {} });
  });

  it('returns an empty map when there are no windows', () => {
    getWindowIds.mockReturnValue([]);
    selectInfoResponses.mockReturnValue({});

    const props = mapStateToProps({});

    expect(props.visibleCanvasesByWindow).toEqual({});
    expect(getVisibleCanvases).not.toHaveBeenCalled();
  });

  it('reports authSucceeded once any access token has succeeded', () => {
    getWindowIds.mockReturnValue([]);
    selectInfoResponses.mockReturnValue({});

    getAccessTokens.mockReturnValue({ 'token-svc': { isFetching: true } });
    expect(mapStateToProps({}).authSucceeded).toBe(false);

    getAccessTokens.mockReturnValue({
      'token-svc': { isFetching: false },
      'other-svc': { success: true },
    });
    expect(mapStateToProps({}).authSucceeded).toBe(true);
  });

  it('tolerates missing access token state', () => {
    getWindowIds.mockReturnValue([]);
    selectInfoResponses.mockReturnValue({});
    getAccessTokens.mockReturnValue(undefined);

    expect(mapStateToProps({}).authSucceeded).toBe(false);
  });
});

describe('LoginMonitor component', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders no UI', () => {
    const { container } = render(
      <LoginMonitor
        visibleCanvasesByWindow={{}}
        infoResponses={{}}
        authSucceeded={false}
        requestInfoResponse={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('registers and cleans up the focus listener and restores window.open', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const originalOpen = window.open;

    const { unmount } = render(
      <LoginMonitor
        visibleCanvasesByWindow={{}}
        infoResponses={{}}
        authSucceeded={false}
        requestInfoResponse={vi.fn()}
      />,
    );

    expect(addSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));
    expect(window.open).not.toBe(originalOpen);

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));
    expect(window.open).toBe(originalOpen);
  });
});

// Helper: an info response entry as core's reducer stores it. `degraded: true`
// is the 401 path (low-res tiles); `false` is a normal authenticated 200.
const entry = (id, degraded) => ({
  degraded, id, isFetching: false, json: { id },
});

describe('LoginMonitor verify-then-repair', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MiradorCanvas.mockReset();
    requestInfoResponse.mockReset();
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const canvases = { w1: [{ id: 'c1' }] };

  const renderAt = (infoResponses, authSucceeded) => render(
    <LoginMonitor
      visibleCanvasesByWindow={canvases}
      infoResponses={infoResponses}
      authSucceeded={authSucceeded}
      requestInfoResponse={requestInfoResponse}
    />,
  );

  /** Push a new infoResponses object, as a Redux update would. */
  const update = (view, infoResponses, authSucceeded = true) => view.rerender(
    <LoginMonitor
      visibleCanvasesByWindow={canvases}
      infoResponses={infoResponses}
      authSucceeded={authSucceeded}
      requestInfoResponse={requestInfoResponse}
    />,
  );

  /** Render logged-out, then flip to logged-in — the access-token trigger. */
  const login = (infoResponses) => {
    const view = renderAt(infoResponses, false);
    update(view, infoResponses);
    return view;
  };

  it('repairs a degraded service core left untouched after a successful login', () => {
    login({ 'svc-a': entry('svc-a', true) });
    expect(requestInfoResponse).not.toHaveBeenCalled(); // still inside grace

    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });

  // The regression that shipped in 2.1.0: an already-signed-in user gets a
  // full-resolution image on the FIRST fetch, so core has nothing to refetch.
  // Reading that silence as failure reloaded a perfectly good image 1.5s after
  // every load.
  it('does NOT repair when the image was never degraded (already signed in)', () => {
    login({ 'svc-a': entry('svc-a', false) });
    vi.advanceTimersByTime(REPAIR_GRACE_MS * 2);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('does NOT repair when core already replaced the degraded response', () => {
    const view = login({ 'svc-a': entry('svc-a', true) });

    // Core's own refetchInfoResponses fires: new entry, no longer degraded.
    update(view, { 'svc-a': entry('svc-a', false) });
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('does NOT repair while core\'s own refetch is still in flight', () => {
    const view = login({ 'svc-a': entry('svc-a', true) });

    // REQUEST_INFO_RESPONSE: isFetching, and `degraded` is absent entirely.
    update(view, { 'svc-a': { id: 'svc-a', isFetching: true } });
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('does NOT repair when core removed the info response', () => {
    const view = login({ 'svc-a': entry('svc-a', true) });

    // REMOVE_INFO_RESPONSE — core discarded it for lazy re-fetch.
    update(view, {});
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('does NOT repair a service with no info response at all', () => {
    login({});
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('repairs only the degraded services core missed', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a', 'svc-b'] }));
    const stillStale = entry('svc-b', true);
    const view = login({ 'svc-a': entry('svc-a', true), 'svc-b': stillStale });

    // Core refreshed svc-a only; svc-b keeps its original degraded entry.
    update(view, { 'svc-a': entry('svc-a', false), 'svc-b': stillStale });
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-b');
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });

  it('ignores an undegraded service alongside a degraded one', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-ok', 'svc-bad'] }));
    login({ 'svc-ok': entry('svc-ok', false), 'svc-bad': entry('svc-bad', true) });
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-bad');
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm while authSucceeded stays true', () => {
    const stale = { 'svc-a': entry('svc-a', true) };
    const view = login(stale);
    vi.advanceTimersByTime(REPAIR_GRACE_MS);
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);

    // Unrelated re-render with auth still true must not trigger another check.
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    update(view, stale);
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });

  it('skips the check when there are no visible canvases', () => {
    const view = render(
      <LoginMonitor
        visibleCanvasesByWindow={{}}
        infoResponses={{}}
        authSucceeded={false}
        requestInfoResponse={requestInfoResponse}
      />,
    );
    view.rerender(
      <LoginMonitor
        visibleCanvasesByWindow={{}}
        infoResponses={{}}
        authSucceeded
        requestInfoResponse={requestInfoResponse}
      />,
    );
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).not.toHaveBeenCalled();
    expect(MiradorCanvas).not.toHaveBeenCalled();
  });

  it('skips falsy service ids and de-duplicates repeats', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a', null, '', 'svc-a'] }));

    login({ 'svc-a': entry('svc-a', true) });
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
  });

  it('logs and continues when a canvas throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    MiradorCanvas
      .mockImplementationOnce(() => { throw new Error('bad canvas'); })
      .mockImplementationOnce(() => ({ imageServiceIds: ['svc-ok'] }));

    const twoCanvases = { w1: [{ id: 'c1' }, { id: 'c2' }] };
    const responses = { 'svc-ok': entry('svc-ok', true) };
    const view = render(
      <LoginMonitor
        visibleCanvasesByWindow={twoCanvases}
        infoResponses={responses}
        authSucceeded={false}
        requestInfoResponse={requestInfoResponse}
      />,
    );
    view.rerender(
      <LoginMonitor
        visibleCanvasesByWindow={twoCanvases}
        infoResponses={responses}
        authSucceeded
        requestInfoResponse={requestInfoResponse}
      />,
    );
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(errorSpy).toHaveBeenCalled();
    expect(requestInfoResponse).toHaveBeenCalledWith('svc-ok');
  });
});

describe('LoginMonitor popup-close trigger', () => {
  let originalOpen;

  beforeEach(() => {
    vi.useFakeTimers();
    MiradorCanvas.mockReset();
    requestInfoResponse.mockReset();
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));
    originalOpen = window.open;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.open = originalOpen;
  });

  // authSucceeded stays false throughout: this is the first-login case where no
  // token action ever reaches core, so the popup is the only signal available.
  const renderMonitor = (degraded = true) => render(
    <LoginMonitor
      visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
      infoResponses={{ 'svc-a': entry('svc-a', degraded) }}
      authSucceeded={false}
      requestInfoResponse={requestInfoResponse}
    />,
  );

  const closeAndFocus = (popup) => {
    if (popup) popup.closed = true;
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(REPAIR_GRACE_MS * 2);
  };

  it('repairs after an auth popup is detected and closed on focus', () => {
    const popup = { closed: false };
    // Set the underlying window.open BEFORE rendering so the plugin's wrapper
    // calls through to it and returns our fake popup.
    window.open = vi.fn().mockReturnValue(popup);

    renderMonitor();

    const returned = window.open('https://example.com/login', '_blank');
    expect(returned).toBe(popup);

    closeAndFocus(popup);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
  });

  it('does not repair after a popup closes if the image is not degraded', () => {
    const popup = { closed: false };
    window.open = vi.fn().mockReturnValue(popup);

    renderMonitor(false);
    window.open('https://example.com/login', '_blank');

    closeAndFocus(popup);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('does not track popups for non-auth urls', () => {
    window.open = vi.fn().mockReturnValue({ closed: true });

    renderMonitor();
    window.open('https://example.com/some-page', '_blank');

    closeAndFocus(null);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('repairs when the popup cannot be accessed (cross-origin)', () => {
    // Accessing `.closed` throws, simulating a cross-origin popup.
    const popup = { get closed() { throw new Error('cross-origin'); } };
    window.open = vi.fn().mockReturnValue(popup);

    renderMonitor();
    window.open('https://example.com/auth', '_blank');

    closeAndFocus(null);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
  });

  it('ignores focus events when no popup is active', () => {
    renderMonitor();
    closeAndFocus(null);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('does not repair while the popup is still open', () => {
    window.open = vi.fn().mockReturnValue({ closed: false });

    renderMonitor();
    window.open('https://example.com/login', '_blank');

    closeAndFocus(null);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('repairs once when both triggers fire for the same login', () => {
    const popup = { closed: false };
    window.open = vi.fn().mockReturnValue(popup);

    const responses = { 'svc-a': entry('svc-a', true) };
    const view = render(
      <LoginMonitor
        visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
        infoResponses={responses}
        authSucceeded={false}
        requestInfoResponse={requestInfoResponse}
      />,
    );

    window.open('https://example.com/login', '_blank');
    popup.closed = true;
    window.dispatchEvent(new Event('focus'));

    // Token succeeds at essentially the same moment the popup closes.
    view.rerender(
      <LoginMonitor
        visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
        infoResponses={responses}
        authSucceeded
        requestInfoResponse={requestInfoResponse}
      />,
    );

    vi.advanceTimersByTime(REPAIR_GRACE_MS * 2);

    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });
});

describe('originOf', () => {
  it('reduces a popup url to its bare origin', () => {
    expect(originOf('https://mps-dev.example.com/logout/mirador?a=1')).toBe('https://mps-dev.example.com');
  });

  it('resolves a relative url against the viewer location', () => {
    expect(originOf('/logout/mirador')).toBe(window.location.origin);
  });

  it('returns null for an unparseable url', () => {
    expect(originOf('http://')).toBeNull();
  });
});

describe('LoginMonitor logout refresh', () => {
  const LOGIN_HOST = 'https://mps-dev.example.com';
  const LOGOUT_URL = `${LOGIN_HOST}/logout/mirador`;
  let originalOpen;

  beforeEach(() => {
    vi.useFakeTimers();
    MiradorCanvas.mockReset();
    requestInfoResponse.mockReset();
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a', 'svc-b'] }));
    originalOpen = window.open;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.open = originalOpen;
  });

  // The post-logout state: the cached info responses are the FULL-RESOLUTION
  // ones, so nothing is `degraded` and the verify-then-repair path would refuse
  // to act. Re-requesting them is exactly what makes them degrade again.
  const renderMonitor = () => render(
    <LoginMonitor
      visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
      infoResponses={{ 'svc-a': entry('svc-a', false), 'svc-b': entry('svc-b', false) }}
      authSucceeded
      requestInfoResponse={requestInfoResponse}
    />,
  );

  const postLogoutComplete = (origin = LOGIN_HOST, data = { type: LOGOUT_COMPLETE_TYPE }) => {
    window.dispatchEvent(new MessageEvent('message', { data, origin }));
    vi.advanceTimersByTime(REPAIR_GRACE_MS);
  };

  const openLogoutPopup = (popup = { closed: false }) => {
    window.open = vi.fn().mockReturnValue(popup);
    renderMonitor();
    window.open(LOGOUT_URL, '_blank');
    return popup;
  };

  it('re-requests every visible service — degraded or not — on mps-logout-complete', () => {
    openLogoutPopup();

    postLogoutComplete();

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
    expect(requestInfoResponse).toHaveBeenCalledWith('svc-b');
    expect(requestInfoResponse).toHaveBeenCalledTimes(2);
  });

  it('ignores a logout message from a foreign origin', () => {
    openLogoutPopup();

    postLogoutComplete('https://evil.example.com');

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('ignores a message of the wrong type', () => {
    openLogoutPopup();

    postLogoutComplete(LOGIN_HOST, { type: 'mps-login-complete' });
    window.dispatchEvent(new MessageEvent('message', { data: 'plain string', origin: LOGIN_HOST }));
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('ignores a logout message when no logout popup is being tracked', () => {
    renderMonitor();

    postLogoutComplete();

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('ignores a logout message while only a login popup is tracked', () => {
    window.open = vi.fn().mockReturnValue({ closed: false });
    renderMonitor();
    window.open(`${LOGIN_HOST}/login/mirador`, '_blank');

    postLogoutComplete();

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('refreshes anyway when the logout popup is closed by hand', () => {
    const popup = openLogoutPopup();

    popup.closed = true;
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
    expect(requestInfoResponse).toHaveBeenCalledWith('svc-b');
    expect(requestInfoResponse).toHaveBeenCalledTimes(2);
  });

  it('refreshes once when the message and the popup close both land', () => {
    const popup = openLogoutPopup();

    postLogoutComplete();
    popup.closed = true;
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledTimes(2); // one per service, once
  });

  it('debounces a second logout inside the refresh window', () => {
    openLogoutPopup();
    postLogoutComplete();
    expect(requestInfoResponse).toHaveBeenCalledTimes(2);

    // Same popup handle re-opened well inside REFRESH_DEBOUNCE_MS.
    window.open(LOGOUT_URL, '_blank');
    postLogoutComplete();

    expect(requestInfoResponse).toHaveBeenCalledTimes(2);
  });

  it('refreshes again once the debounce window has passed', () => {
    openLogoutPopup();
    postLogoutComplete();
    expect(requestInfoResponse).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    window.open(LOGOUT_URL, '_blank');
    postLogoutComplete();

    expect(requestInfoResponse).toHaveBeenCalledTimes(4);
  });

  it('cancels a pending login repair when logout completes', () => {
    const popup = { closed: false };
    window.open = vi.fn().mockReturnValue(popup);

    // A degraded image arms the login repair...
    const responses = { 'svc-a': entry('svc-a', true), 'svc-b': entry('svc-b', true) };
    const view = render(
      <LoginMonitor
        visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
        infoResponses={responses}
        authSucceeded={false}
        requestInfoResponse={requestInfoResponse}
      />,
    );
    view.rerender(
      <LoginMonitor
        visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
        infoResponses={responses}
        authSucceeded
        requestInfoResponse={requestInfoResponse}
      />,
    );

    // ...then the user logs out before the grace period elapses.
    window.open(LOGOUT_URL, '_blank');
    postLogoutComplete();

    expect(requestInfoResponse).toHaveBeenCalledTimes(2);

    // The armed repair must not fire a second round for a session that is gone.
    vi.advanceTimersByTime(REPAIR_GRACE_MS * 2);
    expect(requestInfoResponse).toHaveBeenCalledTimes(2);
  });

  it('tracks nothing when the popup was blocked', () => {
    window.open = vi.fn().mockReturnValue(null);
    renderMonitor();
    window.open(LOGOUT_URL, '_blank');

    postLogoutComplete();

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  // The message can land in the window between focus firing and the deferred
  // `popup.closed` read; the message path has already refreshed by then.
  it('drops the deferred close check when the message wins the race', () => {
    const popup = openLogoutPopup();

    popup.closed = true;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: LOGOUT_COMPLETE_TYPE },
      origin: LOGIN_HOST,
    }));
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledTimes(2);
  });

  it('does nothing when there are no visible canvases to refresh', () => {
    window.open = vi.fn().mockReturnValue({ closed: false });
    render(
      <LoginMonitor
        visibleCanvasesByWindow={{}}
        infoResponses={{}}
        authSucceeded
        requestInfoResponse={requestInfoResponse}
      />,
    );
    window.open(LOGOUT_URL, '_blank');

    postLogoutComplete();

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });
});

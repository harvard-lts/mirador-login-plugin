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
const { default: plugin, REPAIR_GRACE_MS, REFRESH_DEBOUNCE_MS } = mod;
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
    expect(window.open).not.toBe(originalOpen);

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(window.open).toBe(originalOpen);
  });

  it('does not listen for auth postMessages (core already handles that path)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');

    render(
      <LoginMonitor
        visibleCanvasesByWindow={{}}
        infoResponses={{}}
        authSucceeded={false}
        requestInfoResponse={vi.fn()}
      />,
    );

    expect(addSpy).not.toHaveBeenCalledWith('message', expect.any(Function));
  });
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

  // Render logged-out, then flip to logged-in — the access-token trigger.
  const login = (infoResponses) => {
    const view = render(
      <LoginMonitor
        visibleCanvasesByWindow={canvases}
        infoResponses={infoResponses}
        authSucceeded={false}
        requestInfoResponse={requestInfoResponse}
      />,
    );
    view.rerender(
      <LoginMonitor
        visibleCanvasesByWindow={canvases}
        infoResponses={infoResponses}
        authSucceeded
        requestInfoResponse={requestInfoResponse}
      />,
    );
    return view;
  };

  /** Push a new infoResponses object, as a Redux update would. */
  const update = (view, infoResponses) => view.rerender(
    <LoginMonitor
      visibleCanvasesByWindow={canvases}
      infoResponses={infoResponses}
      authSucceeded
      requestInfoResponse={requestInfoResponse}
    />,
  );

  it('repairs a service core left untouched after a successful login', () => {
    const stale = { 'svc-a': { id: 'svc-a', json: { degraded: true } } };

    login(stale);
    expect(requestInfoResponse).not.toHaveBeenCalled(); // still inside grace

    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });

  it('does NOT repair when core already replaced the info response', () => {
    const before = { 'svc-a': { id: 'svc-a', json: { degraded: true } } };
    const view = login(before);

    // Core's own refetchInfoResponses fires: new entry object for svc-a.
    update(view, { 'svc-a': { id: 'svc-a', json: { full: true } } });
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('does NOT repair when core removed the info response', () => {
    const view = login({ 'svc-a': { id: 'svc-a' } });

    // REMOVE_INFO_RESPONSE — core discarded it for lazy re-fetch.
    update(view, {});
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('repairs only the services core missed', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a', 'svc-b'] }));
    const sharedStale = { id: 'svc-b', json: { degraded: true } };
    const view = login({
      'svc-a': { id: 'svc-a', json: { degraded: true } },
      'svc-b': sharedStale,
    });

    // Core refreshed svc-a only; svc-b keeps its original entry object.
    update(view, { 'svc-a': { id: 'svc-a', json: { full: true } }, 'svc-b': sharedStale });
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-b');
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });

  it('requests a service that has no info response at all', () => {
    login({});
    vi.advanceTimersByTime(REPAIR_GRACE_MS);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
  });

  it('does not re-arm while authSucceeded stays true', () => {
    const stale = { 'svc-a': { id: 'svc-a' } };
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

    login({});
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
    const view = render(
      <LoginMonitor
        visibleCanvasesByWindow={twoCanvases}
        infoResponses={{}}
        authSucceeded={false}
        requestInfoResponse={requestInfoResponse}
      />,
    );
    view.rerender(
      <LoginMonitor
        visibleCanvasesByWindow={twoCanvases}
        infoResponses={{}}
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
  const renderMonitor = () => render(
    <LoginMonitor
      visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
      infoResponses={{ 'svc-a': { id: 'svc-a' } }}
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

    const view = render(
      <LoginMonitor
        visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
        infoResponses={{ 'svc-a': { id: 'svc-a' } }}
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
        infoResponses={{ 'svc-a': { id: 'svc-a' } }}
        authSucceeded
        requestInfoResponse={requestInfoResponse}
      />,
    );

    vi.advanceTimersByTime(REPAIR_GRACE_MS * 2);

    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });
});

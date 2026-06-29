import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { render } from '@testing-library/react';

// Mock `mirador` so we control the selectors/actions and avoid loading the full
// bundle (which triggers a jsdom HTMLCanvasElement.getContext error).
const getWindowIds = vi.fn();
const getVisibleCanvases = vi.fn();
const selectInfoResponses = vi.fn();
const requestInfoResponse = vi.fn();
const MiradorCanvas = vi.fn();

vi.mock('mirador', () => ({
  getWindowIds: (...args) => getWindowIds(...args),
  getVisibleCanvases: (...args) => getVisibleCanvases(...args),
  selectInfoResponses: (...args) => selectInfoResponses(...args),
  requestInfoResponse: (...args) => requestInfoResponse(...args),
  MiradorCanvas: function (...args) { return MiradorCanvas(...args); },
}));

// Import AFTER vi.mock so the mock is in effect.
const { default: plugin } = await import('../plugins/MiradorLoginPlugin.js');
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
        requestInfoResponse={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('registers and cleans up window listeners and restores window.open', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const originalOpen = window.open;

    const { unmount } = render(
      <LoginMonitor
        visibleCanvasesByWindow={{}}
        infoResponses={{}}
        requestInfoResponse={vi.fn()}
      />,
    );

    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(window.open).not.toBe(originalOpen);

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(window.open).toBe(originalOpen);
  });
});

describe('LoginMonitor refresh behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MiradorCanvas.mockReset();
    requestInfoResponse.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const renderMonitor = (props = {}) => render(
    <LoginMonitor
      visibleCanvasesByWindow={{}}
      infoResponses={{}}
      requestInfoResponse={requestInfoResponse}
      {...props}
    />,
  );

  // Dispatch an auth postMessage that the handler should recognize.
  const fireAuthMessage = (data) => {
    const event = new MessageEvent('message', { data });
    window.dispatchEvent(event);
  };

  it('requests info responses for image services on an auth message', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a', 'svc-b'] }));

    renderMonitor({
      visibleCanvasesByWindow: { w1: [{ id: 'c1' }] },
    });

    fireAuthMessage({ accessToken: 'abc' });
    // handler waits 1s before refreshing
    vi.advanceTimersByTime(1000);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
    expect(requestInfoResponse).toHaveBeenCalledWith('svc-b');
    expect(requestInfoResponse).toHaveBeenCalledTimes(2);
  });

  it('recognizes token and string-token message shapes', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));

    renderMonitor({ visibleCanvasesByWindow: { w1: [{ id: 'c1' }] } });

    fireAuthMessage({ token: 'xyz' });
    vi.advanceTimersByTime(1000);
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);

    // advance past the 2s debounce window
    vi.advanceTimersByTime(2000);

    fireAuthMessage('this is a token string');
    vi.advanceTimersByTime(1000);
    expect(requestInfoResponse).toHaveBeenCalledTimes(2);
  });

  it('ignores messages that are not auth tokens', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));

    renderMonitor({ visibleCanvasesByWindow: { w1: [{ id: 'c1' }] } });

    fireAuthMessage({ unrelated: 'data' });
    fireAuthMessage('nothing useful here');
    fireAuthMessage(null);
    vi.advanceTimersByTime(2000);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('debounces refreshes that happen within 2 seconds', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));

    renderMonitor({ visibleCanvasesByWindow: { w1: [{ id: 'c1' }] } });

    fireAuthMessage({ accessToken: 'abc' });
    vi.advanceTimersByTime(1000);
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);

    // Second message fires too soon - within the 2s debounce window
    fireAuthMessage({ accessToken: 'def' });
    vi.advanceTimersByTime(1000);
    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
  });

  it('skips refresh when there are no windows', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));

    renderMonitor({ visibleCanvasesByWindow: {} });

    fireAuthMessage({ accessToken: 'abc' });
    vi.advanceTimersByTime(1000);

    expect(requestInfoResponse).not.toHaveBeenCalled();
    expect(MiradorCanvas).not.toHaveBeenCalled();
  });

  it('skips falsy service ids but processes valid ones', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a', null, ''] }));

    renderMonitor({ visibleCanvasesByWindow: { w1: [{ id: 'c1' }] } });

    fireAuthMessage({ accessToken: 'abc' });
    vi.advanceTimersByTime(1000);

    expect(requestInfoResponse).toHaveBeenCalledTimes(1);
    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
  });

  it('logs and continues when a canvas throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    MiradorCanvas
      .mockImplementationOnce(() => { throw new Error('bad canvas'); })
      .mockImplementationOnce(() => ({ imageServiceIds: ['svc-ok'] }));

    renderMonitor({ visibleCanvasesByWindow: { w1: [{ id: 'c1' }, { id: 'c2' }] } });

    fireAuthMessage({ accessToken: 'abc' });
    vi.advanceTimersByTime(1000);

    expect(errorSpy).toHaveBeenCalled();
    expect(requestInfoResponse).toHaveBeenCalledWith('svc-ok');
  });
});

describe('LoginMonitor window.open interception', () => {
  let originalOpen;

  beforeEach(() => {
    vi.useFakeTimers();
    MiradorCanvas.mockReset();
    requestInfoResponse.mockReset();
    originalOpen = window.open;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.open = originalOpen;
  });

  const renderMonitor = () => render(
    <LoginMonitor
      visibleCanvasesByWindow={{ w1: [{ id: 'c1' }] }}
      infoResponses={{}}
      requestInfoResponse={requestInfoResponse}
    />,
  );

  it('refreshes after an auth popup is detected and closed on focus', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));
    const popup = { closed: false };
    // Set the underlying window.open BEFORE rendering so the plugin's wrapper
    // calls through to it and returns our fake popup.
    window.open = vi.fn().mockReturnValue(popup);

    renderMonitor();

    // Calls the plugin's wrapper, which delegates to the underlying mock.
    const returned = window.open('https://example.com/login', '_blank');
    expect(returned).toBe(popup);

    // User returns to the main window; popup has since closed.
    popup.closed = true;
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(100); // focus delay
    vi.advanceTimersByTime(500); // refresh delay

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
  });

  it('does not track popups for non-auth urls', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));
    window.open = vi.fn().mockReturnValue({ closed: true });

    renderMonitor();
    window.open('https://example.com/some-page', '_blank');

    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(600);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('refreshes when the popup cannot be accessed (cross-origin)', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));
    // Accessing `.closed` throws, simulating a cross-origin popup.
    const popup = { get closed() { throw new Error('cross-origin'); } };
    window.open = vi.fn().mockReturnValue(popup);

    renderMonitor();
    window.open('https://example.com/auth', '_blank');

    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(500);

    expect(requestInfoResponse).toHaveBeenCalledWith('svc-a');
  });

  it('ignores focus events when no popup is active', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));

    renderMonitor();
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(600);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });

  it('does not refresh while the popup is still open', () => {
    MiradorCanvas.mockImplementation(() => ({ imageServiceIds: ['svc-a'] }));
    window.open = vi.fn().mockReturnValue({ closed: false });

    renderMonitor();
    window.open('https://example.com/login', '_blank');

    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(600);

    expect(requestInfoResponse).not.toHaveBeenCalled();
  });
});

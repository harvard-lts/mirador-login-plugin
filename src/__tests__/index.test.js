import { describe, it, expect, vi } from 'vitest';

vi.mock('mirador', () => ({
  getWindowIds: vi.fn(),
  getVisibleCanvases: vi.fn(),
  selectInfoResponses: vi.fn(),
  requestInfoResponse: vi.fn(),
  getAuth: vi.fn(),
  addAuthenticationRequest: vi.fn(),
  miradorSlice: (state) => state,
  MiradorCanvas: vi.fn(),
}));

const plugins = (await import('../index.js')).default;
const { miradorLoginPlugin, miradorPopupBlockedBannerPlugin } = await import('../index.js');

describe('plugin barrel', () => {
  it('exports the login plugin as a default array', () => {
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins).toContain(miradorLoginPlugin);
  });

  it('named export matches the array entry', () => {
    expect(miradorLoginPlugin.target).toBe('BackgroundPluginArea');
  });

  it('exports the popup-blocked banner, targeting Window', () => {
    expect(plugins).toContain(miradorPopupBlockedBannerPlugin);
    expect(miradorPopupBlockedBannerPlugin.target).toBe('Window');
  });

  it('registers a reducer so the banner state reaches the store', () => {
    expect(Object.keys(miradorPopupBlockedBannerPlugin.reducers)).toHaveLength(1);
  });
});

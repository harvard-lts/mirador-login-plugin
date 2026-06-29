import { describe, it, expect, vi } from 'vitest';

vi.mock('mirador', () => ({
  getWindowIds: vi.fn(),
  getVisibleCanvases: vi.fn(),
  selectInfoResponses: vi.fn(),
  requestInfoResponse: vi.fn(),
  MiradorCanvas: vi.fn(),
}));

const plugins = (await import('../index.js')).default;
const { miradorLoginPlugin } = await import('../index.js');

describe('plugin barrel', () => {
  it('exports the login plugin as a default array', () => {
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins).toContain(miradorLoginPlugin);
  });

  it('named export matches the array entry', () => {
    expect(miradorLoginPlugin.target).toBe('BackgroundPluginArea');
  });
});

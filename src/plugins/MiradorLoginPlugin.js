import { useEffect, useRef } from 'react';
import {
  getWindowIds,
  getVisibleCanvases,
  selectInfoResponses,
  requestInfoResponse,
  MiradorCanvas,
} from 'mirador';

/**
 * Login Monitor Component
 * Monitors authentication state changes (login/logout) and refreshes canvas images
 * This component runs in the background and renders no UI
 */
const LoginMonitor = ({ visibleCanvasesByWindow, infoResponses, requestInfoResponse }) => {
  // Store latest props in refs so event handlers can access current values
  const propsRef = useRef({ visibleCanvasesByWindow, infoResponses, requestInfoResponse });
  const activePopupRef = useRef(null);
  const lastRefreshTimeRef = useRef(0);
  
  // Update refs when props change
  useEffect(() => {
    propsRef.current = { visibleCanvasesByWindow, infoResponses, requestInfoResponse };
  }, [visibleCanvasesByWindow, infoResponses, requestInfoResponse]);

  useEffect(() => {
    /**
     * Refresh all visible canvas images across all windows
     * by dispatching requestInfoResponse for each image service
     * This re-fetches info.json with new authentication credentials
     */
    const refreshCanvases = () => {
      // Debounce: prevent multiple refreshes within 2 seconds
      const now = Date.now();
      if (now - lastRefreshTimeRef.current < 2000) {
        // Skipping duplicate refresh (too soon after last refresh)
        return;
      }
      lastRefreshTimeRef.current = now;
      
      const { visibleCanvasesByWindow, requestInfoResponse } = propsRef.current;
      if (!visibleCanvasesByWindow || Object.keys(visibleCanvasesByWindow).length === 0) {
        // No windows found, skipping refresh
        return;
      }

      let totalInfoResponsesRequested = 0;

      // Iterate through all windows and their visible canvases
      Object.entries(visibleCanvasesByWindow).forEach(([windowId, canvases]) => {        
        // Extract image service IDs from each canvas
        canvases.forEach((canvas, index) => {
          try {
            const miradorCanvas = new MiradorCanvas(canvas);
            const imageServiceIds = miradorCanvas.imageServiceIds;
            
            // Request info response for each service - this triggers re-fetch with auth
            imageServiceIds.forEach((serviceId) => {
              if (serviceId) {
                requestInfoResponse(serviceId);
                totalInfoResponsesRequested++;
              }
            });
          } catch (error) {
            console.error(`[LoginMonitor] Error processing canvas ${index + 1}:`, error);
          }
        });
      });
    };
    
    /**
     * Listen for IIIF Auth API postMessage events
     * When Mirador completes authentication, it receives a postMessage with the token
     */
    const handleAuthMessage = (event) => {      
      // Check if this is an IIIF Auth token message
      // The message should contain accessToken or indicate successful auth
      if (event.data && (
        event.data.accessToken || 
        event.data.token ||
        (typeof event.data === 'string' && event.data.includes('token'))
      )) {
        // Wait for Mirador to process the token, then request fresh info.json
        setTimeout(() => {
          refreshCanvases();
        }, 1000);
      }
    };
    
    /**
     * Handle window focus event to detect when user returns from auth popup
     */
    const handleWindowFocus = () => {
      // Only process if we have an active popup reference
      if (activePopupRef.current) {
        // Main window regained focus, checking if popup closed
        
        // Small delay to ensure popup state is updated
        setTimeout(() => {
          try {
            // Verify popup is actually closed
            if (activePopupRef.current.closed) {
              // Auth popup confirmed closed, refreshing canvases
              activePopupRef.current = null;
              
              // Refresh canvases after popup closes
              setTimeout(() => {
                refreshCanvases();
              }, 500);
            }
          } catch (error) {
            // If we can't access the popup, assume it's closed
            // Cannot access popup (likely closed or cross-origin)
            activePopupRef.current = null;
            
            setTimeout(() => {
              refreshCanvases();
            }, 500);
          }
        }, 100);
      }
    };
    
    /**
     * Intercept window.open to detect when auth popup opens
     */
    const originalWindowOpen = window.open;
    window.open = function(...args) {
      const popup = originalWindowOpen.apply(this, args);
      
      // Check if this looks like an auth popup (by URL pattern)
      const url = args[0];
      if (popup && url && (url.includes('login') || url.includes('auth'))) {
        // Auth popup detected
        activePopupRef.current = popup;
      }
      
      return popup;
    };
    
    // Add event listeners
    window.addEventListener('message', handleAuthMessage);
    window.addEventListener('focus', handleWindowFocus);    
    
    // Cleanup
    return () => {
      window.removeEventListener('message', handleAuthMessage);
      window.removeEventListener('focus', handleWindowFocus);
      // Restore original window.open
      window.open = originalWindowOpen;
    };
  }, []); // Empty dependency array - only run once on mount

  // No UI - this component runs in the background
  return null;
};

/**
 * Map Redux state to component props
 * Gets viewer-wide window IDs and info responses (not scoped to a single window)
 * Creates a map of visible canvases for each window
 */
const mapStateToProps = (state) => {
  const windowIds = getWindowIds(state);
  const visibleCanvasesByWindow = {};
  
  // Get visible canvases for each window
  windowIds.forEach((windowId) => {
    visibleCanvasesByWindow[windowId] = getVisibleCanvases(state, { windowId });
  });
  
  return {
    visibleCanvasesByWindow,
    infoResponses: selectInfoResponses(state),
  };
};

/**
 * Map dispatch actions to component props
 */
const mapDispatchToProps = {
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

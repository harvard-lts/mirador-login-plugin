import React, { useEffect, useRef } from 'react';
import { getWindowIds } from 'mirador/dist/es/src/state/selectors/getters';
import { getVisibleCanvases, selectInfoResponses } from 'mirador/dist/es/src/state/selectors/canvases';
import { requestInfoResponse } from 'mirador/dist/es/src/state/actions/infoResponse';
import MiradorCanvas from 'mirador/dist/es/src/lib/MiradorCanvas';

/**
 * Check if a specific cookie exists
 */
const hasCookie = (cookieName) => {
  const cookies = document.cookie.split(';');
  const found = cookies.some((cookie) => {
    return cookie.trim().startsWith(cookieName + '=');
  });
  console.log(`[hasCookie] Looking for "${cookieName}", found:`, found);
  return found;
};

/**
 * Login Monitor Component
 * Monitors authentication state changes (login/logout) and refreshes canvas images
 * This component runs in the background and renders no UI
 */
const LoginMonitor = ({ visibleCanvasesByWindow, infoResponses, requestInfoResponse }) => {
  console.log('[LoginMonitor] Component instantiated with props:', {
    windowCount: Object.keys(visibleCanvasesByWindow || {}).length,
    infoResponseCount: Object.keys(infoResponses || {}).length,
    hasRequestInfoResponse: typeof requestInfoResponse === 'function'
  });
  
  const previousLoginStateRef = useRef(null);
  const logoutTimeoutRef = useRef(null);
  const intervalRef = useRef(null);
  
  // Store latest props in refs so the interval can access current values
  const propsRef = useRef({ visibleCanvasesByWindow, infoResponses, requestInfoResponse });
  
  // Update refs when props change
  useEffect(() => {
    propsRef.current = { visibleCanvasesByWindow, infoResponses, requestInfoResponse };
  }, [visibleCanvasesByWindow, infoResponses, requestInfoResponse]);

  useEffect(() => {
    console.log('[LoginMonitor] Initializing authentication monitor');
    console.log('[LoginMonitor] Listening for IIIF Auth postMessage events');
    
    /**
     * Refresh all visible canvas images across all windows
     * by dispatching requestInfoResponse for each image service
     * This re-fetches info.json with new authentication credentials
     */
    const refreshCanvases = () => {
      const { visibleCanvasesByWindow, requestInfoResponse } = propsRef.current;
      
      console.log('[LoginMonitor] Refreshing canvases across all windows');
      console.log('[LoginMonitor] Windows with canvases:', Object.keys(visibleCanvasesByWindow));
      
      if (!visibleCanvasesByWindow || Object.keys(visibleCanvasesByWindow).length === 0) {
        console.log('[LoginMonitor] No windows found, skipping refresh');
        return;
      }

      let totalInfoResponsesRequested = 0;

      // Iterate through all windows and their visible canvases
      Object.entries(visibleCanvasesByWindow).forEach(([windowId, canvases]) => {
        console.log(`[LoginMonitor] Processing window: ${windowId}`);
        console.log(`[LoginMonitor] Found ${canvases.length} visible canvases in window ${windowId}`);
        
        // Extract image service IDs from each canvas
        canvases.forEach((canvas, index) => {
          try {
            const miradorCanvas = new MiradorCanvas(canvas);
            const imageServiceIds = miradorCanvas.imageServiceIds;
            
            console.log(`[LoginMonitor] Canvas ${index + 1} has ${imageServiceIds.length} image services`);
            
            // Request info response for each service - this triggers re-fetch with auth
            imageServiceIds.forEach((serviceId) => {
              if (serviceId) {
                console.log(`[LoginMonitor] Requesting info response for service: ${serviceId}`);
                requestInfoResponse(serviceId);
                totalInfoResponsesRequested++;
              }
            });
          } catch (error) {
            console.error(`[LoginMonitor] Error processing canvas ${index + 1}:`, error);
          }
        });
      });

      console.log(`[LoginMonitor] Refresh complete. Requested ${totalInfoResponsesRequested} info responses`);
    };
    
    /**
     * Listen for IIIF Auth API postMessage events
     * When Mirador completes authentication, it receives a postMessage with the token
     */
    const handleAuthMessage = (event) => {
      console.log('[LoginMonitor] Received postMessage:', {
        origin: event.origin,
        data: event.data
      });
      
      // Check if this is an IIIF Auth token message
      // The message should contain accessToken or indicate successful auth
      if (event.data && (
        event.data.accessToken || 
        event.data.token ||
        (typeof event.data === 'string' && event.data.includes('token'))
      )) {
        console.log('[LoginMonitor] LOGIN DETECTED via IIIF Auth postMessage');
        console.log('[LoginMonitor] Auth data:', event.data);
        
        // Wait for Mirador to process the token, then request fresh info.json
        setTimeout(() => {
          console.log('[LoginMonitor] Requesting fresh info responses with authentication');
          refreshCanvases();
        }, 1000);
      }
    };
    
    // Add postMessage listener
    window.addEventListener('message', handleAuthMessage);
    console.log('[LoginMonitor] postMessage listener registered');
    
    // Cleanup
    return () => {
      console.log('[LoginMonitor] Cleaning up authentication monitor');
      window.removeEventListener('message', handleAuthMessage);
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

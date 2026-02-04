import React, { useEffect, useRef } from 'react';
import { getWindowIds } from 'mirador/dist/es/src/state/selectors/getters';
import { getVisibleCanvases, selectInfoResponses } from 'mirador/dist/es/src/state/selectors/canvases';
import { requestInfoResponse, removeInfoResponse } from 'mirador/dist/es/src/state/actions/infoResponse';
import { addAuthenticationRequest, receiveAccessToken } from 'mirador/dist/es/src/state/actions/auth';
import { setCanvas } from 'mirador/dist/es/src/state/actions/canvas';
import MiradorCanvas from 'mirador/dist/es/src/lib/MiradorCanvas';

/**
 * Login Monitor Component
 * Monitors authentication state changes (login/logout) and refreshes canvas images
 * This component runs in the background and renders no UI
 */
const LoginMonitor = ({ visibleCanvasesByWindow, infoResponses, state, requestInfoResponse, removeInfoResponse, addAuthenticationRequest, receiveAccessToken, setCanvas }) => {
  // Store latest props in refs so event handlers can access current values
  const propsRef = useRef({ visibleCanvasesByWindow, infoResponses, state, requestInfoResponse, removeInfoResponse, addAuthenticationRequest, receiveAccessToken, setCanvas });
  const activePopupRef = useRef(null);
  const lastRefreshTimeRef = useRef(0);
  const hasCheckedInitialAuth = useRef(false);
  
  // Update refs when props change
  useEffect(() => {
    propsRef.current = { visibleCanvasesByWindow, infoResponses, state, requestInfoResponse, removeInfoResponse, addAuthenticationRequest, receiveAccessToken, setCanvas };
  }, [visibleCanvasesByWindow, infoResponses, state, requestInfoResponse, removeInfoResponse, addAuthenticationRequest, receiveAccessToken, setCanvas]);
  
  // Check for existing auth on mount - trigger refresh when canvases become available
  useEffect(() => {
    if (!hasCheckedInitialAuth.current && visibleCanvasesByWindow && Object.keys(visibleCanvasesByWindow).length > 0) {
      hasCheckedInitialAuth.current = true;
      
      // Delay to ensure Mirador has finished processing initial info.json
      setTimeout(() => {
        const { visibleCanvasesByWindow, infoResponses, state, requestInfoResponse, removeInfoResponse, addAuthenticationRequest, receiveAccessToken, setCanvas } = propsRef.current;
        
        let refreshCount = 0;
        Object.entries(visibleCanvasesByWindow).forEach(([windowId, canvases]) => {
          canvases.forEach((canvas) => {
            try {
              const miradorCanvas = new MiradorCanvas(canvas);
              const imageServiceIds = miradorCanvas.imageServiceIds;
              
              imageServiceIds.forEach((serviceId) => {
                if (serviceId && infoResponses[serviceId]) {
                  const info = infoResponses[serviceId];
                  
                  // Check if this service has authentication
                  // The actual IIIF data is in info.json
                  const iiifData = info.json || info;
                  const services = Array.isArray(iiifData.service) ? iiifData.service : (iiifData.service ? [iiifData.service] : []);
                  const hasAuthService = services.some(s => 
                    s.profile && typeof s.profile === 'string' && (
                      s.profile.includes('/auth/') ||
                      s.profile.includes('login') || 
                      s.profile.includes('clickthrough') ||
                      s.profile.includes('external') ||
                      s.profile.includes('kiosk') ||
                      s.profile.includes('logout')
                    )
                  );
                  
                  // Also check if the info itself has an auth profile
                  const infoHasAuth = iiifData.profile && typeof iiifData.profile === 'string' && 
                    iiifData.profile.includes('/auth/');
                  
                  if (hasAuthService || infoHasAuth) {
                    requestInfoResponse(serviceId);
                    refreshCount++;
                    
                    // Trigger Mirador's auth flow to check if user is authenticated
                    const authService = iiifData.service;
                    
                    if (authService && authService['@id']) {
                      
                      const tokenService = authService.service && Array.isArray(authService.service) 
                        ? authService.service.find(s => s.profile && s.profile.includes('/token'))
                        : null;
                      
                      if (tokenService && tokenService['@id']) {
                        // Check if we previously authenticated successfully
                        // Use domain-based key to work across different objects from same auth provider
                        let storageKey;
                        let authDataString;
                        
                        try {
                          const url = new URL(tokenService['@id']);
                          const authDomain = url.origin;
                          storageKey = 'miradorAuthSuccess_' + authDomain;
                          authDataString = localStorage.getItem(storageKey);
                        } catch (e) {
                          // Fallback to specific token service ID
                          storageKey = 'miradorAuthSuccess_' + tokenService['@id'];
                          authDataString = localStorage.getItem(storageKey);
                        }
                        
                        if (authDataString) {
                          try {
                            const authData = JSON.parse(authDataString);
                            const now = Date.now();
                            
                            // Check if auth has expired
                            if (authData.expiresAt && now > authData.expiresAt) {
                              localStorage.removeItem(storageKey);
                            } else {
                              setTimeout(() => {
                                // Restore auth state in Redux
                                addAuthenticationRequest(authService['@id'], authService.profile, windowId);
                                // Note: We use a placeholder token since we can't fetch the real one
                                // The actual auth will work via cookies on image requests
                                const timeUntilExpiry = Math.floor((authData.expiresAt - now) / 1000);
                                receiveAccessToken(authService['@id'], tokenService['@id'], {
                                  accessToken: 'restored-session',
                                  expiresIn: timeUntilExpiry
                                });
                              }, 1000);
                            }
                          } catch (e) {
                            // Invalid JSON, clear it
                            localStorage.removeItem(storageKey);
                          }
                        }
                      }
                    }
                  }
                }
              });
            } catch (error) {
              console.error('[LoginMonitor] Error during initial auth check:', error);
            }
          });
        });
      }, 3000);
    }
  }, [visibleCanvasesByWindow]);

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
        return;
      }
      lastRefreshTimeRef.current = now;
      
      const { visibleCanvasesByWindow, requestInfoResponse, removeInfoResponse } = propsRef.current;
      if (!visibleCanvasesByWindow || Object.keys(visibleCanvasesByWindow).length === 0) {
        return;
      }

      // Iterate through all windows and their visible canvases
      Object.entries(visibleCanvasesByWindow).forEach(([windowId, canvases]) => {        
        // Extract image service IDs from each canvas
        canvases.forEach((canvas, index) => {
          try {
            const miradorCanvas = new MiradorCanvas(canvas);
            const imageServiceIds = miradorCanvas.imageServiceIds;
            
            // First remove cached info responses, then request fresh ones
            imageServiceIds.forEach((serviceId) => {
              if (serviceId) {
                removeInfoResponse(serviceId);
              }
            });
          } catch (error) {
            console.error(`[LoginMonitor] Error processing canvas ${index + 1}:`, error);
          }
        });
      });
      
      // Request new info responses after brief delay to ensure removal is processed
      setTimeout(() => {
        Object.entries(visibleCanvasesByWindow).forEach(([windowId, canvases]) => {        
          canvases.forEach((canvas, index) => {
            try {
              const miradorCanvas = new MiradorCanvas(canvas);
              const imageServiceIds = miradorCanvas.imageServiceIds;
              
              imageServiceIds.forEach((serviceId) => {
                if (serviceId) {
                  requestInfoResponse(serviceId);
                }
              });
            } catch (error) {
              console.error(`[LoginMonitor] Error requesting info ${index + 1}:`, error);
            }
          });
        });
      }, 100);
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
        // Store auth success in localStorage
        if (event.data.messageId) {
          const expiresIn = event.data.expiresIn || 3600; // Default to 1 hour
          const expirationTime = Date.now() + (expiresIn * 1000);
          
          const authData = {
            authenticated: true,
            expiresAt: expirationTime
          };
          
          // Extract domain from messageId to use as key (works across different objects from same auth provider)
          try {
            const url = new URL(event.data.messageId);
            const authDomain = url.origin; // e.g., "http://localhost:23000"
            localStorage.setItem('miradorAuthSuccess_' + authDomain, JSON.stringify(authData));
          } catch (e) {
            // Fallback to original messageId if URL parsing fails
            localStorage.setItem('miradorAuthSuccess_' + event.data.messageId, JSON.stringify(authData));
          }
        }
        
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
        // Small delay to ensure popup state is updated
        setTimeout(() => {
          try {
            // Verify popup is actually closed
            if (activePopupRef.current.closed) {
              activePopupRef.current = null;
              
              // Refresh canvases after popup closes (for both login and logout)
              setTimeout(() => {
                refreshCanvases();
              }, 500);
            }
          } catch (error) {
            // If we can't access the popup, assume it's closed
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
      if (popup && url && (url.includes('login') || url.includes('auth') || url.includes('logout'))) {
        activePopupRef.current = popup;
        
        // Mark if this is a logout popup
        if (url.includes('logout')) {
          popup.__isLogout = true;
        }
      }
      
      return popup;
    };
    
    /**
     * Intercept fetch to detect logout requests
     */
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      
      if (url && url.includes('logout')) {
        // After logout completes, refresh canvases and clear localStorage
        return originalFetch.apply(this, args).then(response => {
          if (response.ok) {
            // Clear localStorage immediately
            Object.keys(localStorage).forEach(key => {
              if (key.startsWith('miradorAuthSuccess_')) {
                localStorage.removeItem(key);
              }
            });
            
            // Wait for logout to fully complete on server
            setTimeout(() => {
              refreshCanvases();
            }, 1000);
          }
          return response;
        });
      }
      
      return originalFetch.apply(this, args);
    };
    
    /**
     * Detect logout button clicks
     */
    const handleClick = (event) => {
      // Check if click was on or inside a logout button
      const target = event.target.closest('button');
      if (target && (
        target.textContent.toLowerCase().includes('logout') ||
        target.textContent.toLowerCase().includes('log out') ||
        target.getAttribute('aria-label')?.toLowerCase().includes('logout')
      )) {
        // Clear localStorage immediately
        Object.keys(localStorage).forEach(key => {
          if (key.startsWith('miradorAuthSuccess_')) {
            localStorage.removeItem(key);
          }
        });
        
        // Wait for logout to complete, then refresh
        setTimeout(() => {
          refreshCanvases();
        }, 1000);
      }
    };
    
    // Add event listeners
    window.addEventListener('message', handleAuthMessage);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('click', handleClick, true); // Use capture phase to catch it early
    
    // Cleanup
    return () => {
      window.removeEventListener('message', handleAuthMessage);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('click', handleClick, true);
      // Restore original window.open and fetch
      window.open = originalWindowOpen;
      window.fetch = originalFetch;
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
    state,
    visibleCanvasesByWindow,
    infoResponses: selectInfoResponses(state),
  };
};

/**
 * Map dispatch actions to component props
 */
const mapDispatchToProps = {
  requestInfoResponse,
  removeInfoResponse,
  addAuthenticationRequest,
  receiveAccessToken,
  setCanvas,
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

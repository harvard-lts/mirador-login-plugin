import React, { Component } from 'react';
import Paper from '@material-ui/core/Paper';
import Typography from '@material-ui/core/Typography';
import Button from '@material-ui/core/Button';
import { getCurrentCanvas } from 'mirador/dist/es/src/state/selectors/canvases';

/**
 * Custom authentication bar component that replaces Mirador's WindowAuthenticationBar
 * Displays header and label from the auth service in the manifest's info.json
 */
class CustomAuthenticationBar extends Component {
  /**
   * Check if a specific cookie exists
   */
  hasCookie(cookieName) {
    return document.cookie.split(';').some((cookie) => {
      return cookie.trim().startsWith(cookieName + '=');
    });
  }

  render() {
    const { 
      classes, 
      header, 
      label, 
      confirmButton, 
      confirmLabel, 
      authServiceId,
      logoutServiceId,
      logoutLabel,
      logoutConfirm,
      canvas
    } = this.props;
    
    // Debug: Log all cookies
    console.log('All cookies:', document.cookie);
    console.log('Cookie array:', document.cookie.split(';').map(c => c.trim()));
    
    // Check if user is logged in by checking for the cookie
    const isLoggedIn = this.hasCookie('mps-login-access-local');
    console.log('Is logged in (has mps-login-access-local cookie):', isLoggedIn);
    
    // Get canvas thumbnail ID
    console.log('Canvas object:', canvas);
    console.log('Canvas __jsonld:', canvas && canvas.__jsonld);
    
    let canvasThumbnailId = '';
    if (canvas) {
      // Try different ways to access the thumbnail
      if (canvas.__jsonld && canvas.__jsonld.thumbnail) {
        const thumb = canvas.__jsonld.thumbnail;
        canvasThumbnailId = thumb['@id'] || thumb.id || (Array.isArray(thumb) && thumb[0] && (thumb[0]['@id'] || thumb[0].id)) || '';
      }
      // Try getThumbnail method if available
      if (!canvasThumbnailId && typeof canvas.getThumbnail === 'function') {
        const thumbnail = canvas.getThumbnail();
        console.log('Thumbnail from getThumbnail():', thumbnail);
        if (thumbnail) {
          canvasThumbnailId = thumbnail.id || thumbnail['@id'] || '';
        }
      }
      // Try getProperty method
      if (!canvasThumbnailId && typeof canvas.getProperty === 'function') {
        const thumbnail = canvas.getProperty('thumbnail');
        console.log('Thumbnail from getProperty():', thumbnail);
        if (thumbnail) {
          canvasThumbnailId = thumbnail.id || thumbnail['@id'] || (Array.isArray(thumbnail) && thumbnail[0] && (thumbnail[0]['@id'] || thumbnail[0].id)) || '';
        }
      }
      
      // Extract the part between "assets/images" and "/full/"
      if (canvasThumbnailId) {
        const match = canvasThumbnailId.match(/assets\/images\/([^/]+)\/full\//);
        if (match && match[1]) {
          canvasThumbnailId = '/' + match[1];
        }
      }
    }
    console.log('Canvas thumbnail ID:', canvasThumbnailId);
    
    // Determine which button to show
    const buttonLabel = isLoggedIn 
      ? (logoutConfirm || logoutLabel || 'Logout')
      : (confirmButton || confirmLabel || 'Login');
    
    let buttonUrl = isLoggedIn ? logoutServiceId : authServiceId;
    
    // Add parameters to login URL
    if (!isLoggedIn && buttonUrl) {
      const separator = buttonUrl.includes('?') ? '&' : '?';
      buttonUrl = `${buttonUrl}${separator}target=${encodeURIComponent('/assets/image')}`;
      if (canvasThumbnailId) {
        buttonUrl = `${buttonUrl}&path=${encodeURIComponent(canvasThumbnailId)}`;
      }
    }
    
    console.log('Button label:', buttonLabel, 'Button URL:', buttonUrl);
    
    return (
      <Paper
        square
        elevation={4}
        color="secondary"
        classes={{ root: classes.paper }}
      >
        <div className={classes.topBar}>
          <Typography
            className={classes.label}
            component="h3"
            variant="body1"
            color="inherit"
          >
            {header && label ? `${header}: ${label}` : (header || label || '')}
          </Typography>
          <Button
            component="a"
            href={buttonUrl}
            className={classes.buttonInvert}
            color="secondary"
          >
            {buttonLabel}
          </Button>
        </div>
      </Paper>
    );
  }
}

/**
 * Plugin configuration to replace WindowAuthenticationBar with CustomAuthenticationBar
 */
const mapStateToProps = (state, { windowId }) => ({
  canvas: getCurrentCanvas(state, { windowId }),
});

export default {
  target: 'WindowAuthenticationBar',
  mode: 'wrap',
  component: CustomAuthenticationBar,
  mapStateToProps,
};

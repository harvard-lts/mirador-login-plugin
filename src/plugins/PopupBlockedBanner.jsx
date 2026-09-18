import PropTypes from 'prop-types';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { styled } from '@mui/material/styles';
import LockIcon from '@mui/icons-material/LockSharp';
import { addAuthenticationRequest } from 'mirador';
import {
  clearPopupBlocked, popupBlockedReducers, selectPopupBlocked,
} from '../state/popupBlocked';

/**
 * Mirador renders the `Window` plugin hook as the last child of a flex-column
 * Window, which would put this below the thumbnail strip — too buried for a
 * message explaining why the image is low resolution. `order: -1` lifts it to
 * the top of the window instead. Remove the `order` to get the default
 * bottom-of-window placement.
 */
const Bar = styled(Paper, { name: 'PopupBlockedBanner', slot: 'root' })(({ theme }) => ({
  alignItems: 'center',
  backgroundColor: theme.palette.secondary.main,
  borderRadius: 0,
  color: theme.palette.secondary.contrastText,
  display: 'flex',
  flexWrap: 'wrap',
  gap: theme.spacing(1),
  order: -1,
  padding: theme.spacing(1),
}));

/**
 * Shown when the browser refused to open the auth popup.
 *
 * The kiosk service is opened by Mirador with no user gesture behind it, which
 * browsers block under their default pop-up policy. A click, by contrast,
 * carries transient user activation — so Retry re-dispatches the same auth
 * request and the popup is permitted without the user changing any browser
 * setting. The reload hint covers the case where pop-ups are explicitly blocked
 * for this site, which no amount of clicking can work around.
 */
export const PopupBlockedBanner = ({
  blocked = undefined, windowId, requestAuth, dismiss,
}) => {
  if (!blocked) return null;

  const retry = () => {
    // Clear first: if the popup is blocked again, the window.open patch
    // re-dispatches and the banner comes straight back.
    dismiss({ windowId });
    requestAuth(windowId, blocked.authServiceId, blocked.profile);
  };

  return (
    <Bar square elevation={4}>
      <LockIcon sx={{ marginInlineEnd: 1 }} />
      <Typography component="h3" variant="body1" color="inherit" sx={{ flexGrow: 1 }}>
        In-library access needs a pop-up window.
        <Typography component="span" variant="body2" color="inherit" sx={{ display: 'block' }}>
          Still blocked? Allow pop-ups for this site, then reload.
        </Typography>
      </Typography>
      <Button
        onClick={retry}
        color="secondary"
        sx={(theme) => ({
          backgroundColor: theme.palette.secondary.contrastText,
          lineHeight: '1.5rem',
        })}
      >
        Retry
      </Button>
    </Bar>
  );
};

PopupBlockedBanner.propTypes = {
  blocked: PropTypes.shape({
    authServiceId: PropTypes.string,
    profile: PropTypes.string,
  }),
  dismiss: PropTypes.func.isRequired,
  requestAuth: PropTypes.func.isRequired,
  windowId: PropTypes.string.isRequired,
};

export const mapStateToProps = (state, { windowId }) => ({
  blocked: selectPopupBlocked(state, windowId),
});

export const mapDispatchToProps = {
  dismiss: clearPopupBlocked,
  requestAuth: addAuthenticationRequest,
};

export default {
  component: PopupBlockedBanner,
  mapDispatchToProps,
  mapStateToProps,
  mode: 'add',
  reducers: popupBlockedReducers,
  target: 'Window',
};

import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const popup = style({
  position: 'fixed',
  right: 16,
  bottom: 72,
  zIndex: 3,
  width: 'min(440px, calc(100vw - 32px))',
  height: 'min(680px, calc(100vh - 104px))',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 12,
  overflow: 'hidden',
  border: `0.5px solid ${cssVar('borderColor')}`,
  background: cssVar('backgroundPrimaryColor'),
  boxShadow: cssVar('overlayPanelShadow'),
  selectors: {
    '&[data-open="false"]': {
      display: 'none',
    },
  },
});

export const header = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 8px 8px 16px',
  borderBottom: `0.5px solid ${cssVarV2('layer/insideBorder/border')}`,
});

export const title = style({
  fontSize: cssVar('fontSm'),
  fontWeight: 600,
  whiteSpace: 'nowrap',
});

export const tabsContainer = style({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
});

export const content = style({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  padding: '0 12px',
});

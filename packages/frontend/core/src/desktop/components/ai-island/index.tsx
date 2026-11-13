import { WorkbenchService } from '@affine/core/modules/workbench';
import { useLiveData, useService } from '@toeverything/infra';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';

import { FloatingAIChat } from '../ai-floating-chat';
import { IslandContainer } from './container';
import { AIIcon } from './icons';
import { aiIslandBtn, aiIslandWrapper, toolStyle } from './styles.css';

const hideChat: Array<string | ((path: string) => boolean)> = [
  '/chat',
  path => path.includes('attachments'),
];

export const AIIsland = () => {
  // to make sure ai island is hidden first and animate in
  const [hide, setHide] = useState(true);
  const [open, setOpen] = useState(false);
  // keep the chat mounted once opened, so closing the popup keeps the session
  const [mounted, setMounted] = useState(false);

  const workbench = useService(WorkbenchService).workbench;
  const activeView = useLiveData(workbench.activeView$);
  const activeLocation = useLiveData(activeView.location$);

  useEffect(() => {
    const path = activeLocation.pathname;
    const hide = hideChat.some(item =>
      typeof item === 'string' ? path === item : item(path)
    );
    setHide(hide);
    if (hide) setOpen(false);
  }, [activeLocation.pathname]);

  const onToggleChat = useCallback(() => {
    if (hide) return;
    setMounted(true);
    setOpen(open => !open);
  }, [hide]);

  const onCloseChat = useCallback(() => setOpen(false), []);

  return (
    <>
      {mounted ? (
        <FloatingAIChat open={open && !hide} onClose={onCloseChat} />
      ) : null}
      <IslandContainer className={clsx(toolStyle, { hide })}>
        <div className={aiIslandWrapper} data-hide={hide}>
          <button
            className={aiIslandBtn}
            data-testid="ai-island"
            data-active={open}
            onClick={onToggleChat}
          >
            <AIIcon />
          </button>
        </div>
      </IslandContainer>
    </>
  );
};

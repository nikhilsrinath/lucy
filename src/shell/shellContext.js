import { createContext, useContext } from 'react';

/* What the frame offers the screens inside it: starting a call from anywhere
   (the sidebar's call button, the composer's phone button, a brief item).
   The provider lives in ShellProvider.jsx. */

export const ShellCtx = createContext({ canCall: false, startCall: () => {}, endCall: () => {}, call: null });

export const useShell = () => useContext(ShellCtx);

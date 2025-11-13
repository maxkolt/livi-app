import React, { createContext, useContext, useRef, ReactNode } from 'react';

interface WebRTCContextType {
  prewarmedStreamRef: React.MutableRefObject<any | null>;
  prewarmedPcRef: React.MutableRefObject<any | null>;
  webrtcPrewarmedRef: React.MutableRefObject<boolean>;
}

const WebRTCContext = createContext<WebRTCContextType | null>(null);

export const WebRTCProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const prewarmedStreamRef = useRef<any | null>(null);
  const prewarmedPcRef = useRef<any | null>(null);
  const webrtcPrewarmedRef = useRef<boolean>(false);

  return (
    <WebRTCContext.Provider value={{
      prewarmedStreamRef,
      prewarmedPcRef,
      webrtcPrewarmedRef
    }}>
      {children}
    </WebRTCContext.Provider>
  );
};

export const useWebRTC = (): WebRTCContextType => {
  const context = useContext(WebRTCContext);
  if (!context) {
    throw new Error('useWebRTC must be used within a WebRTCProvider');
  }
  return context;
};

// Ambient declaration for Bare, the global passed by the Pear worker host.
declare const Bare: {
  IPC: import('bare-stream').Duplex;
  exit: (code?: number) => void;
  platform: string;
};

// Ambient declarations for the runtime globals the worker files reach.
// Bare is the global passed by the Pear worker host.
declare const Bare: {
  IPC: import('bare-stream').Duplex;
  exit: (code?: number) => void;
  platform: string;
};

export type RealtimeSocket = {
  connected?: boolean;
  disconnect: () => void;
  emit: (event: string, payload?: unknown) => void;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler?: (...args: any[]) => void) => void;
};

type SocketIoFactory = (url: string, options: Record<string, unknown>) => RealtimeSocket;

declare global {
  interface Window {
    io?: SocketIoFactory;
    __socketIoScriptPromise?: Promise<void>;
  }
}

let socketInstance: RealtimeSocket | null = null;

function normalizeSocketUrl(url: string) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function ensureSocketIoClient(socketUrl: string): Promise<SocketIoFactory | null> {
  if (typeof window === 'undefined') return null;
  if (window.io) return window.io;

  if (!window.__socketIoScriptPromise) {
    window.__socketIoScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${normalizeSocketUrl(socketUrl)}/socket.io/socket.io.js`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load socket.io-client runtime'));
      document.head.appendChild(script);
    });
  }

  await window.__socketIoScriptPromise;
  return window.io ?? null;
}

export async function createSocketConnection(token: string): Promise<RealtimeSocket | null> {
  const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL;

  if (!socketUrl) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('NEXT_PUBLIC_SOCKET_URL is missing. Realtime features are disabled.');
    }
    return null;
  }

  if (socketInstance?.connected) {
    return socketInstance;
  }

  const ioFactory = await ensureSocketIoClient(socketUrl);
  if (!ioFactory) return null;

  socketInstance = ioFactory(socketUrl, {
    autoConnect: true,
    transports: ['websocket', 'polling'],
    auth: {
      token,
    },
  });

  return socketInstance;
}

export function getSocket(): RealtimeSocket | null {
  return socketInstance;
}

export function disconnectSocket(): void {
  if (!socketInstance) return;
  socketInstance.disconnect();
  socketInstance = null;
}

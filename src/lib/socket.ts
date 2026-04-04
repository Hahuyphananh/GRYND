import { io, Socket } from 'socket.io-client';

let socketInstance: Socket | null = null;

export function createSocketConnection(token: string): Socket | null {
  const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL;

  if (!socketUrl) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('NEXT_PUBLIC_SOCKET_URL is missing. Realtime features are disabled.');
    }
    return null;
  }

  if (socketInstance && socketInstance.connected) {
    return socketInstance;
  }

  socketInstance = io(socketUrl, {
    autoConnect: true,
    transports: ['websocket', 'polling'],
    auth: {
      token,
    },
  });

  return socketInstance;
}

export function getSocket(): Socket | null {
  return socketInstance;
}

export function disconnectSocket(): void {
  if (!socketInstance) return;
  socketInstance.disconnect();
  socketInstance = null;
}

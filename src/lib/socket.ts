'use client';

import { io, type Socket } from 'socket.io-client';

let socketInstance: Socket | null = null;

const getSocketUrl = () => {
  const url = process.env.NEXT_PUBLIC_SOCKET_URL;
  if (!url) {
    throw new Error('NEXT_PUBLIC_SOCKET_URL is not defined');
  }
  return url;
};

export const createSocketConnection = (token?: string): Socket => {
  if (socketInstance?.connected) {
    return socketInstance;
  }

  socketInstance = io(getSocketUrl(), {
    autoConnect: false,
    transports: ['websocket'],
    auth: token ? { token } : {},
  });

  socketInstance.connect();
  return socketInstance;
};

export const getSocket = () => socketInstance;

export const disconnectSocket = () => {
  if (!socketInstance) {
    return;
  }

  socketInstance.disconnect();
  socketInstance = null;
};

const globalForUno = globalThis;

if (!globalForUno.__unoStableRooms) {
  globalForUno.__unoStableRooms = new Map();
}

export const unoRoomStore = globalForUno.__unoStableRooms;
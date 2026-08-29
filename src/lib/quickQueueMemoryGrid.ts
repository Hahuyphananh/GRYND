import { createOrJoin } from "./memory-grid/serverStore";

export async function createOrJoinMemoryGridDestination({ userId, stakeAmount = 50 }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake <= 0) {
    return { error: "Invalid Memory Grid stake", status: 400 };
  }
  return createOrJoin({ userId, stakeAmount: stake });
}

# Pool Multiplayer Desync Fix

## Problem Summary

When one player shoots a ball in the pool multiplayer game, the other player cannot see the balls moving on their screen - they appear frozen. This is a critical synchronization issue that breaks the multiplayer experience.

## Root Cause Analysis

### Issue 1: Physics Simulation Only Ran for Local Shooter

**Location:** `src/app/casino/pool-masters/game/[matchId]/page.tsx` (lines 171-187)

The physics simulation interval was checking only `localShotInProgressRef.current`:

```javascript
if (!shotLock.current || !localShotInProgressRef.current) return prev; // ONLY simulate local shooter
```

When the remote player shoots:
- `remoteShotInProgressRef.current` is set to `true`
- But `localShotInProgressRef.current` remains `false`
- **The physics simulation doesn't run on the opponent's screen**
- The balls appear frozen because no physics are being calculated

### Issue 2: shotLock Not Engaged for Remote Shots

In the `handleLiveState` function, when receiving a remote SHOOTING/ROLLING event:
- `remoteShotInProgressRef.current` was set to `true`
- But `shotLock.current` was never set to `true`
- Without `shotLock.current = true`, the physics interval exits early

## Solution

### Fix 1: Enable Physics for Both Local and Remote Shots

Changed the physics interval condition to check both flags:

```javascript
if (!shotLock.current) return prev;
if (!localShotInProgressRef.current && !remoteShotInProgressRef.current) return prev;
```

### Fix 2: Engage shotLock for Remote Shots

Updated `handleLiveState` to properly engage the shot lock when receiving remote shot events:

```javascript
if (remoteRolling && !localShotInProgress) {
  remoteShotInProgressRef.current = true;
  // Engage shotLock so physics simulation can run for remote shots
  shotLock.current = true;
  lifecycleRef.current = payload.lifecycle;
  // Store the active shot ID for tracking
  if (payload.shotId) {
    activeShotIdRef.current = payload.shotId;
  }
  // Reset shotMeta for remote shot
  if (payload.lifecycle === "SHOOTING" && !remoteShotMetaInitializedRef.current) {
    shotMeta.current = {
      firstContactNumber: null,
      railAfterContact: false,
      pocketedNumbers: [],
      cueScratch: false,
    };
    remoteShotMetaInitializedRef.current = true;
  }
}
```

### Fix 3: Added Remote Shot Meta Tracking

Added a new ref `remoteShotMetaInitializedRef` to track when shotMeta has been initialized for a remote shot, ensuring it's only reset once per remote shot sequence.

## WebSocket Connection Issues

The logs also show WebSocket connection failures:

```
WebSocket connection to 'wss://casino-app-9ajh.onrender.com/socket.io/' failed
GET https://casino-app-sandy.vercel.app/api/pool/lobbies net::ERR_INTERNET_DISCONNECTED
```

These are separate infrastructure issues that need to be addressed:

### Required Environment Variables

1. **Frontend (.env.local or Vercel):**
   - `NEXT_PUBLIC_SOCKET_URL` - Must point to your realtime server URL

2. **Realtime Server (realtime-server/.env or Render):**
   - `CLIENT_URL` - Must include your Vercel production URL (`https://www.grynd.dedyn.io`)
   - `CLERK_SECRET_KEY` - Required for authentication

### Deployment Checklist

1. Deploy the realtime server to Render (or similar platform)
2. Set `NEXT_PUBLIC_SOCKET_URL` in Vercel to the Render URL
3. Set `CLIENT_URL` in Render to include your Vercel URL
4. Ensure both services are running and accessible

## Testing the Fix

1. Start two browser windows/tabs
2. Log in as different users
3. Join the same pool match
4. Player 1 takes a shot
5. Verify Player 2 sees the balls moving in real-time

## Files Modified

- `src/app/casino/pool-masters/game/[matchId]/page.tsx`
  - Added `remoteShotMetaInitializedRef` ref
  - Modified physics simulation interval condition
  - Updated `handleLiveState` to engage shotLock and reset shotMeta for remote shots
  - Added cleanup of `remoteShotMetaInitializedRef` when shot settles
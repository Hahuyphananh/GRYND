"use client";

// src/components/AdSlot.tsx
//
// Ad-free gating infrastructure for Grynd+ members.
//
// There is no ad inventory on the platform yet. This component is the seam
// where ads will render: pass `premium` (the viewer's Grynd+ membership
// status, from /api/membership/status or server-side) and `slotId` (the ad
// unit's placement key). Members always render nothing; non-members get the
// slot so a real ad network can be dropped into the `else` branch without
// touching every page.
//
// Usage (when ads ship):
//   <AdSlot premium={isPremiumMember} slotId="home-top-banner" />

export default function AdSlot({
  premium,
  slotId,
}: {
  premium?: boolean;
  slotId?: string;
}) {
  if (premium) {
    // Grynd+ members are ad-free — render nothing.
    return null;
  }

  // Placeholder slot for non-members. Replace the inner markup with the ad
  // network's renderer (e.g. an <ins class="adsbygoogle"> or <div data-ad-slot>)
  // when an ad provider is integrated. Kept as a tiny empty container so
  // layouts reserve the space and don't reflow when ads go live.
  return (
    <div
      data-ad-slot={slotId ?? "ad-slot"}
      aria-hidden="true"
      className="min-h-[2px]"
    />
  );
}

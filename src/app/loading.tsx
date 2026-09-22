import PageSkeleton from "../components/skeletons/PageSkeleton";

/**
 * Root streaming fallback.
 *
 * Shown while a route segment's server render is in flight, using the same
 * per-route skeleton the splash screen uses. Without it, a slow server
 * response paints an empty <main> — which is exactly the "blank page" this
 * app is trying to eliminate.
 */
export default function Loading() {
  return <PageSkeleton />;
}

"use client";

import { usePathname } from "next/navigation";
import ChatWidget from "./ChatWidget";

const AUTHLESS_ROUTES = new Set(["/_not-found", "/404"]);

export default function ClerkSafeChatWidget() {
  const pathname = usePathname();

  const hasPublishableKey = Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );

  if (!hasPublishableKey || !pathname || AUTHLESS_ROUTES.has(pathname)) {
    return null;
  }

  return <ChatWidget />;
}

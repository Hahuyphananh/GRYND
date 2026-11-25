import { useEffect, useState } from "react";

export default function useInstallPWA() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    // Deliberately NOT calling preventDefault(). Doing so suppresses Chrome's
    // own install banner and makes it log "Banner not shown: …preventDefault()
    // called" on every load — while this app's custom button is only visible
    // at 2xl widths (or inside the mobile menu), so most visitors were left
    // with no install affordance at all. Keeping the event cancelable lets the
    // browser offer installation, and the deferred event still powers the
    // button for anyone who wants it.
    const handler = (e: any) => {
      setDeferredPrompt(e);
      setCanInstall(true);
    };

    // Once installed (by either path) the button must disappear; without this
    // it stays forever, because the prompt event only fires before install.
    const installed = () => {
      setDeferredPrompt(null);
      setCanInstall(false);
    };

    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", installed);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;

    setDeferredPrompt(null);
    setCanInstall(false);

    return result.outcome;
  };

  return { canInstall, install };
}
"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import { withReducedMotion } from "../../lib/animations";

/**
 * Global branded toast system (UX plan P0-1, Law 6 — Doherty Threshold).
 *
 * Mounted once in the root layout; any component calls
 * `const { showToast } = useToast()` and fires `showToast(message, type)`.
 * Toasts render in a portal on <body> (bottom-right, matching the old home
 * page toast position), auto-dismiss after ~4s, support manual dismissal,
 * and honor reduced motion.
 *
 * Types: "success" (emerald check), "error" (red alert), "info" (cyan).
 * Message can be a plain string or a ReactNode.
 */

const AUTO_DISMISS_MS = 4000;

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return ctx;
}

let nextToastId = 0;

const toastMotion = {
  initial: { opacity: 0, y: 16, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.98 },
  transition: { duration: 0.25, ease: "easeOut" },
};

const TYPE_STYLES = {
  success: {
    border: "border-emerald-400/60",
    iconColor: "text-emerald-300",
    Icon: IconCheck,
    role: "status",
  },
  error: {
    border: "border-red-400/60",
    iconColor: "text-red-300",
    Icon: IconAlertTriangle,
    role: "alert",
  },
  info: {
    border: "border-[#00e5ff]/60",
    iconColor: "text-[#00e5ff]",
    Icon: IconInfoCircle,
    role: "status",
  },
};

function ToastItem({ toast, onDismiss, shouldReduce }) {
  const style = TYPE_STYLES[toast.type] || TYPE_STYLES.info;
  const { Icon } = style;
  const variant = withReducedMotion(shouldReduce, toastMotion);

  return (
    <motion.div
      layout
      {...variant}
      role={style.role}
      className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border ${style.border} bg-[#040d24]/95 p-3 shadow-[0_0_24px_rgba(0,229,255,0.25)] backdrop-blur-md`}
    >
      <span className={`mt-0.5 shrink-0 ${style.iconColor}`}>
        <Icon size={18} aria-hidden="true" />
      </span>
      <p className="flex-1 text-sm leading-snug text-[#d8fbff]">
        {toast.message}
      </p>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-m-1 rounded-md p-1 text-[#7dd3fc] transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
      >
        <IconX size={16} aria-hidden="true" />
      </button>
    </motion.div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const shouldReduce = useReducedMotion();
  const timersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message, type = "info") => {
      const id = ++nextToastId;
      setToasts((prev) => [...prev, { id, message, type }]);
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
    },
    [dismiss],
  );

  // Clear any pending timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <div
            aria-live="polite"
            aria-label="Notifications"
            className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,360px)] flex-col gap-2"
          >
            <AnimatePresence initial={false}>
              {toasts.map((toast) => (
                <ToastItem
                  key={toast.id}
                  toast={toast}
                  onDismiss={dismiss}
                  shouldReduce={shouldReduce}
                />
              ))}
            </AnimatePresence>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}
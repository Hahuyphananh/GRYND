"use client";

// src/components/UpgradeProModal.tsx
//
// Reusable GRYND PRO upgrade dialog. It owns nothing but presentation +
// dismissal: the plan, the entitlement and the actions all come from the
// caller (typically UpgradeProButton), so it can be dropped on any
// non-gameplay page without a second fetch or a second source of truth.
//
// Accessibility: labelled dialog, Escape to close, backdrop click to close,
// scroll lock while open, and focus is moved to the close button on open.

import { useCallback, useEffect, useRef } from "react";
import { UIPro17ModalBackdrop, UIPro18ModalPanel } from "./uipro";
import UpgradeProContent, {
  type UpgradeProContentProps,
} from "./UpgradeProContent";

export type UpgradeProModalProps = {
  open: boolean;
  onClose: () => void;
  /** Everything the pitch needs — plan, entitlement, actions, error state. */
  content: Omit<UpgradeProContentProps, "variant" | "onDismiss">;
};

export default function UpgradeProModal({
  open,
  onClose,
  content,
}: UpgradeProModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus into the dialog so keyboard/screen-reader users start there.
    // The panel is the focus target (tabIndex -1) rather than a hidden button,
    // so nothing extra is announced.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <UIPro17ModalBackdrop
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade to GRYND PRO"
      onClick={(event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-lg outline-none"
      >
        <UIPro18ModalPanel className="max-h-[90vh] overflow-y-auto rounded-2xl">
          <UpgradeProContent
            {...content}
            variant="modal"
            onDismiss={onClose}
          />
        </UIPro18ModalPanel>
      </div>
    </UIPro17ModalBackdrop>
  );
}

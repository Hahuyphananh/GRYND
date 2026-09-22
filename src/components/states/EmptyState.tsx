"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { IconInbox } from "@tabler/icons-react";
import StateShell, { statePrimaryAction, stateSecondaryAction } from "./StateShell";
import { useTranslation } from "../../hooks/useTranslation";

type Action = {
  label: string;
  href?: string;
  onClick?: () => void;
};

/**
 * Empty state: the screen loaded fine, there is simply nothing here yet.
 *
 * Always explain *what* belongs here and hand the player the one action that
 * creates the first item — an empty table with no next step is a dead end.
 */
export default function EmptyState({
  title,
  description,
  action,
  secondaryAction,
  icon,
  className,
}: {
  title?: string;
  description?: ReactNode;
  action?: Action;
  secondaryAction?: Action;
  icon?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <StateShell
      className={className}
      icon={icon ?? <IconInbox size={24} aria-hidden="true" />}
      title={title ?? t("states.emptyTitle", "Nothing here yet")}
      description={
        description ??
        t(
          "states.emptyDescription",
          "Once you start playing, your activity will show up here.",
        )
      }
    >
      {action && <ActionButton action={action} className={statePrimaryAction} />}
      {secondaryAction && (
        <ActionButton action={secondaryAction} className={stateSecondaryAction} />
      )}
    </StateShell>
  );
}

function ActionButton({ action, className }: { action: Action; className: string }) {
  if (action.href) {
    return (
      <Link href={action.href} className={className}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={className}>
      {action.label}
    </button>
  );
}

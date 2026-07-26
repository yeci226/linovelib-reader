"use client";

import Link, { type LinkProps } from "next/link";
import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { canOpenOfflineResource } from "@/lib/offline-access";

type OfflineAwareLinkProps = LinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps | "href"> & {
    href: string;
    isOnline: boolean;
    hasCachedResource: boolean;
  };

export function OfflineAwareLink({
  href,
  isOnline,
  hasCachedResource,
  onClick,
  tabIndex,
  ...props
}: OfflineAwareLinkProps) {
  const canOpen = canOpenOfflineResource(isOnline, hasCachedResource);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!canOpen) {
      event.preventDefault();
      return;
    }

    onClick?.(event);
    if (event.defaultPrevented) return;

    if (!isOnline) {
      event.preventDefault();
      window.location.assign(href);
    }
  };

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      aria-disabled={!canOpen}
      tabIndex={canOpen ? tabIndex : -1}
      onClick={handleClick}
    />
  );
}

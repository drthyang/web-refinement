/**
 * The Agent drawer's width, which the user drags (the handle on its left
 * edge) and the browser remembers. The page beside it always keeps
 * PAGE_MIN: the drawer is a companion to the analysis, never a cover for it.
 * Pure, so the bounds are tested without a browser.
 */

import { WIDTH_KEY } from "@/agent/storage";

/** Narrower, and the tool cards' preview lines wrap word by word. */
export const DRAWER_MIN = 320;
/** Wider, and a line of the conversation runs past comfortable reading length. */
export const DRAWER_MAX = 760;
/** What the page keeps beside the drawer. */
export const PAGE_MIN = 480;
/** One arrow-key step on the handle. */
export const KEY_STEP = 24;

/** A width the drawer may take in a window `viewport` CSS px wide. */
export function clampDrawerWidth(width: number, viewport: number): number {
  const max = Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, viewport - PAGE_MIN));
  return Math.round(Math.min(max, Math.max(DRAWER_MIN, width)));
}

/** The width the user last chose, or null for the default. */
export function readDrawerWidth(store: Pick<Storage, "getItem">): number | null {
  try {
    const raw = store.getItem(WIDTH_KEY);
    const w = raw === null ? NaN : Number(raw);
    return Number.isFinite(w) && w >= DRAWER_MIN && w <= DRAWER_MAX ? w : null;
  } catch {
    return null;
  }
}

/** Remember a width (null forgets it: the default again). Storage may be unavailable. */
export function writeDrawerWidth(store: Pick<Storage, "setItem" | "removeItem">, width: number | null): void {
  try {
    if (width === null) store.removeItem(WIDTH_KEY);
    else store.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Private mode or blocked storage: the width lasts for this visit.
  }
}

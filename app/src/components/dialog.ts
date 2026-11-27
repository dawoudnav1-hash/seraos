import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour for a dialog element: moves focus into it, keeps Tab / Shift+Tab inside, closes on Esc
 * and gives focus back to whatever had it before (usually the button that opened it).
 */
export function useModal(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, initialFocus?: RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = initialFocus?.current ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (!ref.current) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || !ref.current.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !ref.current.contains(active))) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open, ref, initialFocus]);
}

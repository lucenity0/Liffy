import { useEffect } from "react";

/**
 * ⌘K, bound while Appearance is on screen.
 *
 * Its own file rather than living next to the palette: the shortcut has to
 * work while the palette is *closed*, which is the only time it is any use,
 * so it cannot be a hook exported from the component that the palette renders.
 *
 * Ctrl+K as well as ⌘K, without branching on platform. The wrong modifier on
 * the wrong OS is a shortcut that quietly does nothing, and neither
 * combination means anything else on this page.
 */
export function usePaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);
}

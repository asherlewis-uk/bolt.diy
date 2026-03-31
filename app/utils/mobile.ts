const MOBILE_BREAKPOINT = 640;

export function isMobile() {
  if (typeof globalThis === 'undefined' || typeof globalThis.innerWidth !== 'number') {
    return false;
  }

  return globalThis.innerWidth < MOBILE_BREAKPOINT;
}

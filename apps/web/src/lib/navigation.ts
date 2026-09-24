/** Lets non-React code (the API error listener) navigate with the data router. */
type Navigate = (to: string, opts?: { replace?: boolean }) => void;
let navigator: Navigate | null = null;

export function setNavigator(fn: Navigate): void {
  navigator = fn;
}

export function navigateTo(to: string, opts?: { replace?: boolean }): void {
  if (navigator) navigator(to, opts);
  else window.location.assign(to);
}

export function currentPath(): string {
  return window.location.pathname + window.location.search;
}

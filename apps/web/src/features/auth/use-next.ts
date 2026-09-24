import { useSearchParams } from 'react-router';

/** A safe post-login destination: same-origin relative paths only. */
export function useNextPath(fallback = '/'): string {
  const [params] = useSearchParams();
  const next = params.get('next');
  // Browsers treat "\" like "/", so "/\evil.com" would become protocol-relative: reject it.
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !next.startsWith('/login')) return next;
  return fallback;
}

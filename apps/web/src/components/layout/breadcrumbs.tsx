import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useMatches } from 'react-router';
import { Breadcrumb, type Crumb } from '@/components/ui/breadcrumb';

export interface RouteHandle {
  crumb?: string;
}

const TailContext = createContext<{ tail: string | null; setTail: (t: string | null) => void } | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [tail, setTail] = useState<string | null>(null);
  return <TailContext.Provider value={{ tail, setTail }}>{children}</TailContext.Provider>;
}

/** Lets a page name the last breadcrumb (e.g. a role or tenant name loaded from the API). */
export function useBreadcrumbTail(label: string | null | undefined): void {
  const ctx = useContext(TailContext);
  const setTail = ctx?.setTail;
  useEffect(() => {
    if (!setTail) return;
    setTail(label ?? null);
    return () => setTail(null);
  }, [label, setTail]);
}

export function RouteBreadcrumbs({ root }: { root: Crumb }) {
  const matches = useMatches();
  const ctx = useContext(TailContext);
  const crumbs: Crumb[] = [root];
  for (const m of matches) {
    const handle = m.handle as RouteHandle | undefined;
    if (handle?.crumb && m.pathname !== root.to) crumbs.push({ label: handle.crumb, to: m.pathname });
  }
  if (ctx?.tail) crumbs.push({ label: ctx.tail });
  return <Breadcrumb items={crumbs} />;
}

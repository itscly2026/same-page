import type { ReactNode } from "react";
import { useAppNavigation } from "./navigation-context";
export function BackButton({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const navigation = useAppNavigation();
  return <button className={className} onClick={() => navigation.back(to)}>{children}</button>;
}

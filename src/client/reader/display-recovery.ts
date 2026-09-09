import { createContext } from "react";
export const DisplayRecovery = createContext<{
  currentPage: number;
  ready(page: number): void;
  failed(page: number, reason: unknown): void;
} | null>(null);

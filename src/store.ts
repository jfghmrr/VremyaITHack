import { create } from "zustand";
export const useApp = create<{ name: string; setName: (name: string) => void }>(
  (set) => ({ name: "", setName: (name) => set({ name }) }),
);

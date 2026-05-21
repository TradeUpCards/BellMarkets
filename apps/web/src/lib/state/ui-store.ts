"use client";

import { create } from "zustand";

interface UiState {
  selectedTicker: string | null;
  setSelectedTicker: (ticker: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedTicker: null,
  setSelectedTicker: (ticker) => set({ selectedTicker: ticker }),
}));

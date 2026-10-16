"use client";

import { createContext, useContext } from "react";

export type CommunityFeedSort = "recommended" | "latest" | "popular";
export const CoCreationFeedContext = createContext<{ sort: CommunityFeedSort; category: string }>({ sort: "latest", category: "builds" });
export function useCoCreationFeed() { return useContext(CoCreationFeedContext); }

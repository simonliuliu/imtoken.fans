export const COMMUNITY_SECTIONS = ["safety", "feedback", "discussion", "activities"] as const;
export type CommunitySection = (typeof COMMUNITY_SECTIONS)[number];
export type FeedbackState = "pending" | "discussion" | "recorded";
export interface DemoPost {
  id: string;
  submissionId?: string;
  title?: string;
  excerpt?: string;
  body?: string;
  isExample?: boolean;
  authorUsername?: string | null;
  authorId?: string | null;
  moderationStatus?: "pending" | "published" | "rejected";
  section: CommunitySection;
  category: string;
  author: string;
  level: number;
  createdAt: string;
  likes: number;
  commentCount: number;
  votes: number;
  // Static stand-in for the administrator recommendation flag; not inferred from popularity.
  featured?: boolean;
  status?: FeedbackState;
  cover?: "safety" | "feedback" | "conversation";
}
export const DEMO_POSTS: DemoPost[] = [
  { id: "approval-checklist", section: "safety", category: "guides", author: "lin", level: 3, createdAt: "2026-10-14T09:10:00+08:00", likes: 36, commentCount: 6, votes: 18, featured: true, cover: "safety" },
  { id: "clearer-transaction", section: "feedback", category: "wallet", author: "summer", level: 2, createdAt: "2026-10-15T10:30:00+08:00", likes: 24, commentCount: 8, votes: 31, featured: true, status: "discussion", cover: "feedback" },
  { id: "first-wallet-question", section: "discussion", category: "questions", author: "river", level: 1, createdAt: "2026-10-15T11:20:00+08:00", likes: 12, commentCount: 5, votes: 9 },
  { id: "weekend-conversation", section: "activities", category: "community", author: "moss", level: 4, createdAt: "2026-10-15T08:40:00+08:00", likes: 21, commentCount: 7, votes: 16, featured: true, cover: "conversation" },
  { id: "fake-support-message", section: "safety", category: "cases", author: "summer", level: 2, createdAt: "2026-10-13T15:10:00+08:00", likes: 42, commentCount: 9, votes: 22 },
  { id: "ai-explainer", section: "feedback", category: "builds", author: "lin", level: 3, createdAt: "2026-10-14T14:20:00+08:00", likes: 18, commentCount: 4, votes: 26 },
  { id: "reading-release-notes", section: "feedback", category: "changelog", author: "river", level: 1, createdAt: "2026-10-12T12:00:00+08:00", likes: 15, commentCount: 3, votes: 17 },
  { id: "learning-notebook", section: "discussion", category: "research", author: "moss", level: 4, createdAt: "2026-10-14T18:30:00+08:00", likes: 19, commentCount: 6, votes: 13, featured: true },
  { id: "checkin-routine", section: "activities", category: "checkin", author: "river", level: 1, createdAt: "2026-10-13T07:20:00+08:00", likes: 13, commentCount: 4, votes: 8 },
  { id: "network-help", section: "safety", category: "questionsSafety", author: "moss", level: 4, createdAt: "2026-10-12T16:00:00+08:00", likes: 27, commentCount: 5, votes: 15 },
  { id: "better-questions", section: "discussion", category: "industry", author: "summer", level: 2, createdAt: "2026-10-11T09:40:00+08:00", likes: 22, commentCount: 3, votes: 14 },
  { id: "reading-circle", section: "activities", category: "announcements", author: "lin", level: 3, createdAt: "2026-10-11T17:10:00+08:00", likes: 16, commentCount: 4, votes: 11 },
];
export const SECTION_CATEGORIES: Record<CommunitySection, string[]> = {
  safety: ["stories", "cases", "guides", "questionsSafety"],
  feedback: ["wallet", "builds", "changelog"],
  discussion: ["questions", "research", "industry"],
  activities: ["announcements", "community", "checkin"],
};
export function isCommunitySection(value: string): value is CommunitySection {
  return COMMUNITY_SECTIONS.some((section) => section === value);
}

export function hasDemoSupport(post: DemoPost) {
  return post.section === "feedback" && (post.category === "wallet" || post.category === "builds");
}
export function compareDemoPopularity(a: DemoPost, b: DemoPost) {
  return b.commentCount - a.commentCount || b.createdAt.localeCompare(a.createdAt);
}

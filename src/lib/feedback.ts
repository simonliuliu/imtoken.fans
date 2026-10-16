export const FEEDBACK_MODULES = ["wallet", "transfer", "browser", "other"] as const;
export const FEEDBACK_STATES = ["inbox", "evaluating", "planned", "building", "done", "needsInfo", "declined"] as const;
export const FEEDBACK_MARKS = ["none", "research", "needsInfo", "featured"] as const;
export type FeedbackModule = typeof FEEDBACK_MODULES[number];
export type FeedbackState = typeof FEEDBACK_STATES[number];
export type FeedbackMark = typeof FEEDBACK_MARKS[number];
export interface FeedbackPost {
  id: string; title: string; description: string; author_name: string | null;
  module: FeedbackModule; status: FeedbackState; mark: FeedbackMark; visibility: "published" | "hidden";
  created_at: string; updated_at: string; version: number; support_count: number; supported: boolean;
  comment_count: number; merge_id: string | null;
}
export interface FeedbackComment {
  id: string; post_id: string; source_title: string; parent_id: string | null; parent_author_name: string | null;
  body: string; author_name: string | null; created_at: string; version: number; mark: FeedbackMark;
  visibility: "published" | "hidden"; support_count: number; supported: boolean;
}
export interface FeedbackData {
  posts: FeedbackPost[]; total: number; selected: FeedbackPost | null; sources: FeedbackPost[];
  comments: FeedbackComment[]; comment_total: number; viewer: { user_id: string | null; signed_in: boolean; can_manage: boolean };
  history: { id: number; action: string; comment_id: string | null; before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null; created_at: string }[];
}
export interface FeedbackQuery { id?: string | null; query?: string; module?: string; status?: string; sort?: string; offset?: number; commentOffset?: number }
export type FeedbackResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string };
export interface FeedbackEdit { title: string; description: string; module: FeedbackModule; status: FeedbackState; mark: FeedbackMark; visibility: "published" | "hidden" }
export const FEEDBACK_CHANGED = "imtoken-feedback-changed";
export const FEEDBACK_COMPOSE = "imtoken-feedback-compose";

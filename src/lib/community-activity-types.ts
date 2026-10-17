export type ActivityType = "event" | "newcomer" | "weekly";
export type ActivityTask = "checkin" | "quiz" | "manual" | "product_review";
export interface CommunityActivity {
  id: string; title: string; summary: string; body: string; organizer: string;
  type: ActivityType; task_kind: ActivityTask; starts_at: string; ends_at: string;
  status: "draft" | "published" | "cancelled"; cancel_reason: string | null;
  reward_xp: number; reward_tickets: number; reward_badge: string | null;
  reward_limit: number | null; rewarded_count: number; checkin_days: number;
  quiz_question: string | null; quiz_options: string[]; quiz_max_attempts: number;
  product_id: string | null; product_available?: boolean; quiz_answer?: number;
}
export interface ActivityReward { activity_id: string; user_id: string; xp: number; tickets: number; badge: string | null; created_at: string }
export interface ActivityParticipation {
  activity_id: string; user_id: string; status: "joined" | "submitted" | "approved" | "rejected";
  evidence: string | null; review_note: string | null; review_id?: string | null; attempts: number; submitted_at: string | null;
  reward?: ActivityReward | null;
  product_review?: { body: string; rating: number; created_at: string; experienced: boolean; submission_id: string } | null;
}
export interface ActivityRead { items: CommunityActivity[]; mine: ActivityParticipation[]; following: string[] }
export interface AdminActivityRead { items: CommunityActivity[]; participations: ActivityParticipation[]; rewards: ActivityReward[]; products: {id: string; title: string}[] }
export function activityStatus(a: CommunityActivity, now = Date.now()): "active" | "upcoming" | "ended" | "cancelled" {
  if (a.status === "cancelled") return "cancelled";
  if (now < new Date(a.starts_at).getTime()) return "upcoming";
  return now >= new Date(a.ends_at).getTime() ? "ended" : "active";
}

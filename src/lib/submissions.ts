import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { CommentWithAuthor, ProductRating, SubmissionCard, SubmissionType } from "@/lib/types";

function normalizeSubmissionCard(row: SubmissionCard): SubmissionCard {
  return {
    ...row,
    product_platforms: row.product_platforms ?? [],
    pricing_type: row.pricing_type ?? null,
    launch_stage: row.launch_stage ?? null,
    maker_relationship: row.maker_relationship ?? null,
    maker_note: row.maker_note ?? null,
    feedback_prompt: row.feedback_prompt ?? null,
    published_at: row.published_at ?? null,
    support_count: Number(row.support_count ?? 0),
    rating_count: Number(row.rating_count ?? 0),
    rating_average: row.rating_average == null ? null : Number(row.rating_average),
  };
}

// 公开列表页用：只看已发布的内容，可见性最终由 submission_cards 视图底层的 RLS 决定，
// 这里的 .eq('status','published') 只是在此基础上再叠加一层"公开列表只展示已发布"。
export async function getPublishedSubmissionCards(type?: SubmissionType): Promise<SubmissionCard[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createClient();
  let query = supabase.from("submission_cards").select("*").eq("status", "published").is("deleted_at", null);
  if (type) query = query.eq("type", type);

  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as SubmissionCard[]).map(normalizeSubmissionCard);
}

// 详情页用：不加 status 过滤——RLS 已经保证「已发布 OR 自己的 OR 管理员」，
// 查不到就说明这条内容对当前访问者不可见，交给调用方 notFound()。
// 但被管理员删除（deleted_at 非空）的内容对谁都不再可见，包括作者自己和管理员，
// 后台想看得去回收站——所以这一层过滤放在应用层。
export async function getSubmissionCardById(id: string, type: SubmissionType): Promise<SubmissionCard | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("submission_cards")
    .select("*")
    .eq("id", id)
    .eq("type", type)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? normalizeSubmissionCard(data as SubmissionCard) : null;
}

// Profile 页用：作者自己的全部提交，不管状态（RLS 已经保证只能查到自己的 + 已发布的）。
export async function getOwnSubmissionCards(userId: string): Promise<SubmissionCard[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("submission_cards")
    .select("*")
    .eq("submitted_by", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as SubmissionCard[]).map(normalizeSubmissionCard);
}

export async function getSimilarSubmissions(current: SubmissionCard, limit = 4): Promise<SubmissionCard[]> {
  if (current.tags.length === 0) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("submission_cards")
    .select("*")
    .eq("status", "published")
    .is("deleted_at", null)
    .neq("id", current.id)
    .overlaps("tags", current.tags)
    .limit(limit);
  return ((data ?? []) as SubmissionCard[]).map(normalizeSubmissionCard);
}

export async function getUserVoteFlags(submissionId: string): Promise<{ paid: boolean; creative: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { paid: false, creative: false };

  const { data } = await supabase
    .from("votes")
    .select("vote_type")
    .eq("submission_id", submissionId)
    .eq("user_id", user.id);

  const types = new Set((data ?? []).map((row) => row.vote_type));
  return { paid: types.has("paid"), creative: types.has("creative") };
}

export interface ProductEngagement {
  viewerId: string | null;
  viewerSupported: boolean;
  viewerRating: ProductRating | null;
  reviews: ProductRating[];
}

export async function getProductEngagement(submissionId: string): Promise<ProductEngagement> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [supportResult, ratingsResult] = await Promise.all([
    user
      ? supabase
          .from("product_supports")
          .select("id")
          .eq("submission_id", submissionId)
          .eq("user_id", user.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("product_ratings")
      .select(
        "id, submission_id, user_id, rating, body, strengths, improvements, experienced, created_at, updated_at, profiles!product_ratings_user_id_fkey(username, display_name, avatar_url, level)"
      )
      .eq("submission_id", submissionId)
      .order("updated_at", { ascending: false }),
  ]);

  if (ratingsResult.error) {
    console.error("[getProductEngagement] 查询产品评分失败:", ratingsResult.error);
  }

  const reviews = (ratingsResult.data ?? []).map((row) => {
    const author = row.profiles as unknown as {
      username: string | null;
      display_name: string | null;
      avatar_url: string | null;
      level: number | null;
    } | null;
    return {
      id: row.id,
      submission_id: row.submission_id,
      user_id: row.user_id,
      rating: row.rating,
      body: row.body,
      strengths: row.strengths ?? [],
      improvements: row.improvements ?? [],
      experienced: row.experienced,
      created_at: row.created_at,
      updated_at: row.updated_at,
      author_username: author?.username ?? null,
      author_display_name: author?.display_name ?? null,
      author_avatar_url: author?.avatar_url ?? null,
      author_level: author?.level ?? null,
    } satisfies ProductRating;
  });

  return {
    viewerId: user?.id ?? null,
    viewerSupported: Boolean(supportResult.data),
    viewerRating: user ? reviews.find((review) => review.user_id === user.id) ?? null : null,
    reviews,
  };
}

export async function getCommentsForSubmission(submissionId: string): Promise<CommentWithAuthor[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // profiles 必须指名走哪条外键：0014 给 comments 加了 deleted_by -> profiles(id) 之后，
  // comments 到 profiles 有两条外键（user_id 和 deleted_by），写成 profiles(...) 会被
  // PostgREST 当成歧义直接报错（PGRST201）。这里要的是评论作者，即 user_id 那条。
  const { data, error } = await supabase
    .from("comments")
    .select(
      "id, submission_id, user_id, parent_id, body, status, created_at, pinned_at, deleted_at, profiles!comments_user_id_fkey(username, display_name, role, level)"
    )
    .eq("submission_id", submissionId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  // 这里不 throw：评论查不出来不该让整个产品详情页 500。但一定要留日志——
  // 之前这个查询是静默 `const { data } = ...`，出错就返回空数组，
  // 表现成「评论数显示 14、下面却说还没有评论」，排查成本很高。
  if (error) {
    console.error("[getCommentsForSubmission] 查询评论失败:", error);
    return [];
  }

  const rows = data ?? [];
  const commentIds = rows.map((row) => row.id);

  // 评论点赞是公开可读的，一次查出这个提交下所有评论的投票行，再本地聚合成计数 + 当前用户是否投过。
  const { data: voteRows } = commentIds.length
    ? await supabase.from("comment_votes").select("comment_id, user_id").in("comment_id", commentIds)
    : { data: [] as { comment_id: string; user_id: string }[] };

  const voteCounts = new Map<string, number>();
  const viewerVoted = new Set<string>();
  for (const row of voteRows ?? []) {
    voteCounts.set(row.comment_id, (voteCounts.get(row.comment_id) ?? 0) + 1);
    if (user && row.user_id === user.id) viewerVoted.add(row.comment_id);
  }

  return rows.map((row) => {
    const author = row.profiles as unknown as {
      username: string | null;
      display_name: string | null;
      role: CommentWithAuthor["author_role"];
      level: number | null;
    } | null;
    return {
      id: row.id,
      submission_id: row.submission_id,
      user_id: row.user_id,
      parent_id: row.parent_id,
      body: row.body,
      status: row.status,
      created_at: row.created_at,
      pinned_at: row.pinned_at,
      deleted_at: row.deleted_at,
      author_username: author?.username ?? null,
      author_display_name: author?.display_name ?? null,
      author_role: author?.role ?? null,
      author_level: author?.level ?? null,
      vote_count: voteCounts.get(row.id) ?? 0,
      viewer_has_voted: viewerVoted.has(row.id),
    };
  });
}

// 极简公开主页用：只看这个人已发布的产品/点子（RLS 已经保证已发布内容公开可读）。
export async function getPublishedSubmissionsByUser(userId: string): Promise<SubmissionCard[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("submission_cards")
    .select("*")
    .eq("submitted_by", userId)
    .eq("status", "published")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as SubmissionCard[]).map(normalizeSubmissionCard);
}

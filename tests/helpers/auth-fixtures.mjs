// 仅供本地回归：虚构账号、令牌和产品，不连接任何 Supabase 项目。
export const READER_ID = "11111111-1111-4111-8111-111111111111";
export const CREATOR_ID = "22222222-2222-4222-8222-222222222222";
export const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

export function userFor(id = READER_ID) {
  return {
    id, aud: "authenticated", role: "authenticated",
    email: id === CREATOR_ID ? "creator@example.test" : "reader@example.test",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { username: id === CREATOR_ID ? "test_creator" : "test_reader" },
    created_at: "2026-01-01T00:00:00Z",
  };
}

export function sessionFor(id = READER_ID) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = { sub: id, exp: expires, aud: "authenticated", role: "authenticated" };
  const accessToken = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), Buffer.from(JSON.stringify(payload)).toString("base64url"), "local-test-signature"].join(".");
  return { access_token: accessToken, refresh_token: `local-test-refresh-${id}`, token_type: "bearer", expires_in: 3600, expires_at: expires, user: userFor(id) };
}

export function profileFor(id = READER_ID) {
  return {
    id, username: id === CREATOR_ID ? "test_creator" : "test_reader",
    display_name: id === CREATOR_ID ? "Test Creator" : "Test Reader",
    role: "user", permissions: {}, avatar_url: null, bio: null, expertise: [],
    xp: 0, level: 0, onboarded_at: "2026-01-01T00:00:00Z",
    submission_cooldown_until: null, muted_until: null,
  };
}

export const product = {
  id: PRODUCT_ID, type: "product", title: "Local auth test product", tagline: "A fictional fixture for session navigation",
  description: "This is a local test fixture, not a real submitted product.", tags: [], status: "published",
  submitted_by: CREATOR_ID, stats_users: null, stats_dau: null, stats_updated_at: null, built_from_idea_id: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z",
  website_url: null, video_url: null, logo_path: null, screenshot_paths: [], team: [], social_links: [],
  submitted_by_username: "test_creator", submitted_by_avatar_url: null, submitted_by_role: "user", submitted_by_level: 0,
  deleted_at: null, votes_paid: 0, votes_creative: 0, sim_invest_usd: 0, comment_count: 0,
  product_platforms: ["web"], pricing_type: "free", launch_stage: "live", maker_relationship: "creator",
  maker_note: null, feedback_prompt: null, support_count: 1, rating_count: 0, rating_average: null,
};

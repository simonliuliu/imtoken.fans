import { CommunitySubmit } from "@/components/community-submit";
import { ProductSubmissionForm } from "@/components/product-submission-form";

export default async function SubmitPage({ searchParams }: { searchParams: Promise<{ type?: string | string[] }> }) {
  const rawType = (await searchParams).type;
  if (rawType === "product" || rawType === "idea") return <ProductSubmissionForm fixedType={rawType} />;
  return <CommunitySubmit mode="post" />;
}

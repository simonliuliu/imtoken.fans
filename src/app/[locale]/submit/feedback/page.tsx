import { Suspense } from "react";
import { AuthLoading } from "@/components/auth-loading";
import { ProductFeedbackForm } from "@/components/product-feedback-form";

export default function FeedbackSubmitPage() {
  return <Suspense fallback={<AuthLoading />}><ProductFeedbackForm /></Suspense>;
}

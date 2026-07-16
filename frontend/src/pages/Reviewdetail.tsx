import { useParams } from "react-router-dom";

export function ReviewDetail() {
  const { reviewId } = useParams();
  return <h1 className="text-xl font-semibold">Review {reviewId}</h1>;
}
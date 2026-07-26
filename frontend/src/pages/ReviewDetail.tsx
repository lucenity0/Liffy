import { useParams } from "react-router-dom";

export function ReviewDetail() {
  const { reviewId } = useParams();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-hand text-xl text-ink">Review</h1>
      <p className="font-code text-sm text-ink-dim">{reviewId}</p>
    </div>
  );
}

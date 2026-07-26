import { useParams } from "react-router-dom";

export function RepoDetail() {
  const { repoId } = useParams();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-hand text-xl text-ink">Repository</h1>
      <p className="font-code text-sm text-ink-dim">{repoId}</p>
    </div>
  );
}

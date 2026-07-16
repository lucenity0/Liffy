import { useParams } from "react-router-dom";

export function RepoDetail() {
  const { repoId } = useParams();
  return <h1 className="text-xl font-semibold">Repo {repoId}</h1>;
}
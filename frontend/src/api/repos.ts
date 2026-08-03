import { apiClient } from "./client";
import type {
  IndexAccepted,
  PullRequestListOut,
  RepoListItem,
  RepoOut,
  RepoStatusOut,
} from "@/types/api";

export async function listRepos(): Promise<RepoListItem[]> {
  const { data } = await apiClient.get<RepoListItem[]>("/repos");
  return data;
}

export async function connectRepo(fullName: string): Promise<RepoOut> {
  const { data } = await apiClient.post<RepoOut>("/repos", { full_name: fullName });
  return data;
}

export async function disconnectRepo(repoId: string): Promise<void> {
  // 204 No Content — response.data is "" here, never JSON.
  await apiClient.delete(`/repos/${repoId}`);
}

export async function triggerIndex(repoId: string): Promise<IndexAccepted> {
  const { data } = await apiClient.post<IndexAccepted>(`/repos/${repoId}/index`);
  return data;
}

export async function getRepoStatus(repoId: string): Promise<RepoStatusOut> {
  const { data } = await apiClient.get<RepoStatusOut>(`/repos/${repoId}/status`);
  return data;
}

export async function listPullRequests(
  repoId: string,
  state: "open" | "closed" | "all",
): Promise<PullRequestListOut> {
  const { data } = await apiClient.get<PullRequestListOut>(
    `/repos/${repoId}/pulls`,
    { params: { state } },
  );
  return data;
}

import { useQuery } from "@tanstack/react-query";
import { listRepos } from "@/api/repos";
import { keys } from "./keys";

export function useRepos() {
  return useQuery({
    queryKey: keys.repos.list(),
    queryFn: listRepos,
  });
}

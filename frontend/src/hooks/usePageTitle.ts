import { useMatches } from "react-router-dom";

interface RouteHandle {
  title?: string;
}

export function usePageTitle(): string {
  const matches = useMatches();

  const current = [...matches]
    .reverse()
    .find((match) => (match.handle as RouteHandle)?.title);

  return (current?.handle as RouteHandle)?.title ?? "Liffy";
}

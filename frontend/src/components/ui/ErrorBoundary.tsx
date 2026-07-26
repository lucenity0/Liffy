import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";
import { Sheet } from "./Sheet";

/**
 * React Router already installs a boundary around every route (that is what
 * `errorElement` is), so this one exists for the places the router does not
 * cover — chiefly the lazily-loaded Monaco chunk, which can fail to fetch
 * long after the route rendered fine.
 *
 * Class component because there is still no hook equivalent of
 * componentDidCatch.
 */

interface Props {
  children: ReactNode;
  /** Overrides the default panel. Receives a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  title?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Self-hosted tool, no telemetry — the console is the only sink there is.
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    const { children, fallback, title = "This section failed to load" } =
      this.props;

    if (!error) return children;
    if (fallback) return fallback(error, this.reset);

    return (
      <Sheet>
        <Sheet.Header title="Error" />
        <Sheet.Body className="flex flex-col items-start gap-3">
          <p className="font-hand text-lg leading-tight text-ink">{title}</p>
          <p className="font-code text-sm break-words text-ink-dim">
            {error.message}
          </p>
          <Button onClick={this.reset}>Try again</Button>
        </Sheet.Body>
      </Sheet>
    );
  }
}

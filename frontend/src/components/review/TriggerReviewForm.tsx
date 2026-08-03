import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Field, Input, Select } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useRepos } from "@/hooks/useRepos";
import { PullRequestPicker } from "./PullRequestPicker";
import { useTriggerReview } from "@/hooks/useReviewMutations";
import { normalizeApiError } from "@/lib/errors";
import {
  FULL_NAME_HINT,
  isValidFullName,
  isValidPrNumber,
  splitFullName,
} from "@/lib/validators";

/**
 * Point Liffy at any pull request it can reach. This is the demo path while
 * webhook onboarding and auth are still pending, and it is the only way to
 * start a review from inside the app.
 *
 * One `owner/name` field rather than the separate owner and repo fields the
 * issue lists: the connect modal already established that shape, and two
 * different ways to type a repository name in the same product is worse than
 * either one on its own. The request body is still `{owner, repo, pr_number}`
 * — the split happens on submit.
 *
 * Both fields are pickers now, over `GET /repos` and `GET /repos/{id}/pulls`.
 * Starting a review used to mean typing a repository name from memory and
 * reading a pull request number off a GitHub URL.
 *
 * Both keep a way back to typing. The repository endpoint accepts anything
 * Liffy can reach, not only what is connected; and the pull request list is a
 * live GitHub proxy, so it can rate-limit or fail on a repository the
 * caller's token cannot enumerate. "The picker is broken so you cannot start
 * a review" would be worse than the typing it replaced.
 */

/** Sentinel for "not one of the connected repositories". */
const CUSTOM = "__custom__";

export function TriggerReviewForm({
  onClose,
  onQueued,
}: {
  onClose: () => void;
  /**
   * Called with the 202 body. There is no review id in it, so the caller
   * cannot deep-link — it can only go to the list and let it refetch.
   */
  onQueued: (queued: { repo: string; pr_number: number }) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [attempted, setAttempted] = useState(false);
  /** Escape hatch out of the picker, for a repository not connected here. */
  const [custom, setCustom] = useState(false);
  /** Same, for the pull request: the list is a live GitHub proxy and can
   *  fail on a repository the caller's token cannot enumerate. */
  const [typedPr, setTypedPr] = useState(false);

  const repos = useRepos();
  const connected = repos.data ?? [];
  /** The connected repository currently chosen, if it is one of ours. */
  const selectedRepo = connected.find((repo) => repo.full_name === fullName);

  const trigger = useTriggerReview();
  const serverError = trigger.error ? normalizeApiError(trigger.error) : null;

  const nameInvalid = attempted && !isValidFullName(fullName);
  const numberInvalid = attempted && !isValidPrNumber(prNumber);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);

    // Neither branch reaches the network — the backend would only 422 it back.
    if (!isValidFullName(fullName) || !isValidPrNumber(prNumber)) return;

    const { owner, repo } = splitFullName(fullName);
    trigger.mutate(
      { owner, repo, pr_number: Number(prNumber) },
      { onSuccess: (accepted) => onQueued(accepted) },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Review a pull request"
      description="Liffy pulls the diff, retrieves context from the index, and writes a review."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="trigger-review"
            variant="primary"
            loading={trigger.isPending}
          >
            Start review
          </Button>
        </>
      }
    >
      <form
        id="trigger-review"
        onSubmit={onSubmit}
        // noValidate, but the fields keep `required`: without this the
        // browser's own bubble fires first on an empty field and our message
        // never renders — and that bubble is the one thing on the page that
        // cannot be made to look like paper.
        noValidate
        className="flex flex-col gap-3"
      >
        <Field
          label="Repository"
          hint={
            connected.length > 0
              ? "Repositories Liffy has indexed. Reviews of anything else have no context to retrieve."
              : FULL_NAME_HINT
          }
          error={
            nameInvalid
              ? "That doesn't look like owner/name."
              : serverError?.kind === "validation"
                ? serverError.message
                : null
          }
          required
        >
          {(props) =>
            // Nothing typeable until /repos has settled.
            //
            // Rendering the box first and swapping in the picker on arrival
            // meant anyone who started typing immediately had the control
            // replaced under them and their input silently discarded — a race
            // nobody would ever reproduce deliberately but everybody would hit
            // on a slow request. One disabled placeholder, then whichever
            // control is right, and it never changes shape again.
            repos.isPending ? (
              <Select {...props} disabled value="">
                <option value="">Loading repositories…</option>
              </Select>
            ) : // A picker once there is something to pick from, and the
            // free-text box otherwise — the endpoint takes any repository
            // Liffy can reach, so nothing is taken away, but typing
            // `owner/name` by hand when the app already knows the list was
            // busywork with a typo in it. Falls back on its own before the
            // first repository is connected and if /repos fails.
            connected.length > 0 && !custom ? (
              <Select
                {...props}
                autoFocus
                name="full_name"
                value={fullName}
                onChange={(event) => {
                  if (event.target.value === CUSTOM) {
                    setCustom(true);
                    setFullName("");
                    return;
                  }
                  setFullName(event.target.value);
                }}
              >
                <option value="" disabled>
                  Choose a repository…
                </option>
                {connected.map((repo) => (
                  <option key={repo.id} value={repo.full_name}>
                    {repo.full_name}
                  </option>
                ))}
                <option value={CUSTOM}>Another repository…</option>
              </Select>
            ) : (
              <Input
                {...props}
                autoFocus
                name="full_name"
                placeholder="lucenity0/Liffy"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            )
          }
        </Field>

        {/* The picker needs a repository id, which only exists for one Liffy
            has connected — an arbitrary `owner/name` typed into the box above
            has nothing to list. */}
        {selectedRepo && !typedPr ? (
          <Field label="Pull request" required>
            {() => (
              <PullRequestPicker
                repoId={selectedRepo.id}
                value={prNumber === "" ? null : Number(prNumber)}
                onChange={(number) => setPrNumber(String(number))}
                onFallback={() => setTypedPr(true)}
              />
            )}
          </Field>
        ) : (
          <Field
            label="Pull request"
            hint="The number from the PR's URL."
            error={
              numberInvalid
                ? "A pull request number is a whole number above zero."
                : null
            }
            required
          >
            {(props) => (
              <Input
                {...props}
                // type="number" would let a browser hand us "1e3" and "1.5";
                // inputMode gets the numeric keypad without the loopholes.
                inputMode="numeric"
                name="pr_number"
                placeholder="58"
                value={prNumber}
                onChange={(event) => setPrNumber(event.target.value)}
                className="w-28"
              />
            )}
          </Field>
        )}

        {serverError && serverError.kind !== "validation" && (
          <ErrorNote error={trigger.error} />
        )}
      </form>
    </Modal>
  );
}

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Field, Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
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
 */
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
          hint={FULL_NAME_HINT}
          error={
            nameInvalid
              ? "That doesn't look like owner/name."
              : serverError?.kind === "validation"
                ? serverError.message
                : null
          }
          required
        >
          {(props) => (
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
          )}
        </Field>

        <Field
          label="Pull request"
          hint="The number from the PR's URL."
          error={numberInvalid ? "A pull request number is a whole number above zero." : null}
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

        {serverError && serverError.kind !== "validation" && (
          <ErrorNote error={trigger.error} />
        )}
      </form>
    </Modal>
  );
}

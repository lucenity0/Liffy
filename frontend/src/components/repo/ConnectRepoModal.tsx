import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Field, Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useConnectRepo } from "@/hooks/useRepoMutations";
import { normalizeApiError } from "@/lib/errors";
import {
  FULL_NAME_HINT,
  isValidFullName,
  normalizeFullName,
} from "@/lib/validators";
import type { RepoOut } from "@/types/api";

/**
 * Connect a repository: `owner/name` in, `POST /repos` out.
 *
 * Mounted only while open (there is no `open` prop) so the field, the error
 * and the mutation all start clean every time it is opened — reopening a
 * modal still holding the last attempt's error is a classic bit of grit.
 *
 * Errors land in two different places on purpose, which is the distinction
 * that actually matters to someone staring at the form:
 *   - "the value is wrong" — client validation, 422, and 502 (GitHub could
 *     not find it) — under the input, where the fix is.
 *   - "the server cannot do this right now" — 503 and network failures —
 *     in a note below, because retyping the name will not help.
 */
export function ConnectRepoModal({
  onClose,
  knownRepoIds,
}: {
  onClose: () => void;
  /**
   * Ids already in the repo list. `POST /repos` is idempotent and answers
   * 201 either way — reconnecting an existing repo just re-queues indexing
   * — so comparing against what we already had is the only way to tell the
   * two apart without a backend change.
   */
  knownRepoIds: ReadonlySet<string>;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [requeued, setRequeued] = useState<RepoOut | null>(null);

  const connect = useConnectRepo();
  const serverError = connect.error ? normalizeApiError(connect.error) : null;
  const inField =
    serverError && (serverError.kind === "validation" || serverError.kind === "upstream");

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (!isValidFullName(value)) {
      // Never reaches the network — the backend would only 422 it back.
      setInvalid(true);
      return;
    }

    setInvalid(false);
    setRequeued(null);
    connect.mutate(normalizeFullName(value), {
      onSuccess: (repo) => {
        // A repo we already had: closing now would look like nothing
        // happened, since no new card appears. Say what did happen instead.
        if (knownRepoIds.has(repo.id)) setRequeued(repo);
        else onClose();
      },
    });
  }

  const fieldError = invalid
    ? "That doesn't look like owner/name."
    : inField
      ? serverError.message
      : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Connect a repository"
      description="Liffy indexes it, then reviews every pull request opened against it."
      footer={
        <>
          <Button onClick={onClose}>{requeued ? "Done" : "Cancel"}</Button>
          <Button
            type="submit"
            form="connect-repo"
            variant="primary"
            loading={connect.isPending}
          >
            Connect
          </Button>
        </>
      }
    >
      {/* The submit button lives in the modal footer, outside this form —
          `form="connect-repo"` is what still makes it submit, and keeps Enter
          in the text field working. */}
      <form
        id="connect-repo"
        onSubmit={onSubmit}
        // noValidate, but the fields keep `required`: without this the
        // browser's own bubble fires first on an empty field and our message
        // never renders — and that bubble is the one thing on the page that
        // cannot be made to look like paper.
        noValidate
        className="flex flex-col gap-3"
      >
        <Field label="Repository" hint={FULL_NAME_HINT} error={fieldError} required>
          {(props) => (
            <Input
              {...props}
              autoFocus
              name="full_name"
              placeholder="lucenity0/Liffy"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setInvalid(false);
              }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          )}
        </Field>

        {serverError && !inField && <ErrorNote error={connect.error} />}

        {requeued && (
          <p role="status" className="text-base text-sage">
            {requeued.full_name} was already connected — indexing re-queued.
          </p>
        )}
      </form>
    </Modal>
  );
}

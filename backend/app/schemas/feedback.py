"""Comment-feedback request/response models (report §6.4, §3 step 14)."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class FeedbackIn(BaseModel):
    """A thumbs up or a thumbs down. Nothing else.

    ``Literal[1, -1]`` rather than ``int`` on purpose: FastAPI turns an
    out-of-range value into a 422 before the handler runs, so the endpoint has
    no validation branch of its own to keep correct. The column behind this is
    a ``SmallInteger`` with no check constraint, which makes this boundary the
    only thing keeping a ``0`` or a ``7`` out of the approval-rate denominator.
    """

    rating: Literal[1, -1]


class FeedbackOut(BaseModel):
    """The saved row.

    ``created_at`` is the row's original creation time and does not move when a
    rating is replaced. There is no ``updated_at``: report §5 lists exactly
    ``id, comment_id, user_id, rating, created_at``, and re-rating overwrites
    ``rating`` in place rather than appending a second row.
    """

    model_config = ConfigDict(from_attributes=True)

    comment_id: uuid.UUID
    rating: int
    created_at: datetime


class EvalScoresOut(BaseModel):
    """Report §8.1's first two metrics for one review (``GET /reviews/{id}/eval``).

    **Both rates are nullable, and ``null`` is not ``0.0``.** ``null`` means
    nobody has rated; ``0.0`` means every rating was negative. The stub this
    replaced returned a hardcoded ``0.0`` for an unrated review, which reads as
    a measurement and is not one — so ``approval_rate ?? 0`` anywhere
    downstream puts the bug straight back.

    ``rated_comments`` is the denominator and is in the response on purpose: a
    bare "83%" over a sample of six invites a conclusion the data cannot
    support, and n is always small here.

    ``false_positive_rate`` is ``1 - approval_rate`` exactly; see ADR 004.
    """

    model_config = ConfigDict(from_attributes=True)

    review_id: uuid.UUID
    total_comments: int
    rated_comments: int
    approval_rate: float | None
    false_positive_rate: float | None

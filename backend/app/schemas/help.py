"""Response shapes for the help search (#237)."""

from pydantic import BaseModel


class HelpLink(BaseModel):
    """A `related:` pointer, resolved to a title so the client need not look it up."""

    slug: str
    title: str


class HelpPassage(BaseModel):
    """One page of the corpus, as the client renders it.

    ``body`` is the whole page, not an extract. The reading pane shows all of
    it, and a server-side summary would be the one place in this feature where
    something other than the author decides what the answer says.
    """

    slug: str
    title: str
    snippet: str
    """The opening of the page, for the list pane."""

    body: str
    """Markdown. Rendered by the client."""

    related: list[HelpLink]
    figure: str
    """Name of a diagram the client draws above the text, or "" for none."""

    score: float
    """Exposed for debugging and for ordering ties client-side, not for display."""


class HelpSearchOut(BaseModel):
    query: str
    results: list[HelpPassage]
    """Empty means *nothing matched*, which is an answer rather than an error.

    The client renders it as "Liffy's docs don't cover that" — never as a
    failure, and never by falling back to the closest miss.
    """


class HelpTopic(BaseModel):
    slug: str
    title: str


class HelpIndexOut(BaseModel):
    """What the page shows before anything is typed."""

    common: list[HelpTopic]
    """The hand-picked starting questions."""

    all_topics: list[HelpTopic]

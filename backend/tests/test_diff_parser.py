from app.services.diff_parser import (
    FileStatus,
    LineKind,
    chunk_text,
    map_position_to_file_line,
    parse_diff,
)

SINGLE_FILE_DIFF = """\
diff --git a/app/util.py b/app/util.py
index 1111111..2222222 100644
--- a/app/util.py
+++ b/app/util.py
@@ -10,7 +10,8 @@ def helper():
 context line 10
 context line 11
-old line 12
+new line 12
+inserted line 13
 context
 context
 context
 context
"""

MULTI_FILE_DIFF = """\
diff --git a/README.md b/README.md
index aaa..bbb 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Title
+New paragraph.
 Body.
diff --git a/new_module.py b/new_module.py
new file mode 100644
index 000..ccc
--- /dev/null
+++ b/new_module.py
@@ -0,0 +1,2 @@
+def hello():
+    return "hi"
diff --git a/old_module.py b/old_module.py
deleted file mode 100644
index ddd..000
--- a/old_module.py
+++ /dev/null
@@ -1,2 +0,0 @@
-def bye():
-    return "bye"
diff --git a/pics/logo.png b/pics/logo.png
index eee..fff 100644
Binary files a/pics/logo.png and b/pics/logo.png differ
diff --git a/old_name.py b/new_name.py
similarity index 90%
rename from old_name.py
rename to new_name.py
index 123..456 100644
--- a/old_name.py
+++ b/new_name.py
@@ -1,2 +1,2 @@
-x = 1
+x = 2
 y = 3
"""


def test_single_file_parse() -> None:
    files = parse_diff(SINGLE_FILE_DIFF)
    assert len(files) == 1
    fd = files[0]
    assert fd.path == "app/util.py"
    assert fd.status == FileStatus.modified
    assert len(fd.hunks) == 1
    hunk = fd.hunks[0]
    assert (hunk.old_start, hunk.old_count, hunk.new_start, hunk.new_count) == (10, 7, 10, 8)
    assert hunk.section == "def helper():"
    kinds = [dl.kind for dl in hunk.lines]
    assert kinds.count(LineKind.added) == 2
    assert kinds.count(LineKind.removed) == 1
    assert kinds.count(LineKind.context) == 6


def test_line_number_assignment() -> None:
    hunk = parse_diff(SINGLE_FILE_DIFF)[0].hunks[0]
    removed = next(dl for dl in hunk.lines if dl.kind == LineKind.removed)
    assert (removed.old_lineno, removed.new_lineno) == (12, None)
    added = [dl for dl in hunk.lines if dl.kind == LineKind.added]
    assert [(dl.old_lineno, dl.new_lineno) for dl in added] == [(None, 12), (None, 13)]
    last_context = hunk.lines[-1]
    assert (last_context.old_lineno, last_context.new_lineno) == (16, 17)


def test_multi_file_statuses() -> None:
    files = parse_diff(MULTI_FILE_DIFF)
    by_path = {fd.path: fd for fd in files}
    assert len(files) == 5
    assert by_path["README.md"].status == FileStatus.modified
    assert by_path["new_module.py"].status == FileStatus.added
    assert by_path["old_module.py"].status == FileStatus.deleted  # canonical path = old path
    assert by_path["pics/logo.png"].is_binary and not by_path["pics/logo.png"].hunks
    assert by_path["new_name.py"].status == FileStatus.renamed
    assert by_path["new_name.py"].old_path == "old_name.py"


def test_new_file_lines_start_at_one() -> None:
    fd = next(f for f in parse_diff(MULTI_FILE_DIFF) if f.path == "new_module.py")
    assert [dl.new_lineno for dl in fd.hunks[0].lines] == [1, 2]
    assert all(dl.old_lineno is None for dl in fd.hunks[0].lines)


def test_map_position_to_file_line() -> None:
    fd = parse_diff(SINGLE_FILE_DIFF)[0]
    # position 1 = hunk header; 2-3 context (10, 11); 4 removed; 5-6 added (12, 13)
    assert map_position_to_file_line(fd, 2) == 10
    assert map_position_to_file_line(fd, 4) is None  # removed line: no new-file line
    assert map_position_to_file_line(fd, 5) == 12
    assert map_position_to_file_line(fd, 6) == 13
    assert map_position_to_file_line(fd, 99) is None  # out of range


def test_chunk_text_headers_and_body() -> None:
    fd = parse_diff(SINGLE_FILE_DIFF)[0]
    chunks = chunk_text(fd)
    assert len(chunks) == 1
    header, *body = chunks[0].splitlines()
    assert header == "# app/util.py lines 10-17 (def helper():)"
    assert "+new line 12" in body
    assert "-old line 12" in body


def test_empty_and_garbage_input() -> None:
    assert parse_diff("") == []
    assert parse_diff("not a diff at all\njust text\n") == []

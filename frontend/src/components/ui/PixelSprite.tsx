import { useMemo } from "react";
import { cn } from "@/lib/utils";

/**
 * Liffy's pixel art, in the app.
 *
 * Four small marks that belong to the copy beside them — a key for access, a
 * book for the index, an eye for review, a star for the score. The same maps
 * the landing page and the report use, character for character.
 *
 * The cat is not here. It is the logo now, and a logo with four tones and
 * white eyes does not survive being traced into one ink: see LiffyMark.
 *
 * Drawn in `currentColor` on `shape-rendering: crispEdges`, so it themes for
 * free across every palette and stays monochrome — it costs nothing at any
 * size and never needs a second asset for dark mode.
 */

const MAPS = {
  key: [".###.", "#...#", "#...#", ".###.", "..#..", "..##.", "..#..", "..##."],
  book: [
    "########",
    "#......#",
    "#.####.#",
    "#......#",
    "#.####.#",
    "#......#",
    "#.####.#",
    "########",
  ],
  eye: [
    "..####..",
    ".#....#.",
    "#..##..#",
    "#.####.#",
    "#..##..#",
    ".#....#.",
    "..####..",
    "........",
  ],
  star: [
    "...#...",
    "...#...",
    ".#####.",
    "..###..",
    ".##.##.",
    "##...##",
    "#.....#",
  ],
} as const;

export type SpriteName = keyof typeof MAPS;

interface Rect {
  x: number;
  y: number;
  w: number;
}

/**
 * Horizontal runs merged into one rect each.
 *
 * A rect per lit pixel would be ~250 nodes for the cat; merged runs bring it
 * under 40. Same picture, and at `crispEdges` there is no seam between
 * adjacent rects to give it away.
 */
function runsOf(map: readonly string[]): Rect[] {
  const rects: Rect[] = [];
  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === "#") {
        let run = 0;
        while (x + run < row.length && row[x + run] === "#") run++;
        rects.push({ x, y, w: run });
        x += run;
      } else {
        x++;
      }
    }
  });
  return rects;
}

export function PixelSprite({
  /* No default worth having: the four marks mean four different things, and
     a caller that does not name one has not decided yet. */
  name = "key",
  cell = 4,
  className,
  title,
}: {
  name?: SpriteName;
  /** Pixel size of one cell. The art is designed at 3–6. */
  cell?: number;
  className?: string;
  /**
   * Only pass this when the sprite carries meaning on its own. Beside a
   * heading that already says the same thing it is decorative, and a second
   * announcement is noise.
   */
  title?: string;
}) {
  const map = MAPS[name];
  const rects = useMemo(() => runsOf(map), [map]);
  const width = map[0].length * cell;
  const height = map.length * cell;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      fill="currentColor"
      shapeRendering="crispEdges"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
    >
      {rects.map((r) => (
        <rect
          key={`${r.x}-${r.y}`}
          x={r.x * cell}
          y={r.y * cell}
          width={r.w * cell}
          height={cell}
        />
      ))}
    </svg>
  );
}

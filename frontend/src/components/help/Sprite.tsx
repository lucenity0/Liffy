import type { ReactNode } from "react";

/**
 * The landing page's pixel sprites, drawn as SVG rects.
 *
 * Ported from `docs/landing.src.html` rather than imported, because that file
 * is a standalone build artefact with no module boundary to import across.
 * The bitmaps below are the same ones the landing page draws, so the marketing
 * page and the manual illustrate Liffy with the same hand — which is the point
 * of using them here at all.
 *
 * Runs of `#` collapse into one `<rect>`, exactly as the original does. At
 * these sizes it hardly matters; keeping the algorithm identical means a
 * sprite copied from the landing page renders the same here without thought.
 */

const MAPS: Record<string, string[]> = {
  key: [
    ".###.",
    "#...#",
    "#...#",
    ".###.",
    "..#..",
    "..##.",
    "..#..",
    "..##.",
  ],
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
};

export type SpriteName = keyof typeof MAPS & string;

export function Sprite({
  name,
  cell = 4,
  className,
}: {
  name: string;
  cell?: number;
  className?: string;
}) {
  const map = MAPS[name];
  if (!map) return null;

  const width = map[0].length * cell;
  const height = map.length * cell;
  const rects: ReactNode[] = [];

  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === "#") {
        let run = 0;
        while (x + run < row.length && row[x + run] === "#") run++;
        rects.push(
          <rect
            key={`${x}-${y}`}
            x={x * cell}
            y={y * cell}
            width={run * cell}
            height={cell}
          />,
        );
        x += run;
      } else {
        x++;
      }
    }
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={className}
    >
      {rects}
    </svg>
  );
}

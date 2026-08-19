/**
 * The café, on a 320-unit-wide pixel grid.
 *
 * A cat asleep on a sunlit windowsill, with a cup going cold beside it. It
 * is the sign-in screen's illustration and the landing page's hero, and it
 * is the same picture in both: the room is painted here, and `/hero-cat.gif`
 * — 40 frames of pixel art, ink and fur and cushion in three flat colours —
 * is laid over it at the same scale, so one unit here is one of the cat's
 * own pixels. That is what puts the sill under its paws at every width. The
 * two layers are one drawing, split only by which of them had to animate.
 *
 * The grid was 240 wide first, which left the cat at 96 of its own pixels
 * and its face a smudge — at that size the closed eyes and the muzzle merge
 * into one mark. Resolution is the fix, and it has to be the *room's*: the
 * cat is drawn at 128 and cannot be resampled smaller without losing the
 * lines, so the room grew instead. Same picture, same relative size, twice
 * the detail in the animal.
 *
 * Height is not fixed. The room is SCENE_H tall and sits on the bottom edge;
 * a taller box gets more wall and a longer flex on the pendant, which is
 * what lets the sign-in screen stretch the picture level with the column
 * beside it instead of leaving a hole under one of them.
 *
 * Framework-free on purpose: `docs/landing.src.html` is hand-authored and
 * shares no build with the app, so it carries its own copy of this. Two
 * copies of one picture, the same arrangement as the pixel maps in
 * PixelSprite — and the same rule applies. Change the café here, change it
 * there, or the front door stops matching the front desk.
 *
 * Coordinates are literals rather than derived. A scene this size is read by
 * looking at it, and a named constant for the second jar on the shelf would
 * be a worse map of the picture than the number is.
 */

/** The grid's width, and the room's natural height on it. */
export const SCENE_W = 320;
export const SCENE_H = 232;

/** The cat sprite's own size. Its frame is larger than the drawing in it. */
export const CAT_W = 128;
export const CAT_H = 108;

/**
 * Where the cat sits when the box is exactly SCENE_W x SCENE_H: (96, 90),
 * which centres it on the window and lands its cushion on the sill at row
 * 190. React writes this once so the sprite is never unplaced on the first
 * frame; `mountCafeScene` then owns it, because in a taller box the room
 * slides down and the sprite has to slide with it.
 */
export const CAT_BOX = {
  left: `${(96 / SCENE_W) * 100}%`,
  top: `${(90 / SCENE_H) * 100}%`,
  width: `${(CAT_W / SCENE_W) * 100}%`,
  height: `${(CAT_H / SCENE_H) * 100}%`,
};

const KEYS = [
  "wall",
  "wall-lo",
  "line",
  "rule",
  "frame",
  "frame-hi",
  "ink",
  "glass",
  "glass-lo",
  "cloud",
  "far",
  "ground",
  "tree",
  "warm",
  "glow",
  "steam",
] as const;

type Palette = Record<string, string>;

/**
 * Paint the café into `canvas` and keep it painted. Returns the teardown.
 *
 * Everything it owns — the animation frame, the probe element, the resize
 * observer, the two theme listeners — is released by that call, so a route
 * change does not leave a requestAnimationFrame loop running against a
 * detached canvas.
 */
export function mountCafeScene(
  canvas: HTMLCanvasElement,
  options: { reading?: boolean } = {},
): () => void {
  const g = canvas.getContext("2d");
  if (!g) return () => {};

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cat = canvas.parentElement?.querySelector<HTMLElement>("[data-cat]");

  /* ---- palette ------------------------------------------------------
   * Straight off the --scene-* custom properties in index.css, so the room
   * is themed by the same table as the rest of the app and every rung of
   * the theme ladder gets it for free.
   *
   * Read through a probe element rather than with getPropertyValue():
   * custom properties come back as *written*, and a 2d context will not
   * parse the color-mix() that half of them are. Setting `color` and
   * reading it back makes the browser do the resolving, and because the
   * probe sits in the tree it inherits whichever theme is on <html>. */
  const probe = document.createElement("i");
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
  (canvas.parentElement ?? document.body).appendChild(probe);

  const C: Palette = {};
  function readPalette() {
    for (const key of KEYS) {
      probe.style.color = `var(--scene-${key})`;
      const name = key.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
      C[name] = getComputedStyle(probe).color;
    }
  }

  /* ---- day or night --------------------------------------------------
   * The one thing in the scene that is not a colour swap: under a dark
   * theme the window looks out on a night, and a night has stars and a
   * moon in it rather than a sun. Decided by the wall's own luminance
   * rather than by a theme name, so a theme added to the ladder later
   * gets the right sky without being listed here.
   *
   * Measured by painting the colour and reading the pixel back rather
   * than by parsing the string: a resolved color-mix() comes back as
   * `oklab(0.23 …)`, not as `rgb(34, 31, 26)`, and a regex written for
   * the second quietly reads the first as a bright wall.
   *
   * The cat does not flip. It is the same white cat in both, which is the
   * point of it — a cat asleep in a window is the same cat at four in the
   * afternoon and at nine at night. */
  const swatch = document.createElement("canvas").getContext("2d");
  let night = false;
  function readSky() {
    if (!swatch) return;
    swatch.clearRect(0, 0, 1, 1);
    swatch.fillStyle = C.wall;
    swatch.fillRect(0, 0, 1, 1);
    const d = swatch.getImageData(0, 0, 1, 1).data;
    night = (d[0] * 299 + d[1] * 587 + d[2] * 114) / 1000 < 128;
  }

  readPalette();
  readSky();

  /* ---- fitting the box ----------------------------------------------
   * The grid is always SCENE_W across, so a unit is always boxWidth/320 in
   * *both* axes and nothing is ever stretched. Only the number of rows
   * changes, and the extra ones are split either side of the room: OY
   * shifts the drawing down by a little over half of them, the wall fills
   * whatever is left under the sill, and the pendant's flex grows to match.
   * Slightly more above than below, because that is where a ceiling is from
   * a seat by the window — bottom-anchoring it instead put the whole surplus
   * overhead and the room read as a cellar with a very long flex.
   * Clamped at SCENE_H, so a box wider than the room's own ratio squashes
   * rather than losing the top of the window. */
  let VH = SCENE_H;
  let OY = 0;
  function fit(): boolean {
    const box = canvas.getBoundingClientRect();
    if (!box.width) return false;
    const rows = Math.max(
      SCENE_H,
      Math.round((SCENE_W * box.height) / box.width),
    );
    if (rows === VH && canvas.height === rows) return false;
    VH = rows;
    OY = Math.round((VH - SCENE_H) * 0.55);
    canvas.height = VH; /* also clears it; the next draw fills every pixel */
    if (cat) {
      cat.style.top = `${((90 + OY) / VH) * 100}%`;
      cat.style.height = `${(CAT_H / VH) * 100}%`;
    }
    return true;
  }

  function px(x: number, y: number, w: number, h: number, c: string) {
    g!.fillStyle = c;
    g!.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function disc(cx: number, cy: number, r: number, c: string) {
    g!.fillStyle = c;
    g!.beginPath();
    g!.arc(cx, cy, r, 0, Math.PI * 2);
    g!.fill();
  }

  /* A cloud is four stepped bars, not an ellipse: at fifteen pixels wide an
     ellipse renders as a lozenge with two chewed ends. Stepping the widths
     in and the offsets across gives it a flat base and a lumpy top, which
     is the only thing that has to be true. */
  function cloud(x: number, y: number, w: number) {
    px(x, y + 6, w, 3, C.cloud);
    px(x + w * 0.08, y + 3, w * 0.84, 3, C.cloud);
    px(x + w * 0.22, y, w * 0.42, 3, C.cloud);
    px(x + w * 0.6, y + 2, w * 0.26, 2, C.cloud);
  }

  function tree(x: number, base: number, r: number) {
    px(x - 1, base - 2, 3, 6, C.tree); /* trunk */
    disc(x, base - r, r, C.tree);
    px(x - r, base + 3, r * 2, 2, C.far); /* where it meets the ground */
  }

  function bird(x: number, y: number) {
    px(x, y, 2, 2, C.far);
    px(x + 2, y - 2, 2, 2, C.far);
    px(x + 4, y, 2, 2, C.far);
  }

  /* The opening in the wall. The glass ends exactly where the sill begins,
     at row 190, which is also where the cat's cushion lands. */
  const WX = 48,
    WY = 22,
    WW = 224,
    WH = 174,
    FR = 6;
  const GX = WX + FR,
    GY = WY + FR,
    GW = WW - 2 * FR,
    GH = WH - 2 * FR;
  const SILL = GY + GH; /* 190 */
  const HZ = 138; /* the horizon, out there */

  /* Three clouds, fixed rather than seeded: at fifteen pixels wide the
     difference between a good cloud and a bad one is which fifteen. */
  const CLOUDS = [
    { y: 44, w: 31, sp: 0.026, ph: 0.1 },
    { y: 65, w: 20, sp: 0.041, ph: 0.62 },
    { y: 36, w: 15, sp: 0.018, ph: 0.38 },
  ];

  /* Stars, seeded once. Not written out like the roofs — a constellation
     wants the opposite of a rhythm — but not re-rolled per frame either, or
     the sky would boil. Kept clear of the moon's corner. */
  const STARS = (() => {
    const out: {
      x: number;
      y: number;
      ph: number;
      sp: number;
      big: boolean;
    }[] = [];
    let seed = 8171;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    while (out.length < 56) {
      const x = GX + 2 + Math.floor(rnd() * (GW - 4));
      const y = GY + 2 + Math.floor(rnd() * 90);
      if (x > 185 && x < 235 && y < 78) continue; /* the moon's corner */
      out.push({
        x,
        y,
        ph: rnd() * 6.28,
        sp: 0.5 + rnd() * 1.5,
        big: rnd() > 0.87,
      });
    }
    return out;
  })();

  /* A skyline wants a rhythm, and Math.random() has not got one, so the
     roofs are written out: [x, width, height above the horizon]. */
  const ROOFS = [
    [51, 16, 11],
    [67, 12, 19],
    [79, 20, 10],
    [99, 11, 23],
    [109, 23, 15],
    [132, 15, 24],
    [147, 17, 13],
    [164, 24, 19],
    [188, 13, 11],
    [201, 20, 23],
    [221, 16, 13],
    [237, 24, 18],
    [261, 16, 15],
  ];

  function draw(t: number) {
    /* ---- the room ---------------------------------------------------- */
    px(0, 0, SCENE_W, VH, C.wall);
    px(0, VH - 11, SCENE_W, 1, C.line); /* skirting, to stand the room up */
    px(0, VH - 10, SCENE_W, 10, C.wallLo);

    /* ---- the view, clipped to the glass ------------------------------ */
    g!.save();
    g!.beginPath();
    g!.rect(GX, GY + OY, GW, GH);
    g!.clip();

    px(GX, GY + OY, GW, GH, C.glass); /* sky */
    /* The warm band at the horizon is the last of the daylight, so it only
       belongs to the day. Left on at night it read as a sunset that had
       been going for six hours. */
    if (!night) px(GX, HZ - 36 + OY, GW, 36, C.glassLo);
    px(GX, HZ + OY, GW, GY + GH - HZ, C.ground); /* the park over the road */

    if (night) {
      /* Stars first, so the moon's glow sits over them. Anything that dim
         gets dropped rather than drawn at a fractional alpha — at one pixel
         each, a star is either there or it is not. */
      for (const s of STARS) {
        const tw = reduce
          ? 0.8
          : 0.45 + 0.55 * Math.sin(t * 0.0018 * s.sp + s.ph);
        if (tw < 0.3) continue;
        px(s.x, s.y + OY, 2, 2, tw > 0.6 ? C.warm : C.far);
        if (s.big && tw > 0.75) {
          /* the few that get a cross */
          px(s.x - 2, s.y + OY, 2, 2, C.far);
          px(s.x + 2, s.y + OY, 2, 2, C.far);
          px(s.x, s.y - 2 + OY, 2, 2, C.far);
          px(s.x, s.y + 2 + OY, 2, 2, C.far);
        }
      }
      /* Full, with craters, and glowing the same way the sun does — the two
         are the same object at opposite ends of the day, and the scene is
         easier to read if they are drawn the same. A crescent was the first
         try: cut with a second disc it bites a hole out of the glow behind
         it, and cut with an even-odd path it fills *both* lunes and comes
         out as a ring. */
      for (const r of [20, 16, 12, 8]) {
        g!.globalAlpha = 0.13;
        disc(209, 54 + OY, r, C.glow);
      }
      g!.globalAlpha = 1;
      disc(209, 54 + OY, 11, C.warm);
      px(205, 50 + OY, 3, 3, C.glow);
      px(212, 58 + OY, 3, 3, C.glow);
      px(212, 48 + OY, 2, 2, C.glow);
    } else {
      /* A low sun, left of where the cat sits. Five discs at one low alpha
         rather than three at rising ones: equal coats stack into a falloff,
         stepped ones stack into a fried egg. */
      for (const r of [19, 16, 13, 11, 8]) {
        g!.globalAlpha = 0.15;
        disc(86, 109 + OY, r, C.glow);
      }
      g!.globalAlpha = 1;
      disc(86, 109 + OY, 7, C.warm);
    }

    ROOFS.forEach(([x, w, h], i) => {
      px(x, HZ - h + OY, w, h, C.far);
      px(x, HZ - h + OY, w, 2, C.rule); /* a lit ridge line */
      /* Lit windows, once the sun is down — what replaces the horizon glow
         as the warm thing on that side of the glass. Which ones are on
         comes off the window's own coordinates rather than a seeded list:
         at two pixels across, a building wants an arbitrary pattern, not a
         random one, and this way the town is the same town every load. */
      if (!night) return;
      g!.globalAlpha = 0.85;
      for (let wy = HZ - h + 5; wy < HZ - 3; wy += 6)
        for (let wx = x + 2; wx < x + w - 3; wx += 5)
          if ((wx * 7 + wy * 13 + i * 29) % 11 < 4)
            px(wx, wy + OY, 2, 3, C.warm);
      g!.globalAlpha = 1;
    });

    /* Two trees in the park, nearer than the roofs and so stronger. */
    tree(61, 132 + OY, 10);
    tree(253, 135 + OY, 9);
    px(GX, 157 + OY, GW, 2, C.far); /* the far edge of a path */

    /* Clouds, drifting. They wrap through a span wider than the glass, so
       one never pops into existence at the frame edge. */
    g!.globalAlpha = night ? 0.5 : 1; /* lit from below by a city, not a sun */
    for (const cl of CLOUDS) {
      cloud(
        GX - 54 + ((cl.ph + (t * cl.sp) / 100000) % 1) * (GW + 108),
        cl.y + OY,
        cl.w,
      );
    }
    g!.globalAlpha = 1;

    /* Two birds, further off and slower than the clouds. Daylight only — at
       night they read as a smudge on the glass. */
    if (!night) {
      const bx = GX - 26 + ((0.2 + t * 0.0000075) % 1) * (GW + 52);
      bird(bx, 60 + OY);
      bird(bx + 14, 70 + OY);
    }

    g!.restore();

    /* ---- the joinery ------------------------------------------------- */
    px(158, GY + OY, 4, GH, C.frame); /* muntins */
    px(GX, 93 + OY, GW, 4, C.frame);
    px(WX, WY + OY, WW, FR, C.frameHi); /* head */
    px(WX, WY + OY, FR, WH, C.frame); /* jambs */
    px(WX + WW - FR, WY + OY, FR, WH, C.frame);
    px(WX - 2, WY - 2 + OY, WW + 4, 2, C.rule); /* the line it casts */
    px(WX - 2, WY + OY, 2, WH, C.rule);
    px(WX + WW, WY + OY, 2, WH, C.rule);

    /* ---- what stands on the sill, in front of the light -------------- */
    /* In the reading scene a monitor takes the books' and cup's place beside
       the cat. It is the one lit thing in a backlit room, which is the whole
       reason it reads as "something is happening here" while everything else
       reads as "and the cat is not worried about it".

       The lines on it are abstract on purpose. A review is one model call, so
       nothing knows which file the model is looking at — a screen naming real
       files as they scrolled would be inventing that. Shapes that read as text
       claim nothing, and the step list beside this says what is actually
       known. */
    if (options.reading) {
      const SCREEN_X = 44;
      const SCREEN_Y = 150 + OY;
      const SCREEN_W = 52;
      const SCREEN_H = 34;

      /* Stand and base first, so the bezel sits over them. */
      px(SCREEN_X + 22, SCREEN_Y + SCREEN_H, 8, 5, C.ink);
      px(SCREEN_X + 14, SCREEN_Y + SCREEN_H + 5, 24, 3, C.ink);

      /* Bezel, then the lit panel inset inside it. */
      px(SCREEN_X, SCREEN_Y, SCREEN_W, SCREEN_H, C.ink);
      px(SCREEN_X + 3, SCREEN_Y + 3, SCREEN_W - 6, SCREEN_H - 6, C.glow);

      /* The spill of light onto the sill in front of it. Three bands rather
         than a gradient: this grid is one pixel per unit, and a gradient at
         this size is a smudge. */
      g!.globalAlpha = 0.5;
      px(SCREEN_X - 2, SCREEN_Y + SCREEN_H + 8, SCREEN_W + 4, 2, C.glow);
      g!.globalAlpha = 0.3;
      px(SCREEN_X - 5, SCREEN_Y + SCREEN_H + 10, SCREEN_W + 10, 2, C.glow);
      g!.globalAlpha = 1;

      /* The text. Six rows scrolling upward, each row's width driven by its
         index so the block reads as prose rather than as a bar chart, and two
         rows tinted warm so it reads as a diff without being one. */
      const ROW = 4;
      const rows = Math.floor((SCREEN_H - 8) / ROW);
      const scroll = (t / 90) % ROW;
      for (let i = 0; i < rows + 1; i += 1) {
        const y = SCREEN_Y + 5 + i * ROW - scroll;
        if (y < SCREEN_Y + 4 || y > SCREEN_Y + SCREEN_H - 6) continue;
        /* Deterministic pseudo-width: no Math.random, so a repaint on resize
           does not reshuffle the whole block under the reader. */
        const seed = Math.floor(i + t / (90 * ROW));
        const w = 12 + ((seed * 37) % (SCREEN_W - 22));
        const changed = (seed * 7) % 5 === 0;
        g!.globalAlpha = changed ? 0.9 : 0.55;
        px(SCREEN_X + 6, Math.round(y), w, 2, changed ? C.warm : C.ink);
      }
      g!.globalAlpha = 1;
    }

    /* Two books seen edge-on: dark boards with a block of pages between.
       Boards in the darkest ink, like the cup — everything on this sill is
       backlit, and backlit things are shapes before they are objects. */
    if (!options.reading) {
      px(46, 176 + OY, 22, 2, C.ink);
      px(46, 178 + OY, 22, 2, C.frameHi);
      px(46, 180 + OY, 22, 2, C.ink);
      px(44, 182 + OY, 26, 2, C.ink);
      px(44, 184 + OY, 26, 3, C.frameHi);
      px(44, 187 + OY, 26, 2, C.ink);

      /* The cup. Body in the darkest ink so it silhouettes against the glass;
       the rim catches the window, which is what sells the depth. */
      px(76, 174 + OY, 16, 16, C.ink);
      px(74, 171 + OY, 20, 3, C.frameHi);
      px(92, 177 + OY, 4, 3, C.ink);
      px(95, 180 + OY, 3, 3, C.ink);
      px(92, 183 + OY, 4, 3, C.ink);

      /* A plant on the far side of the cat, to answer the cup. */
      px(238, 176 + OY, 18, 13, C.ink);
      px(236, 173 + OY, 22, 3, C.frameHi);
      px(246, 160 + OY, 3, 13, C.tree);
      px(240, 157 + OY, 6, 3, C.tree);
      px(237, 153 + OY, 4, 3, C.tree);
      px(249, 154 + OY, 6, 3, C.tree);
      px(253, 150 + OY, 4, 3, C.tree);
      px(244, 149 + OY, 4, 3, C.tree);
    }

    /* ---- the sill ---------------------------------------------------- */
    px(38, SILL + OY, 244, 9, C.frameHi);
    px(35, SILL + 9 + OY, 250, 5, C.frame);

    /* The window's light, falling down the wall under it. This is the only
       job the strip below the sill has; a chair went here first and read as
       a gate. */
    for (let i = 0; i < 22; i++) {
      g!.globalAlpha = 0.2 * (1 - i / 22);
      px(40 - i, SILL + 15 + i + OY, 240 + i * 2, 1, C.glow);
    }
    g!.globalAlpha = 1;

    /* ---- the pendant, on the strip of wall the window leaves ----------
       Hung from the ceiling rather than from the window, so a taller box
       lengthens the flex instead of leaving the lamp floating. */
    /* x 23, not 24: the flex is two units wide, so centring it on the
       shade's apex at 24 means starting it at 23. Starting it *at* 24 hangs
       the whole lamp one unit to the right of its own cord, which is
       exactly as visible as it sounds. */
    px(23, 0, 2, 30 + OY, C.frame);
    for (let i = 0; i < 9; i++)
      px(21 - i, 30 + i + OY, 6 + i * 2, 1, C.frameHi);
    px(21, 39 + OY, 6, 3, C.warm);
    for (let i = 0; i < 20; i++) {
      /* the cone it throws on the wall */
      g!.globalAlpha = 0.22 * (1 - i / 20) * (1 - i / 20);
      px(20 - i, 42 + i + OY, 8 + i * 2, 1, C.glow);
    }
    g!.globalAlpha = 1;

    /* ---- two jars on a shelf, on the other strip --------------------- */
    px(284, 62 + OY, 9, 11, C.frame);
    px(285, 59 + OY, 7, 3, C.frameHi);
    px(297, 65 + OY, 10, 8, C.frame);
    px(298, 62 + OY, 8, 3, C.frameHi);
    px(280, 73 + OY, 32, 3, C.frameHi);
    px(284, 76 + OY, 3, 4, C.frame);
    px(305, 76 + OY, 3, 4, C.frame);

    /* ---- steam ------------------------------------------------------- */
    /* Last, because it is the only thing that passes in front of the
       joinery. Two wisps on one cycle, offset. Each is two joined vertical
       runs rather than a column of loose dots: spaced dots climbing a long
       way up read as rain falling, which is the opposite of the mood. */
    for (let w = 0; w < 2; w++) {
      const p = ((t + w * 1600) % 3200) / 3200;
      const a = p < 0.25 ? p / 0.25 : (1 - p) / 0.75;
      g!.globalAlpha = Math.max(0, a) * 0.65;
      const sx = 78 + w * 7 + Math.sin(p * 4.2 + w * 2.3) * 2.4;
      const sy = 168 - p * 16 + OY;
      px(sx, sy, 2, 4, C.steam);
      px(sx + (w ? -2 : 2), sy - 4, 2, 3, C.steam);
    }
    g!.globalAlpha = 1;
  }

  /* Motion is four slow loops and nothing else — clouds, birds, steam, and
     the stars twinkling. Reduced motion gets one frame at a t that has all
     of them mid-cycle, so the still is the picture rather than an empty
     sky. */
  let frame = 0;
  fit();
  if (reduce) {
    draw(1400);
  } else {
    let start: number | null = null;
    const loop = (now: number) => {
      if (start === null) start = now;
      draw(now - start);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
  }

  /* Resize is the only thing that changes the row count, and the observer
     fires once on its own when it starts watching — so the rAF loop never
     has to measure, and does not force a layout read sixty times a second
     for a box that changes on resize and never otherwise. */
  const resize = new ResizeObserver(() => {
    if (fit() && reduce) draw(1400);
  });
  resize.observe(canvas);

  /* A theme change has to reach the canvas. The rAF loop picks the new
     palette up on its own once C is refreshed; the reduced-motion path
     draws exactly once, so it needs the redraw spelled out. Appearance
     writes both `data-theme` and the polarity class on <html>, and the
     media query answers for anyone on "system" — both, or half the
     visitors get a stale room. */
  function retheme() {
    readPalette();
    readSky();
    if (reduce) draw(1400);
  }
  const observer = new MutationObserver(retheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", retheme);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    resize.disconnect();
    observer.disconnect();
    media.removeEventListener("change", retheme);
    probe.remove();
  };
}

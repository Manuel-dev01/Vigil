/**
 * Vigil's mark: a sector light. A lamp at the base casts a V of light, with the arc that Admiralty charts
 * draw across a light's sector. The V is also the initial. Geometry is shared with brand/build.py, which
 * writes the SVG and PNG files in brand/.
 */
export const MARK_VIEWBOX = "0 0 48 48";
/** Beam edges, from just above the lamp to the top of the sector. */
export const MARK_EDGES = "M21.24 34.11 9 8 M26.76 34.11 39 8";
/** The sector arc: radius 28 around the lamp, 17 degrees either side of vertical. */
export const MARK_ARC = "M15.81 13.22 A28 28 0 0 1 32.19 13.22";
export const MARK_LAMP = { cx: 24, cy: 40, r: 3.6 };

export function Mark({ size = 28, title, className }: { size?: number; title?: string; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={MARK_EDGES} fill="none" stroke="currentColor" strokeWidth="3.2" />
      <path d={MARK_ARC} fill="none" stroke="currentColor" strokeWidth="2" />
      <circle {...MARK_LAMP} fill="var(--lamp-glow)" />
    </svg>
  );
}

/**
 * A QR code as one SVG path, drawn by the page itself (no image, no inline script). Loaded only when a
 * share link is shown, so uqr (vite.config.ts puts it in its own chunk) is not on the first load.
 */
import { encode } from "uqr";

/** The QR code of `text`: its width in modules (quiet zone of 4 included) and a path of its dark modules. */
export function qrPath(text: string): { size: number; d: string } {
  const { size, data } = encode(text, { ecc: "M", border: 4 });
  let d = "";
  data.forEach((row, y) => {
    // One rectangle per run of dark modules in a row.
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  });
  return { size, d };
}

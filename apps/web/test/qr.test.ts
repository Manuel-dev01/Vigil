/** The share link's QR code: a square of modules with a quiet zone, drawn as one path. */
import { describe, expect, it } from "vitest";
import { qrPath } from "../src/qr.ts";

const link = `https://vigil-pq.up.railway.app/#/payslip?entry=27&dk=${"A".repeat(43)}`;

describe("qrPath", () => {
  it("draws a whole QR symbol with a 4-module quiet zone", () => {
    const { size, d } = qrPath(link);
    const modules = size - 8;
    expect((modules - 17) % 4).toBe(0); // version v is 4v + 17 modules wide
    expect(modules).toBeGreaterThanOrEqual(21);
    // The top-left finder pattern starts at the quiet zone: a 7-module run on its first row.
    expect(d.startsWith("M4 4h7v1h-7z")).toBe(true);
    expect(d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });

  it("is the same for the same link and differs for another", () => {
    expect(qrPath(link)).toEqual(qrPath(link));
    expect(qrPath(link).d).not.toBe(qrPath(link.replace("27", "24")).d);
  });
});

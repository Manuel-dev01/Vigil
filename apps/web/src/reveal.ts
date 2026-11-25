/**
 * Reveal a block once, as it scrolls near the viewport: use `ref={reveal}`. The block rises and fades in
 * (transform and opacity only). With reduced motion, or without IntersectionObserver, nothing is hidden.
 */
let io: IntersectionObserver | undefined;

const on = (): boolean => typeof IntersectionObserver !== "undefined" && !matchMedia("(prefers-reduced-motion: reduce)").matches;

export function reveal(el: Element | null): void {
  if (!el || !on() || el.classList.contains("in")) return;
  io ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io?.unobserve(e.target);
        }
    },
    { rootMargin: "0px 0px -6% 0px" },
  );
  el.classList.add("rv");
  io.observe(el);
}

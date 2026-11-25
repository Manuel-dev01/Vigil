import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
// After the app stylesheet, so the pages' own art direction wins where the two meet.
import "./views/pages.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Start fetching the chain libraries and the descriptor snapshot as soon as the shell is up, in parallel
// with the first view's own chunk.
void import("./chain.ts").then((m) => m.chain()).catch(() => undefined);

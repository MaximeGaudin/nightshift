import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Toaster } from "./components/ui/sonner.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
// Mounted beside App so a toast survives App switching between picker, skeleton and board.
createRoot(root).render(
  <>
    <App />
    <Toaster />
  </>,
);

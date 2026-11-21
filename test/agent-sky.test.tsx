import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentSky, signalCount, starCount } from "../src/web/AgentSky.tsx";

test("agent-sky: decorative canvas, hidden from assistive tech", () => {
  const html = renderToStaticMarkup(<AgentSky activity={0} />);
  expect(html).toBe('<div class="agent-sky" aria-hidden="true"><canvas></canvas></div>');
});

test("agent-sky: signals follow the running agents, within bounds", () => {
  expect(signalCount(0)).toBe(2);
  expect(signalCount(1)).toBe(5);
  expect(signalCount(-3)).toBe(2);
  expect(signalCount(50)).toBe(14);
});

test("agent-sky: star density is bounded on tiny and huge panels", () => {
  expect(starCount(100, 100)).toBe(12);
  expect(starCount(1400, 800)).toBe(53);
  expect(starCount(6000, 4000)).toBe(80);
});

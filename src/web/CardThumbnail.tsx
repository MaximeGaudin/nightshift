import { useState } from "react";
import { cardScreenshots, screenshotUrl } from "../shared/screenshots.ts";
import type { Card } from "../shared/types.ts";

/** First capture of the card, shown on top of its board tile. Click bubbles to the tile. */
export function CardThumbnail({ project, card }: { project: string; card: Card }) {
  const [failed, setFailed] = useState(false);
  const first = cardScreenshots(card.description, card.id)[0];
  if (!first || failed) return null;
  return (
    <img
      className="card-thumb"
      src={screenshotUrl(project, card.id, first.file)}
      alt={first.alt}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

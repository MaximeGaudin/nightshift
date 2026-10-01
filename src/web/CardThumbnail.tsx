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
      className="card-thumb mb-2 -mt-2 -mx-3 block max-h-[120px] w-[calc(100%+1.5rem)] max-w-none rounded-t-[7px] object-cover object-top"
      src={screenshotUrl(project, card.id, first.file)}
      alt={first.alt}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

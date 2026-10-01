import { useEffect, useState } from "react";
import { api } from "./api.ts";

export function ProjectPicker({
  recent,
  current,
  onPick,
  onCancel,
}: {
  recent: string[];
  current?: string;
  onPick: (path: string) => void;
  onCancel?: () => void;
}) {
  const [path, setPath] = useState(current ?? "");
  const [browse, setBrowse] = useState<{ dir: string; parent: string | null; dirs: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = (dir?: string) =>
    api
      .fs(dir)
      .then((b) => {
        setBrowse(b);
        setPath(b.dir);
        setError(null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => void go(current), []);

  return (
    <div className="picker">
      <header>
        <h1>
          <span className="moon">☾</span> Nightshift
        </h1>
        <p className="muted">
          Un dossier = un kanban. L'état est stocké dans <code>nightshift.json</code> à la racine du dossier.
        </p>
      </header>
      {recent.length > 0 && (
        <section>
          <h2>Projets récents</h2>
          <ul className="recent">
            {recent.map((p) => (
              <li key={p}>
                <button className={p === current ? "active" : ""} onClick={() => onPick(p)}>
                  <strong>{p.split("/").pop()}</strong>
                  <span className="muted">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2>Ouvrir un dossier</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) onPick(path.trim());
          }}
        >
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/chemin/vers/le/projet" />
          <button type="button" onClick={() => go(path)}>
            Parcourir
          </button>
          <button className="primary" type="submit">
            Ouvrir
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel}>
              Annuler
            </button>
          )}
        </form>
        {error && <p className="error-text">{error}</p>}
        {browse && (
          <ul className="browser">
            {browse.parent && (
              <li>
                <button onClick={() => go(browse.parent!)}>..</button>
              </li>
            )}
            {browse.dirs.map((d) => (
              <li key={d}>
                <button onClick={() => go(`${browse.dir}/${d}`)}>📁 {d}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

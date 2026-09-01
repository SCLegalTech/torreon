import { useEffect, useState } from "react";

export type SpriteActor = "marquis" | "wolf" | "codex" | "horde";
export type SpriteMotion = "idle" | "attack" | "hurt" | "victory";

const rows: Record<SpriteMotion, { row: number; frames: number; fps: number }> = {
  idle: { row: 0, frames: 4, fps: 5 },
  attack: { row: 1, frames: 6, fps: 10 },
  hurt: { row: 2, frames: 4, fps: 9 },
  victory: { row: 3, frames: 6, fps: 7 },
};

export function Sprite({ actor, motion = "idle", label }: { actor: SpriteActor; motion?: SpriteMotion; label: string }) {
  const [loaded, setLoaded] = useState(false);
  const [frame, setFrame] = useState(0);
  const animation = rows[motion];
  const source = `/assets/sprites/characters/${actor}.png`;

  useEffect(() => {
    const image = new Image();
    image.onload = () => setLoaded(true);
    image.onerror = () => setLoaded(false);
    image.src = source;
  }, [source]);

  useEffect(() => {
    setFrame(0);
    if (!loaded) return;
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % animation.frames), 1000 / animation.fps);
    return () => window.clearInterval(timer);
  }, [animation.fps, animation.frames, loaded, motion]);

  return (
    <div className={`actor actor-${actor} motion-${motion}`}>
      <div
        className={`sprite ${loaded ? "sprite-loaded" : "sprite-placeholder"}`}
        aria-label={label}
        style={loaded ? {
          backgroundImage: `url(${source})`,
          backgroundSize: `${8 * 100}% ${4 * 100}%`,
          backgroundPosition: `${frame * (100 / 7)}% ${animation.row * (100 / 3)}%`,
        } : undefined}
      >
        {!loaded ? <span aria-hidden="true">{actor === "marquis" ? "♜" : actor === "wolf" ? "◆" : actor === "codex" ? "Φ" : "♟"}</span> : null}
      </div>
      <small>{label}</small>
    </div>
  );
}

import { useEffect, useRef, useState } from "preact/hooks";
import { startSilk } from "./silk.ts";

/** The full-screen silk background (silk.ts). Falls back to a still grey gradient when WebGL is not available. */
export function Background() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const stop = startSilk(canvas.current!);
    if (!stop) setStill(true);
    return stop ?? undefined;
  }, []);
  return <canvas ref={canvas} class={still ? "backdrop still" : "backdrop"} aria-hidden="true" />;
}

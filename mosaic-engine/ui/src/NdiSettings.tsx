import { useEffect, useState } from "react";
import { api } from "./api";

// Settings -> Media: how the engine decodes NDI|HX inputs (H.264 / H.265 from encoder boxes).
export function NdiSettings({ onError }: { onError: (e: unknown) => void }) {
  const [state, setState] = useState<{ gpuDecode: boolean; available: boolean } | null>(null);
  useEffect(() => {
    api.ndiSettings().then(setState).catch(onError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="list">
      <div className="list-head">
        <h3>NDI inputs</h3>
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={!!state?.gpuDecode}
          disabled={!state}
          onChange={(e) => api.putNdiSettings({ gpuDecode: e.target.checked }).then(setState).catch(onError)}
        />
        Decode compressed NDI (NDI|HX, H.265) on the GPU
      </label>
      <small className="muted">
        Streams from encoder boxes are decoded on this PC's processor, which several 4K streams can fill. With this on, the graphics card's video decoder
        does it. Watch Task Manager: the processor should drop and the GPU's "Video Decode" rise within a few seconds; if not, restart the engine once. Turn
        it off again if an input goes black or stutters. Full NDI streams are not affected.
        {state && !state.available ? " (This engine runs without NDI, so it has no effect here.)" : ""}
      </small>
    </section>
  );
}

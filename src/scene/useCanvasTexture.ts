import { useEffect, useMemo } from 'react';
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import { create } from 'zustand';

// Canvas text is drawn with the page's fonts, which load after the first
// frame: faces are redrawn once they are in.
export const useFonts = create<{ ready: number }>(() => ({ ready: 0 }));
if (typeof document !== 'undefined' && document.fonts) {
  const bump = () => useFonts.setState((s) => ({ ready: s.ready + 1 }));
  void Promise.all([document.fonts.load('600 46px "Space Grotesk"'), document.fonts.load('500 24px "JetBrains Mono"')]).then(bump, bump);
}

/** A texture backed by its own canvas; `draw` runs again whenever `deps` change. */
export function useCanvasTexture(draw: (canvas: HTMLCanvasElement) => void, deps: unknown[]): CanvasTexture {
  const fonts = useFonts((s) => s.ready);
  const texture = useMemo(() => {
    const t = new CanvasTexture(document.createElement('canvas'));
    t.colorSpace = SRGBColorSpace;
    t.minFilter = LinearFilter;
    t.generateMipmaps = false;
    t.anisotropy = 4;
    return t;
  }, []);
  useEffect(() => {
    const canvas = texture.image as HTMLCanvasElement;
    const before = `${canvas.width}x${canvas.height}`;
    draw(canvas);
    // a resized canvas needs a new GPU texture, not an update of the old one
    if (before !== `${canvas.width}x${canvas.height}`) texture.dispose();
    texture.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texture, fonts, ...deps]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

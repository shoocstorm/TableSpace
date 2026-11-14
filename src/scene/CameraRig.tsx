// The camera: orbit, pan and zoom by hand, and smooth flights when a table
// is clicked or searched, or when the agent points at part of the schema.

import { CameraControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { MathUtils, type PerspectiveCamera } from 'three';
import { bounds } from '../layout/force';
import { positionsOf, useScene } from '../state/scene';
import { introPlaying } from './intro';

/** The whole schema is looked at from in front of the faces, a little to the side and above: azimuth and polar angle. */
const VIEW = { azimuth: 0.22, polar: 1.21 };
/** One table is looked at from higher up, over the tables in front of it. */
const POLAR_ONE = { min: 0.92, max: 1.12 };
/** How far to the side of a face a flight may leave the camera. */
const SIDE = 0.6;
/** How soft the camera's moves are, and how much softer the opening sweep is. */
const SMOOTH = 0.55;
const SMOOTH_OPENING = 1.35;

export function CameraRig({ still }: { still: boolean }) {
  const controls = useRef<CameraControls>(null);
  const cmd = useScene((s) => s.camera);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const first = useRef(true);
  /** The flight the scene opened with: React may run it twice. */
  const opening = useRef(cmd.nonce);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const s = useScene.getState();
    const names = cmd.tables?.length ? cmd.tables : s.schema.tables.map((t) => t.name);
    const { center, radius } = bounds(positionsOf(s), names, cmd.extra);
    // the narrower of the two view angles decides how far back the camera must be (portrait phones)
    const half = Math.atan(Math.tan(MathUtils.degToRad(camera.fov / 2)) * Math.min(1, size.width / size.height));
    const single = names.length === 1 && !cmd.extra?.length;
    const portrait = size.width < size.height;
    const dist = Math.max(16, (radius * (single ? 2.1 : portrait ? 1 : 0.8)) / Math.sin(half));
    const move = !first.current && !still;
    // on a phone the table details cover the lower part of the scene: the table is shown above them
    void c.setFocalOffset(0, single && portrait ? dist * 0.2 : 0, 0, move);

    // The camera turns as little as it can. Angles count every orbit made by hand, so a flight is aimed at the
    // nearest angle that gives the wanted view, never back through those turns. Both faces of a table read the
    // same: a flight to tables stops at whichever face is nearer, no further to its side than the camera already is.
    const now = c.azimuthAngle;
    let azimuth = VIEW.azimuth + Math.round((now - VIEW.azimuth) / (Math.PI * 2)) * Math.PI * 2;
    let polar = VIEW.polar;
    if (cmd.tables?.length && !first.current) {
      const face = Math.round(now / Math.PI) * Math.PI;
      azimuth = face + MathUtils.clamp(now - face, -SIDE, SIDE);
      polar = single ? MathUtils.clamp(c.polarAngle, POLAR_ONE.min, POLAR_ONE.max) : MathUtils.clamp(c.polarAngle, 0.8, VIEW.polar);
    }
    void c.moveTo(center[0], center[1], center[2], move);
    if (cmd.nonce === opening.current && introPlaying()) {
      // the opening: from far off, high and well to the side, the camera sweeps round and down to the schema as it builds
      void c.rotateTo(azimuth - 1.9, 0.5, false);
      void c.dollyTo(Math.min(200, dist * 2.6), false);
      c.smoothTime = SMOOTH_OPENING;
      void Promise.all([c.rotateTo(azimuth, polar, true), c.dollyTo(dist, true)]).then(() => void (c.smoothTime = SMOOTH));
    } else {
      // a flight asked for during the opening sweep is flown at the usual pace
      if (cmd.nonce !== opening.current) c.smoothTime = SMOOTH;
      void c.rotateTo(azimuth, polar, move);
      void c.dollyTo(dist, move);
    }
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd.nonce]);

  return <CameraControls ref={controls} makeDefault smoothTime={SMOOTH} minDistance={4} maxDistance={220} maxPolarAngle={Math.PI * 0.62} dollySpeed={0.6} />;
}
